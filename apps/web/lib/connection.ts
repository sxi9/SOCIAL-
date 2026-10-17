// WS client + reconnect sync engine (API.md §2). Typed by @socialchat/shared.
// The socket is a downstream event pipe plus ephemeral upstream signals;
// durable writes are REST only.
import {
  chunk,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESENCE_SUB_MAX,
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
import { refreshBeacons } from './beacons';
import { refreshConnections } from './connections';
import * as db from './db';
import { onRouletteExpired, refreshOptin } from './discovery';
import { adoptIncomingPost, refreshFeed } from './feed';
import { registerEventSender } from './signals';
import * as store from './store';
import { refreshStories } from './stories';
import { handleWatchEvent } from './watch';
import { handleCallEvent, teardownCall } from './webrtc';

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
// Close 1008 (protocol violation) policy (§2.10): reconnect ONCE; a second
// 1008 means we keep violating the protocol, so stop and surface the error.
let policyViolationCloses = 0;

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

// v0.6 (§2.12): feature modules (lib/webrtc.ts, lib/watch.ts) send their
// ephemeral call.*/watch.* frames through this registered sender — an
// indirection instead of an import cycle. Losing a frame while the socket is
// down loses a moment of UX, never state (the typing precedent).
registerEventSender((frame: ClientEvent): boolean => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
    return true;
  }
  return false;
});

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
  policyViolationCloses = 0;
  if (!started) {
    startConnection();
    return;
  }
  connect();
}

/** Explicit user retry out of the connection-error state (close 1008 twice). */
export function retryConnection(): void {
  attempt = 0;
  policyViolationCloses = 0;
  connect();
}

