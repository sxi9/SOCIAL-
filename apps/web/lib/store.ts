// In-memory app state, fed by REST sync + WS events. Watermarks are monotonic
// maxima and messages apply idempotently by (conversation_id, seq), so events
// may arrive duplicated or out of order without harm (API.md §2.5).
import { MESSAGE_REACTORS_PREVIEW_MAX, TOAST_MAX_VISIBLE } from '@socialchat/shared';
import type {
  AnonMessage,
  AnonThread,
  Attachment,
  Beacon,
  BeaconRole,
  Call,
  CallConnState,
  CallKind,
  Connection,
  Conversation,
  ConversationListItem,
  ConversationPrefs,
  DiscoveryCard,
  DiscoveryOptin,
  EncouragementResponse,
  ExpectationContext,
  FeedLane,
  KudosKind,
  LinkPreview,
  ListConnectionsResponse,
  ListStoriesResponse,
  Message,
  Mood,
  MoodState,
  Poll,
  Post,
  ReleasesResponse,
  ScheduledMessage,
  Story,
  StoryAuthorGroup,
  SyncResponse,
  UserLite,
  UserPrivate,
  UserPublic,
  UserSettings,
} from '@socialchat/shared';
import type { OutboxItem } from './db';

// 'error' = the client stopped reconnecting (repeated close 1008, §2.10);
// the UI surfaces it and offers an explicit retry.
export type ConnState = 'connecting' | 'online' | 'offline' | 'error';

export interface PresenceInfo {
  online: boolean;
  last_seen_at: string | null;
}

export interface PreviewState {
  status: 'pending' | 'ok' | 'failed';
  preview: LinkPreview | null;
}

/** A private beacon.kudos arrival (v0.3 §1.15) — recipient-only, session-scoped. */
export interface KudosArrival {
  beacon_id: string;
  kind: KudosKind;
  from: UserLite;
}

// ---------------------------------------------------------------------------
// v0.6 call state (API.md §1.42 + §2.12). MediaStreams and RTCPeerConnections
// are NOT serializable store state — they live in lib/webrtc.ts; the store
// holds only what the UI renders, and `media_version` bumps whenever a stream
// appears/changes so components re-read them via the webrtc getters.
// ---------------------------------------------------------------------------

/** An incoming ring — the gateway-enriched call.invite frame (§2.12). */
export interface IncomingCall {
  call_id: string;
  conversation_id: string;
  kind: CallKind;
  from_user: string;
}

export type CallPhase = 'ringing' | 'connecting' | 'ongoing' | 'ended';

export interface CallUi {
  call_id: string;
  conversation_id: string;
  kind: CallKind;
  is_group: boolean;
  /** I started this call (outgoing ring) vs joined/accepted it. */
  outgoing: boolean;
  phase: CallPhase;
  /** Durable answer time from the call row — the duration timer's anchor. */
  answered_at: string | null;
  mic_on: boolean;
  cam_on: boolean;
  facing: 'user' | 'environment';
  /** Remote peers with a live tile (mesh ≤ CALL_MESH_MAX−1). */
  peer_ids: string[];
  /** Peers currently mid-reconnect (tile shows "reconnecting…"). */
  reconnecting_ids: string[];
  /** Bumped when any MediaStream changes; tiles re-grab via lib/webrtc. */
  media_version: number;
  /** A callee device confirmed it is ringing (caller copy flips). */
  ringing_heard: boolean;
  /** In-call UI minimized to the floating pill (app stays usable). */
  minimized: boolean;
  error: string | null;
  /** Set when phase === 'ended' — drives the end-card copy. */
  ended_reason: string | null;
  // ---- v0.7.1 (§1.55, FEATURES #89/#90) ----
  /** MY aggregate connectivity (connecting → connected → reconnecting →
   * failed). Derived in lib/webrtc.ts; each transition also rides out as the
   * relayed `call.state` frame (one frame per transition, §2.12). */
  conn_state: CallConnState;
  /** WHY the call failed — verdict copy keyed on what is known (no relay
   * configured / relay unreachable from here / peer gone). Never a bare
   * "call failed" (§1.55 binding contract). */
  conn_reason: string | null;
  /** Peers' self-reported states (relayed call.state frames) — their tiles
   * say the truth too ("reconnecting…"). Advisory UI truth only. */
  peer_states: Record<string, CallConnState>;
  /** TURN honesty (FEATURES #90): false = this instance has no relay
   * (POST …/calls returned turn: null, or the cached §1.55 GET said so) —
   * the caller sees the inline warning instead of a silent failure.
   * null = not known yet. */
  relay_available: boolean | null;
  /** The §1.56 "you won't be rung when the app is closed" note was dismissed
   * for this call (dismissible context, never a gate). */
  push_note_dismissed: boolean;
}

/** v0.6 (§1.43): the live watch-together session for a conversation —
 * whatever the last relayed start/sync frame said, plus when we heard it
 * (sessions go stale after WATCH_SESSION_TTL_S without a sync). */
export interface WatchSession {
  conversation_id: string;
  video_id: string;
  host: string;
  position_s: number;
  playing: boolean;
  received_at: number;
}

/** v0.6 (§1.45): a pending PRIVATE expectation-feedback prompt. Shown exactly
 * once per match (lib/discovery.ts guards with localStorage), skippable. */
export interface FeedbackAsk {
  context: ExpectationContext;
  conversation_id: string;
}

/** v0.7 (§1.49): one finite feed window per lane. */
export interface FeedLaneState {
  posts: Post[] | null;
  cursor: string | null;
  /** true once the hard "all caught up" end was reached — the client STOPS. */
  caughtUp: boolean;
}

/** v0.7 (§1.54): a transient toast ("Scheduled for today 18:30"). */
export interface ToastItem {
  id: number;
  text: string;
}

const emptyLane = (): FeedLaneState => ({ posts: null, cursor: null, caughtUp: false });

