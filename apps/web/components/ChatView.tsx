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
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AttachmentView from './AttachmentView';
import Avatar from './Avatar';
import Composer, { type ComposerPayload } from './Composer';
import PreviewCard from './PreviewCard';
import Ticks, { tickStateFor } from './Ticks';
import TypingIndicator from './TypingIndicator';
import styles from './chat.module.css';

export default function ChatView({ conversationId }: { conversationId: string }) {
  const state = useAppState();
  const conv = state.conversations.get(conversationId);
  const messages = state.messages.get(conversationId) ?? [];
  const meId = state.me?.id;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const loadedForRef = useRef<string | null>(null);
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
      const have = store.state.messages.get(conversationId) ?? [];
      const newest = have.length ? have[have.length - 1].seq : 0;
      if (conv.last_seq > newest) {
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
        {messages.map((msg) => (
          <MessageRow key={msg.id} message={msg} conv={conv} meId={meId ?? ''} />
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

function MessageRow({ message, conv, meId }: { message: Message; conv: ConversationListItem; meId: string }) {
  if (message.type === 'system') {
    return <div className={styles.system}>{message.body ?? messageSnippet(message)}</div>;
  }
  const own = message.sender_id === meId;
  const sender =
    !own && conv.type === 'group'
      ? conv.participants.find((p) => p.user.id === message.sender_id)?.user.display_name ?? 'Unknown'
      : null;
  return (
    <div className={`${styles.row}${own ? ` ${styles.own}` : ''}`}>
      <div className={styles.bubble}>
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
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M13.5 5 L7.5 11 L13.5 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
