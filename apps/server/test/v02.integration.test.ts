// v0.2 integration tests (API.md §1.11 invites + §1.12 reactions):
// mint → public lookup → register-with-token creates the DM, drops the
// invite_joined system message and bumps use_count exactly once; exhausted
// invites read as such and refuse accepts without failing registration;
// reaction add/remove round-trips through the viewer-scoped message DTO.
// Needs live Postgres + Redis — set DATABASE_URL and REDIS_URL (CI provides
// both); skipped otherwise.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvitePrivate, InvitePublic, Message } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window
// register/public-lookup IP limits across repeated runs against the same
// Redis (12.x.x.x so this file never collides with the other suites' ranges).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `12.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

describe.runIf(infra)('v0.2 invites & reactions', () => {
  let app: FastifyInstance;

  interface Session {
    sid: string;
    userId: string;
  }

  async function register(
    username: string,
    inviteToken?: string,
  ): Promise<Session & { invite: { conversation_id: string } | null }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password123',
        display_name: username,
        ...(inviteToken ? { invite_token: inviteToken } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    const sid = res.cookies.find((c) => c.name === 'sid')?.value;
    expect(sid).toBeTruthy();
    const body = res.json() as {
      user: { id: string };
      invite: { conversation_id: string } | null;
    };
    return { sid: sid!, userId: body.user.id, invite: body.invite ?? null };
  }

  function mintInvite(me: Session, conversationId?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: conversationId ? { conversation_id: conversationId } : {},
    });
  }

  function listMessages(me: Session, convId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}/messages?after_seq=0&limit=100`,
      cookies: { sid: me.sid },
    });
  }

  async function myInvite(me: Session, inviteId: string): Promise<InvitePrivate> {
    const res = await app.inject({ method: 'GET', url: '/api/invites', cookies: { sid: me.sid } });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as { invites: InvitePrivate[] }).invites.find((i) => i.id === inviteId);
    expect(row).toBeTruthy();
    return row!;
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

  it('mint → public lookup → register-with-token: DM + system message + use_count', async () => {
    const inviter = await register(`vinv_a_${run}`);

    // Mint a DM-with-inviter invite.
    const mint = await mintInvite(inviter);
    expect(mint.statusCode).toBe(201);
    const invite = (mint.json() as { invite: InvitePrivate }).invite;
    expect(invite.kind).toBe('dm');
    expect(invite.conversation_id).toBeNull();
    expect(invite.status).toBe('valid');
    expect(invite.use_count).toBe(0);
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(invite.url).toBe(`/join/${invite.token}`);

    // Public lookup is UNAUTHENTICATED and shows the inviter.
    const pub = await app.inject({
      method: 'GET',
      url: `/api/invites/${invite.token}/public`,
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(pub.statusCode).toBe(200);
    const pubInvite = (pub.json() as { invite: InvitePublic }).invite;
    expect(pubInvite.status).toBe('valid');
    expect(pubInvite.kind).toBe('dm');
    expect(pubInvite.group_title).toBeNull();
    expect(pubInvite.inviter.username).toBe(`vinv_a_${run}`);
    // No avatar uploaded → proxy URLs are null even while valid.
    expect(pubInvite.inviter.avatar.static_url).toBeNull();
    expect(pubInvite.inviter.avatar.animated_url).toBeNull();

    // Unknown (well-formed) token → 404 invite_not_found, nothing more.
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/invites/${'A'.repeat(43)}/public`,
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: string }).error).toBe('invite_not_found');

    // Register through the link: the DM with the inviter is created.
    const joiner = await register(`vinv_b_${run}`, invite.token);
    expect(joiner.invite).not.toBeNull();
    const convId = joiner.invite!.conversation_id;

    // The invite_joined system message landed, visible to the joiner.
    const list = await listMessages(joiner, convId);
    expect(list.statusCode).toBe(200);
    const msgs = (list.json() as { messages: Message[] }).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe('system');
    expect(msgs[0]!.body).toBe('joined via invite');
    expect(msgs[0]!.metadata.system).toEqual({
      event: 'invite_joined',
      actor_id: joiner.userId,
      target_id: inviter.userId,
    });

    // use_count bumped exactly once, visible in the minter's list.
    expect((await myInvite(inviter, invite.id)).use_count).toBe(1);

    // Idempotent re-accept by the logged-in joiner: same conversation, no
    // second increment, no second system message.
    const again = await app.inject({
      method: 'POST',
      url: `/api/invites/${invite.token}/accept`,
      headers: CSRF,
      cookies: { sid: joiner.sid },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { conversation_id: string }).conversation_id).toBe(convId);
    expect((await myInvite(inviter, invite.id)).use_count).toBe(1);
    const relist = await listMessages(joiner, convId);
    expect((relist.json() as { messages: Message[] }).messages).toHaveLength(1);

    // Your own invite: 400 invite_own.
    const own = await app.inject({
      method: 'POST',
      url: `/api/invites/${invite.token}/accept`,
      headers: CSRF,
      cookies: { sid: inviter.sid },
    });
    expect(own.statusCode).toBe(400);
    expect((own.json() as { error: string }).error).toBe('invite_own');
  });

  it('exhausted invite: status exhausted, 410 on accept, registration still succeeds', async () => {
    const inviter = await register(`vexh_a_${run}`);
    const mint = await mintInvite(inviter);
    expect(mint.statusCode).toBe(201);
    const invite = (mint.json() as { invite: InvitePrivate }).invite;

    // Burn every use directly (max_uses defaults to 50 — simulate 50 joins).
    const { db, schema } = await import('../src/db/index.js');
    await db
      .update(schema.invites)
      .set({ useCount: invite.max_uses })
      .where(eq(schema.invites.id, invite.id));

    // Public lookup still answers 200 — with the derived status by name.
    const pub = await app.inject({
      method: 'GET',
      url: `/api/invites/${invite.token}/public`,
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(pub.statusCode).toBe(200);
    expect((pub.json() as { invite: InvitePublic }).invite.status).toBe('exhausted');

    // Logged-in accept → 410 invite_exhausted.
    const user = await register(`vexh_b_${run}`);
    const acc = await app.inject({
      method: 'POST',
      url: `/api/invites/${invite.token}/accept`,
      headers: CSRF,
      cookies: { sid: user.sid },
    });
    expect(acc.statusCode).toBe(410);
    expect((acc.json() as { error: string }).error).toBe('invite_exhausted');

    // Register-with-token NEVER fails on a dead invite: account created,
    // invite null (API.md §1.1/§1.11).
    const reg = await register(`vexh_c_${run}`, invite.token);
    expect(reg.invite).toBeNull();
  });

  it('revoke: 204 idempotent, then the public lookup reads revoked', async () => {
    const inviter = await register(`vrev_a_${run}`);
    const mint = await mintInvite(inviter);
    const invite = (mint.json() as { invite: InvitePrivate }).invite;

    const revoke = () =>
      app.inject({
        method: 'DELETE',
        url: `/api/invites/${invite.id}`,
        headers: CSRF,
        cookies: { sid: inviter.sid },
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204); // idempotent re-revoke

    const pub = await app.inject({
      method: 'GET',
      url: `/api/invites/${invite.token}/public`,
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect((pub.json() as { invite: InvitePublic }).invite.status).toBe('revoked');
  });

  it('group invite: admin-only mint, scope errors, join_seq history floor on accept', async () => {
    const admin = await register(`vgrp_a_${run}`);
    const member = await register(`vgrp_b_${run}`);
    const conv = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { type: 'group', title: 'bored lounge', user_ids: [member.userId] },
    });
    expect(conv.statusCode).toBe(201);
    const groupId = (conv.json() as { conversation: { id: string } }).conversation.id;

    // Pre-join history the invitee must never see (the §1.4 join_seq floor).
    const secret = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/messages`,
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { client_msg_id: randomUUID(), type: 'text', body: 'secret before join' },
    });
    expect(secret.statusCode).toBe(201);

    // Group minting is ADMIN-only (matching §1.4 participant adds).
    const notAdmin = await mintInvite(member, groupId);
    expect(notAdmin.statusCode).toBe(403);

    // A DM conversation_id cannot be invite-scoped.
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { type: 'dm', user_id: member.userId },
    });
    const dmId = (dm.json() as { conversation: { id: string } }).conversation.id;
    const badScope = await mintInvite(admin, dmId);
    expect(badScope.statusCode).toBe(400);
    expect((badScope.json() as { error: string }).error).toBe('invite_bad_scope');

    const mint = await mintInvite(admin, groupId);
    expect(mint.statusCode).toBe(201);
    const invite = (mint.json() as { invite: InvitePrivate }).invite;
    expect(invite.kind).toBe('group');
    expect(invite.conversation_id).toBe(groupId);

    // Public lookup names the group.
    const pub = await app.inject({
      method: 'GET',
      url: `/api/invites/${invite.token}/public`,
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect((pub.json() as { invite: InvitePublic }).invite).toMatchObject({
      kind: 'group',
      group_title: 'bored lounge',
    });

    // Logged-in accept joins as role 'member' above the history floor.
    const joiner = await register(`vgrp_c_${run}`);
    const acc = await app.inject({
      method: 'POST',
      url: `/api/invites/${invite.token}/accept`,
      headers: CSRF,
      cookies: { sid: joiner.sid },
    });
    expect(acc.statusCode).toBe(200);
    expect((acc.json() as { conversation_id: string }).conversation_id).toBe(groupId);

    const list = await listMessages(joiner, groupId);
    const msgs = (list.json() as { messages: Message[] }).messages;
    expect(msgs.some((x) => x.body === 'secret before join')).toBe(false);
    expect(msgs).toHaveLength(1); // only the invite_joined system message
    expect(msgs[0]!.metadata.system?.event).toBe('invite_joined');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/conversations/${groupId}`,
      cookies: { sid: joiner.sid },
    });
    const parts = (detail.json() as {
      conversation: { participants: Array<{ user: { id: string }; role: string }> };
    }).conversation.participants;
    expect(parts.find((p) => p.user.id === joiner.userId)?.role).toBe('member');
    expect((await myInvite(admin, invite.id)).use_count).toBe(1);
  });

  it('reaction add/remove round-trips through the viewer-scoped message DTO', async () => {
    const a = await register(`vrx_a_${run}`);
    const b = await register(`vrx_b_${run}`);
    const conv = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'dm', user_id: b.userId },
    });
    expect(conv.statusCode).toBe(201);
    const convId = (conv.json() as { conversation: { id: string } }).conversation.id;

    const send = await app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { client_msg_id: randomUUID(), type: 'text', body: 'react to me' },
    });
    expect(send.statusCode).toBe(201);
    const seq = (send.json() as { message: { seq: number } }).message.seq;

    const fire = '\u{1F525}'; // 🔥 — astral, URL-encodes to 4 bytes
    const react = (me: Session, emoji: string) =>
      app.inject({
        method: 'POST',
        url: `/api/conversations/${convId}/messages/${seq}/reactions`,
        headers: CSRF,
        cookies: { sid: me.sid },
        payload: { emoji },
      });
    const unreact = (me: Session, emoji: string) =>
      app.inject({
        method: 'DELETE',
        url: `/api/conversations/${convId}/messages/${seq}/reactions/${encodeURIComponent(emoji)}`,
        headers: CSRF,
        cookies: { sid: me.sid },
      });
    const reactionsSeenBy = async (me: Session) => {
      const res = await listMessages(me, convId);
      expect(res.statusCode).toBe(200);
      const msg = (res.json() as { messages: Message[] }).messages.find((x) => x.seq === seq);
      return msg!.reactions;
    };

    // Chips carry FACES (reactor ids in first-reaction order), never a count.
    const faces = (chips: Message['reactions']) =>
      chips.map((c) => ({
        emoji: c.emoji,
        ids: c.reactors.map((u) => u.id),
        has_more: c.has_more,
        mine: c.mine,
      }));

    // b reacts; re-add is an idempotent 204 (no duplicate face).
    expect((await react(b, fire)).statusCode).toBe(204);
    expect((await react(b, fire)).statusCode).toBe(204);
    expect(faces(await reactionsSeenBy(b))).toEqual([
      { emoji: fire, ids: [b.userId], has_more: false, mine: true },
    ]);
    // `mine` is viewer-dependent: a sees the same face, not held.
    expect(faces(await reactionsSeenBy(a))).toEqual([
      { emoji: fire, ids: [b.userId], has_more: false, mine: false },
    ]);

    // a piles on → two faces in first-reaction order, mine true for a.
    expect((await react(a, fire)).statusCode).toBe(204);
    expect(faces(await reactionsSeenBy(a))).toEqual([
      { emoji: fire, ids: [b.userId, a.userId], has_more: false, mine: true },
    ]);

    // b removes; removing again stays an idempotent 204.
    expect((await unreact(b, fire)).statusCode).toBe(204);
    expect((await unreact(b, fire)).statusCode).toBe(204);
    expect(faces(await reactionsSeenBy(b))).toEqual([
      { emoji: fire, ids: [a.userId], has_more: false, mine: false },
    ]);

    // Distinct-emoji cap: b holds 8, the 9th distinct → 409 reaction_limit,
    // but re-adding a held emoji at the cap stays 204.
    const emoji = ['😀', '😂', '😅', '😎', '😭', '👍', '👎', '🎉'];
    for (const e of emoji) expect((await react(b, e)).statusCode).toBe(204);
    const ninth = await react(b, '🚀');
    expect(ninth.statusCode).toBe(409);
    expect((ninth.json() as { error: string }).error).toBe('reaction_limit');
    expect((await react(b, '😀')).statusCode).toBe(204);

    // Reacting to an invisible seq (0/unknown) is an undifferentiated 404.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages/999/reactions`,
      headers: CSRF,
      cookies: { sid: b.sid },
      payload: { emoji: fire },
    });
    expect(bad.statusCode).toBe(404);
  });
});

describe.runIf(!infra)('v0.2 invites & reactions (skipped)', () => {
  it.skip('requires DATABASE_URL and REDIS_URL (provided in CI)', () => {});
});