export interface AppState {
  booted: boolean;
  authed: boolean | null;
  conn: ConnState;
  me: UserPrivate | null;
  conversations: Map<string, ConversationListItem>;
  /** Loaded message windows per conversation, ascending by seq. */
  messages: Map<string, Message[]>;
  caughtUp: Set<string>;
  presence: Map<string, PresenceInfo>;
  /** conversation_id -> user_id -> typing expiry (epoch ms). */
  typing: Map<string, Map<string, number>>;
  previews: Map<string, PreviewState>;
  /** attachment.ready arrivals keyed by attachment id (composer still open). */
  readyAttachments: Map<string, Attachment>;
  outbox: OutboxItem[];
  activeConversationId: string | null;
  /** v0.3 beacons (§1.15): only cards the viewer may see/join (FoMO-safe). */
  beacons: Map<string, Beacon>;
  beaconsLoaded: boolean;
  /** Boredom radar — aggregate count only, never names (FEATURES #26). */
  radarCount: number | null;
  /** beacon_id → one-shot "needs 1 more" re-ping marker (epoch ms). */
  repings: Map<string, number>;
  /** v0.3 plan roles (§1.16), beacon_id → full list (plan.updated replaces). */
  planRoles: Map<string, BeaconRole[]>;
  /** Private kudos received this session (recipient-only; never public). */
  kudos: KudosArrival[];
  /** v0.3 privacy settings mirror (§1.13) — server-enforced, client-displayed. */
  settings: UserSettings | null;
  /** v0.4 (§1.24): MY per-conversation prefs (theme/wallpaper/nicknames) —
   * personal, never anyone else's; synced via prefs.updated (own sockets). */
  prefs: Map<string, ConversationPrefs>;
  /** v0.4 (§1.26): MY scheduled messages by id (private until delivery). */
  scheduled: Map<string, ScheduledMessage>;
  scheduledLoaded: boolean;
  /** v0.5a (§1.28): my connections mirror (accepted / incoming / outgoing). */
  connections: ListConnectionsResponse | null;
  /** v0.5a (§1.34): the story tray — mine + friends-of groups. */
  stories: ListStoriesResponse | null;
  /** v0.5a (§1.36) + v0.7 lanes (§1.49): one FINITE window per lane
   * (null posts = that lane not loaded yet). Both lanes stay hard-ended. */
  feed: Record<FeedLane, FeedLaneState>;
  /** §1b deep link (/feed/<id>): a post opened by id that no loaded lane
   * holds. Lives in the store (not a component snapshot) so reactions,
   * votes, comments and delete flow into the open sheet exactly as they do
   * for lane posts — replacePost / removePostLocal update it too. */
  feedExtra: Map<string, Post>;
  /** v0.7 (§1.54): transient toasts (ToastHost renders them at the toast layer). */
  toasts: ToastItem[];
  /** v0.7 (§1.47): recent creator edits by beacon id — powers the brief
   * "plan updated" note on cards (the reping marker pattern). */
  beaconEdits: Map<string, { at: number; changed: string[] }>;
  // ---- v0.6 (§1.42–§1.46) ----
  /** Incoming ring (call.invite) — rendered anywhere via GlobalOverlays. */
  callInvite: IncomingCall | null;
  /** The ONE call I am in (UI state; media lives in lib/webrtc.ts). */
  callUi: CallUi | null;
  /** Live (ringing/ongoing) calls by conversation — powers "Join call". */
  liveCalls: Map<string, Call>;
  /** Live watch-together sessions by conversation (§1.43, ephemeral). */
  watch: Map<string, WatchSession>;
  /** My own discovery opt-in (null = not discoverable / lapsed). */
  discoveryOptin: DiscoveryOptin | null;
  discoveryLoaded: boolean;
  /** The current card pool (null = not fetched; gated on my live opt-in). */
  discoveryCards: DiscoveryCard[] | null;
  /** The §1.44 encouragement aggregate — shown PRE-opt-in only (binding). */
  encouragement: EncouragementResponse | null;
  /** Mutual-wave celebration (discovery.matched) — viewer-stamped OTHER. */
  discoveryMatch: { conversation_id: string; user: UserLite } | null;
  /** I am in the roulette queue (optimistic; roulette.matched clears it). */
  rouletteQueued: boolean;
  /** A fresh roulette match to navigate to (GlobalOverlays routes + clears). */
  rouletteMatchNav: string | null;
  /** roulette.expired landed for this conversation — goodbye screen. */
  rouletteGoodbye: string | null;
  /** Pending one-tap expectation-feedback sheet (§1.45 prompt rule). */
  feedbackAsk: FeedbackAsk | null;
  // ---- v0.8a (§1.57/§1.61) ----
  /** MY full mood state (owner-only payload: visibility/expires_at/swing_set).
   * Others' moods ride their UserLite/UserPublic, never here. */
  moodState: MoodState | null;
  /** §1.61 releases + my last-seen marker (null = not fetched yet). */
  releases: ReleasesResponse | null;
  // ---- v0.8b (§1.62/§1.63/§1.66) ----
  /** My anonymous reveal-game threads (§1.62), newest activity first;
   * null = not fetched. Viewer-stamped DTOs — counterpart is null for the
   * recipient until reveal. */
  anonThreads: AnonThread[] | null;
  /** Loaded message windows per anon thread, created_at ASC. */
  anonMessages: Map<string, AnonMessage[]>;
  /** §1.63: when the in-app wave nudge last landed (epoch ms; null = none).
   * Deliberately carries NOTHING else — no identity, no count. */
  discoveryNudgeAt: number | null;
}

const state: AppState = {
  booted: false,
  authed: null,
  conn: 'offline',
  me: null,
  conversations: new Map(),
  messages: new Map(),
  caughtUp: new Set(),
  presence: new Map(),
  typing: new Map(),
  previews: new Map(),
  readyAttachments: new Map(),
  outbox: [],
  activeConversationId: null,
  beacons: new Map(),
  beaconsLoaded: false,
  radarCount: null,
  repings: new Map(),
  planRoles: new Map(),
  kudos: [],
  settings: null,
  prefs: new Map(),
  scheduled: new Map(),
  scheduledLoaded: false,
  connections: null,
  stories: null,
  feed: { friends: emptyLane(), discover: emptyLane() },
  feedExtra: new Map(),
  toasts: [],
  beaconEdits: new Map(),
  callInvite: null,
  callUi: null,
  liveCalls: new Map(),
  watch: new Map(),
  discoveryOptin: null,
  discoveryLoaded: false,
  discoveryCards: null,
  encouragement: null,
  discoveryMatch: null,
  rouletteQueued: false,
  rouletteMatchNav: null,
  rouletteGoodbye: null,
  feedbackAsk: null,
  moodState: null,
  releases: null,
  anonThreads: null,
  anonMessages: new Map(),
  discoveryNudgeAt: null,
};

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getVersion(): number {
  return version;
}

export { state };

// ---------------------------------------------------------------------------

function recomputeUnread(conv: ConversationListItem): void {
  const meId = state.me?.id;
  if (!meId) return;
  const p = conv.participants.find((x) => x.user.id === meId);
  if (p) conv.unread_count = Math.max(0, conv.last_seq - p.last_read_seq);
}

export function setConn(conn: ConnState): void {
  if (state.conn === conn) return;
  state.conn = conn;
  emit();
}

export function setAuthed(authed: boolean): void {
  state.authed = authed;
  if (!authed) {
    state.me = null;
    state.booted = true;
  }
  emit();
}

export function setMe(me: UserPrivate): void {
  state.me = me;
  state.authed = true;
  emit();
}

export function setBooted(): void {
  state.booted = true;
  emit();
}

export function setActiveConversation(id: string | null): void {
  state.activeConversationId = id;
  emit();
}

