// In-memory app state, fed by REST sync + WS events. Watermarks are monotonic
// maxima and messages apply idempotently by (conversation_id, seq), so events
// may arrive duplicated or out of order without harm (API.md §2.5).
import type {
  Attachment,
  Conversation,
  ConversationListItem,
  LinkPreview,
  Message,
  SyncResponse,
  UserPrivate,
  UserPublic,
} from '@socialchat/shared';
import type { OutboxItem } from './db';

export type ConnState = 'connecting' | 'online' | 'offline';

export interface PresenceInfo {
  online: boolean;
  last_seen_at: string | null;
}

export interface PreviewState {
  status: 'pending' | 'ok' | 'failed';
  preview: LinkPreview | null;
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
  emit();
}
