'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PAGE_SIZE_DEFAULT,
  type ConversationListItem,
  type ListMessagesResponse,
  type Message,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import * as db from '@/lib/db';
import {
  queueRead,
  sendDelivered,
  sendMessage,
  sendTyping,
  subscribePresence,
  unsubscribePresence,
} from '@/lib/connection';
import { conversationTitle, dmPeer, formatClock, formatLastSeen, messageSnippet } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { toggleReaction } from '@/lib/reactions';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AttachmentView from './AttachmentView';
import Avatar from './Avatar';
import Composer, { type ComposerPayload } from './Composer';
import { InviteButton } from './InviteSheet';
import PreviewCard from './PreviewCard';
import ReactionPicker from './ReactionPicker';
import Ticks, { tickStateFor } from './Ticks';
import TypingIndicator from './TypingIndicator';
import styles from './chat.module.css';

const LONG_PRESS_MS = 420;

export default function ChatView({ conversationId }: { conversationId: string }) {
  const state = useAppState();
  const conv = state.conversations.get(conversationId);
  const messages = state.messages.get(conversationId) ?? [];
  const meId = state.me?.id;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const loadedForRef = useRef<string | null>(null);
  // Messages created after mount get the entrance animation; loaded history
  // renders instantly (chat.module.css .enter respects prefers-reduced-motion).
  const mountedAtRef = useRef(Date.now());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMoreHistory, setNoMoreHistory] = useState(false);

  // This is the open conversation (read receipts, sync priority).
  useEffect(() => {
    store.setActiveConversation(conversationId);
    return () => store.setActiveConversation(null);
  }, [conversationId]);

  // Initial window: IndexedDB tail, then the newest REST page if we lag.
  useEffect(() => {
    if (!conv || loadedForRef.current === conversationId) return;
    loadedForRef.current = conversationId;
    setNoMoreHistory(false);
    stickRef.current = true;
    let cancelled = false;
    void (async () => {
      store.ensureMessagesEntry(conversationId);
      try {
        const tail = await db.getMessagesTail(conversationId, PAGE_SIZE_DEFAULT);
        if (!cancelled && tail.length) store.addMessages(conversationId, tail);
      } catch {
        /* no local storage */
      }
      // ALWAYS refetch the newest page, even when the IDB tail is caught up by
      // seq: reactions and edits don't bump seq (API.md §1.12), so deltas that
      // landed while this client was closed only reconcile from the DTO
      // aggregate. Fresh DTOs replace stale ones by (conversation_id, seq).
      try {
        const res = await api.get<ListMessagesResponse>(
          `/api/conversations/${conversationId}/messages?before_seq=${conv.last_seq + 1}&limit=${PAGE_SIZE_DEFAULT}`
        );
        if (cancelled) return;
        store.addMessages(conversationId, res.messages);
        const max = await db.storeMessages(conversationId, res.messages).catch(() => 0);
        if (max > 0) sendDelivered(conversationId, max);
      } catch {
        /* offline: the IDB window is what we have */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conv, conversationId]);

  // DM peer presence (on-screen users only, §2.7).
  const peer = conv && meId ? dmPeer(conv, meId) : null;
  const peerId = peer?.id ?? null;
  useEffect(() => {
    if (!peerId) return;
    subscribePresence([peerId]);
    return () => unsubscribePresence([peerId]);
  }, [peerId]);

  // Read watermark: conversation visible on screen → coalesced `read`.
  const lastSeq = conv?.last_seq ?? 0;
  useEffect(() => {
    if (!conv || lastSeq === 0) return;
    const markIfVisible = () => {
      if (document.visibilityState === 'visible') queueRead(conversationId, lastSeq);
    };
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [conv, conversationId, lastSeq]);

  // Pin to bottom while the user is near it.
  const lastRenderedSeq = messages.length ? messages[messages.length - 1].seq : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastRenderedSeq, conversationId]);

  const loadOlder = useCallback(async () => {
    if (!messages.length || loadingOlder) return;
    const oldest = messages[0].seq;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    try {
      const res = await api.get<ListMessagesResponse>(
        `/api/conversations/${conversationId}/messages?before_seq=${oldest}&limit=${PAGE_SIZE_DEFAULT}`
      );
      store.addMessages(conversationId, res.messages);
      void db.storeMessages(conversationId, res.messages).catch(() => undefined);
      if (res.messages.length < PAGE_SIZE_DEFAULT) setNoMoreHistory(true);
      requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight;
      });
    } catch {
      /* ignore; button stays */
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, conversationId]);

  const submit = useCallback(
    async (payload: ComposerPayload): Promise<boolean> => {
      stickRef.current = true;
      // Durable sends are REST-only and idempotent by client_msg_id (§1.5);
      // a network failure parks the send in the outbox.
      await sendMessage(conversationId, { client_msg_id: uuidv7(), ...payload });
      return true;
    },
    [conversationId]
  );

  if (!conv) {
    return (
      <div className={styles.chatPage}>
        <header className={styles.header}>
          <Link href="/" className={styles.back} aria-label="Back">
            <BackIcon />
          </Link>
          <div className={styles.headerText}>
            <h1>{state.booted ? 'Conversation not found' : 'Loading…'}</h1>
          </div>
        </header>
      </div>
    );
  }

  const title = conversationTitle(conv, meId);
  const presence = peerId ? state.presence.get(peerId) : undefined;
  const activeCount = conv.participants.filter((p) => p.left_at === null).length;
  const subline =
    conv.type === 'dm'
      ? presence
        ? presence.online
          ? 'online'
          : formatLastSeen(presence.last_seen_at ?? peer?.last_seen_at ?? null)
        : formatLastSeen(peer?.last_seen_at ?? null)
      : `${activeCount} members`;
  const headerAvatar = conv.type === 'dm' && peer ? peer.avatar : conv.avatar;
  const myJoinSeq = conv.participants.find((p) => p.user.id === meId)?.join_seq ?? 0;
  const oldestLoaded = messages.length ? messages[0].seq : 0;
  const hasOlder = !noMoreHistory && oldestLoaded > myJoinSeq + 1;
  const pendingOutbox = state.outbox.filter((o) => o.conversation_id === conversationId);

  return (
    <div className={styles.chatPage}>
      <header className={styles.header}>
        <Link href="/" className={styles.back} aria-label="Back">
          <BackIcon />
        </Link>
        {/* Animated avatar renders in the open-chat header only (§5.4). */}
        <Avatar avatar={headerAvatar} name={title} size={40} animated />
        <div className={styles.headerText}>
          <h1>
            {peer ? (
              // DM header links to the peer's public profile page (/u/:username).
              <Link href={`/u/${encodeURIComponent(peer.username)}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                {title}
              </Link>
            ) : (
              title
            )}
          </h1>
          <div className={`${styles.headerSub}${conv.type === 'dm' && presence?.online ? ` ${styles.online}` : ''}`}>
            {state.conn === 'error' ? 'connection error' : state.conn !== 'online' ? 'connecting…' : subline}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className={styles.scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {hasOlder && messages.length > 0 ? (
          <button type="button" className={`btn ${styles.loadOlder}`} onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        ) : null}
        {conv.last_seq === 0 && messages.length === 0 && pendingOutbox.length === 0 ? (
          <div className={styles.emptyChat}>
            <QuietDoodle />
            <h3>It&rsquo;s quiet in here… too quiet.</h3>
            <p>Say hi, drop a meme, or rope someone else in.</p>
            {/* Group chats mint a group-scoped invite (admin-only server-side,
                §1.11); DMs mint a personal DM-with-me link. */}
            <InviteButton
              className="btn"
              label="Invite a friend"
              conversationId={conv.type === 'group' ? conv.id : undefined}
            />
          </div>
        ) : null}
        {messages.map((msg) => (
          <MessageRow
            key={msg.id}
            message={msg}
            conv={conv}
            meId={meId ?? ''}
            fresh={new Date(msg.created_at).getTime() > mountedAtRef.current}
          />
        ))}
        {pendingOutbox.map((item) => (
          <div key={item.client_msg_id} className={styles.pendingNote}>
            Queued (offline): {item.payload.body ?? 'attachment'}
          </div>
        ))}
      </div>

      <TypingIndicator conversation={conv} />
      <Composer onSubmit={submit} onTyping={() => sendTyping(conversationId)} autoFocus />
    </div>
  );
}

function MessageRow({
  message,
  conv,
  meId,
  fresh,
}: {
  message: Message;
  conv: ConversationListItem;
  meId: string;
  fresh: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  if (message.type === 'system') {
    return <div className={styles.system}>{message.body ?? messageSnippet(message)}</div>;
  }
  const own = message.sender_id === meId;
  const sender =
    !own && conv.type === 'group'
      ? conv.participants.find((p) => p.user.id === message.sender_id)?.user.display_name ?? 'Unknown'
      : null;

  const toggle = (emoji: string, mine: boolean) =>
    void toggleReaction(message.conversation_id, message.seq, emoji, mine);

  const pick = (emoji: string) => {
    const existing = message.reactions.find((r) => r.emoji === emoji);
    toggle(emoji, existing?.mine ?? false);
    setPicker(false);
  };

  // Touch: long-press the bubble opens the quick-react row (desktop gets the
  // hover button instead — chat.module.css hides it on hover-less devices).
  const startPress = () => {
    cancelPress();
    pressTimer.current = setTimeout(() => setPicker(true), LONG_PRESS_MS);
  };

  return (
    <div className={`${styles.row}${own ? ` ${styles.own}` : ''}${fresh ? ` ${styles.enter}` : ''}`}>
      <div className={styles.msgCol}>
        <div className={styles.bubbleWrap}>
          <div
            className={styles.bubble}
            onTouchStart={startPress}
            onTouchEnd={cancelPress}
            onTouchMove={cancelPress}
            onTouchCancel={cancelPress}
          >
            {sender ? <div className={styles.sender}>{sender}</div> : null}
            {message.attachments.map((att) => (
              <AttachmentView key={att.id} attachment={att} />
            ))}
            {message.metadata.link_preview ? <PreviewCard preview={message.metadata.link_preview} /> : null}
            {message.body ? <span>{message.body}</span> : null}
            <span className={styles.meta}>
              {formatClock(message.created_at)}
              {own ? <Ticks state={tickStateFor(message, conv, meId)} /> : null}
            </span>
          </div>
          <button
            type="button"
            className={styles.reactBtn}
            aria-label="React to this message"
            onClick={() => setPicker((v) => !v)}
          >
            <SmileIcon />
          </button>
          {picker ? <ReactionPicker onPick={pick} onClose={() => setPicker(false)} /> : null}
        </div>
        {message.reactions.length > 0 ? (
          <div className={styles.reactionChips}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`${styles.reactionChip}${r.mine ? ` ${styles.reactionMine}` : ''}`}
                aria-label={`${r.emoji} ${r.count}${r.mine ? ' — you reacted, tap to remove' : ', tap to react'}`}
                onClick={() => toggle(r.emoji, r.mine)}
              >
                <span aria-hidden>{r.emoji}</span>
                {/* Keyed by count so every change remounts → pop animation. */}
                <span key={r.count} className={styles.reactionCount}>
                  {r.count}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SmileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.4" cy="8.4" r="1" fill="currentColor" />
      <circle cx="12.6" cy="8.4" r="1" fill="currentColor" />
      <path d="M6.8 12 a3.6 3.6 0 0 0 6.4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function QuietDoodle() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden>
      <path
        d="M36 10 c14 0 24 9 24 21 c0 12 -10 21 -24 21 c-2.6 0 -5.1 -0.3 -7.4 -0.9 L17 56 l2.8 -9.8 C14.6 42.4 12 37 12 31 C12 19 22 10 36 10 Z"
        stroke="var(--accent)"
        strokeWidth="2.4"
        strokeLinejoin="round"
        opacity="0.6"
      />
      <circle cx="28" cy="31" r="2.4" fill="var(--accent)" opacity="0.6" />
      <circle cx="36" cy="31" r="2.4" fill="var(--accent)" opacity="0.6" />
      <circle cx="44" cy="31" r="2.4" fill="var(--accent)" opacity="0.6" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M13.5 5 L7.5 11 L13.5 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
