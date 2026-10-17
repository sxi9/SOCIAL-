// v0.5a social-layer tests (API.md §1.28–§1.37, ADR-011):
// connection pair uniqueness + block prevention; channel non-admin send
// rejection; finite feed pagination (all_caught_up) + blocked/non-connection
// exclusion; edit window + tombstone immutability (+ reply context over a
// tombstone, + server-parsed mentions); story friends-of visibility + the
// author-only view list. The mention-vs-mute-vs-block push guard is PURE
// (lib/pushGuard.ts) and runs ungated. Infra-gated like the other suites —
// needs live Postgres + Redis (DATABASE_URL + REDIS_URL); skipped otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  Connection,
  Conversation,
  FeedResponse,
  InvitePrivate,
  ListConnectionsResponse,
  Message,
  Post,
  Story,
  StoryAuthorGroup,
  UserLite,
} from '@socialchat/shared';
import { messagePushAllowed } from '../src/lib/pushGuard.js';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (15.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `15.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

// ---------------------------------------------------------------------------
// §1.33/§2.9 push guard — PURE unit (no infra): a mention overrides mute and
// ONLY mute; a block is absolute; read-elsewhere still suppresses.
// ---------------------------------------------------------------------------
describe('v0.5a mention push guard (pure)', () => {
  const now = Date.now();
  const mutedFuture = new Date(now + 3600_000);
  const base = { blockedPair: false, lastReadSeq: 0, seq: 5, mutedUntil: null, mentioned: false, now };

  it('allows an ordinary unread, unmuted push', () => {
    expect(messagePushAllowed({ ...base })).toBe(true);
  });

  it('mute suppresses a non-mention', () => {
    expect(messagePushAllowed({ ...base, mutedUntil: mutedFuture })).toBe(false);
  });

  it('a mention OVERRIDES mute', () => {
    expect(messagePushAllowed({ ...base, mutedUntil: mutedFuture, mentioned: true })).toBe(true);
  });

  it('a mention NEVER overrides a block', () => {
    expect(
      messagePushAllowed({ ...base, blockedPair: true, mentioned: true }),
    ).toBe(false);
    expect(
      messagePushAllowed({ ...base, blockedPair: true, mutedUntil: mutedFuture, mentioned: true }),
    ).toBe(false);
  });

  it('read-elsewhere suppresses even a mention', () => {
    expect(messagePushAllowed({ ...base, lastReadSeq: 5, mentioned: true })).toBe(false);
  });

  it('an expired mute never suppresses', () => {
    expect(
      messagePushAllowed({ ...base, mutedUntil: new Date(now - 1000) }),
    ).toBe(true);
  });
});

describe.runIf(infra)('v0.5a social layer', () => {
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
  function put(me: Session, url: string, payload?: unknown) {
    return app.inject({ method: 'PUT', url, headers: CSRF, cookies: { sid: me.sid }, payload });
  }
  function patch(me: Session, url: string, payload: unknown) {
    return app.inject({ method: 'PATCH', url, headers: CSRF, cookies: { sid: me.sid }, payload });
  }
  function del(me: Session, url: string) {
    return app.inject({ method: 'DELETE', url, headers: CSRF, cookies: { sid: me.sid } });
  }

  async function createDm(a: Session, b: Session): Promise<string> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: b.userId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation.id;
  }

  async function sendText(me: Session, convId: string, body: string): Promise<Message> {
    const res = await post(me, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { message: Message }).message;
  }

  /** Accepted connection both ways: a requests, b's counter-request accepts. */
  async function connectPair(a: Session, b: Session): Promise<void> {
    const r1 = await post(a, `/api/users/${b.userId}/connect`);
    expect(r1.statusCode).toBe(201);
    const r2 = await post(b, `/api/users/${a.userId}/connect`);
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { connection: Connection }).connection.status).toBe('accepted');
  }

  async function block(blocker: Session, target: Session): Promise<void> {
    const res = await put(blocker, `/api/users/${target.userId}/block`);
    expect(res.statusCode).toBe(204);
  }

  /** The §1.6 pipeline needs MinIO/ffmpeg — insert a ready image row directly. */
  async function readyImageAttachment(uploaderId: string): Promise<string> {
    const { db, schema } = await import('../src/db/index.js');
    const id = randomUUID();
    await db.insert(schema.attachments).values({
      id,
      uploaderId,
      kind: 'image',
      originalKey: `orig/test-${id}.webp`,
      thumbKey: `thumb/test-${id}.webp`,
      mime: 'image/webp',
      sizeBytes: 1024,
      width: 64,
      height: 64,
      status: 'ready',
    });
    return id;
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
        queues.timersQueue,
      ].map((q) => q.close()),
    );
    await queues.queueConnection.quit().catch(() => {});
    const { redis } = await import('../src/redis.js');
    await redis.quit().catch(() => {});
    const { pg } = await import('../src/db/index.js');
    await pg.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // §1.28 connections — pair uniqueness + block prevention
  // -------------------------------------------------------------------------
  it('connections: one row per unordered pair, cross-request accepts', async () => {
    const a = await register(`v5cona${run}`);
    const b = await register(`v5conb${run}`);

    const r1 = await post(a, `/api/users/${b.userId}/connect`);
    expect(r1.statusCode).toBe(201);
    const c1 = (r1.json() as { connection: Connection }).connection;
    expect(c1.status).toBe('pending');
    expect(c1.direction).toBe('outgoing');

    // Idempotent re-request → 200, same row.
    const r1b = await post(a, `/api/users/${b.userId}/connect`);
    expect(r1b.statusCode).toBe(200);
    expect((r1b.json() as { connection: Connection }).connection.id).toBe(c1.id);

    // The counter-request ACCEPTS instead of creating a second row.
    const r2 = await post(b, `/api/users/${a.userId}/connect`);
    expect(r2.statusCode).toBe(200);
    const c2 = (r2.json() as { connection: Connection }).connection;
    expect(c2.id).toBe(c1.id);
    expect(c2.status).toBe('accepted');
    expect(c2.responded_at).not.toBeNull();

    // DB-level uniqueness: exactly ONE row for the unordered pair.
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM connections
      WHERE LEAST(requester_id, addressee_id) = LEAST(${a.userId}::uuid, ${b.userId}::uuid)
        AND GREATEST(requester_id, addressee_id) = GREATEST(${a.userId}::uuid, ${b.userId}::uuid)
    `)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(1);

    // Both lists agree.
    const list = (await get(a, '/api/connections')).json() as ListConnectionsResponse;
    expect(list.connections.map((c) => c.user.id)).toContain(b.userId);
    expect(list.incoming).toHaveLength(0);
    expect(list.outgoing).toHaveLength(0);
  });

  it('connections: blocks prevent requests (404-shaped) and delete pending rows', async () => {
    const e = await register(`v5cone${run}`);
    const f = await register(`v5conf${run}`);
    await block(e, f);
    // Both directions read as not_found — never a 403 confirming the block.
    expect((await post(f, `/api/users/${e.userId}/connect`)).statusCode).toBe(404);
    expect((await post(e, `/api/users/${f.userId}/connect`)).statusCode).toBe(404);

    // A block DELETES a pending request, silently.
    const g = await register(`v5cong${run}`);
    const h = await register(`v5conh${run}`);
    expect((await post(g, `/api/users/${h.userId}/connect`)).statusCode).toBe(201);
    await block(h, g);
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM connections
      WHERE (requester_id = ${g.userId} AND addressee_id = ${h.userId})
         OR (requester_id = ${h.userId} AND addressee_id = ${g.userId})
    `)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(0);
    const gList = (await get(g, '/api/connections')).json() as ListConnectionsResponse;
    expect(gList.outgoing).toHaveLength(0);

    // Declines delete the row and keep re-requests possible.
    const i = await register(`v5coni${run}`);
    const j = await register(`v5conj${run}`);
    const req1 = await post(i, `/api/users/${j.userId}/connect`);
    const connId = (req1.json() as { connection: Connection }).connection.id;
    expect((await post(j, `/api/connections/${connId}/decline`)).statusCode).toBe(204);
    expect((await post(i, `/api/users/${j.userId}/connect`)).statusCode).toBe(201);
  });

  // -------------------------------------------------------------------------
  // §1.35 channels — non-admin send rejected; receipts/roles/leave rules
  // -------------------------------------------------------------------------
  it('channels: members read but cannot send; owner/admin rules hold', async () => {
    const owner = await register(`v5chowner${run}`);
    const member = await register(`v5chmem${run}`);

    const created = await post(owner, '/api/conversations', {
      type: 'channel',
      title: 'announcements',
    });
    expect(created.statusCode).toBe(201);
    const conv = (created.json() as { conversation: Conversation }).conversation;
    expect(conv.type).toBe('channel');
    expect(conv.participants).toHaveLength(1);
    expect(conv.participants[0]!.role).toBe('owner');

    // Membership arrives through §1.11 invites (channel conversation_id).
    const minted = await post(owner, '/api/invites', { conversation_id: conv.id });
    expect(minted.statusCode).toBe(201);
    const invite = (minted.json() as { invite: InvitePrivate }).invite;
    expect(invite.kind).toBe('channel');
    const joined = await post(member, `/api/invites/${invite.token}/accept`);
    expect(joined.statusCode).toBe(200);

    // Non-admin send → 403 channel_read_only; owner sends fine.
    const denied = await post(member, `/api/conversations/${conv.id}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'hi',
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: string }).error).toBe('channel_read_only');
    const ownerMsg = await sendText(owner, conv.id, 'welcome in');

    // Members cannot read the member list either (owner/admin only).
    expect((await get(member, `/api/conversations/${conv.id}/participants`)).statusCode).toBe(403);

    // Reactions stay open to every participant.
    const react = await post(
      member,
      `/api/conversations/${conv.id}/messages/${ownerMsg.seq}/reactions`,
      { emoji: '🔥' },
    );
    expect(react.statusCode).toBe(204);

    // No seen-by exposure in channels, for anyone.
    const receipts = await get(
      owner,
      `/api/conversations/${conv.id}/messages/${ownerMsg.seq}/receipts`,
    );
    expect(receipts.statusCode).toBe(403);
    expect((receipts.json() as { error: string }).error).toBe('channel_no_receipts');

    // Owner promotes the member → they can send.
    const promoted = await put(
      owner,
      `/api/conversations/${conv.id}/participants/${member.userId}/role`,
      { role: 'admin' },
    );
    expect(promoted.statusCode).toBe(200);
    await sendText(member, conv.id, 'now I can post');

    // A member/admin may NOT touch the owner's role; the owner never leaves.
    const badRole = await put(
      owner,
      `/api/conversations/${conv.id}/participants/${owner.userId}/role`,
      { role: 'member' },
    );
    expect(badRole.statusCode).toBe(400);
    expect((badRole.json() as { error: string }).error).toBe('bad_role_target');
    const leave = await del(
      owner,
      `/api/conversations/${conv.id}/participants/${owner.userId}`,
    );
    expect(leave.statusCode).toBe(403);
    expect((leave.json() as { error: string }).error).toBe('owner_cannot_leave');

    // The channel DTO never carries the member body for plain viewers — just
    // own row + owner + admins (here: both are privileged, so 2 rows, and
    // never any member COUNT field).
    const refetched = (await get(owner, `/api/conversations/${conv.id}`)).json() as {
      conversation: Conversation;
    };
    expect(refetched.conversation.participants.length).toBe(2);
    expect(JSON.stringify(refetched.conversation)).not.toContain('member_count');
  });

  // -------------------------------------------------------------------------
  // §1.36 feed — finite pagination + audience exclusion
  // -------------------------------------------------------------------------
  it('feed: pages to a hard all_caught_up end; excludes blocked + non-connections', async () => {
    const me = await register(`v5feedme${run}`);
    const conn = await register(`v5feedconn${run}`); // accepted connection
    const dmp = await register(`v5feeddmp${run}`); // dm-partner
    const stranger = await register(`v5feedstr${run}`);
    const blocked = await register(`v5feedblk${run}`); // accepted, then blocked

    await connectPair(me, conn);
    await createDm(me, dmp);
    await connectPair(me, blocked);
    await block(me, blocked);

    const mkPost = async (s: Session, body: string): Promise<Post> => {
      const res = await post(s, '/api/posts', { body });
      expect(res.statusCode).toBe(201);
      return (res.json() as { post: Post }).post;
    };

    const expected = new Set<string>();
    expected.add((await mkPost(conn, 'from the connection')).id);
    expected.add((await mkPost(dmp, 'from the dm partner')).id);
    const strangerPost = await mkPost(stranger, 'from a stranger');
    const blockedPost = await mkPost(blocked, 'from the blocked user');
    expected.add((await mkPost(me, 'mine 1')).id);
    expected.add((await mkPost(me, 'mine 2')).id);
    expected.add((await mkPost(me, 'mine 3')).id);

    // Page with limit 2 until the hard end.
    const seen: string[] = [];
    let cursor: string | null = null;
    let caughtUp = false;
    for (let page = 0; page < 10; page += 1) {
      const url = cursor
        ? `/api/feed?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/api/feed?limit=2';
      const res = await get(me, url);
      expect(res.statusCode).toBe(200);
      const body = res.json() as FeedResponse;
      for (const p of body.posts) seen.push(p.id);
      // all_caught_up ⇔ next_cursor === null, exactly.
      expect(body.all_caught_up).toBe(body.next_cursor === null);
      if (body.all_caught_up) {
        caughtUp = true;
        break;
      }
      cursor = body.next_cursor;
    }
    expect(caughtUp).toBe(true);
    expect(new Set(seen)).toEqual(expected);
    expect(seen).not.toContain(strangerPost.id);
    expect(seen).not.toContain(blockedPost.id);
    // No numeric reaction/comment totals anywhere in the feed payload.
    const flat = (await get(me, '/api/feed?limit=50')).body;
    expect(flat).not.toContain('"count"');
    expect(flat).not.toContain('comment_count');

    // Single-post reads are 404-shaped outside the audience, both ways.
    expect((await get(me, `/api/posts/${strangerPost.id}`)).statusCode).toBe(404);
    expect((await get(blocked, `/api/posts/${blockedPost.id}`)).statusCode).toBe(200);
    expect((await get(me, `/api/posts/${blockedPost.id}`)).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // §1.30 edit window + tombstone immutability (+ §1.29 reply context,
  // §1.33 mention parsing)
  // -------------------------------------------------------------------------
  it('edit/delete: author-only, 24 h window, immutable tombstones', async () => {
    const a = await register(`v5edita${run}`);
    const b = await register(`v5editb${run}`);
    const convId = await createDm(a, b);

    const msg = await sendText(a, convId, `hello @${b.username} let us plan`);
    // §1.33: mentions are SERVER-parsed into metadata.
    expect(msg.metadata.mentions).toEqual([b.userId]);

    // Author edits within the window.
    const edited = await patch(a, `/api/conversations/${convId}/messages/${msg.seq}`, {
      body: 'hello (edited, mention gone)',
    });
    expect(edited.statusCode).toBe(200);
    const editedMsg = (edited.json() as { message: Message }).message;
    expect(editedMsg.edited_at).not.toBeNull();
    expect(editedMsg.body).toBe('hello (edited, mention gone)');
    // Edits re-parse mentions — the token is gone, so is the metadata entry.
    expect(editedMsg.metadata.mentions).toBeUndefined();

    // Non-authors never edit (403, not 404 — they can see the message).
    expect(
      (await patch(b, `/api/conversations/${convId}/messages/${msg.seq}`, { body: 'hijack' }))
        .statusCode,
    ).toBe(403);

    // Push the row outside EDIT_WINDOW_S → 409 edit_window_closed.
    const { db, schema } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      UPDATE messages SET created_at = now() - interval '25 hours'
      WHERE conversation_id = ${convId} AND seq = ${msg.seq}::bigint
    `);
    const late = await patch(a, `/api/conversations/${convId}/messages/${msg.seq}`, {
      body: 'too late',
    });
    expect(late.statusCode).toBe(409);
    expect((late.json() as { error: string }).error).toBe('edit_window_closed');

    // Delete → tombstone: seq survives, body nulls, metadata empties.
    const victim = await sendText(a, convId, 'delete me');
    expect(
      (await del(a, `/api/conversations/${convId}/messages/${victim.seq}`)).statusCode,
    ).toBe(204);
    const historyRes = await get(
      b,
      `/api/conversations/${convId}/messages?after_seq=0&limit=50`,
    );
    const history = (historyRes.json() as { messages: Message[] }).messages;
    const tomb = history.find((m) => m.seq === victim.seq)!;
    expect(tomb.deleted_at).not.toBeNull();
    expect(tomb.body).toBeNull();
    expect(tomb.metadata).toEqual({});

    // Tombstones are immutable: edits 409, re-deletes stay idempotent 204.
    const editTomb = await patch(a, `/api/conversations/${convId}/messages/${victim.seq}`, {
      body: 'raise the dead',
    });
    expect(editTomb.statusCode).toBe(409);
    expect((editTomb.json() as { error: string }).error).toBe('message_deleted');
    expect(
      (await del(a, `/api/conversations/${convId}/messages/${victim.seq}`)).statusCode,
    ).toBe(204);

    // §1.29: tombstoned targets ARE repliable; the context renders deleted.
    const reply = await post(b, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'replying to the ghost',
      reply_to_seq: victim.seq,
    });
    expect(reply.statusCode).toBe(201);
    const replyMsg = (reply.json() as { message: Message }).message;
    expect(replyMsg.reply_to_seq).toBe(victim.seq);
    expect(replyMsg.reply_context).toMatchObject({
      seq: victim.seq,
      deleted: true,
      excerpt: null,
    });
    // reply_to_id is retired — always null from v0.5a on.
    expect(replyMsg.reply_to_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // §1.34 stories — friends-of visibility; author-only view list
  // -------------------------------------------------------------------------
  it('stories: visible only to friends-of; view list is author-only 404-shaped', async () => {
    const author = await register(`v5story${run}`);
    const friend = await register(`v5storyf${run}`); // accepted connection
    const stranger = await register(`v5storys${run}`);
    const foe = await register(`v5storyx${run}`); // connection, then blocked

    await connectPair(author, friend);
    await connectPair(author, foe);
    await block(author, foe);

    const attId = await readyImageAttachment(author.userId);
    const created = await post(author, '/api/stories', {
      attachment_id: attId,
      caption: 'sunset',
    });
    expect(created.statusCode).toBe(201);
    const story = (created.json() as { story: Story }).story;
    expect(story.audience).toBe('friends_of');
    // No view counts anywhere on the DTO.
    expect(JSON.stringify(story)).not.toContain('view_count');

    // Friend sees the tray group; stranger and blocked see nothing.
    const friendTray = (await get(friend, '/api/stories')).json() as {
      mine: Story[];
      groups: StoryAuthorGroup[];
    };
    const group = friendTray.groups.find((g) => g.author.id === author.userId);
    expect(group).toBeDefined();
    expect(group!.stories.map((s) => s.id)).toContain(story.id);
    expect(group!.stories[0]!.viewed).toBe(false);

    for (const outsider of [stranger, foe]) {
      const tray = (await get(outsider, '/api/stories')).json() as {
        mine: Story[];
        groups: StoryAuthorGroup[];
      };
      expect(tray.groups.find((g) => g.author.id === author.userId)).toBeUndefined();
      // Direct reads are 404-shaped (unknown ≡ out-of-audience ≡ blocked).
      expect((await post(outsider, `/api/stories/${story.id}/view`)).statusCode).toBe(404);
      expect((await get(outsider, `/api/stories/${story.id}/views`)).statusCode).toBe(404);
    }

    // Friend views (idempotent), then shows up — once — in the author's list.
    expect((await post(friend, `/api/stories/${story.id}/view`)).statusCode).toBe(204);
    expect((await post(friend, `/api/stories/${story.id}/view`)).statusCode).toBe(204);
    const views = (await get(author, `/api/stories/${story.id}/views`)).json() as {
      viewers: UserLite[];
    };
    expect(views.viewers.map((v) => v.id)).toEqual([friend.userId]);
    // Structural no-seen-at: no timestamp fields in the response.
    const viewsBody = (await get(author, `/api/stories/${story.id}/views`)).body;
    expect(viewsBody).not.toContain('viewed_at');
    expect(viewsBody).not.toContain('created_at');

    // The view list is AUTHOR-ONLY — even the viewer themselves gets 404.
    expect((await get(friend, `/api/stories/${story.id}/views`)).statusCode).toBe(404);

    // story_views structurally stores no timestamp column at all.
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'story_views'
    `)) as unknown as { column_name: string }[];
    expect(cols.map((c) => c.column_name).sort()).toEqual(['story_id', 'viewer_id']);
  });
});
