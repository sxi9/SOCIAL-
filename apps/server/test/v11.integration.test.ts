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

  describe('dm_policy + Requests (Wave 1.7, migration 0015)', () => {
    async function setPolicy(me: Session, dm_policy: string): Promise<void> {
      expect((await patch(me, '/api/users/me/settings', { dm_policy })).statusCode).toBe(200);
    }
    async function listItem(me: Session, convId: string) {
      const res = await get(me, '/api/sync');
      expect(res.statusCode).toBe(200);
      return (res.json() as { conversations: ConversationListItem[] }).conversations.find((c) => c.id === convId);
    }
    function send(me: Session, convId: string, body: string) {
      return post(me, `/api/conversations/${convId}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'text',
        body,
      });
    }

    it("'connections': a stranger's DM parks in my Requests — no unread, capped sends, no call; accept opens it", async () => {
      const guarded = await register(`p5g${run}`);
      const stranger = await register(`p5s${run}`);
      await setPolicy(guarded, 'connections');
      const created = await post(stranger, '/api/conversations', { type: 'dm', user_id: guarded.userId });
      expect(created.statusCode).toBe(201);
      const conv = (created.json() as { conversation: Conversation }).conversation;
      expect(conv.pending_for_me).toBe(false); // the stranger's own row is accepted
      // The guarded side sees a request: pending, never unread.
      expect((await send(stranger, conv.id, 'hi there')).statusCode).toBe(201);
      const mine = await listItem(guarded, conv.id);
      expect(mine?.pending_for_me).toBe(true);
      expect(mine?.unread_count).toBe(0);
      // The stranger may send DM_REQUEST_MESSAGES_MAX in all, then waits.
      expect((await send(stranger, conv.id, 'two')).statusCode).toBe(201);
      expect((await send(stranger, conv.id, 'three')).statusCode).toBe(201);
      const fourth = await send(stranger, conv.id, 'four');
      expect(fourth.statusCode).toBe(400);
      expect((fourth.json() as { error: string }).error).toBe('dm_request_pending');
      // No ring into a parked request — the 404 shape.
      const call = await post(stranger, `/api/conversations/${conv.id}/calls`, { kind: 'audio' });
      expect(call.statusCode).toBe(404);
      // Accept → open: the stranger sends again, I count unread as ever.
      const ok = await post(guarded, `/api/conversations/${conv.id}/accept`);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { conversation: Conversation }).conversation.pending_for_me).toBe(false);
      expect((await send(stranger, conv.id, 'four, again')).statusCode).toBe(201);
      const after = await listItem(guarded, conv.id);
      expect(after?.pending_for_me).toBe(false);
      expect(after?.unread_count).toBeGreaterThan(0);
    });

    it("'connections': an accepted connection opens the DM at once; replying accepts a parked one", async () => {
      const guarded = await register(`p5c${run}`);
      const friend = await register(`p5f${run}`);
      const other = await register(`p5o${run}`);
      await setPolicy(guarded, 'connections');
      const req = await post(friend, `/api/users/${guarded.userId}/connect`);
      const connId = (req.json() as { connection: { id: string } }).connection.id;
      expect((await post(guarded, `/api/connections/${connId}/accept`)).statusCode).toBe(200);
      const open = await post(friend, '/api/conversations', { type: 'dm', user_id: guarded.userId });
      expect(open.statusCode).toBe(201);
      expect((await listItem(guarded, (open.json() as { conversation: Conversation }).conversation.id))?.pending_for_me).toBe(false);
      // A parked one: the guarded side replying accepts it implicitly.
      const parked = (await post(other, '/api/conversations', { type: 'dm', user_id: guarded.userId })).json() as {
        conversation: Conversation;
      };
      expect((await listItem(guarded, parked.conversation.id))?.pending_for_me).toBe(true);
      expect((await send(guarded, parked.conversation.id, 'sure, hi')).statusCode).toBe(201);
      expect((await listItem(guarded, parked.conversation.id))?.pending_for_me).toBe(false);
    });

    it('deleting a request is silent (no system row) and asking again re-seats it as a request', async () => {
      const guarded = await register(`p5d${run}`);
      const stranger = await register(`p5ds${run}`);
      await setPolicy(guarded, 'connections');
      const conv = (await post(stranger, '/api/conversations', { type: 'dm', user_id: guarded.userId })).json() as {
        conversation: Conversation;
      };
      expect((await send(stranger, conv.conversation.id, 'hello?')).statusCode).toBe(201);
      // Delete = self-leave; silent to the stranger.
      expect((await del(guarded, `/api/conversations/${conv.conversation.id}/participants/${guarded.userId}`)).statusCode).toBe(204);
      const history = (await get(stranger, `/api/conversations/${conv.conversation.id}/messages?after_seq=0`)).json() as {
        messages: { type: string; body: string | null }[];
      };
      expect(history.messages.some((m) => m.type === 'system' && /left/.test(m.body ?? ''))).toBe(false);
      expect(await listItem(guarded, conv.conversation.id)).toBeUndefined();
      // Asking again re-seats the recipient, parked again.
      const again = await post(stranger, '/api/conversations', { type: 'dm', user_id: guarded.userId });
      expect(again.statusCode).toBe(200);
      expect((await listItem(guarded, conv.conversation.id))?.pending_for_me).toBe(true);
    });

    it("'nobody' refuses a NEW DM in the unknown-user 404 shape; an existing DM stays open", async () => {
      const closed = await register(`p5n${run}`);
      const before = await register(`p5b${run}`);
      const later = await register(`p5l${run}`);
      // A DM that existed before the policy flipped survives it.
      const existing = await post(before, '/api/conversations', { type: 'dm', user_id: closed.userId });
      expect(existing.statusCode).toBe(201);
      await setPolicy(closed, 'nobody');
      const again = await post(before, '/api/conversations', { type: 'dm', user_id: closed.userId });
      expect(again.statusCode).toBe(200);
      const refused = await post(later, '/api/conversations', { type: 'dm', user_id: closed.userId });
      const unknown = await post(later, '/api/conversations', { type: 'dm', user_id: crypto.randomUUID() });
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toBe(unknown.body);
    });
  });

  describe('§2.5 admin half: bans, delete-any, hand over (migration 0016)', () => {
    function send(me: Session, convId: string, body: string) {
      return post(me, `/api/conversations/${convId}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'text',
        body,
      });
    }
    async function mintInvite(me: Session, convId: string): Promise<string> {
      const res = await post(me, '/api/invites', { conversation_id: convId });
      expect(res.statusCode).toBe(201);
      return (res.json() as { invite: { token: string } }).invite.token;
    }

    it('a removed member is banned at every door until an admin lets them back', async () => {
      const admin = await register(`p6a${run}`);
      const kicked = await register(`p6k${run}`);
      const seed = await register(`p6s${run}`);
      const convId = await createGroup(admin, [kicked, seed], 'public');
      const token = await mintInvite(admin, convId);
      // Remove = ban (silent to the doors).
      expect((await del(admin, `/api/conversations/${convId}/participants/${kicked.userId}`)).statusCode).toBe(204);
      const bans = (await get(admin, `/api/conversations/${convId}/bans`)).json() as { bans: { user: { id: string } }[] };
      expect(bans.bans.map((b) => b.user.id)).toEqual([kicked.userId]);
      // Invite link: the blocked-pair 404, no use burned.
      const viaLink = await post(kicked, `/api/invites/${token}/accept`);
      expect(viaLink.statusCode).toBe(404);
      expect((viaLink.json() as { error: string }).error).toBe('invite_not_found');
      // Public join: the unlisted 404, byte-identical to an unknown id.
      const viaJoin = await post(kicked, `/api/conversations/${convId}/join`);
      const unknown = await post(kicked, `/api/conversations/${crypto.randomUUID()}/join`);
      expect(viaJoin.statusCode).toBe(404);
      expect(viaJoin.body).toBe(unknown.body);
      // Invite-only: the usual 202, but nothing parks and the admin queue stays empty.
      expect((await patch(admin, `/api/conversations/${convId}/visibility`, { visibility: 'invite_only' })).statusCode).toBe(200);
      expect((await post(kicked, `/api/conversations/${convId}/join`)).statusCode).toBe(202);
      const queue = (await get(admin, `/api/conversations/${convId}/join-requests`)).json() as { requests: unknown[] };
      expect(queue.requests).toHaveLength(0);
      // A member (not admin) may not read the list.
      expect((await get(seed, `/api/conversations/${convId}/bans`)).statusCode).toBe(403);
      // Lift it: the link works again.
      expect((await del(admin, `/api/conversations/${convId}/bans/${kicked.userId}`)).statusCode).toBe(204);
      expect((await post(kicked, `/api/invites/${token}/accept`)).statusCode).toBe(200);
    });

    it('an admin adding someone back lifts the ban; approving a request does too', async () => {
      const admin = await register(`p6b${run}`);
      const kicked = await register(`p6bk${run}`);
      const convId = await createGroup(admin, [kicked], 'public');
      expect((await del(admin, `/api/conversations/${convId}/participants/${kicked.userId}`)).statusCode).toBe(204);
      const add = await post(admin, `/api/conversations/${convId}/participants`, { user_ids: [kicked.userId] });
      expect(add.statusCode).toBe(200);
      const bans = (await get(admin, `/api/conversations/${convId}/bans`)).json() as { bans: unknown[] };
      expect(bans.bans).toHaveLength(0);
    });

    it('admins remove anyone’s message (stub says so); members only their own; undo stays the author’s', async () => {
      const admin = await register(`p6d${run}`);
      const member = await register(`p6dm${run}`);
      const convId = await createGroup(admin, [member], 'public');
      const sent = await send(member, convId, 'oops');
      expect(sent.statusCode).toBe(201);
      const seq = (sent.json() as { message: { seq: number } }).message.seq;
      const mine = await send(admin, convId, 'admin words');
      const adminSeq = (mine.json() as { message: { seq: number } }).message.seq;
      // A member cannot touch the admin's message.
      expect((await del(member, `/api/conversations/${convId}/messages/${adminSeq}`)).statusCode).toBe(403);
      // The admin cannot UNDO someone else's (author-only), but can remove it.
      expect((await del(admin, `/api/conversations/${convId}/messages/${seq}?undo=1`)).statusCode).toBe(403);
      expect((await del(admin, `/api/conversations/${convId}/messages/${seq}`)).statusCode).toBe(204);
      const history = (await get(member, `/api/conversations/${convId}/messages?after_seq=0`)).json() as {
        messages: { seq: number; deleted_at: string | null; metadata: { removed_by?: string } }[];
      };
      const stub = history.messages.find((m) => m.seq === seq);
      expect(stub?.deleted_at).not.toBeNull();
      expect(stub?.metadata.removed_by).toBe(admin.userId);
    });

    it('the only admin cannot leave or step down while others remain; handing over makes them a member', async () => {
      const admin = await register(`p6t${run}`);
      const next = await register(`p6tn${run}`);
      const convId = await createGroup(admin, [next], 'public');
      const leave = await del(admin, `/api/conversations/${convId}/participants/${admin.userId}`);
      expect(leave.statusCode).toBe(403);
      expect((leave.json() as { error: string }).error).toBe('last_admin');
      const demote = await app.inject({
        method: 'PUT',
        url: `/api/conversations/${convId}/participants/${admin.userId}/role`,
        headers: CSRF,
        cookies: { sid: admin.sid },
        payload: { role: 'member' },
      });
      expect(demote.statusCode).toBe(403);
      const handover = await post(admin, `/api/conversations/${convId}/transfer`, { user_id: next.userId });
      expect(handover.statusCode).toBe(200);
      const conv = (handover.json() as { conversation: Conversation }).conversation;
      const roleOf = (id: string) => conv.participants.find((p) => p.user.id === id)?.role;
      expect(roleOf(next.userId)).toBe('admin');
      expect(roleOf(admin.userId)).toBe('member');
      // Now the former admin may leave.
      expect((await del(admin, `/api/conversations/${convId}/participants/${admin.userId}`)).statusCode).toBe(204);
    });
  });

  describe('profile share (phase 6, migration 0017)', () => {
    type Hero = {
      username: string;
      display_name: string;
      avatar_url: string | null;
      visibility: 'full' | 'minimal';
      bio_line: string | null;
      interests: string[];
      joined: string | null;
      doors: { message: boolean; call: boolean };
    };
    function pub(username: string) {
      return app.inject({
        method: 'GET',
        url: `/api/users/${encodeURIComponent(username)}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
    }
    async function settings(me: Session, body: Record<string, unknown>): Promise<void> {
      expect((await patch(me, '/api/users/me/settings', body)).statusCode).toBe(200);
    }

    it('UNAUTHENTICATED hero: public visibility = bio line, interests, joined month; never id/last-seen/mood', async () => {
      const me = await register(`p6pub${run}`);
      expect(
        (await patch(me, '/api/users/me', { bio: 'first line of bio\nsecond line never ships' })).statusCode,
      ).toBe(200);
      expect((await patch(me, '/api/users/me/profile', { interests: ['chai', 'walks'] })).statusCode).toBe(200);
      const res = await pub(me.username);
      expect(res.statusCode).toBe(200);
      const hero = (res.json() as { hero: Hero }).hero;
      expect(hero.username).toBe(me.username);
      expect(hero.visibility).toBe('full');
      expect(hero.bio_line).toBe('first line of bio');
      expect(hero.interests).toEqual(['chai', 'walks']);
      expect(hero.joined).toMatch(/^\d{4}-\d{2}$/);
      expect(hero.avatar_url).toBeNull(); // no avatar yet → no path
      // A fresh account defaults dm_policy 'connections': Message opens
      // (it parks in Requests), Call does not (a parked DM can't be rung).
      expect(hero.doors).toEqual({ message: true, call: false });
      const raw = res.json() as Record<string, unknown>;
      expect(JSON.stringify(raw)).not.toContain(me.userId);
      expect(JSON.stringify(raw)).not.toMatch(/last_seen|mood|beacons_/);
    });

    it("'connections' / 'private' visibility reduce the hero to avatar + name; dm_policy drives the doors", async () => {
      const me = await register(`p6min${run}`);
      expect((await patch(me, '/api/users/me', { bio: 'hidden when minimal' })).statusCode).toBe(200);
      await settings(me, { profile_visibility: 'private', dm_policy: 'everyone' });
      let hero = ((await pub(me.username)).json() as { hero: Hero }).hero;
      expect(hero.visibility).toBe('minimal');
      expect(hero.bio_line).toBeNull();
      expect(hero.interests).toEqual([]);
      expect(hero.joined).toBeNull();
      expect(hero.display_name).toBe(`Real ${me.username}`);
      expect(hero.doors).toEqual({ message: true, call: true });
      await settings(me, { profile_visibility: 'connections', dm_policy: 'nobody' });
      hero = ((await pub(me.username)).json() as { hero: Hero }).hero;
      expect(hero.visibility).toBe('minimal');
      expect(hero.doors).toEqual({ message: false, call: false });
    });

    it('unknown and banned answer ONE 404 user_not_found (byte-identical); the avatar proxy too', async () => {
      const victim = await register(`p6ban${run}`);
      const ghost = await pub(`nobody${run}x`);
      expect(ghost.statusCode).toBe(404);
      expect((await pub(victim.username)).statusCode).toBe(200);
      const { db } = await import('../src/db/index.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`UPDATE users SET banned_at = now() WHERE id = ${victim.userId}::uuid`);
      const banned = await pub(victim.username);
      expect(banned.statusCode).toBe(404);
      expect(banned.body).toBe(ghost.body);
      const av = await app.inject({
        method: 'GET',
        url: `/api/users/${victim.username}/public-avatar?v=static`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(av.statusCode).toBe(404);
      expect(av.body).toBe(ghost.body);
      // The animated variant is never public — the schema refuses it.
      const anim = await app.inject({
        method: 'GET',
        url: `/api/users/${victim.username}/public-avatar?v=animated`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(anim.statusCode).toBe(400);
    });

    it('profile token: owner-only mint (anyone else → 404), the page is the same hero, /mine labels it, revoke kills it', async () => {
      const me = await register(`p6tok${run}`);
      const other = await register(`p6toko${run}`);
      expect((await patch(me, '/api/users/me', { bio: 'card bio' })).statusCode).toBe(200);
      // Someone else's id: the §1.14 404 — their /u/ address needs no token.
      const notMine = await post(other, '/api/share-links', { type: 'profile', id: me.userId });
      expect(notMine.statusCode).toBe(404);
      const minted = await post(me, '/api/share-links', { type: 'profile', id: me.userId });
      expect(minted.statusCode).toBe(200);
      const link = (minted.json() as { share_link: { token: string; url: string; preview: string } }).share_link;
      expect(link.url).toBe(`/p/${link.token}`);
      expect(link.preview).toBe('full');
      // Mint-or-return: the ONE open token per owner.
      const again = await post(me, '/api/share-links', { type: 'profile', id: me.userId });
      expect((again.json() as { share_link: { token: string } }).share_link.token).toBe(link.token);
      const page = await app.inject({
        method: 'GET',
        url: `/api/share/${link.token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(page.statusCode).toBe(200);
      const body = (page.json() as { page: Hero & { type: string; id: string } }).page;
      expect(body.type).toBe('profile');
      expect(body.id).toBe(me.userId);
      expect(body.bio_line).toBe('card bio');
      expect(body.visibility).toBe('full');
      // The setting narrows the page LIVE — the token never widens it.
      await settings(me, { profile_visibility: 'private' });
      const narrowed = await app.inject({
        method: 'GET',
        url: `/api/share/${link.token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      const nb = (narrowed.json() as { page: Hero }).page;
      expect(nb.visibility).toBe('minimal');
      expect(nb.bio_line).toBeNull();
      // Listed for the owner with a human label.
      const mine = await get(me, '/api/share-links/mine');
      expect(mine.statusCode).toBe(200);
      const item = (mine.json() as { share_links: { token: string; label: string; live: boolean }[] }).share_links.find(
        (l) => l.token === link.token,
      );
      expect(item?.label).toBe(`Profile · @${me.username}`);
      expect(item?.live).toBe(true);
      // The share-page Report link works on a profile card (reports CHECK widened in 0017).
      const rep = await app.inject({
        method: 'POST',
        url: `/api/share/${link.token}/report`,
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: { reason: 'test report on a profile card' },
      });
      expect(rep.statusCode).toBe(204);
      // Only the owner (or an admin) revokes — anyone else gets the §1.14 404; then the page is gone.
      expect((await del(other, `/api/share-links/${link.token}`)).statusCode).toBe(404);
      expect((await del(me, `/api/share-links/${link.token}`)).statusCode).toBe(204);
      const gone = await app.inject({
        method: 'GET',
        url: `/api/share/${link.token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(gone.statusCode).toBe(404);
    });

    it('a banned owner\'s profile token page is the one 404', async () => {
      const me = await register(`p6tokb${run}`);
      const minted = await post(me, '/api/share-links', { type: 'profile', id: me.userId });
      const token = (minted.json() as { share_link: { token: string } }).share_link.token;
      const { db } = await import('../src/db/index.js');
      const { sql } = await import('drizzle-orm');
      await db.execute(sql`UPDATE users SET banned_at = now() WHERE id = ${me.userId}::uuid`);
      const page = await app.inject({
        method: 'GET',
        url: `/api/share/${token}/public`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(page.statusCode).toBe(404);
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
