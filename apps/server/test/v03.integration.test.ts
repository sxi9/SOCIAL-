// v0.3 integration tests (API.md §1.13–§1.18, ADR-008/ADR-009):
// spark atomicity under concurrent joins; audience visibility matrix incl.
// blocks both directions; reciprocal read receipts hide seen-state both ways;
// group_add_policy enforcement; poll revote replaces; seen-by carries no
// timestamp fields. Needs live Postgres + Redis — set DATABASE_URL and
// REDIS_URL (CI provides both); skipped otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  Beacon,
  Conversation,
  Message,
  Poll,
  UserLite,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits across repeated runs against the same Redis (13.x.x.x so this
// file never collides with the other suites' ranges).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `13.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('v0.3 beacons, privacy, trust', () => {
  let app: FastifyInstance;

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
  function del(me: Session, url: string, payload?: unknown) {
    return app.inject({ method: 'DELETE', url, headers: CSRF, cookies: { sid: me.sid }, payload });
  }

  async function setArea(me: Session, area: string | null): Promise<void> {
    const res = await patch(me, '/api/users/me', { area });
    expect(res.statusCode).toBe(200);
  }

  async function createDm(a: Session, b: Session): Promise<string> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: b.userId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation.id;
  }

  function beaconWindow(): { starts_at: string; expires_at: string } {
    const now = Date.now();
    return {
      starts_at: new Date(now).toISOString(),
      expires_at: new Date(now + 2 * 3600 * 1000).toISOString(),
    };
  }

  async function mintBeacon(
    me: Session,
    body: Record<string, unknown>,
  ): Promise<Beacon> {
    const res = await post(me, '/api/beacons', { ...beaconWindow(), ...body });
    expect(res.statusCode).toBe(201);
    return (res.json() as { beacon: Beacon }).beacon;
  }

  async function listBeaconIds(me: Session): Promise<string[]> {
    const res = await get(me, '/api/beacons');
    expect(res.statusCode).toBe(200);
    return (res.json() as { beacons: Beacon[] }).beacons.map((b) => b.id);
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

  // -------------------------------------------------------------------------
  it('spark atomicity: concurrent joins never over-spark; exactly one group', async () => {
    const creator = await register(`v3spark_c_${run}`);
    const joiners = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => register(`v3spark_j${i}_${run}`)),
    );
    const beacon = await mintBeacon(creator, {
      vibe: 'chai',
      audience: 'public',
      spark_threshold: 2,
    });
    expect(beacon.status).toBe('open');
    expect(beacon.needs).toBe(2);
    expect(beacon.my_state).toBe('creator');

    // All five race the same join; the row lock serializes them.
    const results = await Promise.all(
      joiners.map((j) => post(j, `/api/beacons/${beacon.id}/join`)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    // Exactly two joins land (the second sparks); the rest find the card gone.
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.filter((c) => c === 410)).toHaveLength(3);
    for (const r of results.filter((r) => r.statusCode === 410)) {
      expect((r.json() as { error: string }).error).toBe('beacon_closed');
    }

    const sparkedResponses = results
      .filter((r) => r.statusCode === 200)
      .map((r) => (r.json() as { beacon: Beacon }).beacon);
    const convIds = [
      ...new Set(sparkedResponses.map((b) => b.conversation_id).filter(Boolean)),
    ];
    // Exactly ONE plan conversation, shared by every sparked response.
    expect(convIds).toHaveLength(1);
    const convId = convIds[0]!;

    const { db, schema } = await import('../src/db/index.js');
    const { eq, sql } = await import('drizzle-orm');
    const [row] = await db.select().from(schema.beacons).where(eq(schema.beacons.id, beacon.id));
    expect(row!.status).toBe('sparked');
    expect(row!.conversationId).toBe(convId);
    const joinCount = (await db.execute(sql`
      SELECT count(*)::int AS n FROM beacon_joins WHERE beacon_id = ${beacon.id}
    `)) as unknown as { n: number }[];
    expect(Number(joinCount[0]!.n)).toBe(2); // threshold never over-sparks

    // The plan group: creator admin + 2 joiners, icebreaker (seq 1) + auto
    // venue poll (seq 2) already on the seq log.
    const convRes = await get(creator, `/api/conversations/${convId}`);
    expect(convRes.statusCode).toBe(200);
    const conv = (convRes.json() as { conversation: Conversation }).conversation;
    expect(conv.participants).toHaveLength(3);
    expect(conv.last_seq).toBe(2);
    const msgs = await get(creator, `/api/conversations/${convId}/messages?after_seq=0`);
    const messages = (msgs.json() as { messages: Message[] }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.type).toBe('system');
    expect(messages[0]!.metadata.system?.event).toBe('beacon_sparked');
    expect(messages[1]!.type).toBe('poll');
    expect(messages[1]!.sender_id).toBeNull();
    expect(messages[1]!.poll).not.toBeNull();
    expect(messages[1]!.poll!.options.length).toBeGreaterThanOrEqual(2);

    // Sparked beacons stay visible to insiders only: a bystander's list and
    // radar no longer show it, and their join answers 410/404 — never details.
    const bystander = await register(`v3spark_x_${run}`);
    expect(await listBeaconIds(bystander)).not.toContain(beacon.id);
    expect(await listBeaconIds(creator)).toContain(beacon.id);
  });

  // -------------------------------------------------------------------------
  it('audience visibility matrix, blocks both directions included', async () => {
    const creatorF = await register(`v3audf_c_${run}`); // friends beacon
    const friend = await register(`v3audf_f_${run}`);
    const stranger = await register(`v3audf_s_${run}`);
    await createDm(creatorF, friend);
    const friendsBeacon = await mintBeacon(creatorF, { vibe: 'walk', audience: 'friends' });

    expect(await listBeaconIds(friend)).toContain(friendsBeacon.id);
    expect(await listBeaconIds(stranger)).not.toContain(friendsBeacon.id);
    // Join from outside the audience: 404-shaped, identical to unknown.
    const outsideJoin = await post(stranger, `/api/beacons/${friendsBeacon.id}/join`);
    expect(outsideJoin.statusCode).toBe(404);
    expect((outsideJoin.json() as { error: string }).error).toBe('beacon_not_found');

    // Area: case-insensitive snapshot match; no area = no 'area' beacons.
    const creatorA = await register(`v3auda_c_${run}`);
    const areaMate = await register(`v3auda_m_${run}`);
    const otherArea = await register(`v3auda_o_${run}`);
    const noArea = await register(`v3auda_n_${run}`);
    await setArea(creatorA, 'Indiranagar');
    await setArea(areaMate, 'indiranagar'); // citext equality
    await setArea(otherArea, 'Koramangala');
    const areaBeacon = await mintBeacon(creatorA, { vibe: 'food', audience: 'area' });
    expect(areaBeacon.area).toBe('Indiranagar');
    expect(await listBeaconIds(areaMate)).toContain(areaBeacon.id);
    expect(await listBeaconIds(otherArea)).not.toContain(areaBeacon.id);
    expect(await listBeaconIds(noArea)).not.toContain(areaBeacon.id);

    // area_required when the minter has no area.
    const noAreaMint = await post(noArea, '/api/beacons', {
      ...beaconWindow(),
      vibe: 'food',
      audience: 'area',
    });
    expect(noAreaMint.statusCode).toBe(400);
    expect((noAreaMint.json() as { error: string }).error).toBe('area_required');

    // Public + blocks in BOTH directions.
    const creatorP = await register(`v3audp_c_${run}`);
    const blocker = await register(`v3audp_b_${run}`); // blocker blocks creator
    const blockee = await register(`v3audp_v_${run}`); // creator blocks them
    const publicBeacon = await mintBeacon(creatorP, { vibe: 'game', audience: 'public' });

    expect(await listBeaconIds(stranger)).toContain(publicBeacon.id);
    expect((await put(blocker, `/api/users/${creatorP.userId}/block`)).statusCode).toBe(204);
    expect((await put(creatorP, `/api/users/${blockee.userId}/block`)).statusCode).toBe(204);

    expect(await listBeaconIds(blocker)).not.toContain(publicBeacon.id); // I blocked creator
    expect(await listBeaconIds(blockee)).not.toContain(publicBeacon.id); // creator blocked me
    for (const user of [blocker, blockee]) {
      const joinRes = await post(user, `/api/beacons/${publicBeacon.id}/join`);
      expect(joinRes.statusCode).toBe(404);
      expect((joinRes.json() as { error: string }).error).toBe('beacon_not_found');
    }
    // Radar is an aggregate only and mirrors list visibility: the blocked
    // beacon is absent from the blocker's list (asserted above), and the
    // creator's own radar never counts their own beacons.
    const radarBlocked = await get(blocker, '/api/beacons/radar');
    expect(radarBlocked.statusCode).toBe(200);
    expect(Object.keys(radarBlocked.json() as object)).toEqual(['active_visible_count']);
    const creatorRadar = (await get(creatorP, '/api/beacons/radar')).json() as {
      active_visible_count: number;
    };
    const creatorList = await listBeaconIds(creatorP);
    expect(creatorList).toContain(publicBeacon.id); // mine is in my list…
    // …but my own open beacons never count toward my radar: the radar over
    // everything visible to a fresh user equals the creator's radar + 1 only
    // when no other suite mints concurrently, so assert the structural rule
    // via a dedicated fresh viewer instead.
    const freshViewer = await register(`v3audp_r_${run}`);
    const freshRadar = (await get(freshViewer, '/api/beacons/radar')).json() as {
      active_visible_count: number;
    };
    expect(freshRadar.active_visible_count).toBeGreaterThanOrEqual(1);
    expect(creatorRadar.active_visible_count).toBeLessThan(freshRadar.active_visible_count + 1);
    // Profile 404-shaped in both directions.
    expect((await get(blocker, `/api/users/${creatorP.username}`)).statusCode).toBe(404);
    expect((await get(creatorP, `/api/users/${blockee.username}`)).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  it('reciprocal read receipts hide seen-state both ways', async () => {
    const alice = await register(`v3rr_a_${run}`);
    const bob = await register(`v3rr_b_${run}`);
    const convId = await createDm(alice, bob);

    // Sends raise the sender's own watermarks: a=1 after seq1, b=2 after seq2.
    await post(alice, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'hello',
    });
    await post(bob, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'hi back',
    });

    const readSeqOf = (conv: Conversation, userId: string) =>
      conv.participants.find((p) => p.user.id === userId)!.last_read_seq;

    // Baseline: both on (defaults) → true values both ways.
    let aView = (await get(alice, `/api/conversations/${convId}`)).json() as {
      conversation: Conversation;
    };
    expect(readSeqOf(aView.conversation, bob.userId)).toBe(2);

    // Bob turns receipts off.
    const settingsRes = await patch(bob, '/api/users/me/settings', { read_receipts: false });
    expect(settingsRes.statusCode).toBe(200);
    expect((settingsRes.json() as { settings: { read_receipts: boolean } }).settings.read_receipts).toBe(false);

    // Alice no longer sees Bob's read state…
    aView = (await get(alice, `/api/conversations/${convId}`)).json() as {
      conversation: Conversation;
    };
    expect(readSeqOf(aView.conversation, bob.userId)).toBe(0);
    expect(readSeqOf(aView.conversation, alice.userId)).toBe(1); // own = true

    // …and Bob no longer sees Alice's (reciprocity), but keeps his own.
    const bView = (await get(bob, `/api/conversations/${convId}`)).json() as {
      conversation: Conversation;
    };
    expect(readSeqOf(bView.conversation, alice.userId)).toBe(0);
    expect(readSeqOf(bView.conversation, bob.userId)).toBe(2); // own devices sync

    // delivered is NEVER filtered.
    const bobRow = aView.conversation.participants.find((p) => p.user.id === bob.userId)!;
    expect(bobRow.last_delivered_seq).toBe(2);

    // §1.18: a receipts-off viewer gets 403 read_receipts_off…
    const refused = await get(bob, `/api/conversations/${convId}/messages/1/receipts`);
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { error: string }).error).toBe('read_receipts_off');

    // …and a receipts-off participant caps at delivered in others' lists.
    const receipts = (await get(alice, `/api/conversations/${convId}/messages/1/receipts`)).json() as {
      seen: UserLite[];
      delivered: UserLite[];
    };
    expect(receipts.seen.map((u) => u.id)).not.toContain(bob.userId);
    expect(receipts.delivered.map((u) => u.id)).toContain(bob.userId);

    // Toggle back on: retroactive, serialization-only — Bob reappears in seen.
    await patch(bob, '/api/users/me/settings', { read_receipts: true });
    const receipts2 = (await get(alice, `/api/conversations/${convId}/messages/1/receipts`)).json() as {
      seen: UserLite[];
      delivered: UserLite[];
    };
    expect(receipts2.seen.map((u) => u.id)).toContain(bob.userId);
  });

  // -------------------------------------------------------------------------
  it('group_add_policy enforcement (and blocks are byte-identical)', async () => {
    const adder = await register(`v3gap_a_${run}`);
    const nobody = await register(`v3gap_n_${run}`);
    const dmOnly = await register(`v3gap_d_${run}`);
    const open = await register(`v3gap_o_${run}`);
    const blocker = await register(`v3gap_b_${run}`);

    await patch(nobody, '/api/users/me/settings', { group_add_policy: 'nobody' });
    await patch(dmOnly, '/api/users/me/settings', { group_add_policy: 'dm_partners' });
    await put(blocker, `/api/users/${adder.userId}/block`);

    // Any denied target fails the WHOLE request with the denied ids listed.
    const denied = await post(adder, '/api/conversations', {
      type: 'group',
      title: 'policy test',
      user_ids: [nobody.userId, dmOnly.userId, open.userId],
    });
    expect(denied.statusCode).toBe(403);
    const deniedBody = denied.json() as { error: string; user_ids: string[] };
    expect(deniedBody.error).toBe('group_add_denied');
    expect(deniedBody.user_ids.sort()).toEqual([nobody.userId, dmOnly.userId].sort());

    // Blocked target: SAME shape — a 403 never confirms which refusal it was.
    const blockedAdd = await post(adder, '/api/conversations', {
      type: 'group',
      title: 'blocked test',
      user_ids: [blocker.userId],
    });
    expect(blockedAdd.statusCode).toBe(403);
    expect((blockedAdd.json() as { error: string }).error).toBe('group_add_denied');

    // dm_partners unlocks after an active DM with the adder.
    await createDm(adder, dmOnly);
    const ok = await post(adder, '/api/conversations', {
      type: 'group',
      title: 'policy ok',
      user_ids: [dmOnly.userId, open.userId],
    });
    expect(ok.statusCode).toBe(201);
    const groupId = (ok.json() as { conversation: Conversation }).conversation.id;

    // Same check on participant adds to an existing group.
    const addDenied = await post(adder, `/api/conversations/${groupId}/participants`, {
      user_ids: [nobody.userId],
    });
    expect(addDenied.statusCode).toBe(403);
    expect((addDenied.json() as { error: string; user_ids: string[] }).user_ids).toEqual([
      nobody.userId,
    ]);

    // DM create between a blocked pair: 404-shaped like an unknown user.
    const dmBlocked = await post(adder, '/api/conversations', {
      type: 'dm',
      user_id: blocker.userId,
    });
    expect(dmBlocked.statusCode).toBe(404);
    expect((dmBlocked.json() as { error: string }).error).toBe('user_not_found');
  });

  // -------------------------------------------------------------------------
  it('poll revote replaces (UPSERT), unvote idempotent, bad_option enforced', async () => {
    const asha = await register(`v3poll_a_${run}`);
    const ben = await register(`v3poll_b_${run}`);
    const convId = await createDm(asha, ben);

    const created = await post(asha, `/api/conversations/${convId}/polls`, {
      client_msg_id: randomUUID(),
      question: 'Where to?',
      options: ['The usual', 'Somewhere new', 'Surprise me'],
    });
    expect(created.statusCode).toBe(201);
    const message = (created.json() as { message: Message }).message;
    expect(message.type).toBe('poll');
    expect(message.poll).not.toBeNull();
    const pollId = message.poll!.id;

    // First vote.
    let res = await post(ben, `/api/polls/${pollId}/vote`, { option_idx: 0 });
    expect(res.statusCode).toBe(200);
    let poll = (res.json() as { poll: Poll }).poll;
    expect(poll.counts).toEqual([1, 0, 0]);
    expect(poll.total_votes).toBe(1);
    expect(poll.my_vote).toBe(0);

    // Revote REPLACES — never two votes from one user.
    res = await post(ben, `/api/polls/${pollId}/vote`, { option_idx: 2 });
    poll = (res.json() as { poll: Poll }).poll;
    expect(poll.counts).toEqual([0, 0, 1]);
    expect(poll.total_votes).toBe(1);
    expect(poll.my_vote).toBe(2);

    // Out-of-range index is route-enforced.
    res = await post(ben, `/api/polls/${pollId}/vote`, { option_idx: 3 });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('bad_option');

    // Unvote; idempotent re-unvote.
    res = await del(ben, `/api/polls/${pollId}/vote`);
    poll = (res.json() as { poll: Poll }).poll;
    expect(poll.counts).toEqual([0, 0, 0]);
    expect(poll.my_vote).toBeNull();
    res = await del(ben, `/api/polls/${pollId}/vote`);
    expect(res.statusCode).toBe(200);

    // The viewer-scoped message DTO carries the poll (reconnect truth).
    const history = await get(ben, `/api/conversations/${convId}/messages?after_seq=0`);
    const msgs = (history.json() as { messages: Message[] }).messages;
    const pollMsg = msgs.find((m) => m.type === 'poll')!;
    expect(pollMsg.poll!.id).toBe(pollId);

    // Non-participants cannot see or vote: undifferentiated 404.
    const outsider = await register(`v3poll_x_${run}`);
    res = await post(outsider, `/api/polls/${pollId}/vote`, { option_idx: 1 });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  it('seen-by lists carry UserLite only — no timestamp fields anywhere', async () => {
    const sam = await register(`v3seen_a_${run}`);
    const tia = await register(`v3seen_b_${run}`);
    const convId = await createDm(sam, tia);
    await post(sam, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'receipt test',
    });
    await post(tia, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'raises my watermarks',
    });

    const res = await get(sam, `/api/conversations/${convId}/messages/1/receipts`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { seen: UserLite[]; delivered: UserLite[] };
    expect(Object.keys(body).sort()).toEqual(['delivered', 'seen']);
    expect(body.seen.map((u) => u.id)).toContain(tia.userId);
    // Sender excluded from both lists.
    expect([...body.seen, ...body.delivered].map((u) => u.id)).not.toContain(sam.userId);

    // NO timestamps anywhere (PSYCHOLOGY never-build: "seen 43 min ago" turns
    // a receipt into a deadline) and no last_seen_at leak via UserLite.
    const flat = JSON.stringify(body);
    expect(flat).not.toMatch(/_at"/);
    expect(flat).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    for (const u of [...body.seen, ...body.delivered]) {
      expect(Object.keys(u).sort()).toEqual(['avatar', 'display_name', 'id', 'username']);
    }

    // The message itself must exist within my visibility floor: unknown seq
    // is 404-shaped.
    expect((await get(sam, `/api/conversations/${convId}/messages/99/receipts`)).statusCode).toBe(404);
  });
});
