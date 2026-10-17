// WS gateway (API.md §2): upgrade on /ws authenticated by the session cookie,
// hello frame, heartbeat, ephemeral client events, Redis events-channel fan-out.
import type { IncomingMessage, Server } from 'node:http';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientCallAcceptEventSchema,
  ClientCallAnswerEventSchema,
  ClientCallEndEventSchema,
  ClientCallIceEventSchema,
  ClientCallInviteEventSchema,
  ClientCallLeaveEventSchema,
  ClientCallOfferEventSchema,
  ClientCallRejectEventSchema,
  ClientCallRingingEventSchema,
  ClientCallStateEventSchema,
  ClientTypingEventSchema,
  ClientWatchStartEventSchema,
  ClientWatchStopEventSchema,
  ClientWatchSyncEventSchema,
  DeliveredEventSchema,
  OFFLINE_GRACE_S,
  PRESENCE_SUB_MAX,
  PRESENCE_TTL_S,
  PresenceSubEventSchema,
  PresenceUnsubEventSchema,
  RECEIPT_COALESCE_MS,
  ReadEventSchema,
  type ServerEvent,
  TYPING_TTL_S,
  WATCH_SESSION_TTL_S,
  WATCH_SYNC_MIN_INTERVAL_MS,
  WS_CLOSE_CODES,
  WS_IDLE_CLOSE_S,
  WS_PING_S,
  extractYoutubeVideoId,
  type CallKind,
  type ReadEvent,
  type DeliveredEvent,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import { createRedis, presenceKey, redis } from '../redis.js';
import { authenticateToken, SESSION_COOKIE } from '../modules/auth/service.js';
import { filterBlockedFrom, isBlockedPair } from '../lib/blocks.js';
import { activeParticipantUserIds } from '../lib/dto.js';
import { callMembersKey, isCallMember, loadCall, type CallRow } from '../modules/calls/service.js';
import { EVENTS_CHANNEL, type EventEnvelope, publishPresence, publishToUsers, queueReceipt } from './events.js';
import { registry, type SocketMeta } from './registry.js';

const MAX_STRIKES = 3;

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { t: 'error', d: { code, message } });
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

const lastAlive = new WeakMap<WebSocket, number>();
const offlineGraceTimers = new Map<string, NodeJS.Timeout>();

async function markOnline(userId: string): Promise<void> {
  const timer = offlineGraceTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    offlineGraceTimers.delete(userId);
  }
  await redis.set(presenceKey(userId), '1', 'EX', PRESENCE_TTL_S);
  await publishPresence(userId, true);
}

// Last socket closed: 15 s grace (debounces refresh/navigation), then flush
// users.last_seen_at and broadcast offline (API.md §2.7).
function scheduleOffline(userId: string): void {
  const existing = offlineGraceTimers.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    offlineGraceTimers.delete(userId);
    void (async () => {
      if (registry.userHasSockets(userId)) return;
      await redis.del(presenceKey(userId));
      const lastSeenAt = new Date();
      await db
        .update(schema.users)
        .set({ lastSeenAt })
        .where(eq(schema.users.id, userId));
      await publishPresence(userId, false, lastSeenAt.toISOString());
    })();
  }, OFFLINE_GRACE_S * 1000);
  timer.unref();
  offlineGraceTimers.set(userId, timer);
}

// Monotonic watermark update, clamped to the conversation's last_seq so a
// hostile client cannot run cursors ahead of real messages. Hotspot H4: the
// UPDATE fires ONLY when a watermark actually advances — a replayed/no-op
// frame costs one PK lookup and returns null, so it triggers no settings
// reads and no receipt fan-out (monotonic state: everyone already holds
// frames with values ≥ these).
async function updateWatermarks(
  userId: string,
  conversationId: string,
  seq: number,
  raiseRead: boolean,
): Promise<{ last_delivered_seq: number; last_read_seq: number } | null> {
  const readExpr = raiseRead
    ? sql`GREATEST(cp.last_read_seq, LEAST(${seq}::bigint, c.last_seq))`
    : sql`cp.last_read_seq`;
  const rows = (await db.execute(sql`
    UPDATE conversation_participants cp SET
      last_delivered_seq = GREATEST(cp.last_delivered_seq, LEAST(${seq}::bigint, c.last_seq)),
      last_read_seq = ${readExpr}
    FROM conversations c
    WHERE c.id = cp.conversation_id
      AND cp.conversation_id = ${conversationId}
      AND cp.user_id = ${userId}
      AND cp.left_at IS NULL
      AND (cp.last_delivered_seq < LEAST(${seq}::bigint, c.last_seq)
           OR (${raiseRead} AND cp.last_read_seq < LEAST(${seq}::bigint, c.last_seq)))
    RETURNING cp.last_delivered_seq AS d, cp.last_read_seq AS r
  `)) as unknown as { d: string | number; r: string | number }[];
  const row = rows[0];
  if (!row) return null;
  return { last_delivered_seq: Number(row.d), last_read_seq: Number(row.r) };
}

