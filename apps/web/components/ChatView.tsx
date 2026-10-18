'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  EDIT_WINDOW_S,
  EDITABLE_MESSAGE_TYPES,
  extractYoutubeVideoId,
  FORWARDABLE_MESSAGE_TYPES,
  MAX_MESSAGE_BODY_CHARS,
  MOOD_DRUNK_UNDO_WINDOW_S,
  UNDO_SEND_WINDOW_S,
  ON_MY_WAY_BODY,
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
import { isGhost, isPubliclyReadable, isSupportConversation } from '@/lib/groups';
import { bubbleEffectFor, isColdContact, isSelfDrunk } from '@/lib/mood';
import { displayNameFor, loadPrefs, themeClassName, wallpaperClassName } from '@/lib/prefs';
import { toggleReaction, toggleStamp } from '@/lib/reactions';
import { pendingFor, refreshScheduled } from '@/lib/scheduled';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import { useReducedMotion } from '@/lib/useReducedMotion';
import AfterglowCard from './AfterglowCard';
import AttachmentView from './AttachmentView';
import Avatar from './Avatar';
import { PhoneIcon, VideoIcon } from './CallOverlay';
import ChatBackground from './ChatBackground';
import ChatInfoSheet from './ChatInfoSheet';
import Composer, { type ComposerPayload, type PlusAction } from './Composer';
import DoodleSheet from './DoodleSheet';
import DrunkBanner from './DrunkBanner';
import DrunkConfirmSheet from './DrunkConfirmSheet';
import MoodChip from './MoodChip';
import StyledName from './StyledName';
import EffectOverlay from './EffectOverlay';
import ForwardSheet from './ForwardSheet';
import GameTttView from './GameTttView';
import { InviteButton } from './InviteSheet';
import ListingReviewNudge from './ListingReviewNudge';
import LocationPickerSheet, { MapLinksRow } from './LocationPicker';
import PinnedBar from './PinnedBar';
import PlanHeader from './PlanHeader';
import PollView from './PollView';
import Portal from './Portal';
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
import cm from './community.module.css';
import styles from './chat.module.css';
import idm from './identity.module.css';
import exp from './expression.module.css';
import soc from './social.module.css';
import wtc from './watch.module.css';