export async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* session may already be gone */
  }
  teardownCall(); // stop mic/camera + close peer connections (v0.6 §1.42)
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
  if (code === WS_CLOSE_CODES.POLICY_VIOLATION) {
    // §2.10 "reconnect once; report": the first 1008 gets one reconnect; a
    // repeat means this client keeps sending frames the server rejects —
    // stop retrying and surface a connection-error state the UI shows.
    policyViolationCloses += 1;
    console.error(`ws closed with 1008 (protocol violation), occurrence ${policyViolationCloses}`);
    if (policyViolationCloses > 1) {
      store.setConn('error');
      return;
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
    case 'conv.updated': {
      const conv = ev.d.conversation;
      const meId = store.state.me?.id;
      const mine = conv.participants.find((p) => p.user.id === meId);
      if (meId && (!mine || mine.left_at !== null)) {
        // The server sends the removed/leaving user their own conv.updated
        // (§1.4); not being an active participant any more means this
        // conversation would be missing from the next /api/sync snapshot —
        // drop it locally right away instead of waiting for that sync.
        store.removeConversation(conv.id);
        void db.dropConversation(conv.id).catch(() => undefined);
      } else {
        store.upsertConversation(conv);
      }
      break;
    }
    case 'user.updated':
      store.applyUserUpdated(ev.d.user);
      break;
    case 'reaction.updated': {
      // Same shape of handling as `receipt`: a small delta patches the store
      // live (v0.2 §2.3). Persist the patched DTO so the IndexedDB window
      // shows reactions on next open; reconnect truth stays the DTO aggregate.
      // v0.4 (§1.19): kind='stamp' frames patch Message.stamps (faces) instead
      // of the emoji chips — the sentinel never renders as an emoji.
      if (ev.d.kind === 'stamp') store.applyStampUpdated(ev.d);
      else store.applyReactionUpdated(ev.d);
      const conv = store.state.conversations.get(ev.d.conversation_id);
      const patched =
        store.state.messages.get(ev.d.conversation_id)?.find((m) => m.seq === ev.d.seq) ??
        (conv?.last_message?.seq === ev.d.seq ? conv.last_message : undefined);
      if (patched) {
        void db.storeMessages(ev.d.conversation_id, [patched]).catch(() => undefined);
      }
      break;
    }
    case 'preview.ready':
      store.setPreview(ev.d.url_hash, { status: ev.d.status, preview: ev.d.preview ?? null });
      break;
    // v0.3 beacons (§1.15): the gateway already stamped viewer-specific fields
    // (my_state, conversation_id) — apply as-is. Non-visible states retire the
    // card silently inside upsertBeacon (never "cancelled on you" copy).
    case 'beacon.new':
      store.upsertBeacon(ev.d.beacon);
      break;
    case 'beacon.updated':
      // v0.7 (§1.47): edited/changed mark a creator edit so cards can flash
      // the changed chips; the DTO carries the full new state either way.
      store.upsertBeacon(ev.d.beacon, ev.d.reping, ev.d.edited, ev.d.changed);
      break;
    // PRIVATE kudos — this socket IS the recipient; never rendered publicly.
    case 'beacon.kudos':
      store.addKudos(ev.d);
      break;
    // v0.3 plan roles (§1.16): full-list replace, idempotent and reorder-safe.
    case 'plan.updated':
      store.setPlanRoles(ev.d.beacon_id, ev.d.roles);
      break;
    // v0.3 polls (§1.17): the reaction.updated pattern — small delta patches
    // the aggregate live; persist the patched DTO so IndexedDB stays warm.
    case 'poll.updated': {
      store.applyPollUpdated(ev.d);
      const conv = store.state.conversations.get(ev.d.conversation_id);
      const patched =
        store.state.messages.get(ev.d.conversation_id)?.find((m) => m.seq === ev.d.seq) ??
        (conv?.last_message?.seq === ev.d.seq ? conv.last_message : undefined);
      if (patched) {
        void db.storeMessages(ev.d.conversation_id, [patched]).catch(() => undefined);
      }
      break;
    }
    // v0.4 (§1.24): personal chat prefs — this frame only ever reaches MY own
    // sockets; full-prefs replace, reconcile from GET prefs on demand.
    case 'conv.background':
      // v1.0a (#95): the shared chat background changed — all members get it.
      store.setSharedBackground(ev.d.conversation_id, ev.d.background);
      break;
    case 'prefs.updated':
      store.setPrefs(ev.d.prefs);
      break;
    // v0.4 (§1.26): my scheduled list changed (create/cancel/send) — author's
    // own sockets only; the delivery itself arrives as an ordinary msg.new.
    case 'scheduled.updated':
      store.upsertScheduled(ev.d.scheduled);
      break;
    // v0.5a (§1.28): to the two parties only; viewer-specific DTO stamped at
    // the gateway. removed:true = decline/remove — the row is gone.
    case 'connection.updated':
      store.applyConnectionUpdated(ev.d.connection, ev.d.removed);
      break;
    // v0.5a (§1.34): only sockets of the author's friends-of audience get this;
    // `viewed` is stamped false per recipient. No push, ever.
    case 'story.new':
      store.applyStoryNew(ev.d.story);
      break;
    // v0.5a (§1.36): friends-of audience only. Reactions/comments deliberately
    // fan out nothing — the feed reconciles from GET when the viewer returns.
    // v0.7 (§1.50): join_card frames arrive with ref_summary stripped (it is
    // viewer-specific) — adoptIncomingPost resolves MY view via GET first.
    case 'post.new':
      void adoptIncomingPost(ev.d.post);
      break;
    // v0.6 calls (§1.42/§2.12): relayed signaling + the server-emitted
    // call.updated all route to the media engine (lib/webrtc.ts).
    case 'call.invite':
      // v1.0 (owner: "see WHO called"): the invite frame carries only ids —
      // when the conversation (or the caller among its participants) is not
      // in the store yet (fresh session, brand-new DM), backfill it so the
      // ring card upgrades from "Someone" to name + avatar reactively.
      {
        const inv = ev.d;
        const known = store.state.conversations.get(inv.conversation_id);
        const callerKnown =
          known !== undefined &&
          known.participants.some((pt) => pt.user.id === inv.from_user);
        if (!callerKnown) void adoptConversationById(inv.conversation_id, true);
      }
      handleCallEvent(ev);
      break;
    case 'call.ringing':
    case 'call.accept':
    case 'call.reject':
    case 'call.offer':
    case 'call.answer':
    case 'call.ice':
    case 'call.leave':
    case 'call.end':
    // v0.7.1 (§2.12): relayed peer connection-state reports — same route.
    case 'call.state':
    case 'call.updated':
      handleCallEvent(ev);
      break;
    // v0.6 watch together (§1.43): full-state frames mirror into the store.
    case 'watch.start':
    case 'watch.sync':
    case 'watch.stop':
      handleWatchEvent(ev);
      break;
    // v0.6 (§1.44): a mutual wave — frame is stamped with the OTHER party.
    // The new DM rides its own fan-out; adopt it eagerly so "Say hi" opens
    // a live conversation even before the next sync.
    case 'discovery.matched': {
      store.setDiscoveryMatch(ev.d);
      void adoptConversationById(ev.d.conversation_id);
      void refreshConnections(); // they just became friends-of
      break;
    }
    // v0.6 (§1.45): the provisional DM (viewer-stamped roulette.kept:false).
    case 'roulette.matched':
      store.upsertConversation(ev.d.conversation);
      void db
        .adoptConversation(ev.d.conversation.id, ev.d.conversation.last_seq, null)
        .catch(() => undefined);
      store.setRouletteQueued(false);
      store.setRouletteMatchNav(ev.d.conversation.id);
      break;
    // v0.6 (§1.45): hard-deleted server-side — drop local state, goodbye.
    case 'roulette.expired':
      onRouletteExpired(ev.d.conversation_id);
      break;
    // v0.8b (§1.62): viewer-stamped anon-thread update — to the two parties
    // only. Reconnect truth is GET /api/anon/threads, never frame replay.
    case 'anon.updated':
      store.applyAnonUpdated(ev.d.thread, ev.d.message);
      break;
    // v0.8b (§1.66): full-story replace on canvas changes (overlay add /
    // remove / approve, canvas_mode switch) — audience sockets only.
    case 'story.updated':
      store.replaceStoryLocal(ev.d.story);
      break;
    // v0.8b (§1.63): the anonymous wave nudge — DELIBERATELY empty (no
    // identity, no count, no per-card link). Rendered as a quiet line on the
    // discovery surface, never a toast (toasts confirm MY actions only).
    case 'discovery.nudge':
      store.setDiscoveryNudge(Date.now());
      break;
    case 'error':
      break;
  }
}

