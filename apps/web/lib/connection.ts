// WS client + reconnect sync engine (API.md §2). Typed by @socialchat/shared.
// The socket is a downstream event pipe plus ephemeral upstream signals;
// durable writes are REST only.
import {
  PAGE_SIZE_MAX,
  ServerEventSchema,
  WS_CLOSE_CODES,
  type ClientEvent,
  type ListMessagesResponse,
  type MeResponse,
  type Message,
  type SendMessageRequest,
  type SendMessageResponse,
  type SyncResponse,
} from '@socialchat/shared';
import { api, ApiError, NetworkError } from './api';
import * as db from './db';
import * as store from './store';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const OVERLOAD_MIN_MS = 10000; // close 1013 → reconnect no sooner than 10 s
const TYPING_RESEND_MS = 4000; // §2.6: re-send while typing every ~4 s
const READ_FLUSH_MS = 600; // client-side read coalescing (trailing)

let started = false;
let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let syncRun = 0;

const lastDeliveredSent = new Map<string, number>();
const pendingReads = new Map<string, number>();
let readFlushTimer: ReturnType<typeof setTimeout> | null = null;
const lastTypingSent = new Map<string, number>();
const presenceSubs = new Set<string>();

function send(frame: ClientEvent): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startConnection(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void bootstrapAuth();
  window.addEventListener('online', () => {
    if (store.state.authed) connect();
  });
}

async function bootstrapAuth(): Promise<void> {
  try {
    const res = await api.get<MeResponse>('/api/users/me');
    store.setMe(res.user);
    connect();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      store.setAuthed(false);
      return;
    }
    store.setConn('offline');
    setTimeout(() => void bootstrapAuth(), 3000);
  }
}

/** Called by the login/register pages after a successful auth response. */
export function onAuthenticated(): void {
  attempt = 0;
  if (!started) {
    startConnection();
    return;
  }
  connect();
}

export async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* session may already be gone */
  }
  ws?.close();
  await db.clearOutbox().catch(() => undefined);
  store.resetOnLogout();
}

function connect(): void {
  if (typeof window === 'undefined') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  store.setConn('connecting');
  // Same origin: the sid cookie rides the upgrade (ARCHITECTURE §4).
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    store.setConn('online');
    // Socket first, then snapshot: events racing the snapshot apply
    // idempotently — duplicates harmless, gaps impossible (§2.8).
    void runSync();
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data === 'string') handleFrame(ev.data);
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    store.setConn('offline');
    void handleClose(ev.code);
  };
  sock.onerror = () => {
    /* onclose follows */
  };
}

async function handleClose(code: number): Promise<void> {
  if (store.state.authed === false) return;
  if (code === WS_CLOSE_CODES.UNAUTHENTICATED) {
    // §2.10: probe /api/users/me; 401 → login, else cookie refreshed elsewhere.
    try {
      await api.get<MeResponse>('/api/users/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        store.setAuthed(false);
        return;
      }
    }
  }
  scheduleReconnect(code === WS_CLOSE_CODES.TRY_AGAIN_LATER ? OVERLOAD_MIN_MS : 0);
}

function scheduleReconnect(minMs: number): void {
  if (reconnectTimer !== null) return;
  attempt += 1;
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt - 1));
  const delay = Math.max(minMs, cap / 2 + Math.random() * (cap / 2)); // jitter
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// Inbound frames
// ---------------------------------------------------------------------------

function handleFrame(raw: string): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const parsed = ServerEventSchema.safeParse(json);
  // Unknown `t` values MUST be ignored (§2.2 forward compatibility).
  if (!parsed.success) return;
  const ev = parsed.data;
  switch (ev.t) {
    case 'hello':
      break;
    case 'msg.new':
      void onMsgNew(ev.d.message);
      break;
    case 'msg.updated':
      store.replaceMessage(ev.d.message);
      void db.storeMessages(ev.d.conversation_id, [ev.d.message]).catch(() => undefined);
      break;
    case 'attachment.ready':
      store.attachmentReady(ev.d.attachment);
      break;
    case 'receipt':
      store.applyReceipt(ev.d);
      break;
    case 'typing':
      store.applyTyping(ev.d.conversation_id, ev.d.user_id, ev.d.expires_at);
      break;
    case 'presence':
      store.applyPresence(ev.d);
      break;
    case 'conv.new':
      store.upsertConversation(ev.d.conversation);
      void db.adoptConversation(ev.d.conversation.id, ev.d.conversation.last_seq, null).catch(() => undefined);
      break;
    case 'conv.updated':
      store.upsertConversation(ev.d.conversation);
      break;
    case 'user.updated':
      store.applyUserUpdated(ev.d.user);
      break;
    case 'preview.ready':
      store.setPreview(ev.d.url_hash, { status: ev.d.status, preview: ev.d.preview ?? null });
      break;
    case 'error':
      break;
  }
}