const LONG_PRESS_MS = 420;
const SWIPE_REPLY_PX = 48;
const SWIPE_MAX_PX = 72;
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
  const [locOpen, setLocOpen] = useState(false); // v0.7 §1.52 "Join me here"
  const [activeEffect, setActiveEffect] = useState<MessageEffect | null>(null);

  // v0.5a chat power: reply draft (§1.29), forward target (§1.31), jump flash.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const replyToRef = useRef<Message | null>(null);
  replyToRef.current = replyTo;
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);

  // v0.8a §1.57 drunk guardrails: the live 10 s undo pills on my own sends,
  // and the pending cold-contact "you sure?" (its resolver, promise-style).
  const [undoables, setUndoables] = useState<UndoableSend[]>([]);
  const [drunkAsk, setDrunkAsk] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const reducedMotion = useReducedMotion();

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

  // v1.0a (#96): EVERY successful send gets a transparent undo pill — the
  // §1.57 drunk undo generalized. Drunk keeps its longer window; the server
  // re-checks the window at undo time either way.
  const registerUndoable = useCallback((msg: Message | null) => {
    if (!msg) return;
    const windowS = isSelfDrunk() ? MOOD_DRUNK_UNDO_WINDOW_S : UNDO_SEND_WINDOW_S;
    const snippet = messageSnippet(msg);
    setUndoables((prev) => [
      ...prev.filter((u) => u.until > Date.now() && u.seq !== msg.seq),
      { seq: msg.seq, until: Date.now() + windowS * 1000, snippet },
    ]);
  }, []);

  // v0.8a §1.57 cold-contact confirm (binding UX contract): while drunk, a DM
  // not talked to in >30 d — or a brand-new one — gets a "you sure?" first.
  // Conversation.last_message_at IS the DTO flag; never a server rejection,
  // and the server never learns who hesitated.
  const confirmColdIfNeeded = useCallback(async (): Promise<boolean> => {
    const conv2 = store.state.conversations.get(conversationId);
    if (!conv2 || !isSelfDrunk() || !isColdContact(conv2)) return true;
    return new Promise<boolean>((resolve) => setDrunkAsk({ resolve }));
  }, [conversationId]);

  const undoSend = useCallback(
    async (seq: number) => {
      setUndoables((prev) => prev.filter((u) => u.seq !== seq));
      try {
        await api.del(`/api/conversations/${conversationId}/messages/${seq}?undo=1`);
        // Optimistic vanish — the msg.updated frame confirms with the same
        // vanishing DTO (metadata {"undone": true}; seq survives, rule 2).
        const msg = store.state.messages.get(conversationId)?.find((m) => m.seq === seq);
        if (msg) {
          store.replaceMessage({
            ...msg,
            deleted_at: new Date().toISOString(),
            body: null,
            metadata: { undone: true },
            attachments: [],
            reactions: [],
            stamps: [],
            poll: null,
            vibe: null,
          });
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'undo_window_closed') {
          toast('Too late — that one is out there now');
        } else if (err instanceof ApiError && err.code === 'not_drunk') {
          toast('Drunk mode already wore off — plain delete still works');
        } else {
          toast('Could not unsend it');
        }
      }
    },
    [conversationId]
  );

  const submit = useCallback(
    async (payload: ComposerPayload): Promise<boolean> => {
      if (!(await confirmColdIfNeeded())) return false; // draft stays put
      stickRef.current = true;
      // Durable sends are REST-only and idempotent by client_msg_id (§1.5);
      // a network failure parks the send in the outbox. A reply rides the
      // same send as reply_to_seq (§1.29).
      const reply = replyToRef.current;
      const msg = await sendMessage(conversationId, {
        client_msg_id: uuidv7(),
        ...payload,
        ...(reply ? { reply_to_seq: reply.seq } : {}),
      });
      registerUndoable(msg);
      setReplyTo(null);
      return true;
    },
    [conversationId, confirmColdIfNeeded, registerUndoable]
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
      // §1.57: EVERY send while drunk is guarded — doodles and pins included.
      if (!(await confirmColdIfNeeded())) return;
      stickRef.current = true;
      const msg = await sendMessage(conversationId, { client_msg_id: uuidv7(), ...req });
      registerUndoable(msg);
    },
    [conversationId, confirmColdIfNeeded, registerUndoable]
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
      else if (action === 'location') setLocOpen(true);
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
  // v0.8b §1.68: ghost groups say so (and suppress every identity side
  // channel below); the §1.69 Support conversation wears the brand.
  const ghost = isGhost(conv);
  const supportConv = isSupportConversation(conv);
  const subline =
    conv.type === 'dm'
      ? presence
        ? presence.online
          ? 'online'
          : formatLastSeen(presence.last_seen_at ?? peer?.last_seen_at ?? null)
        : formatLastSeen(peer?.last_seen_at ?? null)
      : conv.type === 'channel'
        ? 'channel'
        : supportConv
          ? '🛟 the operator answers here'
          : ghost
            ? `${activeCount} masks · 👻 ghost group`
            : `${activeCount} members`;
  const role = myRole(conv, meId);
  const canPost = canPostIn(conv, meId);
  const isChannel = conv.type === 'channel';
  // §1.32 pin permission mirror: DM anyone, group admin, channel owner/admin.
  const canPin =
    conv.type === 'dm' ? true : role === 'admin' || role === 'owner';
  // §1.33 autocomplete sources: held participants for DMs/groups; the paged,
  // owner/admin-only search for channels (senders there may read the list).
  // v0.8b §1.68: mentions are NOT parsed in ghost groups (a mention is an
  // identity assertion) — offer no autocomplete there.
  const mentionCandidates: UserLite[] | undefined = isChannel || ghost
    ? undefined
    : conv.participants
        .filter((p) => p.left_at === null)
        .map((p) => ({
          id: p.user.id,
          username: p.user.username,
          display_name: p.user.display_name,
          avatar: p.user.avatar,
          mood: p.user.mood,
          name_style: p.user.name_style,
          mask_emoji: null,
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
            mood: p.user.mood,
            name_style: p.user.name_style,
            mask_emoji: null,
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
  // v0.8a: the §1.60 background (mine alone) + the §1.58 ambient rain, both
  // layered UNDER the scroll content. Rain shows while someone in the round
  // has a visible 'sad' chip (per-viewer resolution already happened
  // server-side), gated by my mood_effects toggle and reduced motion.
  // v1.0a (#95): my own §1.60 pref overrides; else the shared background.
  const background = prefs?.background ?? prefs?.shared_background ?? null;
  const moodEffectsOn = (state.settings?.mood_effects ?? true) && !reducedMotion;
  const rainActive =
    moodEffectsOn &&
    conv.participants.some((p) => p.left_at === null && bubbleEffectFor(p.user.mood) === 'rain');
  const scrollClass = [
    styles.scroll,
    background ? '' : wallpaperClassName(exp, prefs?.wallpaper),
    background || rainActive ? idm.scrollOverBg : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`${styles.chatPage} ${themeClassName(exp, prefs?.theme)}`.trim()}>
      <header className={styles.header}>
        <Link href="/" className={styles.back} aria-label="Back">
          <BackIcon />
        </Link>
        {/* Animated avatar renders in the open-chat header only (§5.4).
            v1.1: tappable — DM goes to the profile, groups open chat info. */}
        {peer ? (
          <Link href={`/u/${encodeURIComponent(peer.username)}`} aria-label={`${title} — open profile`} style={{ lineHeight: 0 }}>
            <Avatar avatar={headerAvatar} name={title} size={40} animated />
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            aria-label="Open chat info"
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', lineHeight: 0 }}
          >
            <Avatar avatar={headerAvatar} name={title} size={40} animated />
          </button>
        )}
        <div className={styles.headerText}>
          <h1>
            {peer ? (
              // DM header links to the peer's public profile page (/u/:username).
              // v0.8a §1.58: the chat header is a pinned animated-name site.
              <Link href={`/u/${encodeURIComponent(peer.username)}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <StyledName userId={peer.id} style={peer.name_style} name={title} />
              </Link>
            ) : (
              <>
                {supportConv ? '🛟 ' : ghost ? '👻 ' : ''}
                {title}
              </>
            )}
            {/* v0.8a §1.57: the peer's mood chip — already per-viewer resolved
                server-side (visibility ∩ blocks ∩ live expiry). */}
            {peer?.mood ? (
              <>
                {' '}
                <MoodChip mood={peer.mood} small />
              </>
            ) : null}
          </h1>
          <div className={`${styles.headerSub}${conv.type === 'dm' && presence?.online ? ` ${styles.online}` : ''}`}>
            {state.conn === 'error' ? 'connection error' : state.conn !== 'online' ? 'connecting…' : subline}
          </div>
        </div>
        {/* v0.6 (§1.42): calls exist for dm/group only — never channels.
            v0.8b (§1.68): nor 👻 ghost groups — masks never ring (the server
            refuses the create 400 call_bad_conversation). */}
        {conv.type !== 'channel' && conv.visibility !== 'ghost' ? (
          <CallHeaderButtons conv={conv} />
        ) : null}
        {conv.disappear_ttl_s !== null ? (
          <span className={exp.ttlChip} title={`Messages disappear after ${TTL_SHORT[conv.disappear_ttl_s] ?? ''}`}>
            ⏳ {TTL_SHORT[conv.disappear_ttl_s] ?? ''}
          </span>
        ) : null}
        {/* v0.7 (§1.54): the scheduled badge moved onto the COMPOSER — one
            badge, where the queue is managed. */}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Chat settings"
          onClick={() => setInfoOpen(true)}
        >
          <MoreIcon />
        </button>
      </header>

      {planBeacon && meId ? (
        /* Royal: the sparked-plan card — panel surface, accent hairline, and
           a pulsing bolt. Pure wrapper: PlanHeader's markup, roles and
           handlers are untouched (chat.module.css restyles around them). */
        <div className={styles.planCard}>
          <span className={styles.planBolt} aria-hidden>
            <BoltIcon />
          </span>
          <div className={styles.planCardBody}>
            <PlanHeader beacon={planBeacon} meId={meId} />
          </div>
        </div>
      ) : null}

      {/* v0.6 (§1.45): the provisional roulette window — countdown + KEEP. */}
      {conv.origin === 'roulette' ? <RouletteBanner conv={conv} /> : null}

      {/* §1.32: the stable pin board — tap cycles pins and jumps. */}
      <PinnedBar conv={conv} canPin={canPin} onJump={(seq) => void jumpToSeq(seq)} />

      {/* v0.8a §1.57: the passive 🍻 banner — a render of an already-visible
          chip, never a push, gone the moment the mood is. */}
      {meId ? <DrunkBanner conv={conv} meId={meId} nameFor={nameFor} /> : null}

      {/* v0.8b §1.68: the PERSISTENT member banner — public_since_seq's
          presence IS the flag; only messages after the switch render publicly. */}
      {isPubliclyReadable(conv) ? (
        <div className={cm.publicBanner} role="status">
          <span aria-hidden>🌐</span>
          <span>
            This group is public — new messages are readable by anyone on its share page.
            Everything from before the switch stays private.
          </span>
        </div>
      ) : null}

      {/* v0.8b §1.68: ghost groups say who YOU are in here — the explicit
          own-mask field (my own participant row serializes REAL, so the mask
          name never appears there). Chat settings holds the re-pick. */}
      {ghost && meId ? (
        <div className={cm.publicBanner} role="status">
          <span aria-hidden>👻</span>
          <span>
            Masks on — in here you&rsquo;re{' '}
            <strong>
              {conv.my_mask ? `${conv.my_mask.emoji} ${conv.my_mask.name}` : 'masked'}
            </strong>
            . Change your mask in chat settings. Admins can see real names for safety.
          </span>
        </div>
      ) : null}

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

      <div className={idm.bgWrap}>
      {/* §1.60: the media + scrim paint behind the scroll (my view only). */}
      {background ? <ChatBackground attachment={background} /> : null}
      {/* §1.58: the one allowed looping overlay — behind bubbles, low opacity. */}
      {rainActive ? <div className={idm.rain} aria-hidden /> : null}
      <div
        ref={scrollRef}
        className={scrollClass}
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
            ghost={ghost}
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
      </div>

      {/* v0.5b §1.40: ONE gentle review prompt after a listing DM wraps up. */}
      {meId && conv.type === 'dm' ? (
        <ListingReviewNudge conv={conv} messages={messages} meId={meId} />
      ) : null}

      {/* Typing is gateway-dropped in channels (§2.11) and suppressed
          entirely in ghost groups (§1.68 — an identity side channel).
          Royal: three blinking dots ride beside the names — CSS shows them
          only while the indicator div holds text (decorative, aria-hidden). */}
      {!isChannel && !ghost ? (
        <div className={styles.typingRow}>
          <TypingIndicator conversation={conv} />
          <span className={styles.typingDots} aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}

      {/* v0.8a §1.57: live 10 s undo pills on my drunk-mode sends — tap and
          the message vanishes (no "deleted" stub, no trace). */}
      {undoables.length > 0 ? (
        <UndoPillRow
          items={undoables}
          onUndo={(seq) => void undoSend(seq)}
          onPrune={() => setUndoables((prev) => prev.filter((u) => u.until > Date.now()))}
        />
      ) : null}

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
          scheduledCount={pendingScheduled.length}
          onOpenScheduled={() => setSchedOpen(true)}
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
      {locOpen ? (
        // v0.7 (§1.52): "📍 Join me here" — a one-tap SNAPSHOT drop; the
        // message is an ordinary §1.5 send with metadata.location + join_me.
        <LocationPickerSheet
          title="Join me here"
          withNote
          submitLabel="Drop the pin 📍"
          onClose={() => setLocOpen(false)}
          onPick={(loc, note) => {
            setLocOpen(false);
            void sendRaw({
              type: 'location',
              ...(note ? { body: note } : {}),
              metadata: { location: loc, join_me: true },
            });
          }}
        />
      ) : null}
      {drunkAsk ? (
        // §1.57 cold-contact "you sure?" — client-side, judgement-free; the
        // draft survives a "hold off".
        <DrunkConfirmSheet
          text={`You're in drunk mode, and you haven't talked ${peer ? `to ${title}` : 'in here'} in a while (or ever). Tonight-you is sure?`}
          confirmLabel="Send it 🍻"
          onConfirm={() => {
            drunkAsk.resolve(true);
            setDrunkAsk(null);
          }}
          onCancel={() => {
            drunkAsk.resolve(false);
            setDrunkAsk(null);
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

/** One undoable drunk-mode send (v0.8a §1.57). */
interface UndoableSend {
  seq: number;
  until: number;
  snippet: string;
}

/**
 * v0.8a §1.57: the undo pill row — its own component so the 1 s countdown
 * tick only runs while pills exist (ChatView itself stays on coarse clocks).
 */
function UndoPillRow({
  items,
  onUndo,
  onPrune,
}: {
  items: UndoableSend[];
  onUndo: (seq: number) => void;
  onPrune: () => void;
}) {
  const now = useNow(500);
  useEffect(() => {
    if (items.some((u) => u.until <= now)) onPrune();
  }, [items, now, onPrune]);
  const live = items.filter((u) => u.until > now);
  if (live.length === 0) return null;
  return (
    <div className={idm.undoRow}>
      {live.map((u) => (
        <button
          key={u.seq}
          type="button"
          className={idm.undoPill}
          aria-label={`Unsend the last message (${Math.max(0, Math.ceil((u.until - now) / 1000))} seconds left)`}
          onClick={() => onUndo(u.seq)}
        >
          <strong>↩ Undo</strong>
          <span>· {Math.max(0, Math.ceil((u.until - now) / 1000))}s</span>
        </button>
      ))}
    </div>
  );
}

// v0.6.1: the reaction picker + message menu render through Portal into
// <body>, FIXED at the bubble's rect. Mounted inline they were clipped by the
// chat scroll container's overflow and could extend past the bottom of the
// viewport — a long-press on a bottom message left "Forward"/"Pin" hitting
// the backdrop and "Message info" entirely off-screen. After paint the
// overlay measures both panels and keeps them inside the viewport: the menu
// flips above the picker when it would overflow the bottom edge, and the
// picker drops below the bubble when it would poke past the top.
function MessageActionsOverlay({
  anchorRef,
  own,
  children,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  own: boolean;
  children: ReactNode;
}) {
  // The bubble's rect, captured once at open. The modal backdrop blocks
  // scrolling underneath, so it cannot go stale while open.
  const [rect] = useState(() => {
    const el = anchorRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const roRef = useRef<ResizeObserver | null>(null);

  // Callback ref, NOT an effect: Portal mounts its children a frame after
  // this component's effects run (it waits for its own mount), so an effect
  // here would measure an empty box. The ref callback fires during the
  // commit that actually attaches the panels — before paint.
  const layoutBox = useCallback(
    (box: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (!box || !rect) return;
      const picker = box.querySelector<HTMLElement>('[data-overlay-part="picker"]');
      const menu = box.querySelector<HTMLElement>('[data-overlay-part="menu"]');

      const layout = () => {
        for (const el of [picker, menu]) {
          if (el) {
            el.style.top = '';
            el.style.bottom = '';
          }
        }
        const pr = picker?.getBoundingClientRect() ?? null;
        const mr = menu?.getBoundingClientRect() ?? null;
        const ph = pr?.height ?? 0;
        if (picker && pr && pr.top < 8) {
          // Bubble near the top: picker drops below the bubble, menu below it.
          picker.style.bottom = 'auto';
          picker.style.top = `${rect.height + 6}px`;
          if (menu) menu.style.top = `${rect.height + 12 + ph}px`;
        } else if (menu && mr && mr.bottom > window.innerHeight - 8) {
          // Bubble near the bottom: menu flips up, stacked above the picker.
          menu.style.top = 'auto';
          menu.style.bottom = `${rect.height + 12 + ph}px`;
        }
      };
      layout();
      // The picker grows when "more emoji" expands — re-run the flip math.
      if (typeof ResizeObserver !== 'undefined' && picker) {
        const ro = new ResizeObserver(layout);
        ro.observe(picker);
        roRef.current = ro;
      }
    },
    [rect]
  );

  if (!rect) return null;
  return (
    <Portal>
      <div
        ref={layoutBox}
        className={`${styles.msgOverlay}${own ? ` ${styles.own}` : ''}`}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        {children}
      </div>
    </Portal>
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
  ghost = false,
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
  /** v0.8b §1.68: ghost groups suppress the seen-by surface (identity side
   * channel) — the "Message info" item never renders there. */
  ghost?: boolean;
}) {
  const state = useAppState();
  const [picker, setPicker] = useState(false);
  const [info, setInfo] = useState(false);
  const [report, setReport] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // draft body
  const [editBusy, setEditBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Royal v2 swipe-to-reply: pointer-based horizontal drag; the visual slide
  // is transform-only (none under reduced motion — the gesture still works).
  const dragRef = useRef<{ id: number; x: number; y: number; armed: boolean } | null>(null);
  const [swipeX, setSwipeX] = useState(0);
  const bubbleWrapRef = useRef<HTMLDivElement | null>(null);
  const own = message.sender_id === meId;
  // v0.8a §1.58 mood-reactive bubbles: tap a drunk sender's crooked bubble to
  // straighten it; reduced motion kills every effect unconditionally.
  const [straightened, setStraightened] = useState(false);
  const reducedMotion = useReducedMotion();

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

  // v0.8a §1.57: an UNDONE drunk-mode send renders NOTHING AT ALL — no
  // "message deleted" stub, no row, no trace. The seq survives server-side
  // (golden rule 2); this client simply never paints it.
  if (deleted && message.metadata.undone) return null;

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

  // v0.8b §1.69: operator replies ride sender_id NULL + metadata.support —
  // they wear the Support BRAND, never a named admin.
  const supportMsg = message.sender_id === null && message.metadata.support !== undefined;
  const sender =
    !own && conv.type === 'group'
      ? message.sender_id === null
        ? supportMsg
          ? '🛟 Bored Chat Support'
          : message.type === 'poll'
            ? null // the auto venue poll speaks for itself
            : 'Unknown'
        : (() => {
            const p = conv.participants.find((x) => x.user.id === message.sender_id);
            return p ? nameFor(p.user.id, p.user.display_name) : 'Unknown';
          })()
      : null;

  // v0.8a: the sender's identity row (their UserPublic rides participants) —
  // drives the §1.58 animated sender name AND the mood-reactive effect.
  const senderUser = own
    ? state.me
    : conv.participants.find((x) => x.user.id === message.sender_id)?.user ?? null;
  // §1.58 mood-reactive bubbles: driven by the sender's mood ALREADY visible
  // to this viewer in the DTOs (per-viewer resolution happened server-side);
  // kinds preset/swing/drunk only (bubbleEffectFor), my mood_effects toggle
  // and reduced motion both kill it. Entry-only, except the drunk settle.
  const moodFx =
    state.settings?.mood_effects !== false && !reducedMotion
      ? bubbleEffectFor(senderUser?.mood ?? null)
      : null;
  const fxClass =
    moodFx === 'wobble'
      ? `${fresh ? ` ${idm.fxWobbleIn}` : ''}${!straightened ? ` ${own ? idm.fxCrookedOwn : idm.fxCrooked}` : ''}`
      : moodFx === 'bounce' && fresh
        ? ` ${idm.fxBounceIn}`
        : moodFx === 'rain' && fresh
          ? ` ${idm.fxFallIn}`
          : '';

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
      className={`${styles.bubble}${justOpened ? ` ${exp.capsuleOpened}` : ''}${fxClass}`}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
      // §1.58: the tipsy bubble settles ≤2° crooked — a tap straightens it.
      onClick={moodFx === 'wobble' && !straightened ? () => setStraightened(true) : undefined}
    >
      {sender ? (
        <div className={styles.sender}>
          {/* §1.58: group sender names are a pinned animated-name site.
              v1.1: the name links to the profile (everything clickable) —
              except in ghost groups, where identities are masks. */}
          {senderUser && message.sender_id && conv.visibility !== 'ghost' ? (
            <Link
              href={`/u/${encodeURIComponent(senderUser.username)}`}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              <StyledName userId={senderUser.id} style={senderUser.name_style} name={sender} />
            </Link>
          ) : senderUser && message.sender_id ? (
            <StyledName userId={senderUser.id} style={senderUser.name_style} name={sender} />
          ) : supportMsg ? (
            <span className={cm.supportBrandName}>{sender}</span>
          ) : (
            sender
          )}
        </div>
      ) : null}
      {message.metadata.forwarded_from ? (
        // §1.31: original-author snapshot — the forwarder stays the sender.
        <span className={soc.fwdTag}>↪ forwarded from {message.metadata.forwarded_from.display_name}</span>
      ) : null}
      {message.reply_context ? (
        // §1.29: server-resolved context — tap jumps to the original.
        // Royal v2: a 2px left bar inside the bubble (white; ink on outgoing).
        <button
          type="button"
          className={styles.replyQuote}
          onClick={() => onJump(message.reply_context!.seq)}
          aria-label="See the message this replies to"
        >
          <span className={styles.replyQuoteAuthor}>
            {message.reply_context.author
              ? nameFor(message.reply_context.author.id, message.reply_context.author.display_name)
              : 'System'}
          </span>
          <span className={`${styles.replyQuoteExcerpt}${message.reply_context.deleted ? ` ${styles.replyQuoteDeleted}` : ''}`}>
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
      {message.attachments.map((att) =>
        att.kind === 'audio' ? (
          // Royal v2 voice note: 30px play orb + 3px bars + duration right —
          // a pure .voiceWrap restyle around AudioBubble's untouched markup.
          <span key={att.id} className={styles.voiceWrap}>
            <AttachmentView attachment={att} doodle={false} />
          </span>
        ) : (
          <AttachmentView key={att.id} attachment={att} doodle={message.metadata.doodle === true} />
        )
      )}
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
      ) : message.type === 'location' && message.metadata.location ? (
        <LocationDrop message={message} conv={conv} meId={meId} own={own} nameFor={nameFor} />
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
      // §1.29 swipe-to-reply, Royal v2: pointer-based. A clean horizontal
      // right-drag >48px sets the reply draft on release; the bubble slides
      // and a reply glyph fades in while dragging. Mouse pointers are left
      // alone (text selection); vertical pans stay native (touch-action).
      onPointerDown={(e) => {
        if (!onReply || e.pointerType === 'mouse') return;
        dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, armed: false };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.id || !onReply) return;
        const dx = e.clientX - d.x;
        const dy = Math.abs(e.clientY - d.y);
        if (!d.armed) {
          if (dx > 12 && dx > dy * 1.4) {
            d.armed = true;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* capture is best-effort */
            }
          } else if (dy > 14) {
            dragRef.current = null; // vertical scroll wins
            return;
          } else {
            return;
          }
        }
        setSwipeX(Math.max(0, Math.min(dx, SWIPE_MAX_PX)));
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d?.armed && onReply && e.clientX - d.x > SWIPE_REPLY_PX) onReply(message);
        setSwipeX(0);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setSwipeX(0);
      }}
    >
      {onReply && swipeX > 0 ? (
        <span
          className={styles.swipeGlyph}
          style={{ opacity: Math.min(1, swipeX / SWIPE_REPLY_PX) }}
          aria-hidden
        >
          <ReplyGlyphIcon />
        </span>
      ) : null}
      <div
        className={`${styles.msgCol}${swipeX > 0 ? ` ${styles.msgColDrag}` : ''}`}
        style={!reducedMotion && swipeX > 0 ? { transform: `translateX(${swipeX}px)` } : undefined}
      >
        <div ref={bubbleWrapRef} className={`${styles.bubbleWrap}${flash ? ` ${soc.flash}` : ''}`}>
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
            <MessageActionsOverlay anchorRef={bubbleWrapRef} own={own}>
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
              <div className={styles.msgMenu} role="menu" aria-label="Message actions" data-overlay-part="menu">
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
                {own && !isChannel && !ghost ? (
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
            </MessageActionsOverlay>
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
 * v0.7 §1.52: the location-drop bubble. The place renders as LINKS out to the
 * user's own map app/site (geo:/OSM/Google — lib/locations) — never a tile
 * embed, never an API key. A join_me drop carries the "On my way 🏃" quick
 * action: an ORDINARY text reply (reply_to_seq = the drop's seq, body =
 * ON_MY_WAY_BODY) — zero new machinery; the headcount strip below is FACES of
 * participants whose on-my-way reply references this drop, derived from the
 * local history (missing pages are one history fetch away, never a counter).
 */
function LocationDrop({
  message,
  conv,
  meId,
  own,
  nameFor,
}: {
  message: Message;
  conv: ConversationListItem;
  meId: string;
  own: boolean;
  nameFor: (userId: string, fallback: string) => string;
}) {
  const state = useAppState();
  const [busy, setBusy] = useState(false);
  const location = message.metadata.location!;
  const joinMe = message.metadata.join_me === true;

  // Client-derived headcount: dedup by sender, participants only (faces).
  const omw: UserLite[] = [];
  if (joinMe) {
    const seen = new Set<string>();
    const list = state.messages.get(message.conversation_id) ?? [];
    for (const m of list) {
      if (
        m.reply_to_seq === message.seq &&
        m.deleted_at === null &&
        m.body === ON_MY_WAY_BODY &&
        m.sender_id !== null &&
        !seen.has(m.sender_id)
      ) {
        const p = conv.participants.find((x) => x.user.id === m.sender_id);
        if (p) {
          seen.add(m.sender_id);
          omw.push({
            id: p.user.id,
            username: p.user.username,
            display_name: p.user.display_name,
            avatar: p.user.avatar,
            mood: p.user.mood,
            name_style: p.user.name_style,
            mask_emoji: null,
          });
        }
      }
    }
  }
  const mineOmw = omw.some((u) => u.id === meId);

  async function onMyWay(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await sendMessage(message.conversation_id, {
        client_msg_id: uuidv7(),
        type: 'text',
        body: ON_MY_WAY_BODY,
        reply_to_seq: message.seq,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={soc.locDrop}>
      <span className={soc.locDropHead}>
        <span aria-hidden>📍</span>
        <span>{joinMe ? 'Join me here' : location.label}</span>
      </span>
      {/* Fixer r1: the place label shows on the SENDER's own card too — they
          need to confirm which place they just dropped. */}
      {joinMe ? <span>{location.label}</span> : null}
      {message.body ? <span>{message.body}</span> : null}
      <MapLinksRow location={location} />
      {joinMe ? (
        <>
          {!own && !mineOmw ? (
            <button
              type="button"
              className={soc.onMyWayBtn}
              disabled={busy}
              onClick={() => void onMyWay()}
            >
              {busy ? 'Sending…' : ON_MY_WAY_BODY}
            </button>
          ) : null}
          {omw.length > 0 ? (
            <span
              className={soc.onMyWayRow}
              aria-label={`On their way: ${omw.map((u) => nameFor(u.id, u.display_name)).join(', ')}`}
            >
              <span className={soc.onMyWayFaces} aria-hidden>
                {omw.map((u) => (
                  <Avatar key={u.id} avatar={u.avatar} name={nameFor(u.id, u.display_name)} size={20} />
                ))}
              </span>
              <span aria-hidden>on their way 🏃</span>
            </span>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/**
 * §1.33 mention highlighting — keyed STRICTLY on metadata.mentions (the server
 * is the only writer; the client never re-parses). Mentioned ids resolve to
 * usernames via the participants the client holds; tokens that cannot resolve
 * (e.g. channel members outside the shipped owner/admin slice) stay plain.
 */
/** v1.1 fix: URLs in message bodies are real links (new tab, no referrer).
 * Mentions still win — this only runs over the non-mention text parts. */
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function LinkifiedText({ text }: { text: string }) {
  if (!text.includes('http')) return <span>{text}</span>;
  const parts = text.split(URL_RE);
  return (
    <span>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className={styles.bodyLink}
            onClick={(e) => e.stopPropagation()}
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

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
  if (!ids || ids.length === 0) return <LinkifiedText text={body} />;
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
  if (byUsername.size === 0) return <LinkifiedText text={body} />;
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
          <span key={`${i}-t`}>
            <LinkifiedText text={part} />
          </span>
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

/* Royal: the plan card's bolt glyph (decorative). */
function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M11.2 1.8 L4.2 11.4 H9 L8.2 18.2 L15.6 8.4 H10.4 Z" fill="currentColor" />
    </svg>
  );
}

/* Royal v2 header system: everything beyond call/video sits behind one "···". */
function MoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5.5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}

/* The swipe-to-reply glyph (decorative). */
function ReplyGlyphIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 7 L5 11.5 L10 16 M5.5 11.5 H14 a5 5 0 0 1 5 5 V18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