export function applySyncSnapshot(snap: SyncResponse): void {
  state.me = snap.me;
  state.authed = true;
  const next = new Map<string, ConversationListItem>();
  for (const conv of snap.conversations) {
    recomputeUnread(conv);
    next.set(conv.id, conv);
  }
  state.conversations = next;
  // Conversations missing from the snapshot were left/deleted (API.md §2.8).
  for (const id of [...state.messages.keys()]) if (!next.has(id)) state.messages.delete(id);
  for (const id of [...state.caughtUp]) if (!next.has(id)) state.caughtUp.delete(id);
  state.booted = true;
  emit();
}

export function upsertConversation(conv: Conversation | ConversationListItem): void {
  const existing = state.conversations.get(conv.id);
  const item: ConversationListItem = {
    ...conv,
    unread_count: 'unread_count' in conv ? conv.unread_count : existing?.unread_count ?? 0,
    last_message: 'last_message' in conv ? conv.last_message : existing?.last_message ?? null,
  };
  recomputeUnread(item);
  state.conversations.set(conv.id, item);
  emit();
}

export function markCaughtUp(conversationId: string): void {
  state.caughtUp.add(conversationId);
  emit();
}

/** Phase 2 (§1.68): a `group.join_request` frame — the admin's queue grew or
 * shrank. Only an admin of an invite_only group ever holds a number here. */
export function applyJoinRequest(conversationId: string, removed: boolean): void {
  const item = state.conversations.get(conversationId);
  if (!item || item.pending_requests === null) return;
  state.conversations.set(conversationId, {
    ...item,
    pending_requests: Math.max(0, item.pending_requests + (removed ? -1 : 1)),
  });
  emit();
}

/** Drop a conversation locally (own removal/leave — §2.8: gone from sync). */
export function removeConversation(conversationId: string): void {
  const existed = state.conversations.delete(conversationId);
  state.messages.delete(conversationId);
  state.caughtUp.delete(conversationId);
  if (existed) emit();
}

function insertBySeq(list: Message[], message: Message): Message[] {
  const idx = list.findIndex((m) => m.seq >= message.seq);
  if (idx === -1) return [...list, message];
  if (list[idx].seq === message.seq) {
    const copy = [...list];
    copy[idx] = message;
    return copy;
  }
  return [...list.slice(0, idx), message, ...list.slice(idx)];
}

export function ensureMessagesEntry(conversationId: string): void {
  if (!state.messages.has(conversationId)) {
    state.messages.set(conversationId, []);
    emit();
  }
}

export function addMessages(conversationId: string, messages: Message[]): void {
  let list = state.messages.get(conversationId) ?? [];
  for (const m of messages) list = insertBySeq(list, m);
  state.messages.set(conversationId, list);
  emit();
}

export function applyMessage(message: Message): void {
  const convId = message.conversation_id;
  const list = state.messages.get(convId);
  if (list) state.messages.set(convId, insertBySeq(list, message));
  const conv = state.conversations.get(convId);
  if (conv) {
    if (message.seq > conv.last_seq) conv.last_seq = message.seq;
    if (!conv.last_message || message.seq >= conv.last_message.seq) {
      conv.last_message = message;
      conv.last_message_at = message.created_at;
    }
    // The send transaction raises the sender's own watermarks server-side.
    if (state.me && message.sender_id === state.me.id) {
      const mine = conv.participants.find((p) => p.user.id === state.me?.id);
      if (mine) {
        mine.last_delivered_seq = Math.max(mine.last_delivered_seq, message.seq);
        mine.last_read_seq = Math.max(mine.last_read_seq, message.seq);
      }
    }
    recomputeUnread(conv);
    if (message.sender_id) {
      const t = state.typing.get(convId);
      if (t) t.delete(message.sender_id);
    }
  }
  emit();
}

/** msg.updated: full fresh DTO, replace by (conversation_id, seq). */
export function replaceMessage(message: Message): void {
  const convId = message.conversation_id;
  const list = state.messages.get(convId);
  if (list) {
    const idx = list.findIndex((m) => m.seq === message.seq);
    if (idx !== -1) {
      const copy = [...list];
      copy[idx] = message;
      state.messages.set(convId, copy);
    }
  }
  const conv = state.conversations.get(convId);
  if (conv && conv.last_message && conv.last_message.seq === message.seq) {
    conv.last_message = message;
  }
  emit();
}

export function applyReceipt(d: {
  conversation_id: string;
  user_id: string;
  last_delivered_seq: number;
  last_read_seq: number;
}): void {
  const conv = state.conversations.get(d.conversation_id);
  if (!conv) return;
  const p = conv.participants.find((x) => x.user.id === d.user_id);
  if (!p) return;
  p.last_delivered_seq = Math.max(p.last_delivered_seq, d.last_delivered_seq);
  p.last_read_seq = Math.max(p.last_read_seq, d.last_read_seq);
  if (state.me && d.user_id === state.me.id) recomputeUnread(conv);
  emit();
}

/** Optimistic local read watermark (the `read` frame rides behind, coalesced). */
export function markReadLocal(conversationId: string, seq: number): void {
  const conv = state.conversations.get(conversationId);
  const meId = state.me?.id;
  if (!conv || !meId) return;
  const p = conv.participants.find((x) => x.user.id === meId);
  if (!p) return;
  p.last_read_seq = Math.max(p.last_read_seq, seq);
  p.last_delivered_seq = Math.max(p.last_delivered_seq, seq);
  recomputeUnread(conv);
  emit();
}

// ---------------------------------------------------------------------------
// Reactions (v0.2 — API.md §1.12). Deltas patch the aggregate in place; the
// reconnect truth is the DTO's reactions[] (sync/history refetch), never
// frame replay, so a missed frame heals on the next page load.
// ---------------------------------------------------------------------------

function patchMessageAt(conversationId: string, seq: number, patch: (msg: Message) => Message): boolean {
  const list = state.messages.get(conversationId);
  if (!list) return false;
  const idx = list.findIndex((m) => m.seq === seq);
  if (idx === -1) return false;
  const copy = [...list];
  copy[idx] = patch(copy[idx]);
  state.messages.set(conversationId, copy);
  const conv = state.conversations.get(conversationId);
  if (conv && conv.last_message && conv.last_message.seq === seq) {
    conv.last_message = copy[idx];
  }
  return true;
}

interface ReactionDelta {
  conversation_id: string;
  seq: number;
  emoji: string;
  user_id: string;
  removed: boolean;
  /** The actor's face, shipped on the frame (masked inside ghost groups) —
   * channel members are NOT in conv.participants, so a local lookup alone
   * cannot resolve every reactor. Optional only for the local optimistic
   * path, which resolves state.me. */
  user?: UserLite;
}

