// WS gateway (API.md §2): upgrade on /ws authenticated by the session cookie,
// hello frame, heartbeat, ephemeral client events, Redis events-channel fan-out.
import type { IncomingMessage, Server } from 'node:http';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientTypingEventSchema,
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
  WS_CLOSE_CODES,
  WS_IDLE_CLOSE_S,
  WS_PING_S,
  type ReadEvent,
  type DeliveredEvent,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import { createRedis, presenceKey, redis } from '../redis.js';
import { authenticateToken, SESSION_COOKIE } from '../modules/auth/service.js';
import { filterBlockedFrom } from '../lib/blocks.js';
import { activeParticipantUserIds } from '../lib/dto.js';
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
  const rows = (await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM conversation_participants mine
    JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
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
