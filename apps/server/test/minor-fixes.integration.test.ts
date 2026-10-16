// Regression tests for the contract-drift fixes: one system message per
// add-participants operation, group_too_large reachable on create, push
// unsubscribe → unconditional 204, the removed user receiving their own
// conv.updated, the shared unfurl budget chokepoint (message sends never
// fail, they just skip the enqueue), and true open-stashes-per-IP counting.
// Needs live Postgres + Redis — set DATABASE_URL and REDIS_URL (CI provides
// both); skipped otherwise.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_STASH_MAX_PER_IP, UNFURL_RATE_PER_HOUR } from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window
// register/stash IP limits across repeated runs against the same Redis.
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 7) & 0xffffff;
  return `11.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

describe.runIf(infra)('minor-findings fixes', () => {
  let app: FastifyInstance;
  let eventsSub: Redis;
  const envelopes: Array<{
    scope: string;
    user_ids?: string[];
    event?: { t: string; d?: Record<string, unknown> };
  }> = [];

  interface Session {
    sid: string;
    userId: string;
  }

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
    expect(sid).toBeTruthy();
    return { sid: sid!, userId: (res.json() as { user: { id: string } }).user.id };
  }

  async function createGroup(me: Session, title: string, userIds: string[]) {
    return app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: { type: 'group', title, user_ids: userIds },
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

  function multipart(fields: Record<string, string>): { payload: string; contentType: string } {
    const boundary = `----vitest${Math.random().toString(36).slice(2)}`;
    let payload = '';
    for (const [name, value] of Object.entries(fields)) {
      payload += `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    payload += `--${boundary}--\r\n`;
    return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();
    const { createRedis } = await import('../src/redis.js');
    eventsSub = createRedis();
    await eventsSub.subscribe('events');
    eventsSub.on('message', (_channel: string, raw: string) => {
      try {
        envelopes.push(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    });
  });

  afterAll(async () => {
    await app?.close();
    await eventsSub?.quit().catch(() => {});
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

  it('DELETE /api/push/subscriptions is an unconditional 204 (API.md §1.9)', async () => {
    const u = await register(`push_${run}`);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/push/subscriptions',
      headers: CSRF,
      cookies: { sid: u.sid },
      payload: { endpoint: 'https://push.example.com/never-registered' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('group create over the 256 cap yields 400 group_too_large (API.md §1.4)', async () => {
    const u = await register(`cap_${run}`);
    const res = await createGroup(
      u,
      'too big',
      Array.from({ length: 256 }, () => randomUUID()),
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('group_too_large');
  });

  it('add-participants inserts ONE system message per operation (API.md §1.4)', async () => {
    const a = await register(`sysa_${run}`);
    const b = await register(`sysb_${run}`);
    const c = await register(`sysc_${run}`);
    const d = await register(`sysd_${run}`);

    const created = await createGroup(a, 'sys', [b.userId]);
    expect(created.statusCode).toBe(201);
    const conv = (created.json() as { conversation: { id: string; last_seq: number } }).conversation;

    const added = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/participants`,
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { user_ids: [c.userId, d.userId] },
    });
    expect(added.statusCode).toBe(200);
    const after = (added.json() as { conversation: { last_seq: number } }).conversation;
    // Adding two users bumps seq by exactly ONE (one system message).
    expect(after.last_seq).toBe(conv.last_seq + 1);

    const list = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conv.id}/messages?after_seq=0&limit=100`,
      cookies: { sid: a.sid },
    });
    const msgs = (list.json() as {
      messages: Array<{ type: string; body: string | null; metadata: { system?: { event: string } } }>;
    }).messages;
    const systemMsgs = msgs.filter((m) => m.metadata.system?.event === 'participant_added');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0]!.body).toBe('2 participants were added');
  });

  it('the removed user receives their own conv.updated (API.md §1.4)', async () => {
    const a = await register(`rema_${run}`);
    const b = await register(`remb_${run}`);
    const c = await register(`remc_${run}`);
    const created = await createGroup(a, 'rem', [b.userId, c.userId]);
    const convId = (created.json() as { conversation: { id: string } }).conversation.id;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${convId}/participants/${b.userId}`,
      headers: CSRF,
      cookies: { sid: a.sid },
    });
    expect(removed.statusCode).toBe(204);

    await waitFor(() =>
      envelopes.some(
        (e) =>
          e.scope === 'users' &&
          e.event?.t === 'conv.updated' &&
          (e.event.d as { conversation?: { id: string } } | undefined)?.conversation?.id === convId &&
          e.user_ids?.includes(b.userId) === true,
      ),
    );
  });

  it('unfurl budget: ONE chokepoint for previews POST and message sends; over-budget sends still succeed', async () => {
    const a = await register(`unf_a_${run}`);
    const b = await register(`unf_b_${run}`);
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'dm', user_id: b.userId },
    });
    const convId = (dm.json() as { conversation: { id: string } }).conversation.id;

    const { unfurlQueue } = await import('../src/queues.js');

    // In budget: a message-send URL enqueues through the chokepoint.
    const countStart = await unfurlQueue.count();
    const inBudget = await sendMessage(a, convId, `see https://example.com/${run}/warm`);
    expect(inBudget.statusCode).toBe(201);
    expect(await unfurlQueue.count()).toBe(countStart + 1);

    // Exhaust the rest of a's 30/hour budget via POST /api/previews.
    for (let i = 1; i < UNFURL_RATE_PER_HOUR; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/previews',
        headers: CSRF,
        cookies: { sid: a.sid },
        payload: { url: `https://example.com/${run}/p${i}` },
      });
      expect(res.statusCode).toBe(202);
    }
    const over = await app.inject({
      method: 'POST',
      url: '/api/previews',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { url: `https://example.com/${run}/p-over` },
    });
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeTruthy();

    // Over budget the message still sends fine — the unfurl is just skipped.
    const countBefore = await unfurlQueue.count();
    const sent = await sendMessage(a, convId, `look at https://example.com/${run}/skipped`);
    expect(sent.statusCode).toBe(201);
    const msg = (sent.json() as { message: { metadata: { link_preview?: unknown } } }).message;
    expect(msg.metadata.link_preview).toBeUndefined();
    expect(await unfurlQueue.count()).toBe(countBefore);

    // A different user has their own budget: same chokepoint, fresh window.
    const countOther = await unfurlQueue.count();
    const fromB = await sendMessage(b, convId, `and https://example.com/${run}/fresh`);
    expect(fromB.statusCode).toBe(201);
    expect(await unfurlQueue.count()).toBe(countOther + 1);
  });

  it('share stash enforces OPEN stashes per IP: claiming frees the slot', async () => {
    const ip = nextIp();
    const stashIds: string[] = [];
    for (let i = 0; i < SHARE_STASH_MAX_PER_IP; i++) {
      const { payload, contentType } = multipart({ share_text: `hello ${i}` });
      const res = await app.inject({
        method: 'POST',
        url: '/api/share-stash',
        headers: { ...CSRF, 'content-type': contentType, 'x-forwarded-for': ip },
        payload,
      });
      expect(res.statusCode).toBe(201);
      stashIds.push((res.json() as { stash_id: string }).stash_id);
    }

    // Slot 4: refused while 3 stashes are open.
    const fourth = multipart({ share_text: 'one too many' });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/share-stash',
      headers: { ...CSRF, 'content-type': fourth.contentType, 'x-forwarded-for': ip },
      payload: fourth.payload,
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeTruthy();

    // Claiming one stash frees its slot…
    const claimer = await register(`stash_${run}`);
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/share-imports/claim',
      headers: CSRF,
      cookies: { sid: claimer.sid },
      payload: { stash_id: stashIds[0] },
    });
    expect(claimed.statusCode).toBe(201);

    // …so the same IP can open a new stash again.
    const fifth = multipart({ share_text: 'fits again' });
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/share-stash',
      headers: { ...CSRF, 'content-type': fifth.contentType, 'x-forwarded-for': ip },
      payload: fifth.payload,
    });
    expect(allowed.statusCode).toBe(201);
  });
});

describe.runIf(!infra)('minor-findings fixes (skipped)', () => {
  it.skip('requires DATABASE_URL and REDIS_URL (provided in CI)', () => {});
});