/** One-actor delta (§2.3): add/remove the reactor's FACE on the chip — the
 * patchStamps pattern (Audit P0 / PSYCHOLOGY rule 3: faces, never a count).
 * An emptied chip drops; a chip at the preview cap flips has_more instead of
 * growing. Duplicate frames are no-ops. Reconnect truth is the DTO aggregate. */
function patchReactions(msg: Message, d: ReactionDelta, isMe: boolean): Message {
  const reactions = [...msg.reactions];
  const i = reactions.findIndex((r) => r.emoji === d.emoji);
  if (d.removed) {
    if (i === -1) return msg;
    const chip = reactions[i];
    const reactors = (chip.reactors ?? []).filter((u) => u.id !== d.user_id);
    const mine = isMe ? false : chip.mine;
    // Drop only when nothing can be hiding: a has_more chip may hold people
    // whose faces this client never had (a legacy IDB row normalized to
    // {reactors: [], has_more: true}, or a reactor past the cap) — dropping it
    // would hide live reactions until the next refetch. The "+" ghost that a
    // withdrawn unresolved reactor can leave is the cheaper staleness and the
    // next DTO clears it.
    if (reactors.length === 0 && !chip.has_more) reactions.splice(i, 1);
    else reactions[i] = { ...chip, reactors, mine };
    return { ...msg, reactions };
  }
  const user = d.user ?? userLiteFor(d.conversation_id, d.user_id);
  if (i === -1) {
    // Chips are ordered by first reaction (min created_at per emoji), so a
    // brand-new chip appends — matching the server's DTO ordering. A face we
    // cannot resolve locally still shows as "someone" via has_more.
    reactions.push({ emoji: d.emoji, reactors: user ? [user] : [], has_more: !user, mine: isMe });
    return { ...msg, reactions };
  }
  const chip = reactions[i];
  const current = chip.reactors ?? [];
  const mine = isMe ? true : chip.mine;
  if (current.some((u) => u.id === d.user_id)) {
    reactions[i] = { ...chip, mine }; // duplicate frame: keep first-reaction order
  } else if (user && (isMe || current.length < MESSAGE_REACTORS_PREVIEW_MAX)) {
    // My own face is ALWAYS added (even one past the cap): the optimistic
    // path and its rollback then stay a clean add/remove of exactly my face,
    // and a failed add can never leave a phantom has_more behind. Only
    // other people's frames flip has_more at the cap.
    reactions[i] = { ...chip, reactors: [...current, user], mine };
  } else {
    reactions[i] = { ...chip, has_more: true, mine };
  }
  return { ...msg, reactions };
}

/** reaction.updated frame: add/remove one face; the DTO is reconnect truth. */
export function applyReactionUpdated(d: ReactionDelta): void {
  const isMe = state.me?.id === d.user_id;
  const changed = patchMessageAt(d.conversation_id, d.seq, (msg) => patchReactions(msg, d, isMe));
  if (changed) {
    emit();
    return;
  }
  // No loaded message window for this conversation — still patch the list
  // item's last_message when the frame targets it, so the frame isn't dropped
  // outright and connection.ts can persist the patched DTO (§1.12).
  const conv = state.conversations.get(d.conversation_id);
  if (conv && conv.last_message && conv.last_message.seq === d.seq) {
    conv.last_message = patchReactions(conv.last_message, d, isMe);
    emit();
  }
}

/** Optimistic local toggle (lib/reactions.ts): my own face on/off, through the
 * same delta patch the WS frame uses — so the confirming frame is a no-op. */
export function applyReactionLocal(conversationId: string, seq: number, emoji: string, add: boolean): void {
  const me = state.me;
  if (!me) return;
  const changed = patchMessageAt(conversationId, seq, (msg) =>
    patchReactions(
      msg,
      { conversation_id: conversationId, seq, emoji, user_id: me.id, removed: !add },
      true,
    ),
  );
  if (changed) emit();
}

// ---------------------------------------------------------------------------
// Avatar stamps (v0.4 — API.md §1.19). A stamp frame is a reaction.updated with
// kind='stamp'; Message.stamps carries the stampers as FACES in first-stamp
// order (never a counter). Reconnect truth is the DTO's stamps[], not frames.
// ---------------------------------------------------------------------------

function userLiteFor(conversationId: string, userId: string): UserLite | null {
  if (state.me && state.me.id === userId) {
    const { id, username, display_name, avatar, mood, name_style } = state.me;
    return { id, username, display_name, avatar, mood, name_style, mask_emoji: null };
  }
  const conv = state.conversations.get(conversationId);
  const p = conv?.participants.find((x) => x.user.id === userId);
  if (!p) return null;
  const { id, username, display_name, avatar, mood, name_style } = p.user;
  return { id, username, display_name, avatar, mood, name_style, mask_emoji: null };
}

function patchStamps(msg: Message, userId: string, user: UserLite | null, removed: boolean): Message {
  const had = msg.stamps.some((u) => u.id === userId);
  if (removed) {
    if (!had) return msg;
    return { ...msg, stamps: msg.stamps.filter((u) => u.id !== userId) };
  }
  if (had) return msg; // keep first-stamp order on duplicate frames
  if (!user) return msg;
  return { ...msg, stamps: [...msg.stamps, user] };
}

/** reaction.updated with kind='stamp' (§2.3): add/remove the stamper's face. */
export function applyStampUpdated(d: {
  conversation_id: string;
  seq: number;
  user_id: string;
  removed: boolean;
  user?: UserLite;
}): void {
  // The frame now carries the stamper's face (masked in ghost groups), so
  // channel members — absent from conv.participants — resolve too.
  const user = d.user ?? userLiteFor(d.conversation_id, d.user_id);
  const patch = (msg: Message): Message => patchStamps(msg, d.user_id, user, d.removed);
  const changed = patchMessageAt(d.conversation_id, d.seq, patch);
  if (changed) {
    emit();
    return;
  }
  const conv = state.conversations.get(d.conversation_id);
  if (conv && conv.last_message && conv.last_message.seq === d.seq) {
    conv.last_message = patch(conv.last_message);
    emit();
  }
}

/** Optimistic local stamp toggle; the WS frame (and DTO on reconnect) confirm. */
export function applyStampLocal(conversationId: string, seq: number, add: boolean): void {
  const meId = state.me?.id;
  if (!meId) return;
  applyStampUpdated({ conversation_id: conversationId, seq, user_id: meId, removed: !add });
}

export function applyTyping(conversationId: string, userId: string, expiresAtIso: string): void {
  if (state.me && userId === state.me.id) return;
  let t = state.typing.get(conversationId);
  if (!t) {
    t = new Map();
    state.typing.set(conversationId, t);
  }
  t.set(userId, new Date(expiresAtIso).getTime());
  emit();
}

export function sweepTyping(): void {
  const now = Date.now();
  let changed = false;
  for (const t of state.typing.values()) {
    for (const [userId, exp] of t) {
      if (exp <= now) {
        t.delete(userId);
        changed = true;
      }
    }
  }
  if (changed) emit();
}

