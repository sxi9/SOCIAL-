// Phase 5 — call links (AUDIT-PLAN §1b, migration 0019): POST
// /api/calls/links (member of a LIVE group call only), the public 'call'
// share page, POST /api/calls/links/:token/join (joins the group through
// the token), and the token dying with the call. Skips cleanly without
// Postgres + Redis.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Call, Conversation } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `34.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('phase 5: call links (migration 0019)', () => {
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
        display_name: `Real ${username}`,
        terms_accepted: true,
        age_attested: true,
      },
    });
    expect(res.statusCode).toBe(201);
    return {
      sid: res.cookies.find((c) => c.name === 'sid')!.value,
      userId: (res.json() as { user: { id: string } }).user.id,
      username,
    };
  }
  function get(me: Session, url: string) {
    return app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  }
  function post(me: Session, url: string, payload: unknown = {}) {
    return app.inject({ method: 'POST', url, headers: CSRF, cookies: { sid: me.sid }, payload: payload as object });
  }
  function put(me: Session, url: string) {
    return app.inject({ method: 'PUT', url, headers: CSRF, cookies: { sid: me.sid } });
  }
  function pub(url: string) {
    return app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': nextIp() } });
  }
  async function group(admin: Session, members: Session[]): Promise<string> {
    const res = await post(admin, '/api/conversations', {
      type: 'group',
      title: `room ${run}`,
      user_ids: members.map((m) => m.userId),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { conversation: Conversation }).conversation.id;
  }
  async function startCall(me: Session, convId: string): Promise<Call> {
    const res = await post(me, `/api/conversations/${convId}/calls`, { kind: 'audio' });
    expect(res.statusCode).toBe(201);
    return (res.json() as { call: Call }).call;
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mint: a member of a LIVE group call only; DM calls take no third person', async () => {
    const a = await register(`p5a${run}`);
    const b = await register(`p5b${run}`);
    const convId = await group(a, [b]);
    const call = await startCall(a, convId);
    // b is a participant but not (yet) in the call → the §1.14 404.
    expect((await post(b, '/api/calls/links', { call_id: call.id })).statusCode).toBe(404);
    const minted = await post(a, '/api/calls/links', { call_id: call.id });
    expect(minted.statusCode).toBe(200);
    const link = (minted.json() as { share_link: { token: string; url: string; object: { type: string } } }).share_link;
    expect(link.url).toBe(`/call/${link.token}`);
    expect(link.object.type).toBe('call');
    // A private group (the default): a non-admin member in the call may NOT
    // mint — members of a private group cannot admit strangers (403).
    expect((await post(b, `/api/calls/${call.id}/join`)).statusCode).toBe(200);
    expect((await post(b, '/api/calls/links', { call_id: call.id })).statusCode).toBe(403);
    // Mint-or-return through the generic route gives the same token.
    const again = await post(a, '/api/share-links', { type: 'call', id: call.id });
    expect((again.json() as { share_link: { token: string } }).share_link.token).toBe(link.token);
    // Listed for the minter.
    const mine = await get(a, '/api/share-links/mine');
    const item = (mine.json() as { share_links: { token: string; label: string; live: boolean }[] }).share_links.find((l) => l.token === link.token);
    expect(item?.label).toBe('Voice call');
    expect(item?.live).toBe(true);
    // DM call → 400 not_public.
    const c = await register(`p5c${run}`);
    const dm = (await post(a, '/api/conversations', { type: 'dm', user_id: c.userId })).json() as { conversation: Conversation };
    // Accept so the DM can be rung (c's dm_policy defaults to connections).
    await post(c, `/api/conversations/${dm.conversation.id}/accept`);
    const dmCall = await post(a, `/api/conversations/${dm.conversation.id}/calls`, { kind: 'audio' });
    expect(dmCall.statusCode).toBe(201);
    const dmMint = await post(a, '/api/calls/links', { call_id: (dmCall.json() as { call: Call }).call.id });
    expect(dmMint.statusCode).toBe(400);
    expect((dmMint.json() as { error: string }).error).toBe('not_public');
  });

  it('public page shows the inviter chip + count (never members); a stranger joins the group through the token, then the call; the link dies with the call', async () => {
    const a = await register(`p5ha${run}`);
    const b = await register(`p5hb${run}`);
    const convId = await group(a, [b]);
    const call = await startCall(a, convId);
    const token = ((await post(a, '/api/calls/links', { call_id: call.id })).json() as { share_link: { token: string } }).share_link.token;

    const page = await pub(`/api/share/${token}/public`);
    expect(page.statusCode).toBe(200);
    const body = (page.json() as { page: Record<string, unknown> }).page;
    expect(body.type).toBe('call');
    expect(body.id).toBe(call.id);
    expect(body.kind).toBe('audio');
    expect(body.member_count).toBe(1);
    expect(body.full).toBe(false);
    expect((body.inviter as { username: string }).username).toBe(a.username);
    expect(JSON.stringify(body)).not.toContain(a.userId);
    expect(JSON.stringify(body)).not.toContain(b.userId);

    // A stranger: join through the token → becomes a group member.
    const s = await register(`p5s${run}`);
    const joined = await post(s, `/api/calls/links/${token}/join`);
    expect(joined.statusCode).toBe(200);
    const j = joined.json() as { conversation_id: string; call_id: string; kind: string };
    expect(j.conversation_id).toBe(convId);
    expect(j.call_id).toBe(call.id);
    expect((await get(s, `/api/conversations/${convId}`)).statusCode).toBe(200);
    // Now the ordinary §1.42 join works.
    const inCall = await post(s, `/api/calls/${call.id}/join`);
    expect(inCall.statusCode).toBe(200);
    expect((inCall.json() as { call: Call }).call.participant_ids).toContain(s.userId);
    // Idempotent for a member.
    expect((await post(s, `/api/calls/links/${token}/join`)).statusCode).toBe(200);

    // A blocked pair with the inviter → the one 404.
    const x = await register(`p5x${run}`);
    expect([200, 204]).toContain((await put(x, `/api/users/${a.userId}/block`)).statusCode);
    const blockedJoin = await post(x, `/api/calls/links/${token}/join`);
    expect(blockedJoin.statusCode).toBe(404);
    const ghost = await post(x, `/api/calls/links/${'A'.repeat(43)}/join`);
    expect(blockedJoin.body).toBe(ghost.body);

    // The call ends (a leaves, s leaves → ≤1 member) → token revoked → 404.
    expect((await post(a, `/api/calls/${call.id}/end`, { reason: 'completed' })).statusCode).toBe(200);
    expect((await post(s, `/api/calls/${call.id}/end`, { reason: 'completed' })).statusCode).toBe(200);
    const gone = await pub(`/api/share/${token}/public`);
    expect(gone.statusCode).toBe(404);
    const lateJoin = await register(`p5l${run}`);
    expect((await post(lateJoin, `/api/calls/links/${token}/join`)).statusCode).toBe(404);
    const mine = await get(a, '/api/share-links/mine');
    expect((mine.json() as { share_links: { token: string }[] }).share_links.some((l) => l.token === token)).toBe(false);
  });
});
