// Wave 1 — the P0 floor (AUDIT-PLAN §1.1/§1.2/§1.5/§1.6/§1.8, migration
// 0018): legal consent at signup + GET /api/instance, account lifecycle
// (delete-with-grace, cancel-on-login, logout-all, email change, export,
// the tombstone sweep), triageable reports (category, object kinds, mine),
// mute, the age gate. Skips cleanly without Postgres + Redis.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, UserPrivate } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `33.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('Wave 1 floor (migration 0018)', () => {
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
    return {
      sid: res.cookies.find((c) => c.name === 'sid')!.value,
      userId: (res.json() as { user: { id: string } }).user.id,
      username,
    };
  }
  async function login(username: string): Promise<Session> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: { username_or_email: username, password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
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
  const del = (me: Session, url: string, payload?: unknown) => mutate('DELETE', me, url, payload);
  async function me(s: Session): Promise<UserPrivate> {
    const res = await get(s, '/api/users/me');
    expect(res.statusCode).toBe(200);
    return (res.json() as { user: UserPrivate }).user;
  }
  async function makeAdmin(s: Session): Promise<void> {
    const { db, schema } = await import('../src/db/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, s.userId));
  }
  async function sqlExec(q: string, params: unknown[] = []): Promise<void> {
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql.raw(q.replace(/\$(\d+)/g, (_, i) => `'${String(params[Number(i) - 1])}'`)));
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

  describe('§1.1 legal + consent', () => {
    it('register requires both boxes and stamps them; GET /api/instance is public with the shipped defaults', async () => {
      const missing = await registerRaw(`w1nobox${run}`, { terms_accepted: undefined, age_attested: undefined });
      expect(missing.statusCode).toBe(400);
      const falsy = await registerRaw(`w1false${run}`, { age_attested: false });
      expect(falsy.statusCode).toBe(400);
      const s = await register(`w1ok${run}`);
      const m = await me(s);
      expect(m.terms_accepted_at).not.toBeNull();
      expect(m.age_attested_at).not.toBeNull();
      expect(m.scheduled_deletion_at).toBeNull();

      const info = await app.inject({ method: 'GET', url: '/api/instance', headers: { 'x-forwarded-for': nextIp() } });
      expect(info.statusCode).toBe(200);
      const body = info.json() as { operator_contact: string; legal: Record<string, string>; age_min: number };
      expect(body.age_min).toBe(18);
      expect(body.legal.privacy).toContain('not end-to-end encrypted');
      expect(body.legal.terms.length).toBeGreaterThan(100);
    });

    it('admin edits the operator contact and one legal page; the public read reflects it, the others keep their default', async () => {
      const admin = await register(`w1adm${run}`);
      await makeAdmin(admin);
      const adminS = await login(admin.username);
      const res = await patch(adminS, '/api/admin/settings', {
        operator_contact: 'ops@example.org',
        legal: { guidelines: '# House rules\n\n- be nice' },
      });
      expect(res.statusCode).toBe(200);
      const info = (await app.inject({ method: 'GET', url: '/api/instance', headers: { 'x-forwarded-for': nextIp() } })).json() as {
        operator_contact: string;
        legal: Record<string, string>;
      };
      expect(info.operator_contact).toBe('ops@example.org');
      expect(info.legal.guidelines).toBe('# House rules\n\n- be nice');
      expect(info.legal.terms).toContain('Terms of use');
    });
  });

  describe('§1.8 age gate', () => {
    it('a pre-0018 account (age_attested_at NULL) gets 403 age_attestation_required on opt-in and roulette until it attests', async () => {
      const s = await register(`w1age${run}`);
      await sqlExec('UPDATE users SET age_attested_at = NULL WHERE id = $1', [s.userId]);
      const optin = await mutate('PUT', s, '/api/discovery/optin', { scope: 'public', note: '' });
      expect(optin.statusCode).toBe(403);
      expect((optin.json() as { error: string }).error).toBe('age_attestation_required');
      const spin = await post(s, '/api/roulette/join');
      expect(spin.statusCode).toBe(403);
      expect((spin.json() as { error: string }).error).toBe('age_attestation_required');
      const attest = await post(s, '/api/users/me/attest-age');
      expect(attest.statusCode).toBe(200);
      expect((attest.json() as { user: UserPrivate }).user.age_attested_at).not.toBeNull();
      const again = await mutate('PUT', s, '/api/discovery/optin', { scope: 'public', note: '' });
      expect(again.statusCode).toBe(200);
    });
  });

  describe('§1.6 mute', () => {
    it('PATCH /mute writes MY row only; the other side never sees it; unmute clears; the past is refused', async () => {
      const a = await register(`w1mua${run}`);
      const b = await register(`w1mub${run}`);
      const created = await post(a, '/api/conversations', { type: 'dm', user_id: b.userId });
      expect(created.statusCode).toBe(201);
      const conv = (created.json() as { conversation: Conversation }).conversation;
      const until = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      const muted = await patch(a, `/api/conversations/${conv.id}/mute`, { until });
      expect(muted.statusCode).toBe(200);
      const mineA = (muted.json() as { conversation: Conversation }).conversation.participants.find((p) => p.user.id === a.userId);
      expect(mineA?.muted_until).toBe(until);
      // b's view: a's muted_until is clamped to null (viewer-private).
      const viewB = await get(b, `/api/conversations/${conv.id}`);
      const aFromB = (viewB.json() as { conversation: Conversation }).conversation.participants.find((p) => p.user.id === a.userId);
      expect(aFromB?.muted_until).toBeNull();
      const past = await patch(a, `/api/conversations/${conv.id}/mute`, { until: new Date(Date.now() - 1000).toISOString() });
      expect(past.statusCode).toBe(400);
      const un = await patch(a, `/api/conversations/${conv.id}/mute`, { until: null });
      expect((un.json() as { conversation: Conversation }).conversation.participants.find((p) => p.user.id === a.userId)?.muted_until).toBeNull();
      // Not a participant → 404.
      const c = await register(`w1muc${run}`);
      expect((await patch(c, `/api/conversations/${conv.id}/mute`, { until })).statusCode).toBe(404);
    });

    it('ending a DM posts no system message (§1.8)', async () => {
      const a = await register(`w1enda${run}`);
      const b = await register(`w1endb${run}`);
      const conv = ((await post(a, '/api/conversations', { type: 'dm', user_id: b.userId })).json() as { conversation: Conversation }).conversation;
      expect((await post(a, `/api/conversations/${conv.id}/messages`, { client_msg_id: crypto.randomUUID(), type: 'text', body: 'hi' })).statusCode).toBe(201);
      expect((await del(a, `/api/conversations/${conv.id}/participants/${a.userId}`)).statusCode).toBe(204);
      const msgs = await get(b, `/api/conversations/${conv.id}/messages?after_seq=0`);
      expect(msgs.statusCode).toBe(200);
      const types = (msgs.json() as { messages: { type: string }[] }).messages.map((m) => m.type);
      expect(types).not.toContain('system');
    });
  });

  describe('§1.5 reports that can be triaged', () => {
    it('category is required; object kinds attach the author; /mine shows received → reviewed; admin lanes filter by category', async () => {
      const reporter = await register(`w1rep${run}`);
      const target = await register(`w1tgt${run}`);
      const noCat = await post(reporter, '/api/reports', { kind: 'user', user_id: target.userId, reason: 'x' });
      expect(noCat.statusCode).toBe(400);
      const ok = await post(reporter, '/api/reports', { kind: 'user', user_id: target.userId, category: 'harassment', reason: 'rude' });
      expect(ok.statusCode).toBe(201);
      // A group I am in: reportable, attached to its admin.
      const grp = await post(target, '/api/conversations', { type: 'group', title: `g ${run}`, user_ids: [reporter.userId] });
      const gid = (grp.json() as { conversation: Conversation }).conversation.id;
      const gRep = await post(reporter, '/api/reports', { kind: 'group', object_id: gid, category: 'spam', reason: '' });
      expect(gRep.statusCode).toBe(201);
      // Not a member → 404; my own group → 404 (report the person, not yourself).
      const outsider = await register(`w1out${run}`);
      expect((await post(outsider, '/api/reports', { kind: 'group', object_id: gid, category: 'spam' })).statusCode).toBe(404);
      expect((await post(target, '/api/reports', { kind: 'group', object_id: gid, category: 'spam' })).statusCode).toBe(404);
      // Unknown object → 404.
      expect((await post(reporter, '/api/reports', { kind: 'post', object_id: crypto.randomUUID(), category: 'spam' })).statusCode).toBe(404);

      const mine = await get(reporter, '/api/reports/mine');
      expect(mine.statusCode).toBe(200);
      const list = (mine.json() as { reports: { id: string; kind: string; category: string; status: string }[] }).reports;
      expect(list.map((r) => r.kind).sort()).toEqual(['group', 'user']);
      expect(list.every((r) => r.status === 'received')).toBe(true);

      const admin = await register(`w1radm${run}`);
      await makeAdmin(admin);
      const adminS = await login(admin.username);
      const lane = await get(adminS, '/api/admin/reports?status=open&category=harassment');
      expect(lane.statusCode).toBe(200);
      const laneRows = (lane.json() as { reports: { id: string; category: string; target_user: { id: string } | null; target_object: unknown }[] }).reports;
      expect(laneRows.some((r) => r.id === (ok.json() as { id: string }).id)).toBe(true);
      expect(laneRows.every((r) => r.category === 'harassment')).toBe(true);
      const spamLane = (await get(adminS, '/api/admin/reports?status=open&category=spam')).json() as {
        reports: { id: string; target_object: { object_type: string; object_id: string; author: { id: string } | null; gone: boolean } | null }[];
      };
      const gRow = spamLane.reports.find((r) => r.id === (gRep.json() as { id: string }).id);
      expect(gRow?.target_object?.object_type).toBe('group');
      expect(gRow?.target_object?.author?.id).toBe(target.userId);
      expect(gRow?.target_object?.gone).toBe(false);

      const closed = await post(adminS, `/api/admin/reports/${(ok.json() as { id: string }).id}/close`, { note: '' });
      expect(closed.statusCode).toBe(200);
      const after = (await get(reporter, '/api/reports/mine')).json() as { reports: { kind: string; status: string }[] };
      expect(after.reports.find((r) => r.kind === 'user')?.status).toBe('reviewed');
    });
  });

  describe('§1.2 account lifecycle', () => {
    it('logout-all keeps only this device; email change re-proofs; export carries my data', async () => {
      const s1 = await register(`w1life${run}`);
      const s2 = await login(s1.username);
      expect((await post(s2, '/api/auth/logout-all')).statusCode).toBe(204);
      expect((await get(s1, '/api/users/me')).statusCode).toBe(401);
      expect((await get(s2, '/api/users/me')).statusCode).toBe(200);
      expect((await patch(s2, '/api/users/me/email', { password: 'wrong', email: `new${run}@example.com` })).statusCode).toBe(401);
      const ch = await patch(s2, '/api/users/me/email', { password: 'password123', email: `new${run}@example.com` });
      expect(ch.statusCode).toBe(200);
      expect((ch.json() as { user: UserPrivate }).user.email).toBe(`new${run}@example.com`);
      expect((ch.json() as { user: UserPrivate }).user.email_verified).toBe(false);
      const exp = await get(s2, '/api/users/me/export');
      expect(exp.statusCode).toBe(200);
      const body = exp.json() as { user: Record<string, unknown>; settings: unknown; profile: unknown; messages: unknown[] };
      expect(body.user.username).toBe(s1.username);
      expect(body.user.password_hash).toBeUndefined();
      expect(body.user.totp_secret).toBeUndefined();
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it('DELETE /me schedules + signs out; login cancels; a due account is tombstoned by the sweep', async () => {
      const s = await register(`w1del${run}`);
      expect((await del(s, '/api/users/me', { password: 'nope' })).statusCode).toBe(401);
      const sched = await del(s, '/api/users/me', { password: 'password123' });
      expect(sched.statusCode).toBe(200);
      const at = (sched.json() as { scheduled_deletion_at: string }).scheduled_deletion_at;
      expect(new Date(at).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 3600 * 1000);
      expect((await get(s, '/api/users/me')).statusCode).toBe(401); // every device out
      // Signing in cancels.
      const back = await login(s.username);
      expect((await me(back)).scheduled_deletion_at).toBeNull();
      // Schedule again, then force the grace to have passed and sweep.
      expect((await del(back, '/api/users/me', { password: 'password123' })).statusCode).toBe(200);
      await sqlExec("UPDATE users SET scheduled_deletion_at = now() - interval '1 minute' WHERE id = $1", [s.userId]);
      const { purgeDueDeletions } = await import('../src/lib/accountDeletion.js');
      const n = await purgeDueDeletions();
      expect(n).toBeGreaterThanOrEqual(1);
      const loginAfter = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: { username_or_email: s.username, password: 'password123' },
      });
      expect(loginAfter.statusCode).toBe(401); // the name no longer exists
      const other = await register(`w1delo${run}`);
      expect((await get(other, `/api/users/${s.username}`)).statusCode).toBe(404);
      const { db } = await import('../src/db/index.js');
      const { sql } = await import('drizzle-orm');
      const rows = (await db.execute(sql`SELECT username, display_name, deleted_at, suspended_at FROM users WHERE id = ${s.userId}::uuid`)) as unknown as {
        username: string;
        display_name: string;
        deleted_at: string | null;
        suspended_at: string | null;
      }[];
      expect(rows[0]?.username.startsWith('deleted_')).toBe(true);
      expect(rows[0]?.display_name).toBe('Deleted account');
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it('admin delete tombstones now; an admin cannot delete themselves via the self route', async () => {
      const admin = await register(`w1dadm${run}`);
      await makeAdmin(admin);
      const adminS = await login(admin.username);
      expect((await del(adminS, '/api/users/me', { password: 'password123' })).statusCode).toBe(400);
      const victim = await register(`w1dvic${run}`);
      const res = await post(adminS, `/api/admin/users/${victim.userId}/delete`, { note: 'test' });
      expect(res.statusCode).toBe(200);
      expect((await get(victim, '/api/users/me')).statusCode).toBe(401);
      expect((await get(adminS, `/api/users/${victim.username}`)).statusCode).toBe(404);
    });
  });
});