async function onMsgNew(message: Message): Promise<void> {
  store.applyMessage(message);
  try {
    const max = await db.storeMessages(message.conversation_id, [message]);
    // Receipt honesty: delivered only after the IndexedDB write committed.
    sendDelivered(message.conversation_id, max);
  } catch {
    /* storage unavailable → no delivered claim */
  }
  if (
    store.state.activeConversationId === message.conversation_id &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
    queueRead(message.conversation_id, message.seq);
  }
}

// ---------------------------------------------------------------------------
// Upstream signals
// ---------------------------------------------------------------------------

export function sendDelivered(conversationId: string, seq: number): void {
  if (seq <= 0) return;
  const prev = lastDeliveredSent.get(conversationId) ?? 0;
  if (seq <= prev) return;
  lastDeliveredSent.set(conversationId, seq);
  send({ t: 'delivered', d: { conversation_id: conversationId, seq } });
}

/** Coalesced read receipts: trailing flush of the per-conversation max. */
export function queueRead(conversationId: string, seq: number): void {
  const conv = store.state.conversations.get(conversationId);
  const meId = store.state.me?.id;
  if (conv && meId) {
    const mine = conv.participants.find((p) => p.user.id === meId);
    if (mine && mine.last_read_seq >= seq) return; // already read
  }
  store.markReadLocal(conversationId, seq);
  const prev = pendingReads.get(conversationId) ?? 0;
  if (seq > prev) pendingReads.set(conversationId, seq);
  if (readFlushTimer === null) {
    readFlushTimer = setTimeout(() => {
      readFlushTimer = null;
      flushReads();
    }, READ_FLUSH_MS);
  }
}

function flushReads(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // kept pending until reconnect sync
  for (const [conversationId, seq] of pendingReads) {
    send({ t: 'read', d: { conversation_id: conversationId, seq } });
    pendingReads.delete(conversationId);
  }
}

export function sendTyping(conversationId: string): void {
  const now = Date.now();
  const last = lastTypingSent.get(conversationId) ?? 0;
  if (now - last < TYPING_RESEND_MS) return;
  lastTypingSent.set(conversationId, now);
  send({ t: 'typing', d: { conversation_id: conversationId } });
}

export function subscribePresence(userIds: string[]): void {
  const fresh = userIds.filter((id) => !presenceSubs.has(id));
  for (const id of fresh) presenceSubs.add(id);
  if (fresh.length) send({ t: 'presence.sub', d: { user_ids: fresh } });
}

export function unsubscribePresence(userIds: string[]): void {
  const gone = userIds.filter((id) => presenceSubs.has(id));
  for (const id of gone) presenceSubs.delete(id);
  if (gone.length) send({ t: 'presence.unsub', d: { user_ids: gone } });
}

// ---------------------------------------------------------------------------
// Durable send (REST only, idempotent by client_msg_id)
// ---------------------------------------------------------------------------

export async function sendMessage(conversationId: string, payload: SendMessageRequest): Promise<Message | null> {
  try {
    const res = await api.post<SendMessageResponse>(`/api/conversations/${conversationId}/messages`, payload);
    store.applyMessage(res.message);
    void db.storeMessages(conversationId, [res.message]).catch(() => undefined);
    return res.message;
  } catch (err) {
    if (err instanceof NetworkError) {
      // Park in the outbound queue; flushed on reconnect (§2.8 step 5).
      const item: db.OutboxItem = {
        client_msg_id: payload.client_msg_id,
        conversation_id: conversationId,
        payload,
        created_at: Date.now(),
      };
      await db.addOutbox(item).catch(() => undefined);
      store.setOutbox(await db.listOutbox().catch(() => []));
      return null;
    }
    throw err;
  }
}