export function applyPresence(d: { user_id: string; online: boolean; last_seen_at?: string }): void {
  state.presence.set(d.user_id, { online: d.online, last_seen_at: d.last_seen_at ?? null });
  emit();
}

export function applyUserUpdated(user: UserPublic): void {
  if (state.me && user.id === state.me.id) {
    state.me = { ...state.me, ...user };
  }
  for (const conv of state.conversations.values()) {
    for (const p of conv.participants) {
      if (p.user.id === user.id) p.user = user;
    }
  }
  emit();
}

export function setPreview(urlHash: string, preview: PreviewState): void {
  // Replaced, not mutated: effects depend on the Map's identity.
  state.previews = new Map(state.previews).set(urlHash, preview);
  emit();
}

export function attachmentReady(attachment: Attachment): void {
  state.readyAttachments = new Map(state.readyAttachments).set(attachment.id, attachment);
  emit();
}

export function setOutbox(items: OutboxItem[]): void {
  state.outbox = items;
  emit();
}

// ---------------------------------------------------------------------------
// Beacons (v0.3 — API.md §1.15). The map holds only cards the viewer can still
// see: `open` ones, plus `sparked` ones where the viewer is in the plan
// (conversation_id non-null). Everything else retires silently — a beacon is
// visible only while you can join it (PSYCHOLOGY design rule 2).
// ---------------------------------------------------------------------------

function beaconVisible(b: Beacon): boolean {
  const live = new Date(b.expires_at).getTime() > Date.now();
  if (b.status === 'open') return live;
  if (b.status === 'sparked') return b.conversation_id !== null && live;
  return false;
}

export function setBeacons(list: Beacon[]): void {
  const next = new Map<string, Beacon>();
  for (const b of list) if (beaconVisible(b)) next.set(b.id, b);
  state.beacons = next;
  state.beaconsLoaded = true;
  emit();
}

export function upsertBeacon(b: Beacon, reping = false, edited = false, changed: string[] = []): void {
  if (beaconVisible(b)) {
    state.beacons = new Map(state.beacons).set(b.id, b);
    if (reping) state.repings = new Map(state.repings).set(b.id, Date.now());
    // v0.7 (§1.47): remember WHAT changed briefly so cards can flash the right
    // chips; the DTO itself carries the full new state + edited_at.
    if (edited) {
      state.beaconEdits = new Map(state.beaconEdits).set(b.id, { at: Date.now(), changed });
    }
  } else {
    const next = new Map(state.beacons);
    next.delete(b.id);
    state.beacons = next;
    state.planRoles.delete(b.id);
  }
  emit();
}

export function removeBeacon(id: string): void {
  const next = new Map(state.beacons);
  if (next.delete(id)) {
    state.beacons = next;
    state.planRoles.delete(id);
    emit();
  }
}

/** Expiry housekeeping: drop cards whose window closed (worker frames may lag). */
export function sweepBeacons(): void {
  let changed = false;
  const next = new Map(state.beacons);
  for (const [id, b] of next) {
    if (!beaconVisible(b)) {
      next.delete(id);
      changed = true;
    }
  }
  if (changed) {
    state.beacons = next;
    emit();
  }
}

export function setRadar(count: number): void {
  if (state.radarCount === count) return;
  state.radarCount = count;
  emit();
}

/** plan.updated / GET roles: full-list replace — idempotent, reorder-safe. */
export function setPlanRoles(beaconId: string, roles: BeaconRole[]): void {
  state.planRoles = new Map(state.planRoles).set(beaconId, roles);
  emit();
}

export function patchPlanRole(beaconId: string, role: BeaconRole): void {
  const list = state.planRoles.get(beaconId) ?? [];
  const idx = list.findIndex((r) => r.id === role.id);
  const next = idx === -1 ? [...list, role] : [...list.slice(0, idx), role, ...list.slice(idx + 1)];
  state.planRoles = new Map(state.planRoles).set(beaconId, next);
  emit();
}

export function dropPlanRole(beaconId: string, roleId: string): void {
  const list = state.planRoles.get(beaconId);
  if (!list) return;
  state.planRoles = new Map(state.planRoles).set(
    beaconId,
    list.filter((r) => r.id !== roleId)
  );
  emit();
}

/** Private kudos delivery — recipient-only; aggregated by the banner, never shown publicly. */
export function addKudos(ev: KudosArrival): void {
  // Idempotent per (beacon, from, kind) — matches the server's PK.
  if (
    state.kudos.some(
      (k) => k.beacon_id === ev.beacon_id && k.from.id === ev.from.id && k.kind === ev.kind
    )
  ) {
    return;
  }
  state.kudos = [...state.kudos, ev];
  emit();
}

export function clearKudos(): void {
  if (!state.kudos.length) return;
  state.kudos = [];
  emit();
}

export function setSettings(settings: UserSettings): void {
  state.settings = settings;
  emit();
}

// ---------------------------------------------------------------------------
// Chat prefs (v0.4 — API.md §1.24). PERSONAL: my view only; prefs.updated
// frames arrive on my own sockets exclusively. Full replace, idempotent.
// ---------------------------------------------------------------------------

export function setPrefs(prefs: ConversationPrefs): void {
  state.prefs = new Map(state.prefs).set(prefs.conversation_id, prefs);
}

/** v1.0a (#95): conv.background patches the shared background in place when
 * the prefs entry is loaded; otherwise the next prefs GET carries it. */
export function setSharedBackground(
  conversationId: string,
  background: ConversationPrefs['shared_background'],
): void {
  const cur = state.prefs.get(conversationId);
  if (!cur) return;
  state.prefs = new Map(state.prefs).set(conversationId, { ...cur, shared_background: background });
  emit();
}

/** #95b: conv.appearance patches the shared theme/wallpaper in place. */
export function setSharedAppearance(
  conversationId: string,
  theme: ConversationPrefs['shared_theme'],
  wallpaper: ConversationPrefs['shared_wallpaper'],
): void {
  const cur = state.prefs.get(conversationId);
  if (!cur) return;
  state.prefs = new Map(state.prefs).set(conversationId, {
    ...cur,
    shared_theme: theme,
    shared_wallpaper: wallpaper,
  });
  emit();
}

// ---------------------------------------------------------------------------
// Scheduled messages (v0.4 — API.md §1.26). Mine only; scheduled.updated
// frames sync create/cancel/send across my devices.
// ---------------------------------------------------------------------------

export function setScheduledList(list: ScheduledMessage[]): void {
  const next = new Map<string, ScheduledMessage>();
  for (const s of list) next.set(s.id, s);
  state.scheduled = next;
  state.scheduledLoaded = true;
  emit();
}

export function upsertScheduled(s: ScheduledMessage): void {
  state.scheduled = new Map(state.scheduled).set(s.id, s);
  emit();
}

