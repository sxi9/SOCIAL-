// In-memory app state, fed by REST sync + WS events. Watermarks are monotonic
// maxima and messages apply idempotently by (conversation_id, seq), so events
// may arrive duplicated or out of order without harm (API.md §2.5).
import type {
  Attachment,
  Beacon,
  BeaconRole,
  Conversation,
  ConversationListItem,
  ConversationPrefs,
  KudosKind,
  LinkPreview,
  Message,
  Poll,
  ScheduledMessage,
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
  count: number;
  user_id: string;
  removed: boolean;
}

function patchReactions(msg: Message, d: ReactionDelta, isMe: boolean): Message {
  const reactions = [...msg.reactions];
  const i = reactions.findIndex((r) => r.emoji === d.emoji);
  if (d.count <= 0) {
    if (i !== -1) reactions.splice(i, 1);
  } else if (i === -1) {
    // Chips are ordered by first reaction (min created_at per emoji), so a
    // brand-new chip appends — matching the server's DTO ordering.
    reactions.push({ emoji: d.emoji, count: d.count, mine: isMe ? !d.removed : false });
  } else {
    reactions[i] = {
      ...reactions[i],
      count: d.count,
      mine: isMe ? !d.removed : reactions[i].mine,
    };
  }
  return { ...msg, reactions };
}

/** reaction.updated frame: `count` is the NEW authoritative total; 0 drops the chip. */
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

/** Optimistic local toggle (lib/reactions.ts); the WS frame confirms totals. */
export function applyReactionLocal(conversationId: string, seq: number, emoji: string, add: boolean): void {
  const changed = patchMessageAt(conversationId, seq, (msg) => {
    const reactions = [...msg.reactions];
    const i = reactions.findIndex((r) => r.emoji === emoji);
    if (add) {
      if (i === -1) reactions.push({ emoji, count: 1, mine: true });
      else if (!reactions[i].mine) reactions[i] = { ...reactions[i], count: reactions[i].count + 1, mine: true };
    } else if (i !== -1 && reactions[i].mine) {
      const next = reactions[i].count - 1;
      if (next <= 0) reactions.splice(i, 1);
      else reactions[i] = { ...reactions[i], count: next, mine: false };
    }
    return { ...msg, reactions };
  });
  if (changed) emit();
}

// ---------------------------------------------------------------------------
// Avatar stamps (v0.4 — API.md §1.19). A stamp frame is a reaction.updated with
// kind='stamp'; Message.stamps carries the stampers as FACES in first-stamp
// order (never a counter). Reconnect truth is the DTO's stamps[], not frames.
// ---------------------------------------------------------------------------

function userLiteFor(conversationId: string, userId: string): UserLite | null {
  if (state.me && state.me.id === userId) {
    const { id, username, display_name, avatar } = state.me;
    return { id, username, display_name, avatar };
  }
  const conv = state.conversations.get(conversationId);
  const p = conv?.participants.find((x) => x.user.id === userId);
  if (!p) return null;
  const { id, username, display_name, avatar } = p.user;
  return { id, username, display_name, avatar };
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
}): void {
  const user = userLiteFor(d.conversation_id, d.user_id);
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

export function upsertBeacon(b: Beacon, reping = false): void {
  if (beaconVisible(b)) {
    state.beacons = new Map(state.beacons).set(b.id, b);
    if (reping) state.repings = new Map(state.repings).set(b.id, Date.now());
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
  emit();
}
