'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  PAGE_SIZE_DEFAULT,
  type ConversationListItem,
  type GameMessageResponse,
  type ListMessagesResponse,
  type Message,
  type MessageEffect,
  type SendMessageRequest,
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
import { claimFirstView, EFFECT_EMOJI, EFFECT_LABEL, wasViewed } from '@/lib/effects';
import { conversationTitle, dmPeer, formatClock, formatLastSeen, messageSnippet } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { displayNameFor, loadPrefs, themeClassName, wallpaperClassName } from '@/lib/prefs';
import { toggleReaction, toggleStamp } from '@/lib/reactions';
import { pendingFor, refreshScheduled } from '@/lib/scheduled';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AfterglowCard from './AfterglowCard';
import AttachmentView from './AttachmentView';
import Avatar from './Avatar';
import ChatInfoSheet from './ChatInfoSheet';
import Composer, { type ComposerPayload, type PlusAction } from './Composer';
import DoodleSheet from './DoodleSheet';
import EffectOverlay from './EffectOverlay';
import GameTttView from './GameTttView';
import { InviteButton } from './InviteSheet';
import PlanHeader from './PlanHeader';
import PollView from './PollView';
import PreviewCard from './PreviewCard';
import PuzzleResultView from './PuzzleResultView';
import ReactionPicker from './ReactionPicker';
import ReportSheet from './ReportSheet';
import ScheduledDrawer from './ScheduledDrawer';
import SeenBySheet from './SeenBySheet';
import Ticks, { tickStateFor } from './Ticks';
import TttChallengeSheet from './TttChallengeSheet';
import TypingIndicator from './TypingIndicator';
import VibeCheckSheet from './VibeCheckSheet';
import VibeCheckView from './VibeCheckView';
import styles from './chat.module.css';
import exp from './expression.module.css';

const LONG_PRESS_MS = 420;

const TTL_SHORT: Record<number, string> = {
  3600: '1h',
  86400: '24h',
  604800: '7d',
  2592000: '30d',
};