// ---------------------------------------------------------------------------
// Polls (v0.3 — API.md §1.17). poll.updated deltas patch counts in place;
// reconnect truth is message.poll (DTO), never frame replay.
// ---------------------------------------------------------------------------

/** Replace the embedded poll DTO on its message (REST responses, optimistic votes). */
export function applyPollDto(poll: Poll): void {
  const patch = (msg: Message): Message => (msg.poll && msg.poll.id === poll.id ? { ...msg, poll } : msg);
  const changed = patchMessageAt(poll.conversation_id, poll.seq, patch);
  if (!changed) {
    const conv = state.conversations.get(poll.conversation_id);
    if (conv?.last_message && conv.last_message.seq === poll.seq) {
      conv.last_message = patch(conv.last_message);
    }
  }
  emit();
}

export interface PollDelta {
  poll_id: string;
  conversation_id: string;
  seq: number;
  counts: number[];
  total_votes: number;
  // Voter identity rides ONLY the voter's own frames (my_vote reconcile);
  // frames to other participants carry aggregates alone (API.md §1.17).
  user_id?: string;
  option_idx?: number | null;
}

/** poll.updated frame: counts are the NEW aggregate; my_vote derives from user_id === me. */
export function applyPollUpdated(d: PollDelta): void {
  const isMe = d.user_id !== undefined && state.me?.id === d.user_id;
  const patch = (msg: Message): Message =>
    msg.poll && msg.poll.id === d.poll_id
      ? {
          ...msg,
          poll: {
            ...msg.poll,
            counts: d.counts,
            total_votes: d.total_votes,
            my_vote: isMe && d.option_idx !== undefined ? d.option_idx : msg.poll.my_vote,
          },
        }
      : msg;
  const changed = patchMessageAt(d.conversation_id, d.seq, patch);
  if (!changed) {
    const conv = state.conversations.get(d.conversation_id);
    if (conv?.last_message && conv.last_message.seq === d.seq) {
      conv.last_message = patch(conv.last_message);
    }
  }
  emit();
}

// ---------------------------------------------------------------------------
// Calls (v0.6 — API.md §1.42 + §2.12). The store carries UI state only; the
// media engine (lib/webrtc.ts) is the sole writer of callUi/callInvite.
// ---------------------------------------------------------------------------

export function setCallInvite(invite: IncomingCall | null): void {
  state.callInvite = invite;
  emit();
}

export function setCallUi(ui: CallUi | null): void {
  state.callUi = ui;
  emit();
}

export function patchCallUi(patch: Partial<CallUi>): void {
  if (!state.callUi) return;
  state.callUi = { ...state.callUi, ...patch };
  emit();
}

/** call.updated / REST responses: live calls power the header "Join call". */
export function upsertLiveCall(call: Call): void {
  const next = new Map(state.liveCalls);
  if (call.status === 'ringing' || call.status === 'ongoing') {
    next.set(call.conversation_id, call);
  } else {
    const cur = next.get(call.conversation_id);
    if (cur && cur.id !== call.id) {
      // A different call is live in that conversation — leave it alone.
      state.liveCalls = next;
      emit();
      return;
    }
    next.delete(call.conversation_id);
  }
  state.liveCalls = next;
  emit();
}

// ---------------------------------------------------------------------------
// Watch together (v0.6 — §1.43). Frames carry FULL state; stale sessions
// (no sync within WATCH_SESSION_TTL_S) are dropped by the sheet/banner.
// ---------------------------------------------------------------------------

export function setWatchSession(ws: WatchSession): void {
  state.watch = new Map(state.watch).set(ws.conversation_id, ws);
  emit();
}

export function clearWatchSession(conversationId: string): void {
  if (!state.watch.has(conversationId)) return;
  const next = new Map(state.watch);
  next.delete(conversationId);
  state.watch = next;
  emit();
}

// ---------------------------------------------------------------------------
// Bored Together: discovery, roulette & feedback (v0.6 — §1.44/§1.45).
// ---------------------------------------------------------------------------

export function setDiscoveryOptin(optin: DiscoveryOptin | null): void {
  state.discoveryOptin = optin;
  state.discoveryLoaded = true;
  // The card pool is gated on my own live opt-in — no opt-in, no cards.
  if (!optin) state.discoveryCards = null;
  emit();
}

export function setDiscoveryCards(cards: DiscoveryCard[] | null): void {
  state.discoveryCards = cards;
  emit();
}

/** Mark my own wave on a card (their side never learns of it — §1.44). */
export function markCardWaved(userId: string): void {
  if (!state.discoveryCards) return;
  state.discoveryCards = state.discoveryCards.map((c) =>
    c.user.id === userId ? { ...c, waved: true } : c
  );
  emit();
}

export function removeCard(userId: string): void {
  if (!state.discoveryCards) return;
  state.discoveryCards = state.discoveryCards.filter((c) => c.user.id !== userId);
  emit();
}

export function setEncouragement(agg: EncouragementResponse | null): void {
  state.encouragement = agg;
  emit();
}

export function setDiscoveryMatch(match: { conversation_id: string; user: UserLite } | null): void {
  state.discoveryMatch = match;
  emit();
}

export function setRouletteQueued(queued: boolean): void {
  if (state.rouletteQueued === queued) return;
  state.rouletteQueued = queued;
  emit();
}

export function setRouletteMatchNav(conversationId: string | null): void {
  state.rouletteMatchNav = conversationId;
  emit();
}

export function setRouletteGoodbye(conversationId: string | null): void {
  state.rouletteGoodbye = conversationId;
  emit();
}

export function setFeedbackAsk(ask: FeedbackAsk | null): void {
  state.feedbackAsk = ask;
  emit();
}

export function resetOnLogout(): void {
  state.authed = false;
  state.me = null;
  state.conversations = new Map();
  state.messages = new Map();
  state.caughtUp = new Set();
  state.presence = new Map();
  state.typing = new Map();
  state.previews = new Map();
  state.readyAttachments = new Map();
  state.outbox = [];
  state.activeConversationId = null;
  state.beacons = new Map();
  state.beaconsLoaded = false;
  state.radarCount = null;
  state.repings = new Map();
  state.planRoles = new Map();
  state.kudos = [];
  state.settings = null;
  state.prefs = new Map();
  state.scheduled = new Map();
  state.scheduledLoaded = false;
  state.connections = null;
  state.stories = null;
  state.feed = { friends: emptyLane(), discover: emptyLane() };
  state.feedExtra = new Map();
  state.toasts = [];
  state.beaconEdits = new Map();
  state.callInvite = null;
  state.callUi = null;
  state.liveCalls = new Map();
  state.watch = new Map();
  state.discoveryOptin = null;
  state.discoveryLoaded = false;
  state.discoveryCards = null;
  state.encouragement = null;
  state.discoveryMatch = null;
  state.rouletteQueued = false;
  state.rouletteMatchNav = null;
  state.rouletteGoodbye = null;
  state.feedbackAsk = null;
  state.moodState = null;
  state.releases = null;
  state.anonThreads = null;
  state.anonMessages = new Map();
  state.discoveryNudgeAt = null;
  emit();
}

