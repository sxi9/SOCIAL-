'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  EDIT_WINDOW_S,
  EDITABLE_MESSAGE_TYPES,
  extractYoutubeVideoId,
  FORWARDABLE_MESSAGE_TYPES,
  MAX_MESSAGE_BODY_CHARS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type ConversationListItem,
  type EditMessageResponse,
  type GameMessageResponse,
  type ListMessagesResponse,
  type ListParticipantsResponse,
  type Message,
  type MessageEffect,
  type SendMessageRequest,
  type UserLite,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import * as db from '@/lib/db';
import {
  queueRead,
  sendDelivered,
  sendMessage,
  sendTyping,
  subscribePresence,
  unsubscribePresence,
} from '@/lib/connection';
import { queueFeedback } from '@/lib/discovery';
import { isSessionLive, startWatch } from '@/lib/watch';
import { joinCall, startCall } from '@/lib/webrtc';
import { claimFirstView, EFFECT_EMOJI, EFFECT_LABEL, wasViewed } from '@/lib/effects';
import {
  canPostIn,
  conversationTitle,
  dmPeer,
  firstUrl,
  formatClock,
  formatLastSeen,
  kindLabel,
  messageSnippet,
  myRole,
} from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { KIND_EMOJI } from '@/lib/listings';
import { displayNameFor, loadPrefs, themeClassName, wallpaperClassName } from '@/lib/prefs';
import { toggleReaction, toggleStamp } from '@/lib/reactions';
import { pendingFor, refreshScheduled } from '@/lib/scheduled';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import AfterglowCard from './AfterglowCard';
import AttachmentView from './AttachmentView';
import Avatar from './Avatar';
import { PhoneIcon, VideoIcon } from './CallOverlay';
import ChatInfoSheet from './ChatInfoSheet';
import Composer, { type ComposerPayload, type PlusAction } from './Composer';
import DoodleSheet from './DoodleSheet';
import EffectOverlay from './EffectOverlay';
import ForwardSheet from './ForwardSheet';
import GameTttView from './GameTttView';
import { InviteButton } from './InviteSheet';
import ListingReviewNudge from './ListingReviewNudge';
import PinnedBar from './PinnedBar';
import PlanHeader from './PlanHeader';
import PollView from './PollView';
import PreviewCard from './PreviewCard';
import PuzzleResultView from './PuzzleResultView';
import ReactionPicker from './ReactionPicker';
import ReportSheet from './ReportSheet';
import RouletteBanner from './RouletteBanner';
import ScheduledDrawer from './ScheduledDrawer';
import SeenBySheet from './SeenBySheet';
import Ticks, { tickStateFor } from './Ticks';
import TttChallengeSheet from './TttChallengeSheet';
import TypingIndicator from './TypingIndicator';
import VibeCheckSheet from './VibeCheckSheet';
import VibeCheckView from './VibeCheckView';
import WatchTogetherSheet from './WatchTogetherSheet';
import brd from './board.module.css';
import cls from './calls.module.css';
import styles from './chat.module.css';
import exp from './expression.module.css';
import soc from './social.module.css';
import wtc from './watch.module.css';

