// Fixer round 1 regression tests:
//  - blocked pairs can never be sparked into one brand-new plan group
//    (join 404s + the beacon vanishes for the blocked counterpart, §1.14);
//  - run-it-back shares the POST /api/beacons mint rate (§1.15) so the
//    run-it-back → cancel loop cannot push-spam the audience;
//  - poll.updated frames carry the voter's identity ONLY on the voter's own
//    envelope (§1.17: no per-voter ballot map reconstructible from the wire);
//  - conversation DTOs are viewer-scoped on EVERY REST path and conv.*
//    broadcast (reciprocal receipt clamping, §1.13a).
// Needs live Postgres + Redis — set DATABASE_URL and REDIS_URL; skipped
// otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Beacon, Conversation, Message } from '@socialchat/shared';
import { BEACON_CREATE_RATE_PER_HOUR } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// 14.x.x.x keeps this suite's forwarded IPs out of the other suites' ranges.
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `14.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
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

describe.runIf(infra)('fixer round 1 regressions', () => {
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
  function patch(me: Session, url: string, payload: unknown) {
    return app.inject({ method: 'PATCH', url, headers: CSRF, cookies: { sid: me.sid }, payload });
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

  async function listBeaconIds(me: Session): Promise<string[]> {
    const res = await get(me, '/api/beacons');
    expect(res.statusCode).toBe(200);
    return (res.json() as { beacons: Beacon[] }).beacons.map((b) => b.id);
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
    // Tap the Redis events channel to assert exact fan-out envelopes.
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
  it('a beacon with a blocked-w.r.t.-me joiner is invisible and unjoinable (both directions)', async () => {
    const creator = await register(`fx1bj_c_${run}`);
    const victim = await register(`fx1bj_v_${run}`);
    const harasser = await register(`fx1bj_h_${run}`);
    expect((await put(victim, `/api/users/${harasser.userId}/block`)).statusCode).toBe(204);

    // Harasser joins first → the victim must never be lured in blind.
    const b1 = await mint(creator, { vibe: 'chai', audience: 'public', spark_threshold: 9 });
    expect(await listBeaconIds(victim)).toContain(b1.id); // joinable pre-join
    expect((await post(harasser, `/api/beacons/${b1.id}/join`)).statusCode).toBe(200);
    expect(await listBeaconIds(victim)).not.toContain(b1.id); // now unjoinable ⇒ invisible
    const vJoin = await post(victim, `/api/beacons/${b1.id}/join`);
    expect(vJoin.statusCode).toBe(404);
    expect((vJoin.json() as { error: string }).error).toBe('beacon_not_found');

    // Victim joins first → the blocker cannot shadow-join behind them.
    const b2 = await mint(creator, { vibe: 'walk', audience: 'public', spark_threshold: 9 });
    expect((await post(victim, `/api/beacons/${b2.id}/join`)).statusCode).toBe(200);
    expect(await listBeaconIds(harasser)).not.toContain(b2.id);
    const hJoin = await post(harasser, `/api/beacons/${b2.id}/join`);
    expect(hJoin.statusCode).toBe(404);
    expect((hJoin.json() as { error: string }).error).toBe('beacon_not_found');

    // An unrelated third user still sees and can join both.
    const bystander = await register(`fx1bj_x_${run}`);
    expect(await listBeaconIds(bystander)).toEqual(expect.arrayContaining([b1.id, b2.id]));
    expect((await post(bystander, `/api/beacons/${b1.id}/join`)).statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------------
  it('run-it-back shares the beacon mint rate (cancel/re-run loop cannot spam)', async () => {
    const creator = await register(`fx1rb_c_${run}`);
    const j1 = await register(`fx1rb_j1_${run}`);
    const j2 = await register(`fx1rb_j2_${run}`);
    const beacon = await mint(creator, { vibe: 'game', audience: 'public', spark_threshold: 2 });
    expect((await post(j1, `/api/beacons/${beacon.id}/join`)).statusCode).toBe(200);
    const spark = await post(j2, `/api/beacons/${beacon.id}/join`);
    expect(spark.statusCode).toBe(200);
    expect((spark.json() as { beacon: Beacon }).beacon.status).toBe('sparked');

    // j1 has minted nothing yet: the audit's loop — run-it-back → cancel —
    // must die at the shared BEACON_CREATE_RATE_PER_HOUR budget.
    for (let i = 0; i < BEACON_CREATE_RATE_PER_HOUR; i += 1) {
      const res = await post(j1, `/api/beacons/${beacon.id}/run-it-back`);
      expect(res.statusCode).toBe(201);
      const fresh = (res.json() as { beacon: Beacon }).beacon;
      expect((await post(j1, `/api/beacons/${fresh.id}/cancel`)).statusCode).toBe(200);
    }
    const blocked = await post(j1, `/api/beacons/${beacon.id}/run-it-back`);
    expect(blocked.statusCode).toBe(429);
  });

  // ---------------------------------------------------------------------------
  it('poll.updated reveals the voter only to the voter (aggregates to the rest)', async () => {
    const asha = await register(`fx1poll_a_${run}`);
    const ben = await register(`fx1poll_b_${run}`);
    const dm = await post(asha, '/api/conversations', { type: 'dm', user_id: ben.userId });
    const convId = (dm.json() as { conversation: Conversation }).conversation.id;

    const created = await post(asha, `/api/conversations/${convId}/polls`, {
      client_msg_id: randomUUID(),
      question: 'Where to?',
      options: ['Here', 'There'],
    });
    expect(created.statusCode).toBe(201);
    const pollId = (created.json() as { message: Message }).message.poll!.id;

    envelopes.length = 0;
    expect((await post(ben, `/api/polls/${pollId}/vote`, { option_idx: 1 })).statusCode).toBe(200);

    const pollEnvelopes = await waitFor(() => {
      const hits = envelopes.filter(
        (e) => e.event.t === 'poll.updated' && e.event.d.poll_id === pollId,
      );
      return hits.length >= 2 ? hits : undefined;
    });
    const toVoter = pollEnvelopes.find((e) => e.user_ids.includes(ben.userId));
    const toOthers = pollEnvelopes.find((e) => e.user_ids.includes(asha.userId));
    expect(toVoter).toBeDefined();
    expect(toOthers).toBeDefined();
    // The voter's own frame reconciles my_vote…
    expect(toVoter!.event.d.user_id).toBe(ben.userId);
    expect(toVoter!.event.d.option_idx).toBe(1);
    expect(toVoter!.user_ids).toEqual([ben.userId]);
    // …everyone else gets aggregates only: NO voter identity on the wire.
    expect(toOthers!.user_ids).not.toContain(ben.userId);
    expect('user_id' in toOthers!.event.d).toBe(false);
    expect('option_idx' in toOthers!.event.d).toBe(false);
    expect(toOthers!.event.d.counts).toEqual([0, 1]);
    expect(toOthers!.event.d.total_votes).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it('conversation DTOs are viewer-scoped on every REST path and broadcast (§1.13a)', async () => {
    const admin = await register(`fx1vc_a_${run}`); // will turn receipts OFF
    const mia = await register(`fx1vc_m_${run}`);
    const noa = await register(`fx1vc_n_${run}`);

    const createRes = await post(admin, '/api/conversations', {
      type: 'group',
      title: 'clamp test',
      user_ids: [mia.userId, noa.userId],
    });
    expect(createRes.statusCode).toBe(201);
    const convId = (createRes.json() as { conversation: Conversation }).conversation.id;

    // Sends raise each sender's own watermarks: admin→1, mia→2, noa→3.
    for (const member of [admin, mia, noa]) {
      const send = await post(member, `/api/conversations/${convId}/messages`, {
        client_msg_id: randomUUID(),
        type: 'text',
        body: `hi from ${member.username}`,
      });
      expect(send.statusCode).toBe(201);
    }
    expect(
      (await patch(admin, '/api/users/me/settings', { read_receipts: false })).statusCode,
    ).toBe(200);

    const readSeqOf = (conv: Conversation, userId: string) =>
      conv.participants.find((p) => p.user.id === userId)!.last_read_seq;

    // PATCH response (previously served unclamped): reciprocity hides the
    // receipts-on members' read state from the receipts-off requester…
    envelopes.length = 0;
    const patched = await patch(admin, `/api/conversations/${convId}`, { title: 'renamed' });
    expect(patched.statusCode).toBe(200);
    const patchedConv = (patched.json() as { conversation: Conversation }).conversation;
    expect(readSeqOf(patchedConv, mia.userId)).toBe(0);
    expect(readSeqOf(patchedConv, noa.userId)).toBe(0);
    expect(readSeqOf(patchedConv, admin.userId)).toBe(1); // own stays true
    // delivered is never filtered.
    expect(
      patchedConv.participants.find((p) => p.user.id === mia.userId)!.last_delivered_seq,
    ).toBe(2);

    // …and the conv.updated broadcast clamps per recipient the same way.
    const convEnvelopes = await waitFor(() => {
      const hits = envelopes.filter(
        (e) =>
          e.event.t === 'conv.updated' &&
          (e.event.d as { conversation?: Conversation }).conversation?.id === convId,
      );
      return hits.length > 0 && hits.some((h) => h.user_ids.includes(mia.userId))
        ? hits
        : undefined;
    });
    const toAdmin = convEnvelopes.find((e) => e.user_ids.includes(admin.userId));
    const toMia = convEnvelopes.find((e) => e.user_ids.includes(mia.userId));
    expect(toAdmin).toBeDefined();
    expect(toMia).toBeDefined();
    const adminConv = (toAdmin!.event.d as { conversation: Conversation }).conversation;
    const miaConv = (toMia!.event.d as { conversation: Conversation }).conversation;
    // Receipts-off admin's copy: everyone else clamped, own true.
    expect(readSeqOf(adminConv, mia.userId)).toBe(0);
    expect(readSeqOf(adminConv, admin.userId)).toBe(1);
    // Receipts-on mia's copy: fellow receipts-on noa true, receipts-off admin
    // clamped (P's own setting), own true.
    expect(readSeqOf(miaConv, noa.userId)).toBe(3);
    expect(readSeqOf(miaConv, admin.userId)).toBe(0);
    expect(readSeqOf(miaConv, mia.userId)).toBe(2);

    // DM-dedupe path (the other previously-unclamped response).
    const first = await post(admin, '/api/conversations', { type: 'dm', user_id: mia.userId });
    expect(first.statusCode).toBe(201);
    const dmId = (first.json() as { conversation: Conversation }).conversation.id;
    const dmSend = await post(mia, `/api/conversations/${dmId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'dm hello',
    });
    expect(dmSend.statusCode).toBe(201);
    const dedupe = await post(admin, '/api/conversations', { type: 'dm', user_id: mia.userId });
    expect(dedupe.statusCode).toBe(200);
    const dedupeConv = (dedupe.json() as { conversation: Conversation }).conversation;
    expect(readSeqOf(dedupeConv, mia.userId)).toBe(0); // reciprocity, admin is off
  });
});