async function flushOutbox(): Promise<void> {
  let items: db.OutboxItem[] = [];
  try {
    items = await db.listOutbox();
  } catch {
    return;
  }
  for (const item of items) {
    try {
      const res = await api.post<SendMessageResponse>(
        `/api/conversations/${item.conversation_id}/messages`,
        item.payload
      );
      store.applyMessage(res.message);
      await db.storeMessages(item.conversation_id, [res.message]).catch(() => undefined);
      await db.removeOutbox(item.client_msg_id);
    } catch (err) {
      if (err instanceof NetworkError) break; // still offline, keep queued
      await db.removeOutbox(item.client_msg_id).catch(() => undefined); // rejected for good
    }
  }
  store.setOutbox(await db.listOutbox().catch(() => []));
}

// ---------------------------------------------------------------------------
// Reconnect catch-up (API.md §2.8): snapshot + after_seq gap-fill
// ---------------------------------------------------------------------------

async function runSync(): Promise<void> {
  const run = ++syncRun;
  let snap: SyncResponse;
  try {
    snap = await api.get<SyncResponse>('/api/sync');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      store.setAuthed(false);
      ws?.close();
    }
    return;
  }
  if (run !== syncRun) return;
  store.applySyncSnapshot(snap);

  let metas: Map<string, number>;
  try {
    metas = await db.getAllMeta();
  } catch {
    metas = new Map();
  }

  // Open conversation first, others lazily in the background.
  const active = store.state.activeConversationId;
  const ordered = [...snap.conversations].sort((a, b) =>
    a.id === active ? -1 : b.id === active ? 1 : 0
  );

  for (const conv of ordered) {
    if (run !== syncRun) return;
    const stored = metas.get(conv.id);
    if (stored === undefined) {
      // New to this device: adopt wholesale; history backfills via before_seq.
      await db.adoptConversation(conv.id, conv.last_seq, conv.last_message).catch(() => undefined);
      sendDelivered(conv.id, conv.last_seq);
      store.markCaughtUp(conv.id);
      continue;
    }
    if (conv.last_seq > stored) {
      await catchUpConversation(conv.id, stored, conv.last_seq, run);
    } else {
      sendDelivered(conv.id, stored);
      store.markCaughtUp(conv.id);
    }
  }

  // Conversations missing from the snapshot were left/deleted.
  for (const id of metas.keys()) {
    if (!snap.conversations.some((c) => c.id === id)) {
      void db.dropConversation(id).catch(() => undefined);
    }
  }

  await flushOutbox();
  flushReads();
  // Presence subs are per-socket; re-subscribe after reconnect.
  if (presenceSubs.size) send({ t: 'presence.sub', d: { user_ids: [...presenceSubs] } });
}

async function catchUpConversation(
  conversationId: string,
  fromSeq: number,
  targetSeq: number,
  run: number
): Promise<void> {
  let cursor = fromSeq;
  while (cursor < targetSeq) {
    if (run !== syncRun) return;
    let page: ListMessagesResponse;
    try {
      page = await api.get<ListMessagesResponse>(
        `/api/conversations/${conversationId}/messages?after_seq=${cursor}&limit=${PAGE_SIZE_MAX}`
      );
    } catch {
      return;
    }
    if (page.messages.length === 0) {
      // Visibility floor (join_seq) can hide the remaining range entirely.
      await db.setMaxSeqStored(conversationId, targetSeq).catch(() => undefined);
      cursor = targetSeq;
      break;
    }
    for (const m of page.messages) store.applyMessage(m);
    let newMax = cursor;
    try {
      newMax = await db.storeMessages(conversationId, page.messages);
    } catch {
      return; // no durable storage → no delivered claim
    }
    const maxInPage = page.messages[page.messages.length - 1].seq;
    if (newMax < maxInPage) {
      // Non-contiguous due to the visibility floor; REST paging is authoritative.
      await db.setMaxSeqStored(conversationId, maxInPage).catch(() => undefined);
      newMax = maxInPage;
    }
    cursor = newMax;
  }
  // One delivered per caught-up conversation (§2.8 step 5).
  sendDelivered(conversationId, cursor);
  store.markCaughtUp(conversationId);
}
