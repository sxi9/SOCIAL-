// Fixer round 2 regression tests:
//  - a block created AFTER both parties entered a beacon's pile is re-checked
//    at spark time under the beacon row lock, so the server never mints a
//    brand-new plan group containing a blocked pair (§1.14). The stale join is
//    evicted (the non-creator when the creator is involved, otherwise the
//    later joiner) and the spark only fires once the cleaned pile crosses the
//    threshold; nobody evicted ever hears about the plan (PSYCHOLOGY rule 2).
// Needs live Postgres + Redis — set DATABASE_URL and REDIS_URL; skipped
// otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Beacon, Conversation } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// 15.x.x.x keeps this suite's forwarded IPs out of the other suites' ranges.
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `15.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

interface UsersEnvelope {
  scope: 'users';
  user_ids: string[];
  event: { t: string; d: Record<string, unknown> };
}

describe.runIf(infra)('fixer round 2 regressions', () => {
  let app: FastifyInstance;
  let subscriber: import('ioredis').default;
  const envelopes: UsersEnvelope[] = [];

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
  function post(me: Session, url: string, payload?: unknown) {
    return app.inject({ method: 'POST', url, headers: CSRF, cookies: { sid: me.sid }, payload });
  }
  function put(me: Session, url: string) {
    return app.inject({ method: 'PUT', url, headers: CSRF, cookies: { sid: me.sid } });
  }

  function beaconWindow(): { starts_at: string; expires_at: string } {
    const now = Date.now();
    return {
      starts_at: new Date(now).toISOString(),
      expires_at: new Date(now + 2 * 3600 * 1000).toISOString(),
    };
  }

  async function mint(me: Session, body: Record<string, unknown>): Promise<Beacon> {
    const res = await post(me, '/api/beacons', { ...beaconWindow(), ...body });
    expect(res.statusCode).toBe(201);
    return (res.json() as { beacon: Beacon }).beacon;
  }

  async function joinOk(me: Session, beaconId: string): Promise<Beacon> {
    const res = await post(me, `/api/beacons/${beaconId}/join`);
    expect(res.statusCode).toBe(200);
    return (res.json() as { beacon: Beacon }).beacon;
  }

  async function waitFor<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = probe();
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();
    const { createRedis } = await import('../src/redis.js');
    subscriber = createRedis();
    await subscriber.subscribe('events');
    subscriber.on('message', (_ch: string, raw: string) => {
      try {
        const env = JSON.parse(raw) as UsersEnvelope;
        if (env.scope === 'users') envelopes.push(env);
      } catch {
        /* ignore */
      }
    });
  });

  afterAll(async () => {
    await subscriber?.quit().catch(() => {});
    await app?.close();
    const queues = await import('../src/queues.js');
    await Promise.allSettled(
      [
        queues.avatarQueue,
        queues.mediaQueue,
        queues.unfurlQueue,
        queues.pushQueue,
        queues.gcQueue,
        queues.beaconsQueue,
      ].map((q) => q.close()),
    );
    await queues.queueConnection.quit().catch(() => {});
    const { redis } = await import('../src/redis.js');
    await redis.quit().catch(() => {});
    const { pg } = await import('../src/db/index.js');
    await pg.end({ timeout: 5 });
  });

  // ---------------------------------------------------------------------------
  it('a block created after both parties joined never sparks them into one group', async () => {
    const creator = await register(`fx2sp_c_${run}`);
    const victim = await register(`fx2sp_v_${run}`);
    const harasser = await register(`fx2sp_h_${run}`);
    const third = await register(`fx2sp_t_${run}`);
    const fourth = await register(`fx2sp_f_${run}`);

    const beacon = await mint(creator, { vibe: 'chai', audience: 'public', spark_threshold: 3 });

    // Both enter the pile while unblocked, then the block lands.
    await joinOk(victim, beacon.id);
    await joinOk(harasser, beacon.id);
    expect((await put(victim, `/api/users/${harasser.userId}/block`)).statusCode).toBe(204);

    // The threshold-crossing join must NOT spark victim+harasser into one
    // brand-new plan group: the stale (later) join is evicted under the row
    // lock and the beacon stays open at 2/3.
    const afterThird = await joinOk(third, beacon.id);
    expect(afterThird.status).toBe('open');
    expect(afterThird.conversation_id).toBeNull();

    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    const joins = (await db.execute(sql`
      SELECT user_id FROM beacon_joins WHERE beacon_id = ${beacon.id}
    `)) as unknown as { user_id: string }[];
    const joinIds = joins.map((j) => j.user_id);
    expect(joinIds).not.toContain(harasser.userId); // stale join evicted
    expect(joinIds).toEqual(expect.arrayContaining([victim.userId, third.userId]));

    // The next clean join sparks a group WITHOUT the blocked counterpart.
    envelopes.length = 0;
    const sparkedView = await joinOk(fourth, beacon.id);
    expect(sparkedView.status).toBe('sparked');
    const convId = sparkedView.conversation_id!;
    expect(convId).toBeTruthy();

    const convRes = await get(creator, `/api/conversations/${convId}`);
    expect(convRes.statusCode).toBe(200);
    const conv = (convRes.json() as { conversation: Conversation }).conversation;
    const memberIds = conv.participants.map((p) => p.user.id).sort();
    expect(memberIds).toEqual(
      [creator.userId, victim.userId, third.userId, fourth.userId].sort(),
    );
    expect(memberIds).not.toContain(harasser.userId);

    // The evicted user is a stranger to the plan group (404, never details)…
    const hConv = await get(harasser, `/api/conversations/${convId}`);
    expect(hConv.statusCode).toBe(404);

    // …and never hears about it: no conv.new envelope names them
    // (PSYCHOLOGY rule 2 — never notify anyone about a plan they cannot join).
    const convNew = await waitFor(() => {
      const hits = envelopes.filter(
        (e) =>
          e.event.t === 'conv.new' &&
          (e.event.d as { conversation?: Conversation }).conversation?.id === convId,
      );
      return hits.length > 0 ? hits : undefined;
    });
    const notified = new Set(convNew.flatMap((e) => e.user_ids));
    expect(notified.has(harasser.userId)).toBe(false);
    expect(notified.has(victim.userId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  it('a creator-involved block created after the join evicts the joiner, not the creator', async () => {
    const creator = await register(`fx2cb_c_${run}`);
    const j1 = await register(`fx2cb_j1_${run}`);
    const j2 = await register(`fx2cb_j2_${run}`);
    const j3 = await register(`fx2cb_j3_${run}`);

    const beacon = await mint(creator, { vibe: 'walk', audience: 'public', spark_threshold: 2 });
    await joinOk(j1, beacon.id);
    expect((await put(creator, `/api/users/${j1.userId}/block`)).statusCode).toBe(204);

    // j2's threshold-crossing join evicts j1 instead of sparking creator+j1.
    const afterJ2 = await joinOk(j2, beacon.id);
    expect(afterJ2.status).toBe('open');
    expect(afterJ2.conversation_id).toBeNull();

    const sparkedView = await joinOk(j3, beacon.id);
    expect(sparkedView.status).toBe('sparked');
    const convId = sparkedView.conversation_id!;
    const convRes = await get(creator, `/api/conversations/${convId}`);
    expect(convRes.statusCode).toBe(200);
    const conv = (convRes.json() as { conversation: Conversation }).conversation;
    expect(conv.participants.map((p) => p.user.id).sort()).toEqual(
      [creator.userId, j2.userId, j3.userId].sort(),
    );
  });
});
