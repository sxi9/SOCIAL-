// v0.7.1 call-reliability tests (API.md §1.55 + §2.9 + §2.12, ADR-017,
// FEATURES #88-#90): the call self-test endpoint is authed, rate-limited and
// mints short-TTL "<expiry>:selftest:<user_id>" probe credentials that verify
// against the coturn HMAC scheme; turn_configured (and the in-band turn:null
// on call create) honestly reflects TURN_SECRET; the ring push is enqueued
// ONLY for callees with no live socket; the worker's execution guards hold
// (muted_until suppresses with NO mention-style override, handled calls never
// ring late, presence skips) and record rung users in call:{id}:rang; a DM
// decline and a first join retract via call.ring.stop jobs and drop the rang
// set; the gateway relays call.state to live members only, from_user stamped.
// Pure-guard tests run ungated; the rest is infra-gated like the other suites.
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Call, Conversation, TurnCredentials } from '@socialchat/shared';
import { callRingPushAllowed } from '../src/lib/pushGuard.js';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

// Must be set BEFORE the first dynamic import of ../src (config parses env at
// import time): the §1.55 selftest tests need a TURN secret to mint against,
// and processPushJob exits early without config.vapid (values only need to be
// present — no web-push send happens, since no subscription rows exist here).
const TURN_SECRET = 'v071-test-turn-secret-0123456789abcdef';
process.env.TURN_SECRET = TURN_SECRET;
process.env.VAPID_PUBLIC_KEY ??= 'test-vapid-public-key';
process.env.VAPID_PRIVATE_KEY ??= 'test-vapid-private-key';

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (18.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `18.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

interface WsFrame {
  t: string;
  d: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// §2.9 pure ring-push guard (lib/pushGuard.ts) — ungated, no infra
// ---------------------------------------------------------------------------

describe('callRingPushAllowed (pure §2.9 ring verdict)', () => {
  const now = Date.now();

  it('allows the plain offline callee', () => {
    expect(callRingPushAllowed({ blockedPair: false, mutedUntil: null, now })).toBe(true);
  });

  it('a block is absolute', () => {
    expect(callRingPushAllowed({ blockedPair: true, mutedUntil: null, now })).toBe(false);
  });

  it('muted_until suppresses the ring — a call is NOT a mention, no override exists', () => {
    expect(
      callRingPushAllowed({ blockedPair: false, mutedUntil: new Date(now + 60_000), now }),
    ).toBe(false);
  });

  it('an expired mute no longer suppresses', () => {
    expect(
      callRingPushAllowed({ blockedPair: false, mutedUntil: new Date(now - 1_000), now }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Infra-gated: endpoint, enqueue/stop machinery, worker guards, WS relay
// ---------------------------------------------------------------------------

describe.runIf(infra)('v0.7.1 call reliability', () => {
  let app: FastifyInstance;
  let port: number;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let redis: typeof import('../src/redis.js').redis;
  let queues: typeof import('../src/queues.js');
  let callsSvc: typeof import('../src/modules/calls/service.js');
  let pushJobs: typeof import('../src/jobs/push.js');
  let config: typeof import('../src/config.js').config;

  const openSockets: WebSocket[] = [];

  async function register(username: string): Promise<Session> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password123',
        display_name: username,
      },
    });
    expect(res.statusCode).toBe(201);
    const sid = res.cookies.find((c) => c.name === 'sid')?.value;
    const body = res.json() as { user: { id: string } };
    return { sid: sid!, userId: body.user.id, username };
  }

  function get(me: Session, url: string) {
    return app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  }
  function post(me: Session, url: string, payload: unknown = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: payload as object,
    });
  }

  async function createDm(a: Session, bUserId: string): Promise<Conversation> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: bUserId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation;
  }

  async function startCall(me: Session, conversationId: string, kind = 'audio'): Promise<Call> {
    const res = await post(me, `/api/conversations/${conversationId}/calls`, { kind });
    expect(res.statusCode).toBe(201);
    return (res.json() as { call: Call }).call;
  }

  /** Every push job this Redis has seen recently. The suite does not run a
   * worker, but a concurrent dev worker on the same Redis may legitimately
   * drain the queue — so enqueue assertions scan completed/active states too
   * (removeOnComplete keeps the last 1000) and key on per-test call ids. */
  async function pushJobsSeen(): Promise<Record<string, unknown>[]> {
    const jobs = await queues.pushQueue.getJobs([
      'waiting',
      'delayed',
      'paused',
      'prioritized',
      'active',
      'completed',
      'failed',
    ]);
    return jobs.filter(Boolean).map((j) => j.data as Record<string, unknown>);
  }

  async function waitForPushJob(
    pred: (j: Record<string, unknown>) => boolean,
    ms = 4000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = (await pushJobsSeen()).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`push job not seen in ${ms}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A live WS client: collects frames; waitFor polls for a matching one. */
  async function connectWs(me: Session): Promise<{
    ws: WebSocket;
    frames: WsFrame[];
    send: (frame: WsFrame) => void;
    waitFor: (pred: (f: WsFrame) => boolean, ms?: number) => Promise<WsFrame>;
  }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: `sid=${me.sid}` },
    });
    openSockets.push(ws);
    const frames: WsFrame[] = [];
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(data.toString()) as WsFrame);
      } catch {
        // ignore
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const waitFor = async (pred: (f: WsFrame) => boolean, ms = 5000): Promise<WsFrame> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`ws frame not seen in ${ms}ms; got: ${frames.map((f) => f.t).join(',')}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitFor((f) => f.t === 'hello');
    return { ws, frames, send: (frame) => ws.send(JSON.stringify(frame)), waitFor };
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    const { setupGateway } = await import('../src/ws/gateway.js');
    app = await buildApp({ logger: false });
    setupGateway(app.server);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    ({ db, schema } = await import('../src/db/index.js'));
    ({ redis } = await import('../src/redis.js'));
    queues = await import('../src/queues.js');
    callsSvc = await import('../src/modules/calls/service.js');
    pushJobs = await import('../src/jobs/push.js');
    ({ config } = await import('../src/config.js'));
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await Promise.all(
      [
        queues.avatarQueue,
        queues.mediaQueue,
        queues.unfurlQueue,
        queues.pushQueue,
        queues.gcQueue,
        queues.beaconsQueue,
        queues.timersQueue,
        queues.discoveryQueue,
      ].map((q) => q.close().catch(() => {})),
    );
    await queues.queueConnection.quit().catch(() => {});
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // §1.55 GET /api/call-selftest — auth, shape, probe creds, TURN honesty
  // -------------------------------------------------------------------------

  describe('GET /api/call-selftest', () => {
    it('requires auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/call-selftest' });
      expect(res.statusCode).toBe(401);
    });

    it('mints short-TTL selftest probe credentials when TURN is configured', async () => {
      const me = await register(`v71self${run}`);
      const res = await get(me, '/api/call-selftest');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { turn_configured: boolean; turn: TurnCredentials | null };
      expect(body.turn_configured).toBe(true);
      expect(body.turn).not.toBeNull();
      const turn = body.turn!;
      // username = "<unix expiry>:selftest:<user_id>" — the infix is log
      // attribution only; coturn verifies the HMAC identically to §1.42.
      const [expiryStr, infix, uid] = turn.username.split(':');
      expect(infix).toBe('selftest');
      expect(uid).toBe(me.userId);
      const expiry = Number(expiryStr);
      const nowUnix = Math.floor(Date.now() / 1000);
      // CALL_SELFTEST_CRED_TTL_S = 300, NOT the 1 h call TTL.
      expect(expiry).toBeGreaterThan(nowUnix + 240);
      expect(expiry).toBeLessThanOrEqual(nowUnix + 300 + 5);
      const expected = createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
      expect(turn.credential).toBe(expected);
      expect(new Date(turn.expires_at).getTime()).toBe(expiry * 1000);
    });

    it('answers turn_configured:false + turn:null when TURN_SECRET is unset — 200, never an error', async () => {
      const me = await register(`v71honest${run}`);
      const peer = await register(`v71honestp${run}`);
      const dm = await createDm(me, peer.userId);
      const mutableConfig = config as { turnSecret: string | null };
      const saved = mutableConfig.turnSecret;
      mutableConfig.turnSecret = null;
      try {
        const res = await get(me, '/api/call-selftest');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ turn_configured: false, turn: null });

        // §1.55: "POST …/calls returning turn:null is the same fact in-band" —
        // the caller-side relay warning keys off this without an extra call.
        const create = await post(me, `/api/conversations/${dm.id}/calls`, { kind: 'audio' });
        expect(create.statusCode).toBe(201);
        const body = create.json() as { call: Call; turn: TurnCredentials | null };
        expect(body.turn).toBeNull();
        await post(peer, `/api/calls/${body.call.id}/reject`);
      } finally {
        mutableConfig.turnSecret = saved;
      }
      // With the secret restored, the same GET carries creds again.
      const again = await get(me, '/api/call-selftest');
      expect((again.json() as { turn_configured: boolean }).turn_configured).toBe(true);
    });

    it('rate-limits at CALL_SELFTEST_RATE_PER_HOUR per user', async () => {
      const me = await register(`v71rate${run}`);
      for (let i = 0; i < 30; i += 1) {
        const res = await get(me, '/api/call-selftest');
        expect(res.statusCode).toBe(200);
      }
      const blocked = await get(me, '/api/call-selftest');
      expect(blocked.statusCode).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // §2.9 ring push — enqueue only without a live socket; stop on handled
  // -------------------------------------------------------------------------

  describe('ring push machinery', () => {
    it('enqueues a call_ring job for the offline callee, with the §2.9 payload fields', async () => {
      const caller = await register(`v71ca${run}`);
      const callee = await register(`v71cb${run}`);
      const dm = await createDm(caller, callee.userId);
      const call = await startCall(caller, dm.id);

      const ring = await waitForPushJob((j) => j.kind === 'call_ring' && j.call_id === call.id);
      expect(ring).toMatchObject({
        kind: 'call_ring',
        user_id: callee.userId,
        call_id: call.id,
        conversation_id: dm.id,
        initiator_id: caller.userId,
        call_kind: 'audio',
        is_group: false,
      });
      // Never one for the initiator (enqueued in the same bulk add, so once
      // the callee's job is visible, absence here is deterministic).
      const jobs = await pushJobsSeen();
      expect(
        jobs.find((j) => j.kind === 'call_ring' && j.call_id === call.id && j.user_id === caller.userId),
      ).toBeUndefined();
      await post(callee, `/api/calls/${call.id}/reject`);
    });

    it('enqueues NO call_ring job for a callee with a live socket (call.invite rings them)', async () => {
      const caller = await register(`v71cc${run}`);
      const callee = await register(`v71cd${run}`);
      const dm = await createDm(caller, callee.userId);
      const calleeWs = await connectWs(callee);
      const call = await startCall(caller, dm.id);

      // Enqueue is synchronous with the 201 — a short settle then a full scan.
      await new Promise((r) => setTimeout(r, 500));
      const jobs = await pushJobsSeen();
      expect(jobs.find((j) => j.kind === 'call_ring' && j.call_id === call.id)).toBeUndefined();
      calleeWs.ws.close();
      await post(callee, `/api/calls/${call.id}/reject`);
    });

    it('excludes blocked callees structurally in a group call', async () => {
      const a = await register(`v71ga${run}`);
      const b = await register(`v71gb${run}`);
      const c = await register(`v71gc${run}`);
      const res = await post(a, '/api/conversations', {
        type: 'group',
        title: 'ring test',
        user_ids: [b.userId, c.userId],
      });
      expect(res.statusCode).toBe(201);
      const group = (res.json() as { conversation: Conversation }).conversation;
      // c blocks a AFTER joining the group (blocks never remove membership).
      await db.insert(schema.blocks).values({ blockerId: c.userId, blockedId: a.userId });

      const call = await startCall(a, group.id, 'video');
      const ring = await waitForPushJob((j) => j.kind === 'call_ring' && j.call_id === call.id);
      expect(ring).toMatchObject({ user_id: b.userId, is_group: true });
      const rings = (await pushJobsSeen()).filter(
        (j) => j.kind === 'call_ring' && j.call_id === call.id,
      );
      expect(rings.map((j) => j.user_id)).toEqual([b.userId]);
      await post(a, `/api/calls/${call.id}/end`, {});
    });

    it('a DM decline retracts: call_ring_stop jobs to exactly the rung users, rang set dropped', async () => {
      const caller = await register(`v71ce${run}`);
      const callee = await register(`v71cf${run}`);
      const dm = await createDm(caller, callee.userId);
      const call = await startCall(caller, dm.id);
      // Simulate the worker having sent the ring (it records BEFORE sending).
      await redis.sadd(callsSvc.callRangKey(call.id), callee.userId);

      const rejected = await post(callee, `/api/calls/${call.id}/reject`);
      expect(rejected.statusCode).toBe(200);

      const stop = await waitForPushJob((j) => j.kind === 'call_ring_stop' && j.call_id === call.id);
      expect(stop).toMatchObject({ kind: 'call_ring_stop', user_id: callee.userId, call_id: call.id });
      expect(await redis.exists(callsSvc.callRangKey(call.id))).toBe(0);
    });

    it('the first join retracts too (answered anywhere stops ringing everywhere)', async () => {
      const caller = await register(`v71cg${run}`);
      const callee = await register(`v71ch${run}`);
      const dm = await createDm(caller, callee.userId);
      const call = await startCall(caller, dm.id);
      await redis.sadd(callsSvc.callRangKey(call.id), callee.userId);

      const join = await post(callee, `/api/calls/${call.id}/join`);
      expect(join.statusCode).toBe(200);

      await waitForPushJob(
        (j) => j.kind === 'call_ring_stop' && j.call_id === call.id && j.user_id === callee.userId,
      );
      expect(await redis.exists(callsSvc.callRangKey(call.id))).toBe(0);
      await post(caller, `/api/calls/${call.id}/end`, {});
    });
  });

  // -------------------------------------------------------------------------
  // §2.9 worker execution guards (processPushJob run directly — no worker, no
  // subscriptions, so nothing is actually sent; the rang set is the witness)
  // -------------------------------------------------------------------------

  describe('ring push worker guards', () => {
    let caller: Session;
    let callee: Session;
    let dm: Conversation;

    function ringJob(call: Call) {
      return {
        kind: 'call_ring' as const,
        user_id: callee.userId,
        call_id: call.id,
        conversation_id: dm.id,
        initiator_id: caller.userId,
        call_kind: 'audio' as const,
        is_group: false,
      };
    }

    beforeAll(async () => {
      caller = await register(`v71wa${run}`);
      callee = await register(`v71wb${run}`);
      dm = await createDm(caller, callee.userId);
    });

    it('rings the offline, unmuted callee of a still-ringing call (and records the rang set)', async () => {
      const call = await startCall(caller, dm.id);
      await pushJobs.processPushJob(ringJob(call));
      expect(await redis.smembers(callsSvc.callRangKey(call.id))).toEqual([callee.userId]);
      // Per-(user, call) debounce key exists — a duplicate job sends nothing.
      expect(await redis.exists(`pushdb:${callee.userId}:callring:${call.id}`)).toBe(1);
      await post(callee, `/api/calls/${call.id}/reject`);
    });

    it('muted_until suppresses the ring — no mention-style override', async () => {
      const { and, eq } = await import('drizzle-orm');
      await db
        .update(schema.conversationParticipants)
        .set({ mutedUntil: new Date(Date.now() + 3600_000) })
        .where(
          and(
            eq(schema.conversationParticipants.conversationId, dm.id),
            eq(schema.conversationParticipants.userId, callee.userId),
          ),
        );
      const call = await startCall(caller, dm.id);
      await pushJobs.processPushJob(ringJob(call));
      expect(await redis.exists(callsSvc.callRangKey(call.id))).toBe(0);
      await db
        .update(schema.conversationParticipants)
        .set({ mutedUntil: null })
        .where(
          and(
            eq(schema.conversationParticipants.conversationId, dm.id),
            eq(schema.conversationParticipants.userId, callee.userId),
          ),
        );
      await post(callee, `/api/calls/${call.id}/reject`);
    });

    it('a handled (no-longer-ringing) call never rings late', async () => {
      const call = await startCall(caller, dm.id);
      await post(callee, `/api/calls/${call.id}/reject`);
      await pushJobs.processPushJob(ringJob(call));
      expect(await redis.exists(callsSvc.callRangKey(call.id))).toBe(0);
    });

    it('presence at execution time skips the ring (the socket rings via call.invite)', async () => {
      const calleeWs = await connectWs(callee);
      // markOnline runs just after the hello frame — poll the presence key in.
      const deadline = Date.now() + 5000;
      while ((await redis.exists(`presence:${callee.userId}`)) !== 1) {
        if (Date.now() > deadline) throw new Error('presence key never appeared');
        await new Promise((r) => setTimeout(r, 25));
      }
      const call = await startCall(caller, dm.id);
      await pushJobs.processPushJob(ringJob(call));
      expect(await redis.exists(callsSvc.callRangKey(call.id))).toBe(0);
      calleeWs.ws.close();
      await post(callee, `/api/calls/${call.id}/reject`);
    });
  });

  // -------------------------------------------------------------------------
  // §2.12 call.state relay — live members only, from_user stamped
  // -------------------------------------------------------------------------

  describe('call.state relay', () => {
    it('relays to live call members with from_user stamped; non-members are refused', async () => {
      const a = await register(`v71sa${run}`);
      const b = await register(`v71sb${run}`);
      const c = await register(`v71sc${run}`);
      const res = await post(a, '/api/conversations', {
        type: 'group',
        title: 'state test',
        user_ids: [b.userId, c.userId],
      });
      const group = (res.json() as { conversation: Conversation }).conversation;
      const call = await startCall(a, group.id, 'video');
      const join = await post(b, `/api/calls/${call.id}/join`);
      expect(join.statusCode).toBe(200);

      const aWs = await connectWs(a);
      const bWs = await connectWs(b);
      const cWs = await connectWs(c);

      // b (live member) reports reconnecting → a's tile hears the truth.
      bWs.send({ t: 'call.state', d: { call_id: call.id, state: 'reconnecting' } });
      const frame = await aWs.waitFor((f) => f.t === 'call.state');
      expect(frame.d).toEqual({
        call_id: call.id,
        from_user: b.userId,
        state: 'reconnecting',
      });

      // c is a conversation participant but NOT a live member → call_not_member.
      cWs.send({ t: 'call.state', d: { call_id: call.id, state: 'connected' } });
      const err = await cWs.waitFor(
        (f) => f.t === 'error' && (f.d as { code?: string }).code === 'call_not_member',
      );
      expect((err.d as { code: string }).code).toBe('call_not_member');

      // A malformed state value is a strike, not a relay.
      bWs.send({ t: 'call.state', d: { call_id: call.id, state: 'sideways' } });
      await bWs.waitFor((f) => f.t === 'error' && (f.d as { code?: string }).code === 'bad_payload');

      await post(a, `/api/calls/${call.id}/end`, {});
    });
  });
});
