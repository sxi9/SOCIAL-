// Wave 1 leftovers (migration 0020): deactivate + reactivate-on-login,
// username availability, registration_mode, the real link Deny, push
// bound to its session, report outcomes (warn / suspend shortcut),
// takedown on comment/story, write rate limits, beacons_* owner-only,
// roulette area scope. Skips cleanly without Postgres + Redis.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, UserPrivate, UserPublic } from '@socialchat/shared';
import { MESSAGE_RATE_PER_MINUTE } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `35.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('Wave 1 leftovers (migration 0020)', () => {
  let app: FastifyInstance;

  async function registerRaw(username: string, extra: Record<string, unknown> = {}) {
    return app.inject({
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
        ...extra,
      },
    });
  }
  async function register(username: string): Promise<Session> {
    const res = await registerRaw(username);
    expect(res.statusCode).toBe(201);
    return { sid: res.cookies.find((c) => c.name === 'sid')!.value, userId: (res.json() as { user: { id: string } }).user.id, username };
  }
  async function loginRaw(username: string) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: { username_or_email: username, password: 'password123' },
    });
  }
  async function login(username: string): Promise<Session> {
    const res = await loginRaw(username);
    expect(res.statusCode).toBe(200);
    return { sid: res.cookies.find((c) => c.name === 'sid')!.value, userId: (res.json() as { user: { id: string } }).user.id, username };
  }
  const get = (me: Session, url: string) => app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  function mutate(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', me: Session, url: string, payload?: unknown) {
    return app.inject({ method, url, headers: CSRF, cookies: { sid: me.sid }, ...(payload === undefined ? {} : { payload: payload as object }) });
  }
  const post = (me: Session, url: string, payload: unknown = {}) => mutate('POST', me, url, payload);
  const patch = (me: Session, url: string, payload: unknown = {}) => mutate('PATCH', me, url, payload);
  const del = (me: Session, url: string, payload?: unknown) => mutate('DELETE', me, url, payload);
  async function makeAdmin(s: Session): Promise<void> {
    const { db, schema } = await import('../src/db/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, s.userId));
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

  it('§1.2 deactivate: hidden + signed out; any login reactivates', async () => {
    const me = await register(`lfd${run}`);
    const other = await register(`lfdo${run}`);
    expect((await post(me, '/api/users/me/deactivate', { password: 'wrong' })).statusCode).toBe(401);
    expect((await post(me, '/api/users/me/deactivate', { password: 'password123' })).statusCode).toBe(200);
    expect((await get(me, '/api/users/me')).statusCode).toBe(401);
    expect((await get(other, `/api/users/${me.username}`)).statusCode).toBe(404);
    const pub = await app.inject({ method: 'GET', url: `/api/users/${me.username}/public`, headers: { 'x-forwarded-for': nextIp() } });
    expect(pub.statusCode).toBe(404);
    const back = await login(me.username); // NOT a 403 — a pause, not a suspension
    expect(((await get(back, '/api/users/me')).json() as { user: UserPrivate }).user.deactivated_at).toBeNull();
    expect((await get(other, `/api/users/${me.username}`)).statusCode).toBe(200);
  });

  it('§1.3 username-available + §1.9 registration_mode', async () => {
    const taken = await register(`lfu${run}`);
    const q = (u: string) => app.inject({ method: 'GET', url: `/api/auth/username-available?username=${u}`, headers: { 'x-forwarded-for': nextIp() } });
    expect((await q(taken.username)).json()).toEqual({ available: false, reason: 'taken' });
    expect((await q('Bad Name!')).json()).toEqual({ available: false, reason: 'invalid' });
    expect((await q(`lfufree${run}`)).json()).toEqual({ available: true, reason: null });

    const admin = await register(`lfadm${run}`);
    await makeAdmin(admin);
    const adminS = await login(admin.username);
    try {
    expect((await patch(adminS, '/api/admin/settings', { registration_mode: 'closed' })).statusCode).toBe(200);
    const info = (await app.inject({ method: 'GET', url: '/api/instance', headers: { 'x-forwarded-for': nextIp() } })).json() as { registration_mode: string };
    expect(info.registration_mode).toBe('closed');
    const closed = await registerRaw(`lfclosed${run}`);
    expect(closed.statusCode).toBe(403);
    expect((closed.json() as { error: string }).error).toBe('registration_closed');
    expect((await patch(adminS, '/api/admin/settings', { registration_mode: 'invite_only' })).statusCode).toBe(200);
    const noInvite = await registerRaw(`lfnoinv${run}`);
    expect(noInvite.statusCode).toBe(403);
    expect((noInvite.json() as { error: string }).error).toBe('invite_required');
    } finally {
      // Never leave the shared instance closed for later suites.
      expect((await patch(adminS, '/api/admin/settings', { registration_mode: 'open' })).statusCode).toBe(200);
    }
    expect((await registerRaw(`lfopen${run}`)).statusCode).toBe(201);
  });

  it('§1.3 Deny kills a pending login link; §1.4 push dies with its session', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/auth/link', headers: { ...CSRF, 'x-forwarded-for': nextIp() }, payload: {} });
    expect(minted.statusCode).toBe(201);
    const { code } = minted.json() as { code: string };
    const phone = await register(`lfph${run}`);
    expect((await post(phone, '/api/auth/link/deny', { code })).statusCode).toBe(204);
    const poll = await app.inject({ method: 'POST', url: '/api/auth/link/poll', headers: { ...CSRF, 'x-forwarded-for': nextIp() }, payload: { code } });
    expect(poll.statusCode).toBe(410);

    const s1 = await register(`lfpush${run}`);
    const sub = await post(s1, '/api/push/subscriptions', {
      endpoint: `https://push.example.test/${run}`,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(sub.statusCode).toBe(201);
    const s2 = await login(s1.username);
    expect((await post(s2, '/api/auth/logout-all')).statusCode).toBe(204); // s1's session goes → its push row cascades
    const rows = await sqlRows<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = 'https://push.example.test/${run}'`);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('§1.5 outcomes: warn sends a Support message; the suspend shortcut suspends + closes; takedown on a comment', async () => {
    const admin = await register(`lfra${run}`);
    await makeAdmin(admin);
    const adminS = await login(admin.username);
    const reporter = await register(`lfrr${run}`);
    const bad = await register(`lfrb${run}`);
    const rep = await post(reporter, '/api/reports', { kind: 'user', user_id: bad.userId, category: 'harassment', reason: 'x' });
    expect(rep.statusCode).toBe(201);
    const id = (rep.json() as { id: string }).id;
    const noText = await post(adminS, `/api/admin/reports/${id}/close`, { outcome: 'warned' });
    expect(noText.statusCode).toBe(400);
    const warned = await post(adminS, `/api/admin/reports/${id}/close`, { outcome: 'warned', warn_text: 'Be kind.', note: '' });
    expect(warned.statusCode).toBe(200);
    expect((warned.json() as { report: { outcome: string; target_user_id: string } }).report.outcome).toBe('warned');
    // The warning reached bad's Support conversation.
    const sync = (await get(bad, '/api/sync')).json() as { conversations: { id: string; title: string | null; last_message: { body: string } | null }[] };
    const support = sync.conversations.find((c) => c.last_message?.body.includes('Be kind.'));
    expect(support).toBeDefined();

    const rep2 = await post(reporter, '/api/reports', { kind: 'user', user_id: bad.userId, category: 'spam', reason: '' });
    const id2 = (rep2.json() as { id: string }).id;
    const susp = await post(adminS, `/api/admin/reports/${id2}/suspend`, { note: 'shortcut' });
    expect(susp.statusCode).toBe(200);
    expect((susp.json() as { report: { status: string; outcome: string } }).report).toMatchObject({ status: 'closed', outcome: 'suspended' });
    const l = await loginRaw(bad.username);
    expect(l.statusCode).toBe(403);
    expect((l.json() as { error: string }).error).toBe('account_suspended');

    // Takedown on a comment.
    const author = await register(`lfca${run}`);
    const postRes = await post(author, '/api/posts', { kind: 'text', audience: 'public', body: `hi ${run}` });
    expect(postRes.statusCode).toBe(201);
    const postId = (postRes.json() as { post: { id: string } }).post.id;
    const c = await post(reporter, `/api/posts/${postId}/comments`, { body: 'rude' });
    expect(c.statusCode).toBe(201);
    const commentId = (c.json() as { comment: { id: string } }).comment.id;
    const td = await post(adminS, `/api/admin/content/comment/${commentId}/takedown`, { reason: 'rude' });
    expect(td.statusCode).toBe(200);
    const left = await sqlRows<{ n: number }>(`SELECT count(*)::int AS n FROM post_comments WHERE id = '${commentId}'`);
    expect(Number(left[0]?.n)).toBe(0);
  });

  it('§1.5 write rate limit: the message POST answers 429 with Retry-After past the budget', async () => {
    const a = await register(`lfma${run}`);
    const b = await register(`lfmb${run}`);
    const conv = ((await post(a, '/api/conversations', { type: 'dm', user_id: b.userId })).json() as { conversation: Conversation }).conversation;
    // b's dm_policy defaults to 'connections': accept first, or the parked
    // request's 3-message cap answers 400 long before the minute budget.
    expect((await post(b, `/api/conversations/${conv.id}/accept`)).statusCode).toBe(200);
    let last = 201;
    let retry: string | null = null;
    for (let i = 0; i < MESSAGE_RATE_PER_MINUTE + 1; i += 1) {
      const r = await post(a, `/api/conversations/${conv.id}/messages`, { client_msg_id: crypto.randomUUID(), type: 'text', body: `m${i}` });
      last = r.statusCode;
      if (r.statusCode === 429) {
        retry = r.headers['retry-after'] as string;
        break;
      }
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });

  it('§1.9 beacons_* are owner-only; area-scoped roulette never pairs across areas', async () => {
    const a = await register(`lfka${run}`);
    const b = await register(`lfkb${run}`);
    const mine = (await get(a, '/api/users/me')).json() as { user: UserPrivate };
    expect(typeof mine.user.beacons_created).toBe('number');
    const seen = (await get(b, `/api/users/${a.username}`)).json() as { user: UserPublic };
    expect(seen.user.beacons_created).toBe(0);
    expect(seen.user.beacons_sparked).toBe(0);

    expect((await patch(a, '/api/users/me', { area: 'Northtown' })).statusCode).toBe(200);
    expect((await patch(b, '/api/users/me', { area: 'Southtown' })).statusCode).toBe(200);
    expect((await mutate('PUT', a, '/api/discovery/optin', { scope: 'area', note: '' })).statusCode).toBe(200);
    expect((await mutate('PUT', b, '/api/discovery/optin', { scope: 'area', note: '' })).statusCode).toBe(200);
    expect((await post(a, '/api/roulette/join')).statusCode).toBe(200);
    expect((await post(b, '/api/roulette/join')).statusCode).toBe(200);
    const { runRoulettePair } = await import('../src/modules/discovery/service.js');
    await runRoulettePair();
    const key = [a.userId, b.userId].sort().join(':');
    const dm = await sqlRows<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE dm_key = '${key}'`);
    expect(Number(dm[0]?.n)).toBe(0);
  });
});