export default function ChatView({ conversationId }: { conversationId: string }) {
  const state = useAppState();
  const router = useRouter();
  const conv = state.conversations.get(conversationId);
  const messages = state.messages.get(conversationId) ?? [];
  const meId = state.me?.id;
  const prefs = state.prefs.get(conversationId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const loadedForRef = useRef<string | null>(null);
  // Messages created after mount get the entrance animation; loaded history
  // renders instantly (chat.module.css .enter respects prefers-reduced-motion).
  const mountedAtRef = useRef(Date.now());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMoreHistory, setNoMoreHistory] = useState(false);

  // v0.4 sheets & overlays
  const [infoOpen, setInfoOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [doodleOpen, setDoodleOpen] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [tttPickOpen, setTttPickOpen] = useState(false);
  const [activeEffect, setActiveEffect] = useState<MessageEffect | null>(null);

  // This is the open conversation (read receipts, sync priority).
  useEffect(() => {
    store.setActiveConversation(conversationId);
    return () => store.setActiveConversation(null);
  }, [conversationId]);

  // My personal prefs for this chat (§1.24) + my scheduled list (§1.26).
  useEffect(() => {
    void loadPrefs(conversationId);
  }, [conversationId]);
  useEffect(() => {
    if (!store.state.scheduledLoaded) void refreshScheduled().catch(() => undefined);
  }, []);

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

  const sendRaw = useCallback(
    async (req: Omit<SendMessageRequest, 'client_msg_id'>): Promise<void> => {
      stickRef.current = true;
      await sendMessage(conversationId, { client_msg_id: uuidv7(), ...req });
    },
    [conversationId]
  );

  // §1.27 tic-tac-toe challenge: DM = opponent implied; group = picker sheet.
  const startTtt = useCallback(
    async (opponentId?: string): Promise<void> => {
      const res = await api.post<GameMessageResponse>(`/api/conversations/${conversationId}/games/ttt`, {
        client_msg_id: uuidv7(),
        ...(opponentId ? { opponent_id: opponentId } : {}),
      });
      stickRef.current = true;
      store.applyMessage(res.message);
      void db.storeMessages(conversationId, [res.message]).catch(() => undefined);
    },
    [conversationId]
  );

  const onPlusAction = useCallback(
    (action: PlusAction) => {
      if (action === 'doodle') setDoodleOpen(true);
      else if (action === 'vibe') setVibeOpen(true);
      else if (action === 'puzzle') router.push('/puzzle');
      else if (action === 'ttt') {
        if (conv?.type === 'dm') void startTtt();
        else setTttPickOpen(true);
      }
    },
    [conv?.type, router, startTtt]
  );

  // §1.22: a message's one-shot effect fires through here (first view only).
  const onEffect = useCallback((effect: MessageEffect) => {
    setActiveEffect((cur) => cur ?? effect);
  }, []);

  // My nickname map (§1.24) — personal, my view only.
  const nameFor = useCallback(
    (userId: string, fallback: string) => prefs?.nicknames[userId] ?? fallback,
    [prefs]
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

  const baseTitle = conversationTitle(conv, meId);
  const title = peer ? displayNameFor(prefs, peer) : baseTitle;
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
  // Sparked-beacon plan group? The Beacon DTO carries conversation_id only for
  // the creator/joiners (§1.15), so a hit here means this viewer is in the plan.
  const planBeacon = [...state.beacons.values()].find((b) => b.conversation_id === conversationId) ?? null;
  const myJoinSeq = conv.participants.find((p) => p.user.id === meId)?.join_seq ?? 0;
  const oldestLoaded = messages.length ? messages[0].seq : 0;
  const hasOlder = !noMoreHistory && oldestLoaded > myJoinSeq + 1;
  const pendingOutbox = state.outbox.filter((o) => o.conversation_id === conversationId);
  const pendingScheduled = pendingFor(conversationId);

  return (
    <div className={`${styles.chatPage} ${themeClassName(exp, prefs?.theme)}`.trim()}>
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
        {conv.disappear_ttl_s !== null ? (
          <span className={exp.ttlChip} title={`Messages disappear after ${TTL_SHORT[conv.disappear_ttl_s] ?? ''}`}>
            ⏳ {TTL_SHORT[conv.disappear_ttl_s] ?? ''}
          </span>
        ) : null}
        {pendingScheduled.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={`${pendingScheduled.length} scheduled ${pendingScheduled.length === 1 ? 'message' : 'messages'}`}
            onClick={() => setSchedOpen(true)}
          >
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <ClockIcon />
              <span className="badge" style={{ position: 'absolute', top: -8, right: -10, minWidth: 16, height: 16, fontSize: 10 }}>
                {pendingScheduled.length}
              </span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Chat settings"
          onClick={() => setInfoOpen(true)}
        >
          <GearIcon />
        </button>
      </header>

      {planBeacon && meId ? <PlanHeader beacon={planBeacon} meId={meId} /> : null}

      <div
        ref={scrollRef}
        className={`${styles.scroll} ${wallpaperClassName(exp, prefs?.wallpaper)}`.trim()}
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
            <p>Say hi, drop a doodle, or rope someone else in.</p>
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
            nameFor={nameFor}
            onEffect={onEffect}
          />
        ))}
        {pendingOutbox.map((item) => (
          <div key={item.client_msg_id} className={styles.pendingNote}>
            Queued (offline): {item.payload.body ?? 'attachment'}
          </div>
        ))}
      </div>

      <TypingIndicator conversation={conv} />
      <Composer
        onSubmit={submit}
        onTyping={() => sendTyping(conversationId)}
        autoFocus
        conversationId={conversationId}
        onPlusAction={onPlusAction}
      />

      {activeEffect ? <EffectOverlay effect={activeEffect} onDone={() => setActiveEffect(null)} /> : null}
      {infoOpen && meId ? <ChatInfoSheet conv={conv} meId={meId} onClose={() => setInfoOpen(false)} /> : null}
      {schedOpen ? <ScheduledDrawer conversationId={conversationId} onClose={() => setSchedOpen(false)} /> : null}
      {doodleOpen ? (
        <DoodleSheet
          onClose={() => setDoodleOpen(false)}
          onSend={async (attachmentId) => {
            await sendRaw({ type: 'image', attachment_ids: [attachmentId], metadata: { doodle: true } });
          }}
        />
      ) : null}
      {vibeOpen ? (
        <VibeCheckSheet
          onClose={() => setVibeOpen(false)}
          onSend={async (prompt) => {
            await sendRaw({ type: 'vibe_check', body: prompt });
          }}
        />
      ) : null}
      {tttPickOpen && meId ? (
        <TttChallengeSheet
          conv={conv}
          meId={meId}
          nameFor={nameFor}
          onClose={() => setTttPickOpen(false)}
          onPick={(opponentId) => startTtt(opponentId)}
        />
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  conv,
  meId,
  fresh,
  nameFor,
  onEffect,
}: {
  message: Message;
  conv: ConversationListItem;
  meId: string;
  fresh: boolean;
  nameFor: (userId: string, fallback: string) => string;
  onEffect: (effect: MessageEffect) => void;
}) {
  const state = useAppState();
  const [picker, setPicker] = useState(false);
  const [info, setInfo] = useState(false);
  const [report, setReport] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const own = message.sender_id === meId;

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  // §1.22: one-shot full-screen effect on FIRST view only (IndexedDB-tracked);
  // fully replaced by the static bubble badge under prefers-reduced-motion.
  const effect = message.metadata.effect;
  const effectSeq = message.seq;
  const effectConv = message.conversation_id;
  const deleted = message.deleted_at !== null;
  useEffect(() => {
    if (!effect || deleted) return;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Mark it viewed so turning motion back on later never replays history.
      void claimFirstView('effect', effectConv, effectSeq);
      return;
    }
    let cancelled = false;
    void claimFirstView('effect', effectConv, effectSeq).then((first) => {
      if (first && !cancelled) onEffect(effect);
    });
    return () => {
      cancelled = true;
    };
  }, [effect, deleted, effectConv, effectSeq, onEffect]);

  // §1.26 capsule reveal state (client-tracked like effects).
  const isCapsule = message.metadata.capsule === true && !deleted;
  const [capsuleOpen, setCapsuleOpen] = useState<boolean | null>(isCapsule ? null : true);
  const [justOpened, setJustOpened] = useState(false);
  useEffect(() => {
    if (!isCapsule) return;
    let cancelled = false;
    // The author sees their own capsule open (they wrote it); recipients get
    // the sealed envelope until their first tap.
    if (own) {
      setCapsuleOpen(true);
      return;
    }
    void wasViewed('capsule', message.conversation_id, message.seq).then((seen) => {
      if (!cancelled) setCapsuleOpen(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [isCapsule, own, message.conversation_id, message.seq]);

  if (message.type === 'system') {
    // Afterglow recap (v0.3 §1.15) renders as a card, not a system pill.
    if (message.metadata.afterglow) {
      return (
        <AfterglowCard
          afterglow={message.metadata.afterglow}
          body={message.body}
          conv={conv}
          meId={meId}
        />
      );
    }
    return <div className={styles.system}>{message.body ?? messageSnippet(message)}</div>;
  }

  // §1.25 tombstone: the sweep nulled body/metadata and dropped attachments;
  // the row (and its seq) survives so the bubble keeps its position.
  if (deleted) {
    return (
      <div className={`${styles.row}${own ? ` ${styles.own}` : ''}`}>
        <div className={styles.msgCol}>
          <div className={styles.bubble}>
            <span className={exp.tombstone}>
              <span aria-hidden>⏳</span> Message expired
            </span>
          </div>
        </div>
      </div>
    );
  }

  const sender =
    !own && conv.type === 'group'
      ? message.sender_id === null
        ? message.type === 'poll'
          ? null // the auto venue poll speaks for itself
          : 'Unknown'
        : (() => {
            const p = conv.participants.find((x) => x.user.id === message.sender_id);
            return p ? nameFor(p.user.id, p.user.display_name) : 'Unknown';
          })()
      : null;

  const toggle = (emoji: string, mine: boolean) =>
    void toggleReaction(message.conversation_id, message.seq, emoji, mine);

  const pick = (emoji: string) => {
    const existing = message.reactions.find((r) => r.emoji === emoji);
    toggle(emoji, existing?.mine ?? false);
    setPicker(false);
  };

  const stamped = message.stamps.some((u) => u.id === meId);
  const stamp = () => {
    void toggleStamp(message.conversation_id, message.seq, stamped);
    setPicker(false);
  };

  // Touch: long-press the bubble opens the quick-react row (desktop gets the
  // hover button instead — chat.module.css hides it on hover-less devices).
  const startPress = () => {
    cancelPress();
    pressTimer.current = setTimeout(() => setPicker(true), LONG_PRESS_MS);
  };

  const sealed = isCapsule && capsuleOpen !== true;

  // §1.23: an avatar-stamp vibe reply is {type:'text', no body, no attachments}
  // — without its own render path the bubble is an empty shell with only the
  // clock. The bubble IS the sender's face, mirroring the collage tile.
  const isStampReply = message.metadata.stamp === true && message.metadata.vibe_reply_seq !== undefined;
  const stampUser = isStampReply
    ? conv.participants.find((x) => x.user.id === message.sender_id)?.user ?? null
    : null;

  const bubbleContent = sealed ? (
    <button
      type="button"
      className={styles.bubble}
      style={{ border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'inherit' }}
      onClick={() => {
        if (capsuleOpen === null) return; // still checking local state
        void claimFirstView('capsule', message.conversation_id, message.seq);
        setJustOpened(true);
        setCapsuleOpen(true);
      }}
      aria-label="Sealed time capsule — tap to open"
    >
      <span className={exp.capsuleSealed}>
        <span className={exp.capsuleEnvelope} aria-hidden>
          💌
        </span>
        <span className={exp.capsuleHint}>{capsuleOpen === null ? 'A time capsule…' : 'Tap to open'}</span>
      </span>
    </button>
  ) : (
    <div
      className={`${styles.bubble}${justOpened ? ` ${exp.capsuleOpened}` : ''}`}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
    >
      {sender ? <div className={styles.sender}>{sender}</div> : null}
      {isCapsule ? (
        <span className={exp.capsuleTag}>
          <span aria-hidden>💌</span> Time capsule
        </span>
      ) : null}
      {message.attachments.map((att) => (
        <AttachmentView key={att.id} attachment={att} doodle={message.metadata.doodle === true} />
      ))}
      {message.metadata.link_preview ? <PreviewCard preview={message.metadata.link_preview} /> : null}
      {message.type === 'poll' && message.poll ? (
        <PollView poll={message.poll} />
      ) : message.type === 'vibe_check' && message.vibe ? (
        <VibeCheckView message={message} nameFor={nameFor} />
      ) : message.type === 'game_ttt' && message.metadata.game ? (
        <GameTttView message={message} conv={conv} meId={meId} nameFor={nameFor} />
      ) : message.type === 'puzzle_result' && message.metadata.puzzle ? (
        <PuzzleResultView puzzle={message.metadata.puzzle} own={own} />
      ) : isStampReply ? (
        <span className={exp.stampReplyBody}>
          {stampUser ? (
            <Avatar
              avatar={stampUser.avatar}
              name={nameFor(stampUser.id, stampUser.display_name)}
              size={44}
              animated
            />
          ) : null}
          <span className={exp.stampReplyLabel}>
            <span aria-hidden>🎭</span> {own ? 'You answered the vibe check' : 'Answered the vibe check'}
          </span>
        </span>
      ) : message.body ? (
        <span>{message.body}</span>
      ) : null}
      <span className={styles.meta}>
        {effect ? (
          <span className={exp.effectBadge} title={`Sent with ${EFFECT_LABEL[effect].toLowerCase()}`} aria-label={`Sent with ${EFFECT_LABEL[effect].toLowerCase()}`}>
            {EFFECT_EMOJI[effect]}
          </span>
        ) : null}
        {formatClock(message.created_at)}
        {own ? <Ticks state={tickStateFor(message, conv, meId)} /> : null}
      </span>
    </div>
  );

  return (
    <div className={`${styles.row}${own ? ` ${styles.own}` : ''}${fresh ? ` ${styles.enter}` : ''}`}>
      <div className={styles.msgCol}>
        <div className={styles.bubbleWrap}>
          {bubbleContent}
          <button
            type="button"
            className={styles.reactBtn}
            aria-label="React to this message"
            onClick={() => setPicker((v) => !v)}
          >
            <SmileIcon />
          </button>
          {picker ? (
            <>
              <ReactionPicker
                onPick={pick}
                onClose={() => setPicker(false)}
                onStamp={stamp}
                stamped={stamped}
                myAvatar={state.me?.avatar ?? null}
              />
              {/* Extra actions ride under the quick-react popover: seen-by info
                  on own messages (§1.18), report on others' (§1.14). */}
              <div className={styles.msgMenu} role="menu">
                {own ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      setInfo(true);
                    }}
                  >
                    Message info
                  </button>
                ) : message.sender_id ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      setReport(true);
                    }}
                  >
                    Report message
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        {info ? (
          <SeenBySheet
            conversationId={message.conversation_id}
            seq={message.seq}
            onClose={() => setInfo(false)}
          />
        ) : null}
        {report ? (
          <ReportSheet
            target={{ kind: 'message', conversation_id: message.conversation_id, seq: message.seq }}
            onClose={() => setReport(false)}
          />
        ) : null}
        {/* §1.19 stamps: FACES, not counters — reactor avatars in first-stamp
            order, animated under the §5 motion rules (Avatar gates internally).
            Tap your own face to unstamp. */}
        {message.stamps.length > 0 ? (
          <div className={`${exp.stampRow}${own ? ` ${exp.stampRowOwn}` : ''}`} aria-label="Avatar stamps">
            {message.stamps.map((u) =>
              u.id === meId ? (
                <button
                  key={u.id}
                  type="button"
                  className={exp.stampFace}
                  aria-label="Your stamp — tap to remove"
                  title="You stamped this — tap to remove"
                  onClick={() => void toggleStamp(message.conversation_id, message.seq, true)}
                >
                  <Avatar avatar={u.avatar} name={nameFor(u.id, u.display_name)} size={26} animated />
                </button>
              ) : (
                <span key={u.id} className={exp.stampFace} title={`${nameFor(u.id, u.display_name)} stamped this`}>
                  <Avatar avatar={u.avatar} name={nameFor(u.id, u.display_name)} size={26} animated />
                </span>
              )
            )}
          </div>
        ) : null}
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

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2.8 L10.9 4.9 a5.4 5.4 0 0 1 2.3 1 l2.2 -0.6 L16.6 7.8 l-1.6 1.6 a5.4 5.4 0 0 1 0 1.2 l1.6 1.6 -1.2 2.5 -2.2 -0.6 a5.4 5.4 0 0 1 -2.3 1 L10 17.2 9.1 15.1 a5.4 5.4 0 0 1 -2.3 -1 l-2.2 0.6 -1.2 -2.5 1.6 -1.6 a5.4 5.4 0 0 1 0 -1.2 L3.4 7.8 4.6 5.3 l2.2 0.6 a5.4 5.4 0 0 1 2.3 -1 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 5.8 V10 L13 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