// ---------------------------------------------------------------------------
// Anonymous reveal game (v0.8b — API.md §1.62). Threads are viewer-stamped
// DTOs patched live by anon.updated frames; reconnect truth is the GET.
// Messages live OFF the seq log — ordered by created_at, deduped by id.
// ---------------------------------------------------------------------------

function anonSortKey(t: AnonThread): number {
  return new Date(t.last_message?.created_at ?? t.created_at).getTime();
}

export function setAnonThreads(list: AnonThread[]): void {
  state.anonThreads = [...list].sort((a, b) => anonSortKey(b) - anonSortKey(a));
  // Drop message windows for threads that no longer exist (hard-deleted).
  const ids = new Set(list.map((t) => t.id));
  for (const id of [...state.anonMessages.keys()]) {
    if (!ids.has(id)) state.anonMessages.delete(id);
  }
  emit();
}

export function upsertAnonThread(thread: AnonThread): void {
  const cur = state.anonThreads ?? [];
  const next = [thread, ...cur.filter((t) => t.id !== thread.id)].sort(
    (a, b) => anonSortKey(b) - anonSortKey(a)
  );
  state.anonThreads = next;
  emit();
}

export function removeAnonThread(threadId: string): void {
  if (state.anonThreads) {
    state.anonThreads = state.anonThreads.filter((t) => t.id !== threadId);
  }
  const msgs = new Map(state.anonMessages);
  msgs.delete(threadId);
  state.anonMessages = msgs;
  emit();
}

export function setAnonMessages(threadId: string, messages: AnonMessage[]): void {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  state.anonMessages = new Map(state.anonMessages).set(threadId, sorted);
  emit();
}

export function appendAnonMessage(threadId: string, message: AnonMessage): void {
  const list = state.anonMessages.get(threadId) ?? [];
  if (list.some((m) => m.id === message.id)) return;
  const next = [...list, message].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  state.anonMessages = new Map(state.anonMessages).set(threadId, next);
  emit();
}

/** anon.updated frame: viewer-stamped thread replace + optional new message. */
export function applyAnonUpdated(thread: AnonThread, message: AnonMessage | null): void {
  upsertAnonThread(thread);
  if (message) appendAnonMessage(thread.id, message);
}

// ---------------------------------------------------------------------------
// Wave nudge (v0.8b — API.md §1.63). One anonymous fact, nothing else.
// ---------------------------------------------------------------------------

export function setDiscoveryNudge(at: number | null): void {
  state.discoveryNudgeAt = at;
  emit();
}

// ---------------------------------------------------------------------------
// Canvas stories (v0.8b — API.md §1.66). story.updated is a full-story
// replace to the audience; reconnect truth stays GET /api/stories.
// ---------------------------------------------------------------------------

export function replaceStoryLocal(story: Story): void {
  const cur = state.stories;
  if (!cur) {
    // Nothing loaded yet — adopt it through the story.new path instead.
    applyStoryNew(story);
    return;
  }
  if (state.me && story.author.id === state.me.id) {
    if (!cur.mine.some((s) => s.id === story.id)) {
      state.stories = { ...cur, mine: [...cur.mine, story] };
    } else {
      state.stories = {
        ...cur,
        mine: cur.mine.map((s) => (s.id === story.id ? { ...story, viewed: s.viewed } : s)),
      };
    }
    emit();
    return;
  }
  let found = false;
  const groups = cur.groups.map((g) =>
    g.stories.some((s) => s.id === story.id)
      ? {
          ...g,
          stories: g.stories.map((s) => {
            if (s.id !== story.id) return s;
            found = true;
            // Keep the local viewed bit if the frame raced my own view POST.
            return { ...story, viewed: story.viewed || s.viewed };
          }),
        }
      : g
  );
  if (!found) {
    applyStoryNew(story);
    return;
  }
  state.stories = { ...cur, groups };
  emit();
}

// ---------------------------------------------------------------------------
// Moods (v0.8a — API.md §1.57). moodState is MY owner-only read; me.mood is
// the chip every surface renders (kept live by user.updated — the expiry
// sweep's frame nulls it with zero trace). lib/mood.ts is the writer.
// ---------------------------------------------------------------------------

export function setMoodState(ms: MoodState): void {
  state.moodState = ms;
  if (state.me) state.me = { ...state.me, mood: ms.mood };
  emit();
}

export function patchMeMood(mood: Mood | null): void {
  if (!state.me) return;
  state.me = { ...state.me, mood };
  emit();
}

// ---------------------------------------------------------------------------
// Releases / what's-new (v0.8a — API.md §1.61). Pull-based; dismissing cards
// POSTs /api/releases/seen and patches the marker here.
// ---------------------------------------------------------------------------

export function setReleases(res: ReleasesResponse): void {
  state.releases = res;
  emit();
}

export function setLastSeenRelease(version: string): void {
  if (!state.releases) return;
  state.releases = { ...state.releases, last_seen_release: version };
  emit();
}

// ---------------------------------------------------------------------------
// Connections (v0.5a — API.md §1.28). connection.updated frames reach the two
// parties only; declines/removals arrive as removed:true. Reconnect truth is
// GET /api/connections, never frame replay.
// ---------------------------------------------------------------------------

function byUsername(a: Connection, b: Connection): number {
  return a.user.username.localeCompare(b.user.username);
}

export function setConnections(res: ListConnectionsResponse): void {
  state.connections = res;
  emit();
}

export function applyConnectionUpdated(conn: Connection, removed: boolean): void {
  const cur = state.connections ?? { connections: [], incoming: [], outgoing: [] };
  const strip = (list: Connection[]): Connection[] => list.filter((c) => c.id !== conn.id);
  let connections = strip(cur.connections);
  let incoming = strip(cur.incoming);
  let outgoing = strip(cur.outgoing);
  if (!removed) {
    if (conn.status === 'accepted') {
      connections = [...connections, conn].sort(byUsername);
    } else if (conn.direction === 'incoming') {
      incoming = [...incoming, conn];
    } else {
      outgoing = [...outgoing, conn];
    }
  }
  state.connections = { connections, incoming, outgoing };
  emit();
}

// ---------------------------------------------------------------------------
// Stories (v0.5a — API.md §1.34). Tray ordering is the server's: authors with
// any unviewed story first, then all-viewed, each bucket by username; within
// an author created_at ASC. story.new inserts live; expiry drops locally.
// ---------------------------------------------------------------------------

