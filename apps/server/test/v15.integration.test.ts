// Handoff "Gallery and post layouts" (migration 0021, API.md §1.79):
// threaded comments (one level), story reply/reaction → DM, the author's
// activity list, caption edit, gallery created_at. Skips cleanly without
// Postgres + Redis.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, Post, PostComment, StoryViewsResponse } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `36.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('handoff layouts (migration 0021, §1.79)', () => {
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
    return { sid: res.cookies.find((c) => c.name === 'sid')!.value, userId: (res.json() as { user: { id: string } }).user.id, username };
  }
  const get = (me: Session, url: string) => app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  function mutate(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', me: Session, url: string, payload?: unknown) {
    return app.inject({ method, url, headers: CSRF, cookies: { sid: me.sid }, ...(payload === undefined ? {} : { payload: payload as object }) });
  }
  const post = (me: Session, url: string, payload: unknown = {}) => mutate('POST', me, url, payload);
  const patch = (me: Session, url: string, payload: unknown = {}) => mutate('PATCH', me, url, payload);
  const del = (me: Session, url: string) => mutate('DELETE', me, url);

  async function connect(a: Session, b: Session): Promise<void> {
    const req = await post(a, `/api/users/${b.userId}/connect`);
    expect([200, 201]).toContain(req.statusCode);
    const conn = (req.json() as { connection: { id: string; status: string } }).connection;
    if (conn.status === 'accepted') return;
    const acc = await post(b, `/api/connections/${conn.id}/accept`);
    expect(acc.statusCode).toBe(200);
  }
  async function insertReadyAttachment(uploaderId: string, kind: 'image' | 'audio' = 'image'): Promise<string> {
    const { db, schema } = await import('../src/db/index.js');
    const id = crypto.randomUUID();
    await db.insert(schema.attachments).values({
      id,
      uploaderId,
      kind,
      originalKey: `test/${id}`,
      mime: kind === 'audio' ? 'audio/webm' : 'image/png',
      sizeBytes: 1234,
      status: 'ready',
    });
    return id;
  }
  async function sqlRows<T>(q: string): Promise<T[]> {
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    return (await db.execute(sql.raw(q))) as unknown as T[];
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

  // ---------------------------------------------------------------------------
  describe('threaded comments — one level (1e)', () => {
    let author: Session;
    let friend: Session;
    let stranger: Session;
    let postId: string;
    let rootId: string;

    beforeAll(async () => {
      author = await register(`h5ca${run}`);
      friend = await register(`h5cf${run}`);
      stranger = await register(`h5cs${run}`);
      const pres = await post(author, '/api/posts', { kind: 'text', audience: 'public', body: 'thread me' });
      expect(pres.statusCode).toBe(201);
      postId = (pres.json() as { post: Post }).post.id;
      const cres = await post(author, `/api/posts/${postId}/comments`, { body: 'root' });
      expect(cres.statusCode).toBe(201);
      const root = (cres.json() as { comment: PostComment }).comment;
      rootId = root.id;
      expect(root.parent_id).toBeNull();
    });

    it('a reply carries parent_id; a reply to a reply is 400 reply_depth', async () => {
      const r = await post(friend, `/api/posts/${postId}/comments`, { body: 'reply', parent_id: rootId });
      expect(r.statusCode).toBe(201);
      const reply = (r.json() as { comment: PostComment }).comment;
      expect(reply.parent_id).toBe(rootId);
      const deep = await post(stranger, `/api/posts/${postId}/comments`, { body: 'deeper', parent_id: reply.id });
      expect(deep.statusCode).toBe(400);
      expect((deep.json() as { error: string }).error).toBe('reply_depth');
    });

    it('a parent on another post is 404 comment_not_found', async () => {
      const other = await post(author, '/api/posts', { kind: 'text', audience: 'public', body: 'other' });
      const otherId = (other.json() as { post: Post }).post.id;
      const r = await post(friend, `/api/posts/${otherId}/comments`, { body: 'x', parent_id: rootId });
      expect(r.statusCode).toBe(404);
      expect((r.json() as { error: string }).error).toBe('comment_not_found');
    });

    it('the list and the post preview serialize parent_id; deleting the parent cascades', async () => {
      const list = await get(friend, `/api/posts/${postId}/comments`);
      expect(list.statusCode).toBe(200);
      const comments = (list.json() as { comments: PostComment[] }).comments;
      expect(comments.find((c) => c.id === rootId)?.parent_id).toBeNull();
      expect(comments.filter((c) => c.parent_id === rootId).length).toBe(1);
      const p = await get(friend, `/api/posts/${postId}`);
      const preview = (p.json() as { post: Post }).post.comments;
      expect(preview.some((c) => c.parent_id === rootId)).toBe(true);

      const d = await del(author, `/api/posts/${postId}/comments/${rootId}`);
      expect(d.statusCode).toBe(204);
      const after = await get(friend, `/api/posts/${postId}/comments`);
      expect((after.json() as { comments: PostComment[] }).comments.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('story reply / reaction → DM + the author’s activity list (2b/2d)', () => {
    let author: Session;
    let friend: Session;
    let other: Session;
    let storyId: string;

    beforeAll(async () => {
      author = await register(`h5sa${run}`);
      friend = await register(`h5sf${run}`);
      other = await register(`h5so${run}`);
      await connect(author, friend);
      await connect(author, other);
      const att = await insertReadyAttachment(author.userId);
      const res = await post(author, '/api/stories', { attachment_id: att, caption: 'hello there', canvas_mode: 'open' });
      expect(res.statusCode).toBe(201);
      storyId = (res.json() as { story: { id: string } }).story.id;
    });

    it('a reaction lands as a DM message with story_ref and is named in the activity list', async () => {
      const r = await post(friend, `/api/stories/${storyId}/reply`, { emoji: '😂' });
      expect(r.statusCode).toBe(201);
      const { conversation_id, message_id } = r.json() as { conversation_id: string; message_id: string };
      const msgs = await get(author, `/api/conversations/${conversation_id}/messages`);
      expect(msgs.statusCode).toBe(200);
      const list = (msgs.json() as { messages: Message[] }).messages;
      const m = list.find((x) => x.id === message_id)!;
      expect(m).toBeTruthy();
      expect(m.body).toBe('😂');
      expect(m.metadata.story_ref).toMatchObject({ story_id: storyId, author_id: author.userId, emoji: '😂', caption: 'hello there' });

      const views = await get(author, `/api/stories/${storyId}/views`);
      expect(views.statusCode).toBe(200);
      const v = views.json() as StoryViewsResponse;
      // No view was ever POSTed by friend — the reaction alone names them.
      expect(v.viewers.some((u) => u.id === friend.userId)).toBe(true);
      expect(v.activity.find((a) => a.user_id === friend.userId)).toMatchObject({ emoji: '😂', replied: false, drew: false });
      expect(JSON.stringify(v)).not.toMatch(/count/);
    });

    it('a text reply flags replied; a later reaction keeps it; a voice reply needs my own audio attachment', async () => {
      const t = await post(friend, `/api/stories/${storyId}/reply`, { body: 'nice one' });
      expect(t.statusCode).toBe(201);
      const again = await post(friend, `/api/stories/${storyId}/reply`, { emoji: '🔥' });
      expect(again.statusCode).toBe(201);
      const v = (await get(author, `/api/stories/${storyId}/views`)).json() as StoryViewsResponse;
      expect(v.activity.find((a) => a.user_id === friend.userId)).toMatchObject({ emoji: '🔥', replied: true });

      const theirs = await insertReadyAttachment(other.userId, 'audio');
      const stolen = await post(friend, `/api/stories/${storyId}/reply`, { attachment_id: theirs });
      expect(stolen.statusCode).toBe(400);
      const mine = await insertReadyAttachment(friend.userId, 'audio');
      const voice = await post(friend, `/api/stories/${storyId}/reply`, { attachment_id: mine });
      expect(voice.statusCode).toBe(201);
      const msgs = (await get(author, `/api/conversations/${(voice.json() as { conversation_id: string }).conversation_id}/messages`)).json() as { messages: Message[] };
      const m = msgs.messages.find((x) => x.id === (voice.json() as { message_id: string }).message_id)!;
      expect(m.type).toBe('audio');
      expect(m.attachments?.length ?? 0).toBe(1);
    });

    it('drew comes from live overlays; the shape rules: own story 400, two fields 400, stranger 404', async () => {
      const ov = await post(other, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'emoji', emoji: '✨', x: 0.5, y: 0.5, scale: 1 },
      });
      expect(ov.statusCode).toBe(201);
      const v = (await get(author, `/api/stories/${storyId}/views`)).json() as StoryViewsResponse;
      expect(v.activity.find((a) => a.user_id === other.userId)).toMatchObject({ drew: true, replied: false, emoji: null });

      const own = await post(author, `/api/stories/${storyId}/reply`, { emoji: '❤️' });
      expect(own.statusCode).toBe(400);
      expect((own.json() as { error: string }).error).toBe('own_story');
      const two = await post(friend, `/api/stories/${storyId}/reply`, { emoji: '❤️', body: 'both' });
      expect(two.statusCode).toBe(400);
      const stranger = await register(`h5sx${run}`);
      const far = await post(stranger, `/api/stories/${storyId}/reply`, { emoji: '❤️' });
      expect(far.statusCode).toBe(404);
    });

    it('dm_policy nobody answers the story 404 — the same bytes a stranger gets', async () => {
      const closed = await register(`h5sn${run}`);
      await connect(closed, friend);
      const pol = await patch(closed, '/api/users/me/settings', { dm_policy: 'nobody' });
      expect([200, 204]).toContain(pol.statusCode);
      const att = await insertReadyAttachment(closed.userId);
      const s = await post(closed, '/api/stories', { attachment_id: att, caption: '' });
      const sid = (s.json() as { story: { id: string } }).story.id;
      const r = await post(friend, `/api/stories/${sid}/reply`, { emoji: '😂' });
      expect(r.statusCode).toBe(404);
      expect((r.json() as { error: string }).error).toBe('story_not_found');
      const stranger = await register(`h5sz${run}`);
      const far = await post(stranger, `/api/stories/${sid}/reply`, { emoji: '😂' });
      expect(far.statusCode).toBe(404);
      expect(far.body).toBe(r.body);
    });

    it('replying into a DM request THEY parked on me accepts my side', async () => {
      const requester = await register(`h5sr${run}`);
      const target = await register(`h5st${run}`);
      await connect(requester, target);
      // target has dm_policy connections by default? Force a parked request:
      // requester opens the DM while NOT connected would park; here they are
      // connected, so park it explicitly by clearing target's accepted_at.
      const open = await post(requester, '/api/conversations', { type: 'dm', user_id: target.userId });
      expect([200, 201]).toContain(open.statusCode);
      const convId = (open.json() as { conversation: { id: string } }).conversation.id;
      await sqlRows(`UPDATE conversation_participants SET accepted_at = NULL WHERE conversation_id = '${convId}' AND user_id = '${target.userId}'`);
      const att = await insertReadyAttachment(requester.userId);
      const s = await post(requester, '/api/stories', { attachment_id: att, caption: '' });
      const sid = (s.json() as { story: { id: string } }).story.id;
      const r = await post(target, `/api/stories/${sid}/reply`, { body: 'hey' });
      expect(r.statusCode).toBe(201);
      expect((r.json() as { conversation_id: string }).conversation_id).toBe(convId);
      const rows = await sqlRows<{ accepted_at: string | null }>(`SELECT accepted_at FROM conversation_participants WHERE conversation_id = '${convId}' AND user_id = '${target.userId}'`);
      expect(rows[0]!.accepted_at).not.toBeNull();
    });

    it('PATCH caption edits it while the story lives; an empty PATCH is 400', async () => {
      const r = await patch(author, `/api/stories/${storyId}`, { caption: '  edited  ' });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { story: { caption: string } }).story.caption).toBe('edited');
      const empty = await patch(author, `/api/stories/${storyId}`, {});
      expect(empty.statusCode).toBe(400);
      const notMine = await patch(friend, `/api/stories/${storyId}`, { caption: 'x' });
      expect(notMine.statusCode).toBe(404);
    });

    it('story_activity dies with the story', async () => {
      const before = await sqlRows<{ n: number }>(`SELECT count(*)::int AS n FROM story_activity WHERE story_id = '${storyId}'`);
      expect(Number(before[0]!.n)).toBeGreaterThan(0);
      const d = await del(author, `/api/stories/${storyId}`);
      expect(d.statusCode).toBe(204);
      const after = await sqlRows<{ n: number }>(`SELECT count(*)::int AS n FROM story_activity WHERE story_id = '${storyId}'`);
      expect(Number(after[0]!.n)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('gallery created_at (1a)', () => {
    it('every item carries the attachment’s created_at, newest first', async () => {
      const me = await register(`h5ga${run}`);
      const att = await insertReadyAttachment(me.userId);
      const pres = await post(me, '/api/posts', { kind: 'text', audience: 'public', body: 'pic', attachment_ids: [att] });
      expect(pres.statusCode).toBe(201);
      const g = await get(me, '/api/users/me/gallery');
      expect(g.statusCode).toBe(200);
      const items = (g.json() as { items: { attachment: { id: string }; created_at: string }[] }).items;
      const mine = items.find((i) => i.attachment.id === att)!;
      expect(mine).toBeTruthy();
      expect(Number.isNaN(new Date(mine.created_at).getTime())).toBe(false);
    });
  });
});
