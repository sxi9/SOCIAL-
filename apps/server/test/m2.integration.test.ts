// ROADMAP M2 integration tests: idempotent replay, seq gaplessness under
// concurrent sends, dm_key race. Needs live Postgres + Redis — set
// DATABASE_URL and REDIS_URL (CI provides both); skipped otherwise.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);
let ipCounter = 0;

describe.runIf(infra)('M2 correctness core', () => {
  let app: FastifyInstance;

  interface Session {
    sid: string;
    userId: string;
  }

  async function register(username: string): Promise<Session> {
    // Distinct forwarded IPs dodge the 3/hour/IP register limit (trustProxy
    // on) — time-salted (the v08b pattern) so re-runs within the same hour
    // never collide with a previous run's counters in a shared local Redis.
    ipCounter += 1;
    const n = ((Date.now() & 0xffffff) + ipCounter * 23) & 0xffffff;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...CSRF, 'x-forwarded-for': `22.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password123',
        display_name: username,
      },
    });
    expect(res.statusCode).toBe(201);
    const sid = res.cookies.find((c) => c.name === 'sid')?.value;
    expect(sid).toBeTruthy();
    return { sid: sid!, userId: (res.json() as { user: { id: string } }).user.id };
  }

  async function createDm(me: Session, peerId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: { type: 'dm', user_id: peerId },
    });
  }

  function sendMessage(me: Session, convId: string, body: string, clientMsgId = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: { client_msg_id: clientMsgId, type: 'text', body },
    });
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    const queues = await import('../src/queues.js');
    await Promise.allSettled(
      [queues.avatarQueue, queues.mediaQueue, queues.unfurlQueue, queues.pushQueue, queues.gcQueue].map(
        (q) => q.close(),
      ),
    );
    await queues.queueConnection.quit().catch(() => {});
    const { redis } = await import('../src/redis.js');
    await redis.quit().catch(() => {});
    const { pg } = await import('../src/db/index.js');
    await pg.end({ timeout: 5 });
  });

  it('dm_key race: concurrent DM creates converge on one conversation', async () => {
    const a = await register(`race_a_${run}`);
    const b = await register(`race_b_${run}`);

    const [r1, r2] = await Promise.all([createDm(a, b.userId), createDm(b, a.userId)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    const id1 = (r1.json() as { conversation: { id: string } }).conversation.id;
    const id2 = (r2.json() as { conversation: { id: string } }).conversation.id;
    expect(id1).toBe(id2);

    // A replay create also dedupes to the same row.
    const r3 = await createDm(a, b.userId);
    expect(r3.statusCode).toBe(200);
    expect((r3.json() as { conversation: { id: string } }).conversation.id).toBe(id1);
  });

  it('idempotent replay: same client_msg_id returns the original row with 200', async () => {
    const a = await register(`idem_a_${run}`);
    const b = await register(`idem_b_${run}`);
    const conv = await createDm(a, b.userId);
    const convId = (conv.json() as { conversation: { id: string } }).conversation.id;

    const clientMsgId = randomUUID();
    const first = await sendMessage(a, convId, 'hello', clientMsgId);
    expect(first.statusCode).toBe(201);
    const msg1 = (first.json() as { message: { id: string; seq: number } }).message;

    const replay = await sendMessage(a, convId, 'hello', clientMsgId);
    expect(replay.statusCode).toBe(200);
    const msg2 = (replay.json() as { message: { id: string; seq: number } }).message;
    expect(msg2.id).toBe(msg1.id);
    expect(msg2.seq).toBe(msg1.seq);

    // Concurrent replays of one client_msg_id also yield exactly one row.
    const dupId = randomUUID();
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => sendMessage(a, convId, 'dup', dupId)),
    );
    const ids = new Set(burst.map((r) => (r.json() as { message: { id: string } }).message.id));
    expect(ids.size).toBe(1);
    expect(burst.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(burst.filter((r) => r.statusCode === 201).length).toBeLessThanOrEqual(1);
  });

  it('departed members see a clean seq prefix (seq <= seq at left_at)', async () => {
    const a = await register(`left_a_${run}`);
    const b = await register(`left_b_${run}`);
    const c = await register(`left_c_${run}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'group', title: 'floor', user_ids: [b.userId, c.userId] },
    });
    expect(res.statusCode).toBe(201);
    const convId = (res.json() as { conversation: { id: string } }).conversation.id;

    expect((await sendMessage(a, convId, 'before leave')).statusCode).toBe(201);
    const leave = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${convId}/participants/${b.userId}`,
      headers: CSRF,
      cookies: { sid: b.sid },
    });
    expect(leave.statusCode).toBe(204);
    expect((await sendMessage(a, convId, 'after leave')).statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}/messages?after_seq=0&limit=100`,
      cookies: { sid: b.sid },
    });
    expect(list.statusCode).toBe(200);
    const msgs = (list.json() as { messages: Array<{ seq: number; body: string | null }> }).messages;
    expect(msgs.length).toBeGreaterThan(0);
    // The prefix is contiguous from seq 1 and stops at the leave floor.
    expect(msgs.map((m) => m.seq)).toEqual(Array.from({ length: msgs.length }, (_v, i) => i + 1));
    expect(msgs.some((m) => m.body === 'before leave')).toBe(true);
    expect(msgs.some((m) => m.body === 'after leave')).toBe(false);
  });

  it('seq gaplessness: concurrent sends produce a contiguous 1..N log', async () => {
    const a = await register(`seq_a_${run}`);
    const b = await register(`seq_b_${run}`);
    const conv = await createDm(a, b.userId);
    const convId = (conv.json() as { conversation: { id: string } }).conversation.id;

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        sendMessage(i % 2 === 0 ? a : b, convId, `msg ${i}`),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}/messages?after_seq=0&limit=100`,
      cookies: { sid: a.sid },
    });
    expect(list.statusCode).toBe(200);
    const seqs = (list.json() as { messages: Array<{ seq: number }> }).messages.map((m) => m.seq);
    expect(seqs).toEqual(Array.from({ length: N }, (_v, i) => i + 1));
  });
});

describe.runIf(!infra)('M2 correctness core (skipped)', () => {
  it.skip('requires DATABASE_URL and REDIS_URL (provided in CI)', () => {});
});
