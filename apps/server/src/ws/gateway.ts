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
// hostile client cannot run cursors ahead of real messages.
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
  const rows = (await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM conversation_participants mine
    JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
    WHERE mine.user_id = ${me} AND mine.left_at IS NULL AND other.left_at IS NULL
      AND other.user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

async function handleReceiptFrame(
  meta: SocketMeta,
  d: DeliveredEvent['d'] | ReadEvent['d'],
  raiseRead: boolean,
): Promise<void> {
  const updated = await updateWatermarks(meta.userId, d.conversation_id, d.seq, raiseRead);
  if (!updated) return;
  const recipients = await activeParticipantUserIds(d.conversation_id);
  queueReceipt(
    {
      conversation_id: d.conversation_id,
      user_id: meta.userId,
      last_delivered_seq: updated.last_delivered_seq,
      last_read_seq: updated.last_read_seq,
    },
    recipients,
  );
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
      await handleReceiptFrame(meta, result.data.d, false);
      return;
    }
    case 'read': {
      const result = ReadEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid read frame');
      // Read implies delivered (API.md §2.4).
      await handleReceiptFrame(meta, result.data.d, true);
      return;
    }
    case 'typing': {
      const result = ClientTypingEventSchema.safeParse(parsed);
      if (!result.success) return strike(ws, meta, 'bad_payload', 'invalid typing frame');
      const { conversation_id } = result.data.d;
      if (!(await isActiveParticipant(meta.userId, conversation_id))) return;
      const expiresAt = new Date(Date.now() + TYPING_TTL_S * 1000).toISOString();
      const others = (await activeParticipantUserIds(conversation_id)).filter(
        (id) => id !== meta.userId,
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
        .select({ id: schema.users.id, lastSeenAt: schema.users.lastSeenAt })
        .from(schema.users)
        .where(inArray(schema.users.id, allowed));
      const lastSeenById = new Map(userRows.map((u) => [u.id, u.lastSeenAt]));
      allowed.forEach((id, i) => {
        const online = results[i]?.[1] === 1;
        const lastSeen = lastSeenById.get(id) ?? null;
        send(ws, {
          t: 'presence',
          d: {
            user_id: id,
            online,
            ...(lastSeen && !online ? { last_seen_at: lastSeen.toISOString() } : {}),
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

function routeEnvelope(env: EventEnvelope): void {
  switch (env.scope) {
    case 'users': {
      for (const userId of env.user_ids) {
        for (const ws of registry.socketsForUser(userId)) send(ws, env.event);
      }
      return;
    }
    case 'presence': {
      for (const ws of registry.watchersOf(env.user_id)) send(ws, env.event);
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