async function isActiveParticipant(userId: string, conversationId: string): Promise<boolean> {
  const cp = schema.conversationParticipants;
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(cp)
    .where(and(eq(cp.conversationId, conversationId), eq(cp.userId, userId), isNull(cp.leftAt)))
    .limit(1);
  return row !== undefined;
}

async function allowedPresenceTargets(me: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  // §1.14/§2.11: subscriptions between blocked pairs are silently dropped —
  // indistinguishable from the existing not-shared-a-conversation drop.
  // v0.8b (§1.68): presence is suppressed entirely in 👻 ghost groups — a
  // conversation shared only there never qualifies a presence subscription.
  const rows = (await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM conversation_participants mine
    JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
    JOIN conversations gc ON gc.id = mine.conversation_id AND gc.visibility <> 'ghost'
    WHERE mine.user_id = ${me} AND mine.left_at IS NULL AND other.left_at IS NULL
      AND other.user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      AND NOT EXISTS (
        SELECT 1 FROM blocks bl
        WHERE (bl.blocker_id = ${me} AND bl.blocked_id = other.user_id)
           OR (bl.blocker_id = other.user_id AND bl.blocked_id = ${me}))
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/**
 * show_last_seen qualification (§1.13): which of `watcherIds` may see
 * `ownerId`'s last_seen_at. The `online` boolean is unaffected (live state,
 * not a timestamp); blocked watchers were already dropped at sub time.
 */
async function lastSeenAudience(ownerId: string, watcherIds: string[]): Promise<Set<string>> {
  if (watcherIds.length === 0) return new Set();
  const [owner] = await db
    .select({ showLastSeen: schema.users.showLastSeen })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  const mode = owner?.showLastSeen ?? 'everyone';
  if (mode === 'nobody') return new Set(watcherIds.filter((id) => id === ownerId));
  if (mode === 'everyone') return new Set(watcherIds);
  // dm_partners: shares an active DM with the owner.
  const rows = (await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM conversation_participants mine
    JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
    JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
    WHERE mine.user_id = ${ownerId} AND mine.left_at IS NULL AND other.left_at IS NULL
      AND other.user_id IN (${sql.join(watcherIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { user_id: string }[];
  const set = new Set(rows.map((r) => r.user_id));
  if (watcherIds.includes(ownerId)) set.add(ownerId);
  return set;
}

/**
 * Reciprocal read receipts at the edge (v0.3 — API.md §1.13b/§2.11):
 * watermarks ALWAYS advance (unread counts + §2.9 push guards untouched);
 * only the FRAME is filtered. Own sessions get true values (cross-device
 * unread sync). Other recipients get the true last_read_seq only when BOTH
 * the reader and that recipient have read_receipts on — otherwise it is
 * clamped to 0. last_delivered_seq is never clamped.
 */
async function applyReceipt(
  meta: SocketMeta,
  conversationId: string,
  seq: number,
  raiseRead: boolean,
): Promise<void> {
  const updated = await updateWatermarks(meta.userId, conversationId, seq, raiseRead);
  if (!updated) return; // no advance (or not a participant) → nothing to fan out

  // v0.5a §1.35/§2.11: receipt frames for CHANNELS go to the reader's own
  // sockets only (cross-device unread sync) — never a 10k fan-out per read.
  const [convRow] = await db
    .select({ type: schema.conversations.type, visibility: schema.conversations.visibility })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  // v0.8b (§1.68): 👻 ghost groups — receipt frames go to the reader's own
  // sockets only (cross-device unread sync); a watermark frame to anyone else
  // is an identity side channel. Same shape as channels.
  if (convRow?.type === 'channel' || convRow?.visibility === 'ghost') {
    queueReceipt(
      {
        conversation_id: conversationId,
        user_id: meta.userId,
        last_delivered_seq: updated.last_delivered_seq,
        last_read_seq: updated.last_read_seq,
      },
      [meta.userId],
      'full',
    );
    return;
  }

  // Hotspot H4: ONE query for the recipient set AND everyone's read_receipts
  // (it was three — participant ids, reader's setting, others' settings).
  const rows = await db
    .select({ id: schema.users.id, readReceipts: schema.users.readReceipts })
    .from(schema.conversationParticipants)
    .innerJoin(schema.users, eq(schema.conversationParticipants.userId, schema.users.id))
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, conversationId),
        isNull(schema.conversationParticipants.leftAt),
      ),
    );
  const others = rows.filter((r) => r.id !== meta.userId);
  const readerOn = rows.find((r) => r.id === meta.userId)?.readReceipts ?? true;

  let trueGroup: string[] = [meta.userId];
  let clampedGroup: string[] = others.map((r) => r.id);
  if (readerOn && others.length > 0) {
    trueGroup = [meta.userId, ...others.filter((r) => r.readReceipts).map((r) => r.id)];
    clampedGroup = others.filter((r) => !r.readReceipts).map((r) => r.id);
  }

  const base = {
    conversation_id: conversationId,
    user_id: meta.userId,
    last_delivered_seq: updated.last_delivered_seq,
  };
  queueReceipt({ ...base, last_read_seq: updated.last_read_seq }, trueGroup, 'full');
  queueReceipt({ ...base, last_read_seq: 0 }, clampedGroup, 'clamped');
}

/**
 * Hotspot H4: inbound read/delivered frames were unthrottled — 4 DB queries
 * per frame let one hostile client in one group peg API + PG. This is the
 * inbound twin of the outbound 1 s coalescer: at most one watermark apply per
 * (socket, conversation) per RECEIPT_COALESCE_MS, trailing flush, merging by
 * max(seq) and OR(raiseRead) — lossless, because watermarks are monotonic
 * maxima and read implies delivered.
 */
function handleReceiptFrame(
  meta: SocketMeta,
  d: DeliveredEvent['d'] | ReadEvent['d'],
  raiseRead: boolean,
): void {
  const convId = d.conversation_id;
  const gate = meta.receiptGates.get(convId);
  if (gate) {
    gate.pending = {
      seq: Math.max(gate.pending?.seq ?? 0, d.seq),
      raiseRead: (gate.pending?.raiseRead ?? false) || raiseRead,
    };
    return;
  }
  void applyReceipt(meta, convId, d.seq, raiseRead).catch((err) =>
    console.error('ws: receipt apply failed', err),
  );
  const timer = setTimeout(() => flushReceiptGate(meta, convId), RECEIPT_COALESCE_MS);
  timer.unref();
  meta.receiptGates.set(convId, { timer, pending: null });
}

function flushReceiptGate(meta: SocketMeta, convId: string): void {
  const gate = meta.receiptGates.get(convId);
  if (!gate) return;
  const pending = gate.pending;
  if (!pending) {
    meta.receiptGates.delete(convId);
    return;
  }
  gate.pending = null;
  void applyReceipt(meta, convId, pending.seq, pending.raiseRead).catch((err) =>
    console.error('ws: receipt apply failed', err),
  );
  gate.timer = setTimeout(() => flushReceiptGate(meta, convId), RECEIPT_COALESCE_MS);
  gate.timer.unref();
}

/** Socket closed: cancel timers and apply any merged pending receipt now, so
 * a read sent just before a disconnect is not lost. */
function drainReceiptGates(meta: SocketMeta): void {
  for (const [convId, gate] of meta.receiptGates) {
    clearTimeout(gate.timer);
    const pending = gate.pending;
    if (pending) {
      void applyReceipt(meta, convId, pending.seq, pending.raiseRead).catch((err) =>
        console.error('ws: receipt drain failed', err),
      );
    }
  }
  meta.receiptGates.clear();
}

// ---------------------------------------------------------------------------
// v0.6 §2.12 — ephemeral call & watch signaling. Every frame here is
// validated, authorized PER FRAME (active participant of the call's
// conversation; live call member past the invite stage), relayed to specific
// recipients with from_user stamped server-side, and DROPPED — never written
// to Postgres or Redis, never replayed. Blocked pairs never exchange relayed
// frames (§2.11); violations answer 404-shaped codes where a block could
// otherwise be confirmed.
// ---------------------------------------------------------------------------

// Per-socket signaling flood guards (fixer r1 — the audit's "per-socket
// signaling rate limit" covers EVERY relayed frame, not just ICE). One fixed
// 10 s window per (socket, kind, call|conversation); budgets sized so no real
// client ever hits them, while line-rate spam is dropped BEFORE the per-frame
// loadCall/SISMEMBER work and before any fan-out (a 64 KiB offer loop and a
// call.invite re-ring storm both die here at ~zero cost per frame).
const SIGNAL_RELAY_WINDOW_MS = 10_000;
const CALL_ICE_RELAY_MAX = 50; // trickle ICE for ≤7 mesh peers
const CALL_SDP_RELAY_MAX = 30; // offers+answers: join to 7 peers + glare + ICE restarts
const CALL_INVITE_RELAY_MAX = 2; // the client sends exactly one per call
const CALL_CTL_RELAY_MAX = 20; // ringing/accept/reject/leave/end combined
// v0.7.1 (§2.12): call.state gets its OWN budget — a flapping network emits
// reconnecting/connected flips and must not starve the hang-up budget above.
const CALL_STATE_RELAY_MAX = 20;
const WATCH_START_RELAY_MAX = 5; // retries after watch_active/bad-URL errors
// window/interval = 10_000/250: the budget a host obeying the 250ms
// min-interval exactly fills, so no real client ever hits it.
const WATCH_SYNC_RELAY_MAX = SIGNAL_RELAY_WINDOW_MS / WATCH_SYNC_MIN_INTERVAL_MS;
const WATCH_STOP_RELAY_MAX = 5; // one real stop + retries after watch_not_host
// A socket holding this many live gate windows is scanning call/conversation
// ids, not calling; expired windows are evicted first, then frames drop.
const SIG_GATES_PER_SOCKET_MAX = 64;

/** Authorization anchor for call.* frames: the call exists and the sender is
 * an active participant of its conversation; past the invite stage also a
 * live member of the call (the Redis set). Errors reply on the socket and
 * return null (the frame is dropped). */
async function authorizeCallFrame(
  ws: WebSocket,
  meta: SocketMeta,
  callId: string,
  requireMember: boolean,
): Promise<CallRow | null> {
  const call = await loadCall(callId);
  if (!call || !(await isActiveParticipant(meta.userId, call.conversationId))) {
    sendError(ws, 'not_found', 'unknown call');
    return null;
  }
  if (requireMember && !(await isCallMember(call.id, meta.userId))) {
    sendError(ws, 'call_not_member', 'not a live member of this call');
    return null;
  }
  return call;
}

/** Point-to-point relay (offer/answer/ice): to_user is consumed here — the
 * frame goes to that user's sockets only, and only while they are a live call
 * member (else silently dropped: they just left, the call.updated catching
 * the sender up is already in flight). Blocked pairs never exchange frames. */
async function relayToCallPeer(
  meta: SocketMeta,
  call: CallRow,
  toUser: string,
  event: ServerEvent,
): Promise<void> {
  if (toUser === meta.userId) return;
  if (!(await isCallMember(call.id, toUser))) return;
  if (await isBlockedPair(meta.userId, toUser)) return;
  await publishToUsers([toUser], event);
}

/** Signaling flood guard (fixer r1): at most `max` relays per (socket, key)
 * per SIGNAL_RELAY_WINDOW_MS; excess dropped without error — well-formed
 * frames never strike (strikes are for protocol violations), they just stop
 * costing anything. Checked BEFORE authorization so dropped frames do no DB
 * or Redis work; the key map is capped so made-up ids cannot grow it. */
function sigGateAllows(meta: SocketMeta, key: string, max: number): boolean {
  const now = Date.now();
  const gate = meta.sigGates.get(key);
  if (gate && now - gate.windowStart < SIGNAL_RELAY_WINDOW_MS) {
    gate.count += 1;
    return gate.count <= max;
  }
  if (!gate && meta.sigGates.size >= SIG_GATES_PER_SOCKET_MAX) {
    for (const [k, g] of meta.sigGates) {
      if (now - g.windowStart >= SIGNAL_RELAY_WINDOW_MS) meta.sigGates.delete(k);
    }
    if (meta.sigGates.size >= SIG_GATES_PER_SOCKET_MAX) return false;
  }
  meta.sigGates.set(key, { windowStart: now, count: 1 });
  return true;
}

interface WatchState {
  video_id: string;
  host_id: string;
  position_s: number;
  playing: boolean;
}

const watchKey = (conversationId: string): string => `watch:${conversationId}`;

async function readWatchState(conversationId: string): Promise<WatchState | null> {
  const raw = await redis.get(watchKey(conversationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WatchState;
  } catch {
    return null;
  }
}

/** Watch-together recipients: all active participants minus blocked pairs
 * w.r.t. the sender (§2.11) — the typing fan-out shape, sender's own other
 * devices included so every surface of one user stays in sync. */
async function watchRecipients(senderId: string, conversationId: string): Promise<string[]> {
  const participants = await activeParticipantUserIds(conversationId);
  const others = await filterBlockedFrom(
    senderId,
    participants.filter((id) => id !== senderId),
  );
  return [senderId, ...others];
}

async function handleFrame(ws: WebSocket, meta: SocketMeta, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    strike(ws, meta, 'bad_json', 'frames must be JSON');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') {
    strike(ws, meta, 'bad_frame', 'expected {"t","d"}');
    return;
  }
  const t = (parsed as { t: string }).t;

  switch (t) {
    case 'delivered': {
      const result = DeliveredEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid delivered frame');
      handleReceiptFrame(meta, result.data.d, false);
      return;
    }
    case 'read': {
      const result = ReadEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid read frame');
      // Read implies delivered (API.md §2.4).
      handleReceiptFrame(meta, result.data.d, true);
      return;
    }
    case 'typing': {
      const result = ClientTypingEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid typing frame');
      const { conversation_id } = result.data.d;
      if (!(await isActiveParticipant(meta.userId, conversation_id))) return;
      // v0.5a §1.35/§2.11: typing frames for CHANNEL conversations are dropped
      // at ingest unconditionally — whatever the sender's show_typing says.
      // v0.8b (§1.68): 👻 ghost groups drop typing the same way — the frame's
      // user_id is an identity, and masks never type.
      const [convRow] = await db
        .select({ type: schema.conversations.type, visibility: schema.conversations.visibility })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversation_id))
        .limit(1);
      if (convRow?.type === 'channel' || convRow?.visibility === 'ghost') return;
      // §1.13 show_typing: suppressed AT INGEST, before rebroadcast. No error
      // frame — typing is best-effort ephemera.
      const [sender] = await db
        .select({ showTyping: schema.users.showTyping })
        .from(schema.users)
        .where(eq(schema.users.id, meta.userId))
        .limit(1);
      if (!sender?.showTyping) return;
      const expiresAt = new Date(Date.now() + TYPING_TTL_S * 1000).toISOString();
      // §1.14/§2.11: never rebroadcast typing between blocked pairs.
      const others = await filterBlockedFrom(
        meta.userId,
        (await activeParticipantUserIds(conversation_id)).filter((id) => id !== meta.userId),
      );
      await publishToUsers(others, {
        t: 'typing',
        d: { conversation_id, user_id: meta.userId, expires_at: expiresAt },
      });
      return;
    }
    case 'presence.sub': {
      const result = PresenceSubEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid presence.sub frame');
      const requested = result.data.d.user_ids;
      const room = PRESENCE_SUB_MAX - meta.presenceSubs.size;
      // Must share a conversation, else silently dropped; cap 100 per socket.
      const allowed = (await allowedPresenceTargets(meta.userId, requested)).slice(0, Math.max(0, room));
      registry.subscribePresence(ws, allowed);
      if (allowed.length === 0) return;
      const pipeline = redis.pipeline();
      for (const id of allowed) pipeline.exists(presenceKey(id));
      const results = (await pipeline.exec()) ?? [];
      const userRows = await db
        .select({
          id: schema.users.id,
          lastSeenAt: schema.users.lastSeenAt,
          showLastSeen: schema.users.showLastSeen,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, allowed));
      const byId = new Map(userRows.map((u) => [u.id, u]));
      // §1.13 show_last_seen for the immediate replies: 'dm_partners' needs
      // one shared-DM lookup for the subscriber.
      const dmPartnerRows = (await db.execute(sql`
        SELECT DISTINCT other.user_id AS user_id
        FROM conversation_participants mine
        JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
        JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
        WHERE mine.user_id = ${meta.userId} AND mine.left_at IS NULL AND other.left_at IS NULL
      `)) as unknown as { user_id: string }[];
      const dmPartners = new Set(dmPartnerRows.map((r) => r.user_id));
      allowed.forEach((id, i) => {
        const online = results[i]?.[1] === 1;
        const row = byId.get(id);
        const qualifies =
          id === meta.userId ||
          row?.showLastSeen === 'everyone' ||
          (row?.showLastSeen === 'dm_partners' && dmPartners.has(id));
        const lastSeen = row?.lastSeenAt ?? null;
        send(ws, {
          t: 'presence',
          d: {
            user_id: id,
            online,
            ...(lastSeen && !online && qualifies ? { last_seen_at: lastSeen.toISOString() } : {}),
          },
        });
      });
      return;
    }
    case 'presence.unsub': {
      const result = PresenceUnsubEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid presence.unsub frame');
      registry.unsubscribePresence(ws, result.data.d.user_ids);
      return;
    }

    // ---- v0.6 §2.12: relayed call signaling (ephemeral, never persisted) ----

    case 'call.invite': {
      const result = ClientCallInviteEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid call.invite frame');
      // Flood guard first: a re-sent invite fans an enriched frame to up to
      // 255 participants — the cheapest amplification here, so the tightest cap.
      if (!sigGateAllows(meta, `inv:${result.data.d.call_id}`, CALL_INVITE_RELAY_MAX)) return;
      const call = await authorizeCallFrame(ws, meta, result.data.d.call_id, false);
      if (!call) return;
      // Only the initiator invites, and only while the call rings — anything
      // else is 404-shaped (no leak about the call's life).
      if (call.initiatorId !== meta.userId || call.status !== 'ringing') {
        return sendError(ws, 'not_found', 'unknown call');
      }
      const others = await filterBlockedFrom(
        meta.userId,
        (await activeParticipantUserIds(call.conversationId)).filter((id) => id !== meta.userId),
      );
      // Enriched so callees ring with zero fetches (§2.12).
      await publishToUsers(others, {
        t: 'call.invite',
        d: {
          call_id: call.id,
          conversation_id: call.conversationId,
          kind: call.kind as CallKind,
          from_user: meta.userId,
        },
      });
      return;
    }
    case 'call.ringing':
    case 'call.accept':
    case 'call.reject': {
      const schema2 =
        t === 'call.ringing'
          ? ClientCallRingingEventSchema
          : t === 'call.accept'
            ? ClientCallAcceptEventSchema
            : ClientCallRejectEventSchema;
      const result = schema2.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', `invalid ${t} frame`);
      if (!sigGateAllows(meta, `ctl:${result.data.d.call_id}`, CALL_CTL_RELAY_MAX)) return;
      const call = await authorizeCallFrame(ws, meta, result.data.d.call_id, false);
      if (!call) return;
      // ringing → initiator; accept/reject → initiator + the sender's own
      // other sockets (which stop ringing). Blocked pairs never relayed.
      const recipients: string[] = t === 'call.ringing' ? [] : [meta.userId];
      if (
        call.initiatorId &&
        call.initiatorId !== meta.userId &&
        !(await isBlockedPair(meta.userId, call.initiatorId))
      ) {
        recipients.push(call.initiatorId);
      }
      if (recipients.length === 0) return;
      await publishToUsers(recipients, {
        t,
        d: { call_id: call.id, from_user: meta.userId },
      } as ServerEvent);
      return;
    }
    case 'call.offer':
    case 'call.answer': {
      const schema2 = t === 'call.offer' ? ClientCallOfferEventSchema : ClientCallAnswerEventSchema;
      const result = schema2.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', `invalid ${t} frame`);
      const { call_id, to_user, sdp } = result.data.d;
      // Each offer/answer is up to 64 KiB of SDP relayed verbatim — gate
      // before the loadCall/member queries (drop silently, like ICE).
      if (!sigGateAllows(meta, `sdp:${call_id}`, CALL_SDP_RELAY_MAX)) return;
      const call = await authorizeCallFrame(ws, meta, call_id, true);
      if (!call) return;
      await relayToCallPeer(meta, call, to_user, {
        t,
        d: { call_id: call.id, from_user: meta.userId, sdp },
      } as ServerEvent);
      return;
    }
    case 'call.ice': {
      const result = ClientCallIceEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid call.ice frame');
      const { call_id, to_user, candidate } = result.data.d;
      if (!sigGateAllows(meta, `ice:${call_id}`, CALL_ICE_RELAY_MAX)) return; // drop, no error
      const call = await authorizeCallFrame(ws, meta, call_id, true);
      if (!call) return;
      await relayToCallPeer(meta, call, to_user, {
        t: 'call.ice',
        d: { call_id: call.id, from_user: meta.userId, candidate },
      });
      return;
    }
    case 'call.leave':
    case 'call.end': {
      const schema2 = t === 'call.leave' ? ClientCallLeaveEventSchema : ClientCallEndEventSchema;
      const result = schema2.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', `invalid ${t} frame`);
      if (!sigGateAllows(meta, `ctl:${result.data.d.call_id}`, CALL_CTL_RELAY_MAX)) return;
      const call = await authorizeCallFrame(ws, meta, result.data.d.call_id, true);
      if (!call) return;
      // leave → all live call members (tiles drop instantly); end → members +
      // every ringing callee (stop ringing everywhere): the conversation's
      // active participants are exactly that superset. Minus blocks (§2.11).
      const pool =
        t === 'call.leave'
          ? await redis.smembers(callMembersKey(call.id))
          : await activeParticipantUserIds(call.conversationId);
      const others = await filterBlockedFrom(
        meta.userId,
        pool.filter((id) => id !== meta.userId),
      );
      const recipients = [meta.userId, ...others]; // own other devices too
      await publishToUsers(recipients, {
        t,
        d: { call_id: call.id, from_user: meta.userId },
      } as ServerEvent);
      return;
    }

    case 'call.state': {
      // v0.7.1 (§1.55/§2.12, ADR-017): self-reported aggregate connection
      // state, relayed to ALL live call members (the call.leave recipient set,
      // own other devices included) so peers' tiles say the truth
      // ("reconnecting…"). Advisory UI ephemera only: no server state changes,
      // no persistence, never replayed — reconnect truth stays call.updated.
      // ICE restart itself adds NO frame: it is restartIce() + a re-offer on
      // the existing call.offer/call.answer pair, indistinguishable from any
      // other renegotiation here, deliberately.
      const result = ClientCallStateEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid call.state frame');
      const { call_id, state } = result.data.d;
      // Own flood key (§2.12): a flapping network must not starve the
      // ringing/accept/reject/leave/end budget.
      if (!sigGateAllows(meta, `cst:${call_id}`, CALL_STATE_RELAY_MAX)) return;
      const call = await authorizeCallFrame(ws, meta, call_id, true);
      if (!call) return;
      const pool = await redis.smembers(callMembersKey(call.id));
      const others = await filterBlockedFrom(
        meta.userId,
        pool.filter((id) => id !== meta.userId),
      );
      await publishToUsers([meta.userId, ...others], {
        t: 'call.state',
        d: { call_id: call.id, from_user: meta.userId, state },
      });
      return;
    }

    // ---- v0.6 §1.43/§2.12: watch together (Redis-TTL ephemera) ----

    case 'watch.start': {
      const result = ClientWatchStartEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid watch.start frame');
      const { conversation_id, url } = result.data.d;
      // Flood guard (fixer r1): each attempt costs a participant query and a
      // Redis SET NX — cap it like the other signaling frames.
      if (!sigGateAllows(meta, `wst:${conversation_id}`, WATCH_START_RELAY_MAX)) return;
      // Participant-gated like typing: non-participants are silently dropped.
      if (!(await isActiveParticipant(meta.userId, conversation_id))) return;
      const videoId = extractYoutubeVideoId(url);
      if (!videoId) return sendError(ws, 'watch_bad_url', 'not a recognizable YouTube URL');
      const state: WatchState = {
        video_id: videoId,
        host_id: meta.userId,
        position_s: 0,
        playing: false,
      };
      // One active session per conversation: NX claims it atomically.
      const claimed = await redis.set(
        watchKey(conversation_id),
        JSON.stringify(state),
        'EX',
        WATCH_SESSION_TTL_S,
        'NX',
      );
      if (claimed !== 'OK') return sendError(ws, 'watch_active', 'a watch session is already live');
      await publishToUsers(await watchRecipients(meta.userId, conversation_id), {
        t: 'watch.start',
        d: {
          conversation_id,
          video_id: videoId,
          host: meta.userId,
          position_s: 0,
          playing: false,
        },
      });
      return;
    }
    case 'watch.sync': {
      const result = ClientWatchSyncEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid watch.sync frame');
      const { conversation_id, position_s, playing } = result.data.d;
      // Flood guards (fixer r2): the 250ms min-interval alone is bypassable
      // with made-up conversation ids (each unique UUID is a fresh key), so
      // the frame must ALSO pass the shared capped sigGate before any DB
      // work — made-up ids die on the 64-key cap, and even real ids cannot
      // exceed the window budget. The min-interval read costs nothing; its
      // stamp is written only after authorization, at relay time, so
      // watchSyncAt holds entries only for conversations the sender actually
      // hosts a live session in (bounded by real state, never by spam).
      const last = meta.watchSyncAt.get(conversation_id) ?? 0;
      const now = Date.now();
      if (now - last < WATCH_SYNC_MIN_INTERVAL_MS) return;
      if (!sigGateAllows(meta, `wsy:${conversation_id}`, WATCH_SYNC_RELAY_MAX)) return;
      if (!(await isActiveParticipant(meta.userId, conversation_id))) return;
      const state = await readWatchState(conversation_id);
      if (!state) return; // session lapsed — TTL expiry behaves as a stop
      if (state.host_id !== meta.userId) {
        return sendError(ws, 'watch_not_host', 'only the host syncs');
      }
      meta.watchSyncAt.set(conversation_id, now); // authorized relay — start the 250ms window
      const next: WatchState = { ...state, position_s, playing };
      // Every host sync refreshes the TTL (the §1.43 keepalive contract).
      await redis.set(watchKey(conversation_id), JSON.stringify(next), 'EX', WATCH_SESSION_TTL_S);
      await publishToUsers(await watchRecipients(meta.userId, conversation_id), {
        t: 'watch.sync',
        d: {
          conversation_id,
          video_id: next.video_id,
          host: next.host_id,
          position_s,
          playing,
        },
      });
      return;
    }
    case 'watch.stop': {
      const result = ClientWatchStopEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid watch.stop frame');
      const { conversation_id } = result.data.d;
      // Flood guard (fixer r2): watch.stop had none — each well-formed frame
      // with an arbitrary id cost a DB query + Redis GET at line rate.
      if (!sigGateAllows(meta, `wsp:${conversation_id}`, WATCH_STOP_RELAY_MAX)) return;
      if (!(await isActiveParticipant(meta.userId, conversation_id))) return;
      const state = await readWatchState(conversation_id);
      if (!state) return; // already gone — idempotent
      // Host stops; anyone may stop once the host has no live socket (§1.43).
      if (state.host_id !== meta.userId && registry.userHasSockets(state.host_id)) {
        return sendError(ws, 'watch_not_host', 'only the host stops a live session');
      }
      await redis.del(watchKey(conversation_id));
      await publishToUsers(await watchRecipients(meta.userId, conversation_id), {
        t: 'watch.stop',
        d: { conversation_id },
      });
      return;
    }

    default:
      // Unknown `t` values MUST be ignored (forward compatibility, API.md §2.2).
      return;
  }
}

function strike(ws: WebSocket, meta: SocketMeta, code: string, message: string): void {
  meta.strikes += 1;
  sendError(ws, code, message);
  if (meta.strikes >= MAX_STRIKES) {
    ws.close(WS_CLOSE_CODES.POLICY_VIOLATION, 'protocol violation');
  }
}

async function deliverPresence(env: Extract<EventEnvelope, { scope: 'presence' }>): Promise<void> {
  const watchers = registry.watchersOf(env.user_id);
  if (watchers.length === 0) return;
  const event = env.event;
  if (event.t !== 'presence') return;
  const hasLastSeen = event.d.last_seen_at !== undefined;
  const watcherUserIds = [
    ...new Set(watchers.map((ws) => registry.metaOf(ws)?.userId).filter((v): v is string => !!v)),
  ];
  // Blocks created AFTER a subscription still suppress frames (§1.14).
  const blockRows = (await db.execute(sql`
    SELECT blocked_id AS id FROM blocks WHERE blocker_id = ${env.user_id}
    UNION
    SELECT blocker_id AS id FROM blocks WHERE blocked_id = ${env.user_id}
  `)) as unknown as { id: string }[];
  const blocked = new Set(blockRows.map((r) => r.id));
  const qualified = hasLastSeen ? await lastSeenAudience(env.user_id, watcherUserIds) : null;
  for (const ws of watchers) {
    const meta = registry.metaOf(ws);
    if (!meta || blocked.has(meta.userId)) continue;
    if (!hasLastSeen || qualified?.has(meta.userId)) {
      send(ws, event);
    } else {
      // Non-qualifying subscribers get the online boolean without the stamp.
      send(ws, { t: 'presence', d: { user_id: event.d.user_id, online: event.d.online } });
    }
  }
}

function routeEnvelope(env: EventEnvelope): void {
  switch (env.scope) {
    case 'users': {
      for (const userId of env.user_ids) {
        for (const ws of registry.socketsForUser(userId)) send(ws, env.event);
      }
      return;
    }
    case 'presence': {
      // v0.3 (§2.11): the events channel stays an unfiltered firehose — the
      // per-watcher show_last_seen / block filtering happens HERE, where the
      // recipients are known.
      void deliverPresence(env).catch((err) => console.error('ws: presence deliver failed', err));
      return;
    }
    case 'session_close': {
      for (const ws of registry.socketsForSession(env.session_id)) {
        ws.close(env.code, 'session revoked');
      }
      return;
    }
    case 'user_sessions_close': {
      for (const ws of registry.socketsForUser(env.user_id)) {
        ws.close(env.code, 'session revoked');
      }
      return;
    }
  }
}

export function setupGateway(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // The Redis `events` channel subscriber — ALL server→client fan-out flows
  // through here (multi-node seam, ARCHITECTURE §3).
  const sub = createRedis();
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_channel: string, raw: string) => {
    try {
      routeEnvelope(JSON.parse(raw) as EventEnvelope);
    } catch (err) {
      console.error('ws: bad envelope', err);
    }
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onUpgrade(req, ws);
    });
  });

  async function onUpgrade(req: IncomingMessage, ws: WebSocket): Promise<void> {
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await authenticateToken(token) : null;
    if (!auth) {
      ws.close(WS_CLOSE_CODES.UNAUTHENTICATED, 'unauthenticated');
      return;
    }
    const meta: SocketMeta = {
      userId: auth.user.id,
      sessionId: auth.session.id,
      isAlive: true,
      strikes: 0,
      presenceSubs: new Set(),
      receiptGates: new Map(),
      sigGates: new Map(),
      watchSyncAt: new Map(),
    };
    const { firstSocketForUser } = registry.add(ws, meta);
    lastAlive.set(ws, Date.now());

    send(ws, {
      t: 'hello',
      d: {
        user_id: auth.user.id,
        session_id: auth.session.id,
        server_time: new Date().toISOString(),
        heartbeat_ms: WS_PING_S * 1000,
      },
    });

    if (firstSocketForUser) await markOnline(auth.user.id);

    ws.on('pong', () => lastAlive.set(ws, Date.now()));
    ws.on('message', (data) => {
      lastAlive.set(ws, Date.now());
      void handleFrame(ws, meta, data.toString()).catch((err) => {
        console.error('ws: frame handler failed', err);
        sendError(ws, 'internal', 'internal error');
      });
    });
    ws.on('close', () => {
      drainReceiptGates(meta);
      const removed = registry.remove(ws);
      if (removed?.lastSocketForUser) scheduleOffline(removed.meta.userId);
    });
    ws.on('error', () => ws.terminate());
  }

  // Heartbeat sweep: protocol ping every 25 s, close 1001 after 60 s silence;
  // refresh Redis presence for users with live sockets.
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws] of registry.allSockets()) {
      const alive = lastAlive.get(ws) ?? 0;
      if (now - alive > WS_IDLE_CLOSE_S * 1000) {
        ws.close(WS_CLOSE_CODES.GOING_AWAY, 'heartbeat timeout');
        setTimeout(() => ws.terminate(), 1000).unref();
        continue;
      }
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
    void (async () => {
      const pipeline = redis.pipeline();
      for (const userId of registry.onlineUserIds()) {
        pipeline.set(presenceKey(userId), '1', 'EX', PRESENCE_TTL_S);
      }
      await pipeline.exec();
    })();
  }, WS_PING_S * 1000);
  pingTimer.unref();

  // Session expiry mid-socket also closes 4401 (ARCHITECTURE §4).
  const expiryTimer = setInterval(() => {
    void (async () => {
      const live = registry.liveSessions();
      if (live.length === 0) return;
      const ids = live.map((s) => s.sessionId);
      const rows = await db
        .select({ id: schema.sessions.id, expiresAt: schema.sessions.expiresAt })
        .from(schema.sessions)
        .where(inArray(schema.sessions.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.expiresAt]));
      const now = Date.now();
      for (const { sessionId } of live) {
        const expiresAt = byId.get(sessionId);
        if (!expiresAt || expiresAt.getTime() <= now) {
          for (const ws of registry.socketsForSession(sessionId)) {
            ws.close(WS_CLOSE_CODES.UNAUTHENTICATED, 'session expired');
          }
        }
      }
    })();
  }, 10 * 60 * 1000);
  expiryTimer.unref();
}
