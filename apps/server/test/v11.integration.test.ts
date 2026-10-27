// Share-everything phase 2 (AUDIT-PLAN §2.5) — the group join loop's
// requester half: GET/DELETE /api/conversations/:id/join, the admin-only
// pending_requests count, and the §1.68 routes it leans on. Skips cleanly
// without Postgres + Redis (the repo convention).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, ConversationListItem } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `31.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('share-everything phase 2: group join loop (§1.68)', () => {
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
  function mutate(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', me: Session, url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  const post = (me: Session, url: string, payload: unknown = {}) => mutate('POST', me, url, payload);
  const patch = (me: Session, url: string, payload: unknown = {}) => mutate('PATCH', me, url, payload);
  const del = (me: Session, url: string) => mutate('DELETE', me, url);
  const put = (me: Session, url: string, payload: unknown = {}) => mutate('PUT', me, url, payload);

  async function createGroup(admin: Session, members: Session[], visibility: 'public' | 'invite_only') {
    const res = await post(admin, '/api/conversations', {
      type: 'group',
      title: `loop ${visibility} ${run}`,
      user_ids: members.map((m) => m.userId),
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { conversation: Conversation }).conversation.id;
    const sw = await patch(admin, `/api/conversations/${id}/visibility`, {
      visibility,
      ...(visibility === 'public' ? { confirm: true } : {}),
    });
    expect(sw.statusCode).toBe(200);
    return id;
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

  describe('invite_only: ask → requested → withdraw / approve', () => {
    let admin: Session;
    let member: Session;
    let asker: Session;
    let convId: string;

    beforeAll(async () => {
      admin = await register(`p2admin${run}`);
      member = await register(`p2member${run}`);
      asker = await register(`p2asker${run}`);
      convId = await createGroup(admin, [member], 'invite_only');
    });

    it('a stranger reads state none; the admin sees an empty queue (0)', async () => {
      const st = await get(asker, `/api/conversations/${convId}/join`);
      expect(st.statusCode).toBe(200);
      expect(st.json()).toEqual({ state: 'none' });
      const conv = (await get(admin, `/api/conversations/${convId}`)).json() as {
        conversation: Conversation;
      };
      expect(conv.conversation.pending_requests).toBe(0);
      // A plain member never holds the number.
      const asMember = (await get(member, `/api/conversations/${convId}`)).json() as {
        conversation: Conversation;
      };
      expect(asMember.conversation.pending_requests).toBeNull();
    });

    it('asking parks ONE row (202 twice), the admin count and queue show it', async () => {
      const first = await post(asker, `/api/conversations/${convId}/join`);
      expect(first.statusCode).toBe(202);
      const again = await post(asker, `/api/conversations/${convId}/join`);
      expect(again.statusCode).toBe(202);
      expect((await get(asker, `/api/conversations/${convId}/join`)).json()).toEqual({
        state: 'requested',
      });
      const queue = (await get(admin, `/api/conversations/${convId}/join-requests`)).json() as {
        requests: { user: { id: string } }[];
      };
      expect(queue.requests.map((r) => r.user.id)).toEqual([asker.userId]);
      const conv = (await get(admin, `/api/conversations/${convId}`)).json() as {
        conversation: Conversation;
      };
      expect(conv.conversation.pending_requests).toBe(1);
      // The list read carries it too (the sidebar badge's source).
      const list = (await get(admin, '/api/conversations')).json() as {
        conversations: ConversationListItem[];
      };
      expect(list.conversations.find((c) => c.id === convId)?.pending_requests).toBe(1);
    });

    it('withdraw empties the queue (idempotent 204) and the state is none again', async () => {
      expect((await del(asker, `/api/conversations/${convId}/join`)).statusCode).toBe(204);
      expect((await del(asker, `/api/conversations/${convId}/join`)).statusCode).toBe(204);
      expect((await get(asker, `/api/conversations/${convId}/join`)).json()).toEqual({ state: 'none' });
      const conv = (await get(admin, `/api/conversations/${convId}`)).json() as {
        conversation: Conversation;
      };
      expect(conv.conversation.pending_requests).toBe(0);
    });

    it('ask again → approve → member (and the join-state says so)', async () => {
      expect((await post(asker, `/api/conversations/${convId}/join`)).statusCode).toBe(202);
      const ok = await post(admin, `/api/conversations/${convId}/join-requests/${asker.userId}/approve`);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { conversation: Conversation }).conversation.pending_requests).toBe(0);
      expect((await get(asker, `/api/conversations/${convId}/join`)).json()).toEqual({ state: 'member' });
      // A member's POST is the idempotent 200 joined.
      const re = await post(asker, `/api/conversations/${convId}/join`);
      expect(re.statusCode).toBe(200);
      expect((re.json() as { status: string }).status).toBe('joined');
    });

    it('a member (not admin) may not read the queue; a non-member may not withdraw for others', async () => {
      expect((await get(member, `/api/conversations/${convId}/join-requests`)).statusCode).toBe(403);
      // The admin DELETE guard is untouched: a stranger hits the 404 shape.
      const stranger = await register(`p2str${run}`);
      const res = await del(stranger, `/api/conversations/${convId}/join-requests/${asker.userId}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('invite page group card (slice G)', () => {
    it('a group invite names the group, its size and description; the avatar proxy is valid-gated', async () => {
      const admin = await register(`p2inv${run}`);
      const seed = await register(`p2invm${run}`);
      const convId = await createGroup(admin, [seed], 'invite_only');
      const desc = await patch(admin, `/api/conversations/${convId}/visibility`, {
        visibility: 'invite_only',
        description: 'tuesday chai people',
      });
      expect(desc.statusCode).toBe(200);
      const mint = await post(admin, '/api/invites', { conversation_id: convId });
      expect(mint.statusCode).toBe(201);
      const invite = (mint.json() as { invite: { id: string; token: string } }).invite;

      const pub = await app.inject({
        method: 'GET',
        url: `/api/invites/${invite.token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(pub.statusCode).toBe(200);
      const body = (pub.json() as { invite: Record<string, unknown> }).invite;
      expect(body.conversation_id).toBe(convId);
      expect(body.group).toEqual({
        description: 'tuesday chai people',
        avatar_url: null, // no group avatar set
        member_count: 2,
      });
      // No avatar → the proxy 404s like the inviter's.
      const av = await app.inject({
        method: 'GET',
        url: `/api/invites/${invite.token}/group-avatar`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(av.statusCode).toBe(404);

      // A DM invite carries no card.
      const dm = await post(admin, '/api/invites', {});
      expect(dm.statusCode).toBe(201);
      const dmTok = (dm.json() as { invite: { token: string } }).invite.token;
      const dmPub = await app.inject({
        method: 'GET',
        url: `/api/invites/${dmTok}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      const dmBody = (dmPub.json() as { invite: Record<string, unknown> }).invite;
      expect(dmBody.conversation_id).toBeNull();
      expect(dmBody.group).toBeNull();

      // Revoked: a dead link is a dead capability — no card, no id.
      expect((await del(admin, `/api/invites/${invite.id}`)).statusCode).toBe(204);
      const gone = await app.inject({
        method: 'GET',
        url: `/api/invites/${invite.token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      const goneBody = (gone.json() as { invite: Record<string, unknown> }).invite;
      expect(goneBody.status).toBe('revoked');
      expect(goneBody.group).toBeNull();
      expect(goneBody.conversation_id).toBeNull();
    });
  });

  describe('outside the audience → a request (phase 3, slice H)', () => {
    async function setArea(me: Session, area: string): Promise<void> {
      expect((await patch(me, '/api/users/me', { area })).statusCode).toBe(200);
    }
    function landing(me: Session, token: string) {
      return get(me, `/api/share/${token}/landing`);
    }
    async function mint(me: Session, type: string, id: string): Promise<string> {
      const res = await post(me, '/api/share-links', { type, id });
      expect(res.statusCode).toBe(200);
      return (res.json() as { share_link: { token: string } }).share_link.token;
    }

    it('friends-only post: a stranger with the token reads outside + the author; a friend reads visible', async () => {
      const author = await register(`p3pa${run}`);
      const stranger = await register(`p3ps${run}`);
      const friend = await register(`p3pf${run}`);
      const created = await post(author, '/api/posts', { kind: 'text', audience: 'friends_of', body: 'inner circle' });
      expect(created.statusCode).toBe(201);
      const postId = (created.json() as { post: { id: string } }).post.id;
      const token = await mint(author, 'post', postId);
      // The object read keeps its §1.14 404 for the stranger.
      expect((await get(stranger, `/api/posts/${postId}`)).statusCode).toBe(404);
      const out = await landing(stranger, token);
      expect(out.statusCode).toBe(200);
      const body = out.json() as { state: string; object_type: string; object_id: string; author: { id: string } };
      expect(body.state).toBe('outside');
      expect(body.object_type).toBe('post');
      expect(body.object_id).toBe(postId);
      expect(body.author.id).toBe(author.userId);
      // A connection accepted → friends-of → visible.
      const req = await post(friend, `/api/users/${author.userId}/connect`);
      expect(req.statusCode).toBe(201);
      const connId = (req.json() as { connection: { id: string } }).connection.id;
      expect((await post(author, `/api/connections/${connId}/accept`)).statusCode).toBe(200);
      expect((await landing(friend, token)).json()).toMatchObject({ state: 'visible' });
      expect((await get(friend, `/api/posts/${postId}`)).statusCode).toBe(200);
      // A revoked token answers the public read's 404, byte-identical to unknown.
      expect((await del(author, `/api/share-links/${token}`)).statusCode).toBe(204);
      const dead = await landing(stranger, token);
      const unknown = await landing(stranger, 'x'.repeat(43));
      expect(dead.statusCode).toBe(404);
      expect(dead.body).toBe(unknown.body);
    });

    it('area-only listing: a foreign-area visitor reads outside; contact through the token opens the DM and the read', async () => {
      const author = await register(`p3la${run}`);
      const faraway = await register(`p3lf${run}`);
      await setArea(author, `koramangala-${run}`);
      await setArea(faraway, `elsewhere-${run}`);
      const created = await post(author, '/api/listings', {
        kind: 'gig',
        title: `band practice ${run}`,
        details: { direction: 'seeking', tags: ['music'] },
      });
      expect(created.statusCode).toBe(201);
      const listingId = (created.json() as { listing: { id: string; is_public: boolean } }).listing.id;
      const token = await mint(author, 'listing', listingId);
      expect((await get(faraway, `/api/listings/${listingId}`)).statusCode).toBe(404);
      expect((await landing(faraway, token)).json()).toMatchObject({ state: 'outside', object_type: 'listing' });
      // Without the token the area gate holds…
      expect((await post(faraway, `/api/listings/${listingId}/contact`, {})).statusCode).toBe(404);
      // …with it the contact lands, and the contact row grants the read.
      const contact = await post(faraway, `/api/listings/${listingId}/contact`, { share_token: token });
      expect(contact.statusCode).toBe(201);
      expect((await get(faraway, `/api/listings/${listingId}`)).statusCode).toBe(200);
      expect((await landing(faraway, token)).json()).toMatchObject({ state: 'visible' });
    });

    it('friends-audience plan: a stranger reads outside + the host; blocked pairs get the 404', async () => {
      const host = await register(`p3bh${run}`);
      const stranger = await register(`p3bs${run}`);
      const blocked = await register(`p3bb${run}`);
      const now = Date.now();
      const created = await post(host, '/api/beacons', {
        vibe: 'chai',
        audience: 'friends',
        note: 'usual place',
        starts_at: new Date(now).toISOString(),
        expires_at: new Date(now + 2 * 3600 * 1000).toISOString(),
      });
      expect(created.statusCode).toBe(201);
      const beaconId = (created.json() as { beacon: { id: string } }).beacon.id;
      const token = await mint(host, 'beacon', beaconId);
      const out = (await landing(stranger, token)).json() as { state: string; author: { id: string } };
      expect(out.state).toBe('outside');
      expect(out.author.id).toBe(host.userId);
      expect([200, 204]).toContain((await put(host, `/api/users/${blocked.userId}/block`)).statusCode);
      const hidden = await landing(blocked, token);
      const unknown = await landing(blocked, 'x'.repeat(43));
      expect(hidden.statusCode).toBe(404);
      expect(hidden.body).toBe(unknown.body);
    });
  });

  describe('public and unlisted groups', () => {
    it('public: join lands at once; the state reads member', async () => {
      const admin = await register(`p2pub${run}`);
      const seed = await register(`p2pubm${run}`); // groups need one member
      const joiner = await register(`p2pubj${run}`);
      const convId = await createGroup(admin, [seed], 'public');
      expect((await get(joiner, `/api/conversations/${convId}/join`)).json()).toEqual({ state: 'none' });
      const res = await post(joiner, `/api/conversations/${convId}/join`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('joined');
      expect((await get(joiner, `/api/conversations/${convId}/join`)).json()).toEqual({ state: 'member' });
      // No queue on a public group — not even for the admin.
      const conv = (await get(admin, `/api/conversations/${convId}`)).json() as {
        conversation: Conversation;
      };
      expect(conv.conversation.pending_requests).toBeNull();
    });

    it('private group: GET/DELETE /join answer the unknown-id 404, byte-identical', async () => {
      const admin = await register(`p2priv${run}`);
      const seed = await register(`p2privm${run}`);
      const outsider = await register(`p2privo${run}`);
      const res = await post(admin, '/api/conversations', {
        type: 'group',
        title: `private ${run}`,
        user_ids: [seed.userId],
      });
      expect(res.statusCode).toBe(201);
      const convId = (res.json() as { conversation: Conversation }).conversation.id;
      const real = await get(outsider, `/api/conversations/${convId}/join`);
      const ghost = await get(outsider, `/api/conversations/${crypto.randomUUID()}/join`);
      expect(real.statusCode).toBe(404);
      expect(real.body).toBe(ghost.body);
      const wd = await del(outsider, `/api/conversations/${convId}/join`);
      expect(wd.statusCode).toBe(404);
      expect(wd.body).toBe(ghost.body);
    });
  });
});
