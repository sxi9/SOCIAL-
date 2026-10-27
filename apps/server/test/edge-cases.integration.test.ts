// Regression tests for the three audited v0.2 edge cases (API.md §1.11 +
// §1.12): parallel adds of DISTINCT emoji can never overshoot the per-user
// reaction cap (the guarded insert is serialized per (conversation, seq,
// user)); accept dedupe resolves BEFORE invite status, so an existing member
// re-accepting an expired invite gets 200 with use_count unchanged; leaving a
// DM makes a re-accept a genuinely-new join — a dead (expired/revoked) invite
// is refused 410, while a valid one reactivates the participant (left_at NULL,
// fresh join_seq window) instead of stranding them on conversation_not_found.
// Needs live Postgres + Redis — set DATABASE_URL and REDIS_URL (CI provides
// both); skipped otherwise.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REACTIONS_PER_USER_PER_MESSAGE_MAX,
  type InvitePrivate,
  type Message,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window
// register/public-lookup IP limits across repeated runs against the same
// Redis (13.x.x.x so this file never collides with the other suites' ranges).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `13.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

describe.runIf(infra)('v0.2 audited edge cases', () => {
  let app: FastifyInstance;

  interface Session {
    sid: string;
    userId: string;
  }

  async function register(username: string, inviteToken?: string): Promise<
    Session & { invite: { conversation_id: string } | null }
  > {
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

  async function mintInvite(me: Session, conversationId?: string): Promise<InvitePrivate> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: conversationId ? { conversation_id: conversationId } : {},
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { invite: InvitePrivate }).invite;
  }

  function accept(me: Session, token: string) {
    return app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      headers: CSRF,
      cookies: { sid: me.sid },
    });
  }

  function sendMessage(me: Session, convId: string, body: string) {
    return app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: { client_msg_id: randomUUID(), type: 'text', body },
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

  async function expireInvite(inviteId: string): Promise<void> {
    const { db, schema } = await import('../src/db/index.js');
    await db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.invites.id, inviteId));
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

  it('parallel adds of distinct emoji never exceed the per-user cap (§1.12)', async () => {
    const a = await register(`edg_rxa_${run}`);
    const b = await register(`edg_rxb_${run}`);
    const conv = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'dm', user_id: b.userId },
    });
    expect(conv.statusCode).toBe(201);
    const convId = (conv.json() as { conversation: { id: string } }).conversation.id;

    const send = await sendMessage(a, convId, 'pile on');
    expect(send.statusCode).toBe(201);
    const seq = (send.json() as { message: { seq: number } }).message.seq;

    const react = (me: Session, emoji: string) =>
      app.inject({
        method: 'POST',
        url: `/api/conversations/${convId}/messages/${seq}/reactions`,
        headers: CSRF,
        cookies: { sid: me.sid },
        payload: { emoji },
      });

    // 12 DISTINCT emoji fired CONCURRENTLY by one user: without per-(conv,
    // seq, user) serialization several cap-count subqueries read the same
    // pre-insert count and all land. Exactly 8 may succeed.
    const emoji = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎'];
    const results = await Promise.all(emoji.map((e) => react(b, e)));
    const added = results.filter((r) => r.statusCode === 204);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(added).toHaveLength(REACTIONS_PER_USER_PER_MESSAGE_MAX);
    expect(refused).toHaveLength(emoji.length - REACTIONS_PER_USER_PER_MESSAGE_MAX);
    for (const r of refused) {
      expect((r.json() as { error: string }).error).toBe('reaction_limit');
    }

    // The database agrees: exactly the cap, never more.
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_reactions
      WHERE conversation_id = ${convId} AND seq = ${seq}::bigint AND user_id = ${b.userId}
    `)) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(REACTIONS_PER_USER_PER_MESSAGE_MAX);

    // So does the viewer-scoped DTO: 8 chips, each wearing b's one face, all mine.
    const list = await listMessages(b, convId);
    const msg = (list.json() as { messages: Message[] }).messages.find((x) => x.seq === seq);
    expect(msg!.reactions).toHaveLength(REACTIONS_PER_USER_PER_MESSAGE_MAX);
    for (const chip of msg!.reactions) {
      expect(chip).toMatchObject({ has_more: false, mine: true });
      expect(chip.reactors.map((u) => u.id)).toEqual([b.userId]);
    }

    // Idempotency survives the cap: re-adding a HELD emoji stays 204, and a
    // fresh distinct one still answers 409.
    const held = msg!.reactions[0]!.emoji;
    expect((await react(b, held)).statusCode).toBe(204);
    const extra = await react(b, '🚀');
    expect(extra.statusCode).toBe(409);
    expect((extra.json() as { error: string }).error).toBe('reaction_limit');
  });

  it('DELETE /api/conversations/:id — a group admin deletes for everyone; members 403; DMs 400', async () => {
    const admin = await register(`edg_dla_${run}`);
    const member = await register(`edg_dlb_${run}`);
    const conv = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { type: 'group', title: 'doomed lounge', user_ids: [member.userId] },
    });
    expect(conv.statusCode).toBe(201);
    const groupId = (conv.json() as { conversation: { id: string } }).conversation.id;
    expect((await sendMessage(member, groupId, 'last words')).statusCode).toBe(201);

    const byMember = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${groupId}`,
      headers: CSRF,
      cookies: { sid: member.sid },
    });
    expect(byMember.statusCode).toBe(403);
    const byAdmin = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${groupId}`,
      headers: CSRF,
      cookies: { sid: admin.sid },
    });
    expect(byAdmin.statusCode).toBe(204);
    // Gone for everyone — the §1.14 404 shape, and nothing to list.
    expect((await listMessages(member, groupId)).statusCode).toBe(404);
    expect((await listMessages(admin, groupId)).statusCode).toBe(404);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${groupId}`,
      headers: CSRF,
      cookies: { sid: admin.sid },
    });
    expect(again.statusCode).toBe(404);

    // DMs are not deletable.
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { type: 'dm', user_id: member.userId },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = (dm.json() as { conversation: { id: string } }).conversation.id;
    const dmDel = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${dmId}`,
      headers: CSRF,
      cookies: { sid: admin.sid },
    });
    expect(dmDel.statusCode).toBe(400);
    expect((dmDel.json() as { error: string }).error).toBe('not_deletable');
  });

  it('dedupe precedes status: expired-invite accept by an existing member → 200, use_count unchanged (§1.11)', async () => {
    // --- Group: an active member re-accepting a now-expired invite. ---
    const admin = await register(`edg_ga_${run}`);
    const filler = await register(`edg_gb_${run}`);
    const conv = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: admin.sid },
      payload: { type: 'group', title: 'edge lounge', user_ids: [filler.userId] },
    });
    expect(conv.statusCode).toBe(201);
    const groupId = (conv.json() as { conversation: { id: string } }).conversation.id;

    const groupInvite = await mintInvite(admin, groupId);
    const joiner = await register(`edg_gc_${run}`);
    const first = await accept(joiner, groupInvite.token);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { conversation_id: string }).conversation_id).toBe(groupId);
    expect((await myInvite(admin, groupInvite.id)).use_count).toBe(1);

    await expireInvite(groupInvite.id);
    expect((await myInvite(admin, groupInvite.id)).status).toBe('expired');

    // Still a member → 200 with the conversation id, NO use consumed.
    const again = await accept(joiner, groupInvite.token);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { conversation_id: string }).conversation_id).toBe(groupId);
    expect((await myInvite(admin, groupInvite.id)).use_count).toBe(1);

    // A genuinely-new joiner still gets the precise 410 — the dead-invite
    // contract is untouched.
    const stranger = await register(`edg_gd_${run}`);
    const refused = await accept(stranger, groupInvite.token);
    expect(refused.statusCode).toBe(410);
    expect((refused.json() as { error: string }).error).toBe('invite_expired');

    // --- DM: the existing-DM dedupe answers 200 on an expired invite too. ---
    const inviter = await register(`edg_da_${run}`);
    const dmInvite = await mintInvite(inviter);
    const peer = await register(`edg_db_${run}`, dmInvite.token);
    expect(peer.invite).not.toBeNull();
    const dmId = peer.invite!.conversation_id;
    expect((await myInvite(inviter, dmInvite.id)).use_count).toBe(1);

    await expireInvite(dmInvite.id);
    const dmAgain = await accept(peer, dmInvite.token);
    expect(dmAgain.statusCode).toBe(200);
    expect((dmAgain.json() as { conversation_id: string }).conversation_id).toBe(dmId);
    expect((await myInvite(inviter, dmInvite.id)).use_count).toBe(1);
  });

  it('leave-DM-then-accept-invite reactivates the participant: left_at null, fresh window (§1.11/§1.4)', async () => {
    const inviter = await register(`edg_la_${run}`);
    const dmInvite = await mintInvite(inviter);
    const u = await register(`edg_lb_${run}`, dmInvite.token);
    expect(u.invite).not.toBeNull();
    const convId = u.invite!.conversation_id;
    expect((await myInvite(inviter, dmInvite.id)).use_count).toBe(1);

    // History u must NOT see again after re-joining (fresh §1.4 floor).
    expect((await sendMessage(inviter, convId, 'pre-leave secret')).statusCode).toBe(201);

    // u leaves the DM…
    const left = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${convId}/participants/${u.userId}`,
      headers: CSRF,
      cookies: { sid: u.sid },
    });
    expect(left.statusCode).toBe(204);

    // …and is stranded: the conversation 404s for them.
    const gone = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      cookies: { sid: u.sid },
    });
    expect(gone.statusCode).toBe(404);

    // A dead invite is NOT a re-entry capability for a departed peer: the
    // re-join is a genuinely-new join and status-gates first (§1.11).
    await expireInvite(dmInvite.id);
    const refusedExpired = await accept(u, dmInvite.token);
    expect(refusedExpired.statusCode).toBe(410);
    expect((refusedExpired.json() as { error: string }).error).toBe('invite_expired');

    // Revocation cuts them off too (precedence revoked > expired — ADR-007:
    // the token is a revocable capability).
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/invites/${dmInvite.id}`,
      headers: CSRF,
      cookies: { sid: inviter.sid },
    });
    expect(revoked.statusCode).toBe(204);
    const refusedRevoked = await accept(u, dmInvite.token);
    expect(refusedRevoked.statusCode).toBe(410);
    expect((refusedRevoked.json() as { error: string }).error).toBe('invite_revoked');
    expect((await myInvite(inviter, dmInvite.id)).use_count).toBe(1);

    // A FRESH valid invite reactivates them through the dm_key dedupe — and,
    // as a genuinely-new join, it claims a use.
    const dmInvite2 = await mintInvite(inviter);
    const back = await accept(u, dmInvite2.token);
    expect(back.statusCode).toBe(200);
    expect((back.json() as { conversation_id: string }).conversation_id).toBe(convId);
    expect((await myInvite(inviter, dmInvite2.id)).use_count).toBe(1);

    // The participant row is live again: left_at and left_seq NULL.
    const { db, schema } = await import('../src/db/index.js');
    const cp = schema.conversationParticipants;
    const [part] = await db
      .select()
      .from(cp)
      .where(and(eq(cp.conversationId, convId), eq(cp.userId, u.userId)))
      .limit(1);
    expect(part).toBeTruthy();
    expect(part!.leftAt).toBeNull();
    expect(part!.leftSeq).toBeNull();

    // No longer 404: the conversation is reachable and back in /sync.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      cookies: { sid: u.sid },
    });
    expect(detail.statusCode).toBe(200);
    const sync = await app.inject({ method: 'GET', url: '/api/sync', cookies: { sid: u.sid } });
    expect(sync.statusCode).toBe(200);
    const convIds = (sync.json() as { conversations: Array<{ id: string }> }).conversations.map(
      (c) => c.id,
    );
    expect(convIds).toContain(convId);

    // Fresh join_seq = last_seq window: the pre-leave history (and the leave
    // system message) stay hidden; the re-join drops its own invite_joined
    // system message above the floor…
    const afterRejoin = await listMessages(u, convId);
    expect(afterRejoin.statusCode).toBe(200);
    const rejoinMsgs = (afterRejoin.json() as { messages: Message[] }).messages;
    expect(rejoinMsgs).toHaveLength(1);
    expect(rejoinMsgs[0]!.body).toBe('joined via invite');

    // …while new traffic lands normally.
    expect((await sendMessage(inviter, convId, 'welcome back')).statusCode).toBe(201);
    const fresh = await listMessages(u, convId);
    const msgs = (fresh.json() as { messages: Message[] }).messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.body).toBe('welcome back');
  });
});

describe.runIf(!infra)('v0.2 audited edge cases (skipped)', () => {
  it.skip('requires DATABASE_URL and REDIS_URL (provided in CI)', () => {});
});