/** Fetch + adopt a conversation the server just created for me (mutual wave):
 * conv.new may race or be missed; GET is the reconcile (§2.8 doctrine).
 * Exported for v1.0 call-invite identity backfill (webrtc.ts); `force`
 * refetches even when a (possibly stale) row is already in the store. */
export async function adoptConversationById(
  conversationId: string,
  force = false,
): Promise<void> {
  if (!force && store.state.conversations.has(conversationId)) return;
  try {
    const res = await api.get<{ conversation: import('@socialchat/shared').Conversation }>(
      `/api/conversations/${conversationId}`
    );
    store.upsertConversation(res.conversation);
    await db
      .adoptConversation(res.conversation.id, res.conversation.last_seq, null)
      .catch(() => undefined);
  } catch {
    /* the next sync snapshot carries it */
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

// presence.sub / presence.unsub frames are capped at PRESENCE_SUB_MAX ids
// each (API.md §2.4) — an oversized frame fails server-side validation, costs
// a protocol strike and silently drops the whole subscription, so always
// chunk to the cap.
function sendPresenceFrames(t: 'presence.sub' | 'presence.unsub', userIds: string[]): void {
  for (const ids of chunk(userIds, PRESENCE_SUB_MAX)) {
    send({ t, d: { user_ids: ids } });
  }
}

export function subscribePresence(userIds: string[]): void {
  const fresh = userIds.filter((id) => !presenceSubs.has(id));
  for (const id of fresh) presenceSubs.add(id);
  if (fresh.length) sendPresenceFrames('presence.sub', fresh);
}

export function unsubscribePresence(userIds: string[]): void {
  const gone = userIds.filter((id) => presenceSubs.has(id));
  for (const id of gone) presenceSubs.delete(id);
  if (gone.length) sendPresenceFrames('presence.unsub', gone);
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

  // Beacon cards & radar reconcile from REST on every (re)connect — WS frames
  // missed while offline never replay (§2.8 doctrine, same as reactions).
  void refreshBeacons();

  // v0.5a surfaces reconcile from REST the same way: connections and the story
  // tray always (they power header badges and the strip); the feed only when a
  // window is already open — its own tab fetches on first visit.
  void refreshConnections();
  void refreshStories();
  // v0.7 (§1.49): lanes reconcile independently — only windows already open.
  for (const lane of ['friends', 'discover'] as const) {
    if (store.state.feed[lane].posts !== null) void refreshFeed(lane).catch(() => undefined);
  }
  // v0.6 (§1.44): my opt-in state reconciles from REST once the Local tab has
  // looked at it (frames never carry it — it is owner-only state).
  if (store.state.discoveryLoaded) void refreshOptin();

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
      // Caught up by seq — but reactions and edits don't bump seq (§1.12), so
      // frames missed while disconnected leave stale aggregates behind.
      // Reconnect truth is the DTO aggregate: adopt the snapshot's fresh
      // last_message, and refetch the newest page for any conversation whose
      // message window is loaded (typically the open one).
      if (conv.last_message) {
        store.replaceMessage(conv.last_message);
        await db.storeMessages(conv.id, [conv.last_message]).catch(() => undefined);
      }
      if ((store.state.messages.get(conv.id)?.length ?? 0) > 0) {
        await refreshNewestPage(conv.id, conv.last_seq, run);
      }
      if (run !== syncRun) return;
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
  // Presence subs are per-socket; re-subscribe after reconnect, chunked to
  // PRESENCE_SUB_MAX ids per frame (the accumulated set can exceed the cap).
  if (presenceSubs.size) sendPresenceFrames('presence.sub', [...presenceSubs]);
}

/**
 * Refresh the newest page of an already-caught-up conversation so seq-less
 * deltas (reactions §1.12, edits) missed while disconnected reconcile from the
 * DTO aggregate. Fresh DTOs replace stale ones by (conversation_id, seq) in
 * both the store and IndexedDB; failures are benign (next open refetches).
 */
async function refreshNewestPage(conversationId: string, lastSeq: number, run: number): Promise<void> {
  let page: ListMessagesResponse;
  try {
    page = await api.get<ListMessagesResponse>(
      `/api/conversations/${conversationId}/messages?before_seq=${lastSeq + 1}&limit=${PAGE_SIZE_DEFAULT}`
    );
  } catch {
    return;
  }
  if (run !== syncRun || page.messages.length === 0) return;
  store.addMessages(conversationId, page.messages);
  await db.storeMessages(conversationId, page.messages).catch(() => undefined);
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