const LONG_PRESS_MS = 420;
const SWIPE_REPLY_PX = 64;
const JUMP_PAGE_CAP = 12; // at most this many before_seq pages per jump

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

  // v0.5a chat power: reply draft (§1.29), forward target (§1.31), jump flash.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const replyToRef = useRef<Message | null>(null);
  replyToRef.current = replyTo;
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);

  // v0.6 watch together (§1.43): sheet open + session liveness (coarse tick —
  // a session is stale once syncs stop for WATCH_SESSION_TTL_S).
  const [watchOpen, setWatchOpen] = useState(false);
  const watchNow = useNow(10_000);
  const watchSession = state.watch.get(conversationId);
  const watchLive = isSessionLive(watchSession, watchNow);

  // v0.6 (§1.45 prompt rule): leaving an origin:'discovery' DM for the first
  // time queues the one-time PRIVATE expectation-feedback sheet (it guards
  // itself against ever showing twice).
  const convOrigin = conv?.origin ?? null;
  useEffect(() => {
    if (convOrigin !== 'discovery') return;
    const id = conversationId;
    return () => queueFeedback('discovery', id);
  }, [convOrigin, conversationId]);

  // This is the open conversation (read receipts, sync priority).
  useEffect(() => {
    store.setActiveConversation(conversationId);
    return () => store.setActiveConversation(null);
  }, [conversationId]);

  // My personal prefs for this chat (§1.24) + my scheduled list (§1.26).
  useEffect(() => {
    void loadPrefs(conversationId);
  }, [conversationId]);

  // v0.6 §1.42: reconnect truth for calls is the log, never frame replay —
  // one page on open keeps the "Join call" chip honest after a cold start.
  const convType = conv?.type;
  useEffect(() => {
    if (!convType || convType === 'channel') return;
    let cancelled = false;
    void api
      .get<{ calls: import('@socialchat/shared').Call[] }>(
        `/api/conversations/${conversationId}/calls?limit=3`
      )
      .then((res) => {
        if (cancelled) return;
        for (const c of res.calls) store.upsertLiveCall(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [convType, conversationId]);
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
      // a network failure parks the send in the outbox. A reply rides the
      // same send as reply_to_seq (§1.29).
      const reply = replyToRef.current;
      await sendMessage(conversationId, {
        client_msg_id: uuidv7(),
        ...payload,
        ...(reply ? { reply_to_seq: reply.seq } : {}),
      });
      setReplyTo(null);
      return true;
    },
    [conversationId]
  );

  // §1.29 "tap the context to jump": page history by before_seq until the
  // target is local (it is at most a few pages away), then scroll + flash.
  const jumpToSeq = useCallback(
    async (seq: number) => {
      for (let i = 0; i < JUMP_PAGE_CAP; i++) {
        const list = store.state.messages.get(conversationId) ?? [];
        if (list.some((m) => m.seq === seq)) break;
        const oldest = list.length ? list[0].seq : undefined;
        // Nothing loaded, bottom of history, or the target is inside/above the
        // loaded window yet missing (visibility floor) — stop paging.
        if (oldest === undefined || oldest <= 1 || oldest <= seq) break;
        try {
          const res = await api.get<ListMessagesResponse>(
            `/api/conversations/${conversationId}/messages?before_seq=${oldest}&limit=${PAGE_SIZE_MAX}`
          );
          if (res.messages.length === 0) break; // visibility floor
          store.addMessages(conversationId, res.messages);
          void db.storeMessages(conversationId, res.messages).catch(() => undefined);
        } catch {
          break;
        }
      }
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${conversationId}-${seq}`);
        if (!el) return;
        stickRef.current = false;
        const reduced =
          typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
        setFlashSeq(seq);
        setTimeout(() => setFlashSeq(null), 1400);
      });
    },
    [conversationId]
  );

  // §1.32 pin/unpin — permission mirrors the server (DM: anyone; group:
  // admin; channel: owner/admin); conv.updated confirms, this is optimistic.
  const togglePin = useCallback(
    async (message: Message, pinned: boolean) => {
      const conv2 = store.state.conversations.get(conversationId);
      if (!conv2) return;
      try {
        if (pinned) {
          await api.del(`/api/conversations/${conversationId}/pins/${message.seq}`);
          store.upsertConversation({ ...conv2, pins: conv2.pins.filter((p) => p.seq !== message.seq) });
        } else {
          await api.post(`/api/conversations/${conversationId}/pins`, { seq: message.seq });
          if (!conv2.pins.some((p) => p.seq === message.seq)) {
            store.upsertConversation({
              ...conv2,
              pins: [
                ...conv2.pins,
                { seq: message.seq, pinned_by: store.state.me?.id ?? null, created_at: new Date().toISOString() },
              ],
            });
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'pin_limit') {
          window.alert('Pin board is full — 10 per chat. Unpin something first.');
        }
      }
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
  // v0.5a §1.35: channels never show a member count, anywhere (PSYCHOLOGY
  // rule 3) — the subline names the kind, not a number.
  const subline =
    conv.type === 'dm'
      ? presence
        ? presence.online
          ? 'online'
          : formatLastSeen(presence.last_seen_at ?? peer?.last_seen_at ?? null)
        : formatLastSeen(peer?.last_seen_at ?? null)
      : conv.type === 'channel'
        ? 'channel'
        : `${activeCount} members`;
  const role = myRole(conv, meId);
  const canPost = canPostIn(conv, meId);
  const isChannel = conv.type === 'channel';
  // §1.32 pin permission mirror: DM anyone, group admin, channel owner/admin.
  const canPin =
    conv.type === 'dm' ? true : role === 'admin' || role === 'owner';
  // §1.33 autocomplete sources: held participants for DMs/groups; the paged,
  // owner/admin-only search for channels (senders there may read the list).
  const mentionCandidates: UserLite[] | undefined = isChannel
    ? undefined
    : conv.participants
        .filter((p) => p.left_at === null)
        .map((p) => ({
          id: p.user.id,
          username: p.user.username,
          display_name: p.user.display_name,
          avatar: p.user.avatar,
        }));
  const searchMentions = isChannel
    ? async (q: string): Promise<UserLite[]> => {
        if (!q) return [];
        try {
          const res = await api.get<ListParticipantsResponse>(
            `/api/conversations/${conversationId}/participants?q=${encodeURIComponent(q)}&limit=8`
          );
          return res.participants.map((p) => ({
            id: p.user.id,
            username: p.user.username,
            display_name: p.user.display_name,
            avatar: p.user.avatar,
          }));
        } catch {
          return [];
        }
      }
    : undefined;
  const replySenderName = replyTo
    ? replyTo.sender_id === meId
      ? 'yourself'
      : (() => {
          const p = conv.participants.find((x) => x.user.id === replyTo.sender_id);
          return p ? nameFor(p.user.id, p.user.display_name) : 'this message';
        })()
    : '';
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
        {/* v0.6 (§1.42): calls exist for dm/group only — never channels. */}
        {conv.type !== 'channel' ? <CallHeaderButtons conv={conv} /> : null}
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

      {/* v0.6 (§1.45): the provisional roulette window — countdown + KEEP. */}
      {conv.origin === 'roulette' ? <RouletteBanner conv={conv} /> : null}

      {/* §1.32: the stable pin board — tap cycles pins and jumps. */}
      <PinnedBar conv={conv} canPin={canPin} onJump={(seq) => void jumpToSeq(seq)} />

      {/* v0.6 (§1.43): a live watch-together session — one tap locks on. */}
      {watchLive && !watchOpen ? (
        <div className={wtc.banner} role="status">
          <span className={wtc.bannerDot} aria-hidden />
          <span>Watch together is live</span>
          <button type="button" className={wtc.bannerJoin} onClick={() => setWatchOpen(true)}>
            Join
          </button>
        </div>
      ) : null}

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
                §1.11); channels mint channel invites (owner/admin, §1.35);
                DMs mint a personal DM-with-me link. */}
            {conv.type !== 'channel' || canPost ? (
              <InviteButton
                className="btn"
                label={conv.type === 'channel' ? 'Share the channel' : 'Invite a friend'}
                conversationId={conv.type !== 'dm' ? conv.id : undefined}
              />
            ) : null}
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
            isChannel={isChannel}
            canPin={canPin}
            flash={flashSeq === msg.seq}
            onJump={(seq) => void jumpToSeq(seq)}
            onReply={canPost ? (m) => setReplyTo(m) : undefined}
            onForward={(m) => setForwarding(m)}
            onPinToggle={canPin ? (m, pinned) => void togglePin(m, pinned) : undefined}
            onWatch={(url, videoId) => {
              // Session already live → just lock on; else this client becomes
              // the host (the server parses the URL again — §1.43).
              if (!watchLive) startWatch(conversationId, url, videoId);
              setWatchOpen(true);
            }}
          />
        ))}
        {pendingOutbox.map((item) => (
          <div key={item.client_msg_id} className={styles.pendingNote}>
            Queued (offline): {item.payload.body ?? 'attachment'}
          </div>
        ))}
      </div>

      {/* v0.5b §1.40: ONE gentle review prompt after a listing DM wraps up. */}
      {meId && conv.type === 'dm' ? (
        <ListingReviewNudge conv={conv} messages={messages} meId={meId} />
      ) : null}

      {/* Typing is gateway-dropped in channels (§2.11) — don't render the slot. */}
      {!isChannel ? <TypingIndicator conversation={conv} /> : null}

      {replyTo ? (
        <div className={soc.replyBar}>
          <button
            type="button"
            className={soc.replyBarBody}
            onClick={() => void jumpToSeq(replyTo.seq)}
            aria-label={`Replying to ${replySenderName} — tap to see the original`}
          >
            <strong>Replying to {replySenderName}</strong>
            <span>
              {replyTo.deleted_at
                ? 'message deleted'
                : replyTo.body?.trim()
                  ? replyTo.body
                  : kindLabel(replyTo.type)}
            </span>
          </button>
          <button
            type="button"
            className={soc.replyBarCancel}
            aria-label="Cancel reply"
            onClick={() => setReplyTo(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {canPost ? (
        <Composer
          onSubmit={submit}
          onTyping={() => sendTyping(conversationId)}
          autoFocus
          conversationId={conversationId}
          onPlusAction={onPlusAction}
          mentionCandidates={mentionCandidates}
          searchMentions={searchMentions}
          hideGames={isChannel}
        />
      ) : (
        // §1.35 channel_read_only — reading and reacting stay open to everyone.
        <div className={soc.adminsOnly}>
          ✨ Only admins post here — reactions are all yours though.
        </div>
      )}

      {watchOpen ? (
        <WatchTogetherSheet conversationId={conversationId} onClose={() => setWatchOpen(false)} />
      ) : null}
      {activeEffect ? <EffectOverlay effect={activeEffect} onDone={() => setActiveEffect(null)} /> : null}
      {forwarding ? <ForwardSheet message={forwarding} onClose={() => setForwarding(null)} /> : null}
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
  isChannel,
  canPin,
  flash,
  onJump,
  onReply,
  onForward,
  onPinToggle,
  onWatch,
}: {
  message: Message;
  conv: ConversationListItem;
  meId: string;
  fresh: boolean;
  nameFor: (userId: string, fallback: string) => string;
  onEffect: (effect: MessageEffect) => void;
  isChannel: boolean;
  canPin: boolean;
  flash: boolean;
  onJump: (seq: number) => void;
  onReply?: (message: Message) => void;
  onForward: (message: Message) => void;
  onPinToggle?: (message: Message, pinned: boolean) => void;
  onWatch?: (url: string, videoId: string) => void;
}) {
  const state = useAppState();
  const [picker, setPicker] = useState(false);
  const [info, setInfo] = useState(false);
  const [report, setReport] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // draft body
  const [editBusy, setEditBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeRef = useRef<{ x: number; y: number; fired: boolean } | null>(null);
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
          recapSeq={message.seq}
        />
      );
    }
    // Name the pill's subject where the client can resolve it: the server
    // stores only ids in metadata.system (API.md §1.4/§1.11 keep the literal
    // body), but membership pills are meaningless without a name ("joined via
    // invite" — who?). Subject: the joiner (actor) for invite_joined; the
    // affected member (target) for add/leave/remove. Unresolvable ids (e.g. a
    // channel, where the participant list is not shipped) and multi-user adds
    // (no single target) fall back to the verbatim body.
    const sys = message.metadata.system;
    const body = message.body ?? messageSnippet(message);
    const subjectId =
      sys?.event === 'invite_joined'
        ? sys.actor_id
        : sys?.event === 'participant_added' ||
            sys?.event === 'participant_left' ||
            sys?.event === 'participant_removed'
          ? sys.target_id
          : undefined;
    const subject = subjectId
      ? conv.participants.find((p) => p.user.id === subjectId)?.user
      : undefined;
    const label = subject
      ? `${subjectId === meId ? 'You' : nameFor(subject.id, subject.display_name)} ${body}`
      : body;
    // v0.5b §1.39: listing-context pills ('listing_contact' / 'team_up') carry
    // a listing_ref SNAPSHOT — the chip keeps rendering (and deep-linking)
    // even after the listing closes, expires or is deleted.
    const listingRef = message.metadata.listing_ref;
    // v0.6 §1.42: the missed-call system message carries a server-written
    // call_ref snapshot — render the pill with a one-tap call-back (same
    // kind). Calls exist for dm/group only, so the guard mirrors the header.
    const callRef = message.metadata.call_ref;
    const missedByMe = sys?.actor_id === meId; // I was the unanswered caller
    return (
      <div className={styles.system}>
        {callRef ? (
          <span aria-hidden>{callRef.kind === 'video' ? '📹 ' : '📞 '}</span>
        ) : null}
        {label}
        {listingRef ? (
          <>
            <br />
            <Link className={brd.refChip} href={`/local?l=${listingRef.listing_id}`}>
              <span aria-hidden>{KIND_EMOJI[listingRef.kind]}</span>
              <span>{listingRef.title}</span>
            </Link>
          </>
        ) : null}
        {callRef && conv.type !== 'channel' ? (
          <>
            <br />
            <button
              type="button"
              className={cls.callBackBtn}
              onClick={() => void startCall(message.conversation_id, callRef.kind)}
            >
              {callRef.kind === 'video' ? <VideoIcon /> : <PhoneIcon />}
              {missedByMe ? 'Call again' : 'Call back'}
            </button>
          </>
        ) : null}
      </div>
    );
  }

  // §1.25/§1.30 tombstone: body/metadata nulled, attachments dropped; the row
  // (and its seq) survives so the bubble keeps its position. The DTO does not
  // say WHICH path tombstoned it, so the copy follows the conversation's TTL.
  if (deleted) {
    const expired = conv.disappear_ttl_s !== null;
    return (
      <div className={`${styles.row}${own ? ` ${styles.own}` : ''}`} id={`msg-${message.conversation_id}-${message.seq}`}>
        <div className={styles.msgCol}>
          <div className={`${styles.bubble}${flash ? ` ${soc.flash}` : ''}`}>
            <span className={exp.tombstone}>
              <span aria-hidden>{expired ? '⏳' : '🗑'}</span> {expired ? 'Message expired' : 'Message deleted'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ---- v0.5a chat power helpers (after the system/tombstone early-outs) ----
  const isPinned = conv.pins.some((p) => p.seq === message.seq);
  const editTypes: readonly string[] = EDITABLE_MESSAGE_TYPES;
  const fwdTypes: readonly string[] = FORWARDABLE_MESSAGE_TYPES;
  const withinEditWindow = Date.now() - new Date(message.created_at).getTime() < EDIT_WINDOW_S * 1000;
  const canEdit = own && editTypes.includes(message.type) && withinEditWindow && message.body !== null;
  const canForward = fwdTypes.includes(message.type);
  const canDelete = own;
  // v0.6 §1.43: a YouTube link lights the "Watch together" affordance — the
  // SAME shared parser the server runs on watch.start, so we never offer a
  // session the gateway would refuse (watch_bad_url).
  const bodyUrl = message.body ? firstUrl(message.body) : null;
  const ytVideoId = bodyUrl ? extractYoutubeVideoId(bodyUrl) : null;

  const saveEdit = async (): Promise<void> => {
    const body = (editing ?? '').trim();
    if (!body || editBusy) return;
    setEditBusy(true);
    setRowError(null);
    try {
      const res = await api.patch<EditMessageResponse>(
        `/api/conversations/${message.conversation_id}/messages/${message.seq}`,
        { body }
      );
      store.replaceMessage(res.message);
      void db.storeMessages(message.conversation_id, [res.message]).catch(() => undefined);
      setEditing(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_window_closed') {
        setRowError('The 24-hour edit window has closed.');
      } else {
        setRowError('Could not save the edit.');
      }
    } finally {
      setEditBusy(false);
    }
  };

  const removeMessage = async (): Promise<void> => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await api.del(`/api/conversations/${message.conversation_id}/messages/${message.seq}`);
      // Optimistic tombstone — the msg.updated frame confirms (§1.30).
      store.replaceMessage({
        ...message,
        deleted_at: new Date().toISOString(),
        body: null,
        metadata: {},
        attachments: [],
        reactions: [],
        stamps: [],
        poll: null,
        vibe: null,
      });
    } catch {
      setRowError('Could not delete the message.');
    }
  };

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
      {message.metadata.forwarded_from ? (
        // §1.31: original-author snapshot — the forwarder stays the sender.
        <span className={soc.fwdTag}>↪ forwarded from {message.metadata.forwarded_from.display_name}</span>
      ) : null}
      {message.reply_context ? (
        // §1.29: server-resolved context — tap jumps to the original.
        <button
          type="button"
          className={soc.replyCard}
          onClick={() => onJump(message.reply_context!.seq)}
          aria-label="See the message this replies to"
        >
          <span className={soc.replyAuthor}>
            {message.reply_context.author
              ? nameFor(message.reply_context.author.id, message.reply_context.author.display_name)
              : 'System'}
          </span>
          <span className={`${soc.replyExcerpt}${message.reply_context.deleted ? ` ${soc.replyDeleted}` : ''}`}>
            {message.reply_context.deleted
              ? 'message deleted'
              : message.reply_context.excerpt ?? kindLabel(message.reply_context.type)}
          </span>
        </button>
      ) : null}
      {isCapsule ? (
        <span className={exp.capsuleTag}>
          <span aria-hidden>💌</span> Time capsule
        </span>
      ) : null}
      {message.attachments.map((att) => (
        <AttachmentView key={att.id} attachment={att} doodle={message.metadata.doodle === true} />
      ))}
      {message.metadata.link_preview ? <PreviewCard preview={message.metadata.link_preview} /> : null}
      {message.metadata.rescue === true ? (
        // v0.6 §1.46: the rescue SOS card — one tap starts the call back.
        <span className={cls.rescueCard}>
          <span className={cls.rescueHead}>
            <span aria-hidden>🆘</span>
            {own
              ? 'You asked for a rescue call'
              : `${(() => {
                  const p = conv.participants.find((x) => x.user.id === message.sender_id);
                  return p ? nameFor(p.user.id, p.user.display_name) : 'A friend';
                })()} needs a rescue call!`}
          </span>
          {message.body ? <span>{message.body}</span> : null}
          {!own ? (
            <button
              type="button"
              className={cls.rescueBtn}
              onClick={() => void startCall(message.conversation_id, 'audio')}
            >
              <PhoneIcon /> Call now
            </button>
          ) : null}
        </span>
      ) : message.type === 'poll' && message.poll ? (
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
      ) : editing !== null ? (
        <span className={soc.editBox}>
          <textarea
            value={editing}
            maxLength={MAX_MESSAGE_BODY_CHARS}
            aria-label="Edit message"
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void saveEdit();
              } else if (e.key === 'Escape') {
                setEditing(null);
              }
            }}
          />
          <span className={soc.editBoxRow}>
            <button type="button" className="btn" onClick={() => setEditing(null)} disabled={editBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={editBusy || !editing.trim()}
              onClick={() => void saveEdit()}
            >
              {editBusy ? 'Saving…' : 'Save'}
            </button>
          </span>
        </span>
      ) : message.body ? (
        <MentionedBody message={message} conv={conv} nameFor={nameFor} />
      ) : null}
      {ytVideoId && bodyUrl && onWatch ? (
        <button
          type="button"
          className={wtc.watchBtn}
          onClick={() => onWatch(bodyUrl, ytVideoId)}
          aria-label="Watch this video together, in sync"
        >
          <span aria-hidden>📺</span> Watch together
        </button>
      ) : null}
      <span className={styles.meta}>
        {effect ? (
          <span className={exp.effectBadge} title={`Sent with ${EFFECT_LABEL[effect].toLowerCase()}`} aria-label={`Sent with ${EFFECT_LABEL[effect].toLowerCase()}`}>
            {EFFECT_EMOJI[effect]}
          </span>
        ) : null}
        {/* §1.30: the edited badge IS edited_at — no history stored or shown. */}
        {message.edited_at && message.type !== 'game_ttt' ? (
          <span className={soc.editedTag}>edited</span>
        ) : null}
        {isPinned ? <span aria-label="Pinned">📌</span> : null}
        {formatClock(message.created_at)}
        {own && !isChannel ? <Ticks state={tickStateFor(message, conv, meId)} /> : null}
      </span>
    </div>
  );

  return (
    <div
      className={`${styles.row}${own ? ` ${styles.own}` : ''}${fresh ? ` ${styles.enter}` : ''}`}
      id={`msg-${message.conversation_id}-${message.seq}`}
      // §1.29 swipe-to-reply (touch): a clean horizontal right-swipe arms the
      // composer's reply chip. Desktop uses the message menu instead.
      onTouchStart={(e) => {
        if (!onReply) return;
        const t = e.touches[0];
        swipeRef.current = { x: t.clientX, y: t.clientY, fired: false };
      }}
      onTouchMove={(e) => {
        const sw = swipeRef.current;
        if (!sw || sw.fired || !onReply) return;
        const t = e.touches[0];
        const dx = t.clientX - sw.x;
        const dy = Math.abs(t.clientY - sw.y);
        if (dx > SWIPE_REPLY_PX && dy < 40) {
          sw.fired = true;
          onReply(message);
        }
      }}
      onTouchEnd={() => {
        swipeRef.current = null;
      }}
    >
      <div className={styles.msgCol}>
        <div className={`${styles.bubbleWrap}${flash ? ` ${soc.flash}` : ''}`}>
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
              {/* The message menu rides under the quick-react popover: reply /
                  forward / pin (§1.29–§1.32), edit & delete on own messages
                  (§1.30), seen-by info (§1.18 — never in channels, §1.35),
                  report on others' (§1.14). */}
              <div className={styles.msgMenu} role="menu">
                {onReply ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      onReply(message);
                    }}
                  >
                    ↩ Reply
                  </button>
                ) : null}
                {canForward ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      onForward(message);
                    }}
                  >
                    ⤻ Forward
                  </button>
                ) : null}
                {onPinToggle ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      onPinToggle(message, isPinned);
                    }}
                  >
                    {isPinned ? '📌 Unpin' : '📌 Pin'}
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      setEditing(message.body ?? '');
                    }}
                  >
                    ✏️ Edit
                  </button>
                ) : null}
                {canDelete ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicker(false);
                      void removeMessage();
                    }}
                  >
                    🗑 Delete
                  </button>
                ) : null}
                {own && !isChannel ? (
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
                ) : null}
                {!own && message.sender_id ? (
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
        {rowError ? <p className="error-text" style={{ margin: '2px 0 0' }}>{rowError}</p> : null}
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

/**
 * §1.33 mention highlighting — keyed STRICTLY on metadata.mentions (the server
 * is the only writer; the client never re-parses). Mentioned ids resolve to
 * usernames via the participants the client holds; tokens that cannot resolve
 * (e.g. channel members outside the shipped owner/admin slice) stay plain.
 */
function MentionedBody({
  message,
  conv,
  nameFor,
}: {
  message: Message;
  conv: ConversationListItem;
  nameFor: (userId: string, fallback: string) => string;
}) {
  const body = message.body ?? '';
  const ids = message.metadata.mentions;
  if (!ids || ids.length === 0) return <span>{body}</span>;
  const byUsername = new Map<string, { id: string; display: string }>();
  for (const id of ids) {
    const p = conv.participants.find((x) => x.user.id === id);
    if (p) {
      byUsername.set(p.user.username.toLowerCase(), {
        id: p.user.id,
        display: nameFor(p.user.id, p.user.display_name),
      });
    }
  }
  if (byUsername.size === 0) return <span>{body}</span>;
  const parts = body.split(/(@[a-z0-9_]{3,24})/gi);
  return (
    <span>
      {parts.map((part, i) => {
        const hit = part.startsWith('@') ? byUsername.get(part.slice(1).toLowerCase()) : undefined;
        return hit ? (
          <Link
            key={`${i}-${part}`}
            href={`/u/${encodeURIComponent(part.slice(1))}`}
            className={soc.mention}
            title={hit.display}
          >
            {part}
          </Link>
        ) : (
          <span key={`${i}-t`}>{part}</span>
        );
      })}
    </span>
  );
}

/**
 * v0.6 §1.42 header call buttons: audio + video starters, replaced by ONE
 * breathing "Join" chip while a call is live in this conversation (DM accept
 * and group join are the same transition). Disabled while I am already in a
 * call — the mesh is one call per person.
 */
function CallHeaderButtons({ conv }: { conv: ConversationListItem }) {
  const state = useAppState();
  const live = state.liveCalls.get(conv.id);
  const inCall = state.callUi !== null && state.callUi.phase !== 'ended';
  const inThisCall = inCall && state.callUi?.conversation_id === conv.id;

  if (live && !inThisCall) {
    return (
      <button
        type="button"
        className={cls.joinChip}
        disabled={inCall}
        onClick={() => void joinCall(live.id, live.kind)}
        aria-label={`Join the ${live.kind} call`}
      >
        {live.kind === 'video' ? <VideoIcon /> : <PhoneIcon />} Join
      </button>
    );
  }
  return (
    <span className={cls.headerCallBtns}>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Start a voice call"
        disabled={inCall}
        onClick={() => void startCall(conv.id, 'audio')}
      >
        <PhoneIcon />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Start a video call"
        disabled={inCall}
        onClick={() => void startCall(conv.id, 'video')}
      >
        <VideoIcon />
      </button>
    </span>
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