function sortStoryGroups(groups: StoryAuthorGroup[]): StoryAuthorGroup[] {
  return [...groups].sort((a, b) => {
    const unA = a.stories.some((s) => !s.viewed) ? 0 : 1;
    const unB = b.stories.some((s) => !s.viewed) ? 0 : 1;
    if (unA !== unB) return unA - unB;
    return a.author.username.localeCompare(b.author.username);
  });
}

export function setStories(res: ListStoriesResponse): void {
  state.stories = { mine: res.mine, groups: sortStoryGroups(res.groups) };
  emit();
}

export function applyStoryNew(story: Story): void {
  const cur = state.stories ?? { mine: [], groups: [] };
  if (state.me && story.author.id === state.me.id) {
    if (cur.mine.some((s) => s.id === story.id)) return;
    state.stories = { ...cur, mine: [...cur.mine, story] };
    emit();
    return;
  }
  const groups = cur.groups.map((g) =>
    g.author.id === story.author.id
      ? g.stories.some((s) => s.id === story.id)
        ? g
        : { ...g, stories: [...g.stories, story] }
      : g
  );
  if (!groups.some((g) => g.author.id === story.author.id)) {
    groups.push({ author: story.author, stories: [story] });
  }
  state.stories = { ...cur, groups: sortStoryGroups(groups) };
  emit();
}

export function markStoryViewedLocal(storyId: string): void {
  const cur = state.stories;
  if (!cur) return;
  const groups = cur.groups.map((g) =>
    g.stories.some((s) => s.id === storyId)
      ? { ...g, stories: g.stories.map((s) => (s.id === storyId ? { ...s, viewed: true } : s)) }
      : g
  );
  // Deliberately NOT re-sorted mid-session: a watched author's ring dims in
  // place; the next GET re-buckets (keeps the tray from reshuffling underfoot).
  state.stories = { ...cur, groups };
  emit();
}

export function removeStoryLocal(storyId: string): void {
  const cur = state.stories;
  if (!cur) return;
  state.stories = {
    mine: cur.mine.filter((s) => s.id !== storyId),
    groups: cur.groups
      .map((g) => ({ ...g, stories: g.stories.filter((s) => s.id !== storyId) }))
      .filter((g) => g.stories.length > 0),
  };
  emit();
}

/** Drop expired cards between frames (expiry fans nothing, §1.34). */
export function sweepStories(): void {
  const cur = state.stories;
  if (!cur) return;
  const now = Date.now();
  const live = (s: Story) => new Date(s.expires_at).getTime() > now;
  if (cur.mine.every(live) && cur.groups.every((g) => g.stories.every(live))) return;
  state.stories = {
    mine: cur.mine.filter(live),
    groups: cur.groups
      .map((g) => ({ ...g, stories: g.stories.filter(live) }))
      .filter((g) => g.stories.length > 0),
  };
  emit();
}

// ---------------------------------------------------------------------------
// Feed (v0.5a — API.md §1.36). A finite window with a hard end; post.new
// prepends live. Reactions/comments reconcile via single-post refetch only.
// ---------------------------------------------------------------------------

export function setFeedPage(
  lane: FeedLane,
  posts: Post[],
  nextCursor: string | null,
  allCaughtUp: boolean,
  reset: boolean
): void {
  const laneState = state.feed[lane];
  const cur = reset ? [] : laneState.posts ?? [];
  const seen = new Set(cur.map((p) => p.id));
  state.feed = {
    ...state.feed,
    [lane]: {
      posts: [...cur, ...posts.filter((p) => !seen.has(p.id))],
      cursor: nextCursor,
      caughtUp: allCaughtUp,
    },
  };
  emit();
}

/** post.new (friends-of fan-out, §1.49) and my own creates. A lane not loaded
 * yet is skipped — its first GET carries the post. Public posts land in both
 * lanes (discover is a superset filter, not a dedupe puzzle). */
export function prependPost(post: Post): void {
  const next = { ...state.feed };
  let changed = false;
  for (const lane of ['friends', 'discover'] as const) {
    const ls = next[lane];
    if (ls.posts === null) continue;
    if (lane === 'discover' && post.audience !== 'public') continue;
    if (ls.posts.some((p) => p.id === post.id)) continue;
    next[lane] = { ...ls, posts: [post, ...ls.posts] };
    changed = true;
  }
  if (changed) {
    state.feed = next;
    emit();
  }
}

export function replacePost(post: Post): void {
  const next = { ...state.feed };
  let changed = false;
  for (const lane of ['friends', 'discover'] as const) {
    const ls = next[lane];
    if (ls.posts === null) continue;
    if (!ls.posts.some((p) => p.id === post.id)) continue;
    next[lane] = { ...ls, posts: ls.posts.map((p) => (p.id === post.id ? post : p)) };
    changed = true;
  }
  if (state.feedExtra.has(post.id)) {
    const extra = new Map(state.feedExtra);
    extra.set(post.id, post);
    state.feedExtra = extra;
    changed = true;
  }
  if (changed) {
    state.feed = next;
    emit();
  }
}

export function removePostLocal(postId: string): void {
  const next = { ...state.feed };
  let changed = false;
  for (const lane of ['friends', 'discover'] as const) {
    const ls = next[lane];
    if (ls.posts === null) continue;
    if (!ls.posts.some((p) => p.id === postId)) continue;
    next[lane] = { ...ls, posts: ls.posts.filter((p) => p.id !== postId) };
    changed = true;
  }
  if (state.feedExtra.has(postId)) {
    const extra = new Map(state.feedExtra);
    extra.delete(postId);
    state.feedExtra = extra;
    changed = true;
  }
  if (changed) {
    state.feed = next;
    emit();
  }
}

/** §1b deep link: hold a post opened by id outside the lane windows. */
export function setExtraPost(post: Post): void {
  const extra = new Map(state.feedExtra);
  extra.set(post.id, post);
  state.feedExtra = extra;
  emit();
}

export function clearExtraPost(postId: string): void {
  if (!state.feedExtra.has(postId)) return;
  const extra = new Map(state.feedExtra);
  extra.delete(postId);
  state.feedExtra = extra;
  emit();
}

// ---------------------------------------------------------------------------
// Toasts (v0.7 §1.54 → v0.7.1 §1.56). Transient, self-expiring; rendered by
// the ONE shared components/Toast.tsx through Portal at the toast layer of
// the z-scale. At most TOAST_MAX_VISIBLE at once — oldest dropped (never a
// stack of nags; confirmations are glanceable, not a log).
// ---------------------------------------------------------------------------

let toastSeq = 0;

export function pushToast(text: string, ttlMs: number): void {
  const id = ++toastSeq;
  const next = [...state.toasts, { id, text }];
  state.toasts = next.length > TOAST_MAX_VISIBLE ? next.slice(next.length - TOAST_MAX_VISIBLE) : next;
  emit();
  setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  if (!state.toasts.some((t) => t.id === id)) return;
  state.toasts = state.toasts.filter((t) => t.id !== id);
  emit();
}
