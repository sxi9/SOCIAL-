// v0.6 calls + discovery tests (API.md §1.42–§1.46 + §2.12, ADR-014/ADR-015):
// TURN credentials verify against the coturn static-auth-secret HMAC scheme;
// the signaling relay rejects non-participants (and non-members past the
// invite stage) while relaying to real callees; the mesh cap holds at join
// (409 call_full); missed-call machinery drops the call_ref system message;
// discovery cards exclude blocks / friends-of / other-scope; CONCURRENT
// mutual waves mint exactly one DM; roulette keep-by-both persists while
// keep-by-one is hard-deleted by the sweep (with the feedback tombstone);
// the rescue daily cap answers 429. Infra-gated like the other suites —
// needs live Postgres + Redis (DATABASE_URL + REDIS_URL); skipped otherwise.
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Call, Conversation, DiscoveryCard, Message, TurnCredentials } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

// Must be set BEFORE the first dynamic import of ../src (config parses env
// at import time): the §1.42 TURN tests need a secret, and the HMAC check
// below re-derives credentials from this value.
const TURN_SECRET = 'v06-test-turn-secret-0123456789abcdef';
process.env.TURN_SECRET = TURN_SECRET;

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (17.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `17.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
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

describe.runIf(infra)('v0.6 calls + discovery', () => {
  let app: FastifyInstance;
  let port: number;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;
  let redis: typeof import('../src/redis.js').redis;
  let discoverySvc: typeof import('../src/modules/discovery/service.js');

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
  function put(me: Session, url: string, payload: unknown = {}) {
    return app.inject({
      method: 'PUT',
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: payload as object,
    });
  }
  function del(me: Session, url: string) {
    return app.inject({ method: 'DELETE', url, headers: CSRF, cookies: { sid: me.sid } });
  }

  async function createDm(a: Session, bUserId: string): Promise<Conversation> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: bUserId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation;
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
    // Swallow the hello frame deterministically.
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
    ({ sql: sqlTag } = await import('drizzle-orm'));
    ({ redis } = await import('../src/redis.js'));
    discoverySvc = await import('../src/modules/discovery/service.js');
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // §1.42 calls: TURN HMAC, lifecycle, mesh cap, missed-call machinery
  // -------------------------------------------------------------------------
  describe('calls', () => {
    let caller: Session;
    let callee: Session;
    let outsider: Session;
    let dm: Conversation;

    beforeAll(async () => {
      caller = await register(`v6caller${run}`);
      callee = await register(`v6callee${run}`);
      outsider = await register(`v6outsider${run}`);
      dm = await createDm(caller, callee.userId);
    });

    it('mints TURN credentials that verify against the coturn HMAC scheme', async () => {
      const res = await post(caller, `/api/conversations/${dm.id}/calls`, { kind: 'audio' });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { call: Call; turn: TurnCredentials | null };
      expect(body.call.status).toBe('ringing');
      expect(body.call.participant_ids).toEqual([caller.userId]);
      expect(body.turn).not.toBeNull();
      const turn = body.turn!;
      // coturn static-auth-secret format: "<unix expiry>:<user_id>" +
      // base64(HMAC-SHA1(secret, username)).
      const [expiryStr, uid] = turn.username.split(':');
      expect(uid).toBe(caller.userId);
      const expiry = Number(expiryStr);
      const nowS = Math.floor(Date.now() / 1000);
      expect(expiry).toBeGreaterThan(nowS + 3000);
      expect(expiry).toBeLessThanOrEqual(nowS + 3700);
      const expected = createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
      expect(turn.credential).toBe(expected);
      expect(turn.uris.some((u) => u.startsWith('stun:'))).toBe(true);
      expect(turn.uris.some((u) => u.includes('transport=udp'))).toBe(true);

      // Participant-gated refresh endpoint, same scheme.
      const fresh = await get(caller, `/api/turn-credentials?call_id=${body.call.id}`);
      expect(fresh.statusCode).toBe(200);
      const minted = (fresh.json() as { turn: TurnCredentials }).turn;
      expect(minted.credential).toBe(
        createHmac('sha1', TURN_SECRET).update(minted.username).digest('base64'),
      );
      // Non-participant: 404-shaped.
      const denied = await get(outsider, `/api/turn-credentials?call_id=${body.call.id}`);
      expect(denied.statusCode).toBe(404);

      // One live call per conversation.
      const second = await post(caller, `/api/conversations/${dm.id}/calls`, { kind: 'video' });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: string }).error).toBe('call_active');

      // Clean up: callee rejects → terminal.
      const rejected = await post(callee, `/api/calls/${body.call.id}/reject`);
      expect(rejected.statusCode).toBe(200);
      expect((rejected.json() as { call: Call }).call.status).toBe('rejected');
    });

    it('relays signaling to participants and rejects non-participants', async () => {
      const res = await post(caller, `/api/conversations/${dm.id}/calls`, { kind: 'video' });
      expect(res.statusCode).toBe(201);
      const call = (res.json() as { call: Call }).call;

      const callerWs = await connectWs(caller);
      const calleeWs = await connectWs(callee);
      const outsiderWs = await connectWs(outsider);

      // Non-participant signaling → 404-shaped error, nothing relayed.
      outsiderWs.send({
        t: 'call.offer',
        d: { call_id: call.id, to_user: caller.userId, sdp: 'v=0 outsider' },
      });
      const err = await outsiderWs.waitFor((f) => f.t === 'error');
      expect((err.d as { code: string }).code).toBe('not_found');

      // A participant who is NOT a live member yet cannot push SDP either.
      calleeWs.send({
        t: 'call.offer',
        d: { call_id: call.id, to_user: caller.userId, sdp: 'v=0 too-early' },
      });
      const notMember = await calleeWs.waitFor(
        (f) => f.t === 'error' && (f.d as { code?: string }).code === 'call_not_member',
      );
      expect((notMember.d as { code: string }).code).toBe('call_not_member');

      // Initiator's call.invite reaches the callee, enriched.
      callerWs.send({ t: 'call.invite', d: { call_id: call.id } });
      const invite = await calleeWs.waitFor((f) => f.t === 'call.invite');
      expect(invite.d).toMatchObject({
        call_id: call.id,
        conversation_id: dm.id,
        kind: 'video',
        from_user: caller.userId,
      });

      // The callee joins (durable accept) and offers; the caller receives it
      // with from_user stamped server-side.
      const join = await post(callee, `/api/calls/${call.id}/join`);
      expect(join.statusCode).toBe(200);
      expect((join.json() as { call: Call }).call.status).toBe('ongoing');
      calleeWs.send({
        t: 'call.offer',
        d: { call_id: call.id, to_user: caller.userId, sdp: 'v=0 real-offer' },
      });
      const offer = await callerWs.waitFor((f) => f.t === 'call.offer');
      expect(offer.d).toMatchObject({
        call_id: call.id,
        from_user: callee.userId,
        sdp: 'v=0 real-offer',
      });

      // Hang up (last-leaves semantics: 2 members, one end → completed).
      const end = await post(caller, `/api/calls/${call.id}/end`);
      expect(end.statusCode).toBe(200);
      expect((end.json() as { call: Call }).call.status).toBe('completed');
    });

    it('flood-guards call.offer and call.invite per socket (fixer r1)', async () => {
      const res = await post(caller, `/api/conversations/${dm.id}/calls`, { kind: 'audio' });
      expect(res.statusCode).toBe(201);
      const call = (res.json() as { call: Call }).call;

      const callerWs = await connectWs(caller);
      const calleeWs = await connectWs(callee);

      // call.invite: budget 2 per (socket, call) per 10 s window — a re-ring
      // storm fans to every participant, so excess is dropped silently.
      for (let i = 0; i < 6; i += 1) {
        callerWs.send({ t: 'call.invite', d: { call_id: call.id } });
      }
      await calleeWs.waitFor((f) => f.t === 'call.invite');
      await new Promise((r) => setTimeout(r, 400));
      const invites = calleeWs.frames.filter((f) => f.t === 'call.invite');
      expect(invites.length).toBe(2);

      // The callee joins → live member, may push SDP.
      const join = await post(callee, `/api/calls/${call.id}/join`);
      expect(join.statusCode).toBe(200);

      // call.offer/answer share a 30-per-window budget per (socket, call);
      // frame 31+ is dropped WITHOUT an error (well-formed spam never strikes,
      // so the socket stays open) and never relayed.
      for (let i = 0; i < 40; i += 1) {
        calleeWs.send({
          t: 'call.offer',
          d: { call_id: call.id, to_user: caller.userId, sdp: `v=0 spam-${i}` },
        });
      }
      await callerWs.waitFor(
        (f) => f.t === 'call.offer' && (f.d as { sdp?: string }).sdp === 'v=0 spam-29',
      );
      await new Promise((r) => setTimeout(r, 400));
      const offers = callerWs.frames.filter((f) => f.t === 'call.offer');
      expect(offers.length).toBe(30);
      expect(calleeWs.frames.some((f) => f.t === 'error')).toBe(false);
      expect(calleeWs.ws.readyState).toBe(WebSocket.OPEN);

      const end = await post(caller, `/api/calls/${call.id}/end`);
      expect(end.statusCode).toBe(200);
    });

    it('enforces the mesh cap at join (409 call_full)', async () => {
      const members: Session[] = [];
      for (let i = 0; i < 10; i += 1) {
        members.push(await register(`v6mesh${i}${run}`));
      }
      const groupRes = await post(members[0]!, '/api/conversations', {
        type: 'group',
        title: 'mesh party',
        user_ids: members.slice(1).map((m) => m.userId),
      });
      expect(groupRes.statusCode).toBe(201);
      const group = (groupRes.json() as { conversation: Conversation }).conversation;

      const created = await post(members[0]!, `/api/conversations/${group.id}/calls`, {
        kind: 'audio',
      });
      expect(created.statusCode).toBe(201);
      const call = (created.json() as { call: Call }).call;
      expect(call.is_group).toBe(true);

      // 7 joins fill the mesh to CALL_MESH_MAX=8.
      for (let i = 1; i <= 7; i += 1) {
        const res = await post(members[i]!, `/api/calls/${call.id}/join`);
        expect(res.statusCode).toBe(200);
      }
      const ninth = await post(members[8]!, `/api/calls/${call.id}/join`);
      expect(ninth.statusCode).toBe(409);
      expect((ninth.json() as { error: string }).error).toBe('call_full');

      // Idempotent re-join stays 200 and never bumps the set.
      const rejoin = await post(members[3]!, `/api/calls/${call.id}/join`);
      expect(rejoin.statusCode).toBe(200);
      expect((rejoin.json() as { call: Call }).call.participant_ids).toHaveLength(8);
    });

    it('cancel-before-answer runs the missed-call machinery (call_ref system message)', async () => {
      const res = await post(caller, `/api/conversations/${dm.id}/calls`, { kind: 'audio' });
      expect(res.statusCode).toBe(201);
      const call = (res.json() as { call: Call }).call;

      const ended = await post(caller, `/api/calls/${call.id}/end`);
      expect(ended.statusCode).toBe(200);
      expect((ended.json() as { call: Call }).call.status).toBe('missed');

      const history = await get(callee, `/api/conversations/${dm.id}/messages?after_seq=0&limit=100`);
      expect(history.statusCode).toBe(200);
      const messages = (history.json() as { messages: Message[] }).messages;
      const missed = messages.find(
        (m) => m.type === 'system' && m.metadata.call_ref?.call_id === call.id,
      );
      expect(missed).toBeDefined();
      expect(missed!.metadata.system?.event).toBe('call_missed');
      expect(missed!.metadata.call_ref).toMatchObject({
        call_id: call.id,
        kind: 'audio',
        status: 'missed',
        duration_s: null,
      });

      // The call log reads back, newest first, with empty participant_ids on
      // terminal rows.
      const log = await get(caller, `/api/conversations/${dm.id}/calls`);
      expect(log.statusCode).toBe(200);
      const calls = (log.json() as { calls: Call[] }).calls;
      expect(calls[0]!.id).toBe(call.id);
      expect(calls[0]!.participant_ids).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // §1.44 discovery: cards exclusions + concurrent mutual waves
  // -------------------------------------------------------------------------
  describe('discovery', () => {
    const AREA_A = `v6area-${run}`;
    const AREA_B = `v6elsewhere-${run}`;
    let me: Session;
    let neighbor: Session;
    let publicFar: Session;
    let blocked: Session;
    let friend: Session;
    let farAway: Session;

    async function setArea(s: Session, area: string): Promise<void> {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: CSRF,
        cookies: { sid: s.sid },
        payload: { area },
      });
      expect(res.statusCode).toBe(200);
    }

    beforeAll(async () => {
      me = await register(`v6me${run}`);
      neighbor = await register(`v6nb${run}`);
      publicFar = await register(`v6pub${run}`);
      blocked = await register(`v6blk${run}`);
      friend = await register(`v6frd${run}`);
      farAway = await register(`v6far${run}`);
      await setArea(me, AREA_A);
      await setArea(neighbor, AREA_A);
      await setArea(publicFar, AREA_B);
      await setArea(blocked, AREA_A);
      await setArea(friend, AREA_A);
      await setArea(farAway, AREA_B);
      // friend shares a DM with me → friends-of → excluded from discovery.
      await createDm(me, friend.userId);
      // blocked: I block them.
      const blockRes = await app.inject({
        method: 'PUT',
        url: `/api/users/${blocked.userId}/block`,
        headers: CSRF,
        cookies: { sid: me.sid },
      });
      expect(blockRes.statusCode).toBe(204);
    });

    it('cards exclude blocks, friends-of and other-scope users', async () => {
      // Everyone opts in.
      expect((await put(me, '/api/discovery/optin', { scope: 'area', note: 'bored' })).statusCode).toBe(200);
      expect((await put(neighbor, '/api/discovery/optin', { scope: 'area', note: 'same area' })).statusCode).toBe(200);
      expect((await put(publicFar, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await put(blocked, '/api/discovery/optin', { scope: 'area' })).statusCode).toBe(200);
      expect((await put(friend, '/api/discovery/optin', { scope: 'area' })).statusCode).toBe(200);
      expect((await put(farAway, '/api/discovery/optin', { scope: 'area' })).statusCode).toBe(200);

      const res = await get(me, '/api/discovery/cards');
      expect(res.statusCode).toBe(200);
      const cards = (res.json() as { cards: DiscoveryCard[] }).cards;
      const ids = cards.map((c) => c.user.id);
      // neighbor: same area, mutual reach → visible.
      expect(ids).toContain(neighbor.userId);
      // publicFar reaches me (public), but MY area scope does not reach them
      // (different area) — mutual reachability fails.
      expect(ids).not.toContain(publicFar.userId);
      // blocked pair: never.
      expect(ids).not.toContain(blocked.userId);
      // friends-of (DM partner): this surface is for meeting people.
      expect(ids).not.toContain(friend.userId);
      // area-scoped in another area: no reach either way.
      expect(ids).not.toContain(farAway.userId);
      // the card carries UserLite + note only — no last-seen, no area text.
      const nb = cards.find((c) => c.user.id === neighbor.userId)!;
      expect(nb.note).toBe('same area');
      expect('last_seen_at' in nb.user).toBe(false);
      expect('area' in nb.user).toBe(false);

      // No lurking: without a live opt-in the read is refused.
      const noOptin = await get(farAway, '/api/discovery/cards');
      expect(noOptin.statusCode).toBe(200); // farAway IS opted in — sanity
      await del(farAway, '/api/discovery/optin');
      const lapsed = await get(farAway, '/api/discovery/cards');
      expect(lapsed.statusCode).toBe(403);
      expect((lapsed.json() as { error: string }).error).toBe('discovery_not_opted_in');

      // Waving at a non-visible card is 404-shaped, whatever the reason.
      const waveBlocked = await post(me, '/api/discovery/wave', { user_id: blocked.userId });
      expect(waveBlocked.statusCode).toBe(404);
      expect((waveBlocked.json() as { error: string }).error).toBe('discovery_card_not_found');
      const waveFriend = await post(me, '/api/discovery/wave', { user_id: friend.userId });
      expect(waveFriend.statusCode).toBe(404);
    });

    it('concurrent mutual waves create exactly one DM', async () => {
      const a = await register(`v6wavea${run}`);
      const b = await register(`v6waveb${run}`);
      expect((await put(a, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await put(b, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);

      const [resA, resB] = await Promise.all([
        post(a, '/api/discovery/wave', { user_id: b.userId }),
        post(b, '/api/discovery/wave', { user_id: a.userId }),
      ]);
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      const bodies = [resA.json(), resB.json()] as { matched: boolean; conversation_id: string | null }[];
      const matchedBodies = bodies.filter((x) => x.matched);
      expect(matchedBodies).toHaveLength(1);

      const dmKey = [a.userId, b.userId].sort().join(':');
      const convRows = (await db.execute(sqlTag`
        SELECT id, metadata FROM conversations WHERE dm_key = ${dmKey}
      `)) as unknown as { id: string; metadata: { origin?: string } }[];
      expect(convRows).toHaveLength(1);
      expect(convRows[0]!.metadata.origin).toBe('discovery');
      expect(convRows[0]!.id).toBe(matchedBodies[0]!.conversation_id);

      // Both wave rows are gone; the icebreaker system message landed.
      const waves = (await db.execute(sqlTag`
        SELECT 1 AS one FROM discovery_waves
        WHERE (from_user_id = ${a.userId} AND to_user_id = ${b.userId})
           OR (from_user_id = ${b.userId} AND to_user_id = ${a.userId})
      `)) as unknown as { one: number }[];
      expect(waves).toHaveLength(0);
      const history = await get(a, `/api/conversations/${convRows[0]!.id}/messages?after_seq=0`);
      const messages = (history.json() as { messages: Message[] }).messages;
      expect(
        messages.some((m) => m.type === 'system' && m.metadata.system?.event === 'discovery_matched'),
      ).toBe(true);

      // The conversation DTO carries origin for the feedback prompt.
      const convRes = await get(b, `/api/conversations/${convRows[0]!.id}`);
      expect((convRes.json() as { conversation: Conversation }).conversation.origin).toBe('discovery');
    });

    it('a single wave is parked silently and re-waves stay idempotent', async () => {
      const c = await register(`v6wavec${run}`);
      const d = await register(`v6waved${run}`);
      expect((await put(c, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await put(d, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      const first = await post(c, '/api/discovery/wave', { user_id: d.userId });
      expect(first.statusCode).toBe(200);
      expect((first.json() as { matched: boolean }).matched).toBe(false);
      const again = await post(c, '/api/discovery/wave', { user_id: d.userId });
      expect((again.json() as { matched: boolean }).matched).toBe(false);
      // The target's own card list shows nothing about who waved at them —
      // only the WAVER sees waved:true.
      const cCards = await get(c, '/api/discovery/cards');
      const cCard = (cCards.json() as { cards: DiscoveryCard[] }).cards.find(
        (x) => x.user.id === d.userId,
      );
      expect(cCard?.waved).toBe(true);
      const dCards = await get(d, '/api/discovery/cards');
      const dCard = (dCards.json() as { cards: DiscoveryCard[] }).cards.find(
        (x) => x.user.id === c.userId,
      );
      expect(dCard?.waved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // §1.45 roulette: pairing, keep handshake, hard-delete sweep, feedback
  // -------------------------------------------------------------------------
  describe('roulette', () => {
    let r1: Session;
    let r2: Session;

    beforeAll(async () => {
      r1 = await register(`v6r1${run}`);
      r2 = await register(`v6r2${run}`);
      expect((await put(r1, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await put(r2, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
    });

    it('queue join requires a live opt-in; the worker pairs queued users', async () => {
      const noOptin = await register(`v6r0${run}`);
      const denied = await post(noOptin, '/api/roulette/join');
      expect(denied.statusCode).toBe(403);
      expect((denied.json() as { error: string }).error).toBe('discovery_not_opted_in');

      expect((await post(r1, '/api/roulette/join')).statusCode).toBe(200);
      expect((await post(r2, '/api/roulette/join')).statusCode).toBe(200);
      await discoverySvc.runRoulettePair();

      const dmKey = [r1.userId, r2.userId].sort().join(':');
      const rows = (await db.execute(sqlTag`
        SELECT id, metadata, expires_at FROM conversations WHERE dm_key = ${dmKey}
      `)) as unknown as { id: string; metadata: { origin?: string }; expires_at: string | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.origin).toBe('roulette');
      expect(rows[0]!.expires_at).not.toBeNull();

      // Viewer-scoped DTO: provisional rider with my own kept=false.
      const conv = await get(r1, `/api/conversations/${rows[0]!.id}`);
      const dto = (conv.json() as { conversation: Conversation }).conversation;
      expect(dto.origin).toBe('roulette');
      expect(dto.roulette).not.toBeNull();
      expect(dto.roulette!.kept).toBe(false);
    });

    it('keep by one stays provisional and never leaks; keep by both persists', async () => {
      const dmKey = [r1.userId, r2.userId].sort().join(':');
      const [row] = (await db.execute(sqlTag`
        SELECT id FROM conversations WHERE dm_key = ${dmKey}
      `)) as unknown as { id: string }[];
      const convId = row!.id;

      const keep1 = await post(r1, '/api/roulette/keep', { conversation_id: convId });
      expect(keep1.statusCode).toBe(200);
      const body1 = keep1.json() as { conversation: Conversation; permanent: boolean };
      expect(body1.permanent).toBe(false);
      expect(body1.conversation.roulette!.kept).toBe(true);

      // The OTHER party's view never carries my keep (no pressure surface).
      const asR2 = await get(r2, `/api/conversations/${convId}`);
      expect((asR2.json() as { conversation: Conversation }).conversation.roulette!.kept).toBe(false);

      const keep2 = await post(r2, '/api/roulette/keep', { conversation_id: convId });
      expect(keep2.statusCode).toBe(200);
      const body2 = keep2.json() as { conversation: Conversation; permanent: boolean };
      expect(body2.permanent).toBe(true);
      expect(body2.conversation.roulette).toBeNull();
      expect(body2.conversation.origin).toBe('roulette');

      // The sweep must NOT touch the kept conversation.
      await discoverySvc.runRouletteSweep();
      const still = await get(r1, `/api/conversations/${convId}`);
      expect(still.statusCode).toBe(200);
      const messages = (
        (await get(r1, `/api/conversations/${convId}/messages?after_seq=0`)).json() as {
          messages: Message[];
        }
      ).messages;
      expect(
        messages.some((m) => m.type === 'system' && m.metadata.system?.event === 'roulette_kept'),
      ).toBe(true);

      // Outsider keep: 404-shaped.
      const outsider = await register(`v6rout${run}`);
      const denied = await post(outsider, '/api/roulette/keep', { conversation_id: convId });
      expect(denied.statusCode).toBe(404);
    });

    it('keep-by-one lapses: the sweep hard-deletes and writes the feedback tombstone', async () => {
      const r3 = await register(`v6r3${run}`);
      const r4 = await register(`v6r4${run}`);
      expect((await put(r3, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await put(r4, '/api/discovery/optin', { scope: 'public' })).statusCode).toBe(200);
      expect((await post(r3, '/api/roulette/join')).statusCode).toBe(200);
      expect((await post(r4, '/api/roulette/join')).statusCode).toBe(200);
      await discoverySvc.runRoulettePair();

      const dmKey = [r3.userId, r4.userId].sort().join(':');
      const [row] = (await db.execute(sqlTag`
        SELECT id FROM conversations WHERE dm_key = ${dmKey}
      `)) as unknown as { id: string }[];
      expect(row).toBeDefined();
      const convId = row!.id;

      // Only one keeps; the window lapses (forced), the sweep hard-deletes.
      expect((await post(r3, '/api/roulette/keep', { conversation_id: convId })).statusCode).toBe(200);
      await db.execute(sqlTag`
        UPDATE conversations SET expires_at = now() - interval '1 second' WHERE id = ${convId}
      `);
      await discoverySvc.runRouletteSweep();

      const gone = (await db.execute(sqlTag`
        SELECT 1 AS one FROM conversations WHERE id = ${convId}
      `)) as unknown as { one: number }[];
      expect(gone).toHaveLength(0);
      const msgs = (await db.execute(sqlTag`
        SELECT 1 AS one FROM messages WHERE conversation_id = ${convId}
      `)) as unknown as { one: number }[];
      expect(msgs).toHaveLength(0);

      // Keeping after the delete is 404; the keep window answered 410 while
      // the row still existed — covered by the tombstone feedback below.
      const late = await post(r3, '/api/roulette/keep', { conversation_id: convId });
      expect(late.statusCode).toBe(404);

      // The 24 h tombstone authorizes the late one-tap for both parties only.
      const tomb = await redis.get(`roulette:fb:${convId}`);
      expect(tomb).not.toBeNull();
      const fb = await post(r3, '/api/discovery/feedback', {
        context: 'roulette',
        conversation_id: convId,
        verdict: 'better',
      });
      expect(fb.statusCode).toBe(204);
      const dupe = await post(r3, '/api/discovery/feedback', {
        context: 'roulette',
        conversation_id: convId,
        verdict: 'worse',
      });
      expect(dupe.statusCode).toBe(204); // first verdict wins, repeat taps 204
      const stranger = await register(`v6rstr${run}`);
      const deniedFb = await post(stranger, '/api/discovery/feedback', {
        context: 'roulette',
        conversation_id: convId,
        verdict: 'better',
      });
      expect(deniedFb.statusCode).toBe(404);

      const rows = (await db.execute(sqlTag`
        SELECT verdict FROM expectation_feedback
        WHERE user_id = ${r3.userId} AND conversation_id = ${convId}
      `)) as unknown as { verdict: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.verdict).toBe('better');
    });

    it('the encouragement aggregate hides small samples', async () => {
      const res = await get(r1, '/api/discovery/encouragement');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { sample_size: number; better_percent: number | null };
      expect(body.sample_size).toBeGreaterThanOrEqual(1);
      if (body.sample_size < 10) expect(body.better_percent).toBeNull();
      else expect(typeof body.better_percent).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // §1.46 rescue: friends-of gate + daily cap
  // -------------------------------------------------------------------------
  describe('rescue', () => {
    it('sends the SOS message to friends-of DMs and enforces the daily cap', async () => {
      const bored = await register(`v6sos${run}`);
      const buddy = await register(`v6bud${run}`);
      const stranger = await register(`v6strg${run}`);
      await createDm(bored, buddy.userId); // dm-partner → friends-of

      // A stranger target fails the WHOLE request 404-shaped.
      const deniedStranger = await post(bored, '/api/rescue', {
        user_ids: [buddy.userId, stranger.userId],
        note: 'help',
      });
      expect(deniedStranger.statusCode).toBe(404);

      // 3 rescues per UTC day.
      for (let i = 0; i < 3; i += 1) {
        const res = await post(bored, '/api/rescue', {
          user_ids: [buddy.userId],
          note: `so bored ${i}`,
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as { rescues: { user_id: string; conversation_id: string }[] };
        expect(body.rescues).toHaveLength(1);
        expect(body.rescues[0]!.user_id).toBe(buddy.userId);
      }
      const fourth = await post(bored, '/api/rescue', { user_ids: [buddy.userId] });
      expect(fourth.statusCode).toBe(429);
      expect(fourth.headers['retry-after']).toBeDefined();

      // The rescue message carries the SERVER-written metadata.rescue flag.
      const dmKey = [bored.userId, buddy.userId].sort().join(':');
      const [conv] = (await db.execute(sqlTag`
        SELECT id FROM conversations WHERE dm_key = ${dmKey}
      `)) as unknown as { id: string }[];
      const history = await get(buddy, `/api/conversations/${conv!.id}/messages?after_seq=0`);
      const messages = (history.json() as { messages: Message[] }).messages;
      const sos = messages.filter((m) => m.metadata.rescue === true);
      expect(sos.length).toBe(3);
      expect(sos[0]!.body).toBe('so bored 0');
      expect(sos[0]!.sender_id).toBe(bored.userId);
    });
  });

  // -------------------------------------------------------------------------
  // §1.43/§2.12 watch together: host authority + server-side URL parsing
  // -------------------------------------------------------------------------
  describe('watch together', () => {
    it('parses the video id server-side, enforces host-only sync', async () => {
      const host = await register(`v6host${run}`);
      const guest = await register(`v6guest${run}`);
      const dm = await createDm(host, guest.userId);

      const hostWs = await connectWs(host);
      const guestWs = await connectWs(guest);

      hostWs.send({ t: 'watch.start', d: { conversation_id: dm.id, url: 'https://example.com/nope' } });
      const bad = await hostWs.waitFor((f) => f.t === 'error');
      expect((bad.d as { code: string }).code).toBe('watch_bad_url');

      hostWs.send({
        t: 'watch.start',
        d: { conversation_id: dm.id, url: 'https://youtu.be/dQw4w9WgXcQ' },
      });
      const started = await guestWs.waitFor((f) => f.t === 'watch.start');
      expect(started.d).toMatchObject({
        conversation_id: dm.id,
        video_id: 'dQw4w9WgXcQ',
        host: host.userId,
        position_s: 0,
        playing: false,
      });

      // Non-host sync is refused; the host's sync relays full state.
      guestWs.send({
        t: 'watch.sync',
        d: { conversation_id: dm.id, position_s: 10, playing: true },
      });
      const notHost = await guestWs.waitFor(
        (f) => f.t === 'error' && (f.d as { code?: string }).code === 'watch_not_host',
      );
      expect((notHost.d as { code: string }).code).toBe('watch_not_host');

      hostWs.send({
        t: 'watch.sync',
        d: { conversation_id: dm.id, position_s: 42.5, playing: true },
      });
      const synced = await guestWs.waitFor((f) => f.t === 'watch.sync');
      expect(synced.d).toMatchObject({
        conversation_id: dm.id,
        video_id: 'dQw4w9WgXcQ',
        host: host.userId,
        position_s: 42.5,
        playing: true,
      });

      hostWs.send({ t: 'watch.stop', d: { conversation_id: dm.id } });
      const stopped = await guestWs.waitFor((f) => f.t === 'watch.stop');
      expect(stopped.d).toMatchObject({ conversation_id: dm.id });
      expect(await redis.get(`watch:${dm.id}`)).toBeNull();
    });

    // Fixer r2: the watch.sync min-interval gate alone was bypassable with
    // unique made-up conversation ids (each UUID a fresh key, stamped BEFORE
    // auth, map uncapped), and watch.stop had no flood guard at all. Both now
    // ride the capped per-socket sigGates, and the min-interval stamp is only
    // written for authorized relayed syncs.
    it('watch.sync/watch.stop floods with made-up ids cap out; stamps only on relay', async () => {
      const { randomUUID } = await import('node:crypto');
      const { registry } = await import('../src/ws/registry.js');

      const host = await register(`v6wfh${run}`);
      const guest = await register(`v6wfg${run}`);
      const attacker = await register(`v6wfa${run}`);
      const dm = await createDm(host, guest.userId);

      const hostWs = await connectWs(host);
      const guestWs = await connectWs(guest);
      const attackerWs = await connectWs(attacker);

      // Well-formed spam with unique random conversation ids, far past the
      // 64-live-window cap.
      for (let i = 0; i < 150; i += 1) {
        attackerWs.send({
          t: 'watch.sync',
          d: { conversation_id: randomUUID(), position_s: 1, playing: true },
        });
      }
      for (let i = 0; i < 150; i += 1) {
        attackerWs.send({ t: 'watch.stop', d: { conversation_id: randomUUID() } });
      }
      // Let the server drain the burst.
      await new Promise((r) => setTimeout(r, 500));

      const attackerSocket = registry.socketsForUser(attacker.userId)[0]!;
      const meta = registry.metaOf(attackerSocket)!;
      // Gate map capped: made-up ids cannot grow per-socket memory...
      expect(meta.sigGates.size).toBeLessThanOrEqual(64);
      // ...and unauthorized syncs never write the min-interval stamp map.
      expect(meta.watchSyncAt.size).toBe(0);
      // Well-formed frames are dropped, never struck: the socket stays open.
      expect(meta.strikes).toBe(0);
      expect(attackerWs.ws.readyState).toBe(WebSocket.OPEN);

      // The flood on one socket degrades nothing for real users: a session
      // starts, syncs relay, and host syncs within 250ms are coalesced.
      hostWs.send({
        t: 'watch.start',
        d: { conversation_id: dm.id, url: 'https://youtu.be/dQw4w9WgXcQ' },
      });
      await guestWs.waitFor((f) => f.t === 'watch.start');

      hostWs.send({ t: 'watch.sync', d: { conversation_id: dm.id, position_s: 1, playing: true } });
      await guestWs.waitFor(
        (f) => f.t === 'watch.sync' && (f.d as { position_s: number }).position_s === 1,
      );
      // The relay stamped the window; an immediate second sync is dropped.
      hostWs.send({ t: 'watch.sync', d: { conversation_id: dm.id, position_s: 2, playing: true } });
      await new Promise((r) => setTimeout(r, 350));
      expect(
        guestWs.frames.some(
          (f) => f.t === 'watch.sync' && (f.d as { position_s: number }).position_s === 2,
        ),
      ).toBe(false);
      // Past the interval the next sync relays again.
      hostWs.send({ t: 'watch.sync', d: { conversation_id: dm.id, position_s: 3, playing: true } });
      await guestWs.waitFor(
        (f) => f.t === 'watch.sync' && (f.d as { position_s: number }).position_s === 3,
      );
      // The stamp map holds exactly the one conversation the host relays in.
      const hostMeta = registry.metaOf(registry.socketsForUser(host.userId)[0]!)!;
      expect(hostMeta.watchSyncAt.size).toBe(1);

      hostWs.send({ t: 'watch.stop', d: { conversation_id: dm.id } });
      await guestWs.waitFor((f) => f.t === 'watch.stop');
      expect(await redis.get(`watch:${dm.id}`)).toBeNull();
    });
  });
});
