// v0.4 Expression-pack tests (API.md §1.19–§1.27, ADR-010):
// scheduled-delivery idempotency under concurrent workers; TTL sweep
// tombstones with seq preservation; tic-tac-toe illegal-move rejection;
// puzzle guess scoring matrix (pure, ungated); stamp cap + emoji-slot
// independence; vibe reply aggregation. Infra-gated like the other suites —
// needs live Postgres + Redis (DATABASE_URL + REDIS_URL); skipped otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PUZZLE_WORDLIST,
  STAMP_REACTION_KEY,
  type Conversation,
  type Message,
  type ScheduledMessage,
} from '@socialchat/shared';
import { scoreGuess, wordForDate } from '../src/modules/puzzle/service.js';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (14.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `14.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

// ---------------------------------------------------------------------------
// Pure scoring matrix — no infra needed (§1.27: greens claimed first, then
// yellows left-to-right while supply lasts; duplicates never over-score).
// ---------------------------------------------------------------------------
describe('v0.4 puzzle scoring matrix (pure)', () => {
  it('scores the full matrix Wordle-style', () => {
    expect(scoreGuess('apple', 'apple')).toBe('ggggg');
    expect(scoreGuess('crane', 'spoil')).toBe('xxxxx');
    // Greens claimed before yellows: only one 'a' exists in 'apple'.
    expect(scoreGuess('aaxxx', 'apple')).toBe('gxxxx');
    // Duplicate guess letters drain the supply left-to-right.
    expect(scoreGuess('pppaa', 'apple')).toBe('xggyx');
    expect(scoreGuess('babes', 'abbey')).toBe('yyggx');
    // Yellows stop once the letter supply is exhausted by greens.
    expect(scoreGuess('eexxx', 'melee')).toBe('ygxxx');
    expect(scoreGuess('lever', 'melee')).toBe('ygxgx');
  });

  it('derives a deterministic in-list word per (date, secret)', () => {
    const w1 = wordForDate('2026-10-16', 'secret-a');
    const w2 = wordForDate('2026-10-16', 'secret-a');
    expect(w1).toBe(w2);
    expect(PUZZLE_WORDLIST as readonly string[]).toContain(w1);
    expect(PUZZLE_WORDLIST as readonly string[]).toContain(wordForDate('2026-10-17', 'secret-b'));
  });
});

describe.runIf(infra)('v0.4 expression pack', () => {
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

  async function createGroup(a: Session, members: Session[]): Promise<string> {
    const res = await post(a, '/api/conversations', {
      type: 'group',
      title: 'v04 group',
      user_ids: members.map((m) => m.userId),
    });
    expect(res.statusCode).toBe(201);
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

  /** Avatar transcoding needs ffmpeg/MinIO — flip the columns directly. */
  async function giveAvatar(userId: string): Promise<void> {
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      UPDATE users SET avatar_status = 'ready', avatar_version = 1,
        avatar_static_key = ${'avatar/' + userId + '.jpg'}
      WHERE id = ${userId}
    `);
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
  it('stamp cap: one per user per message, never eating an emoji slot', async () => {
    const a = await register(`v4stampa${run}`);
    const b = await register(`v4stampb${run}`);
    const convId = await createDm(a, b);
    const msg = await sendText(a, convId, 'stamp me');
    const base = `/api/conversations/${convId}/messages/${msg.seq}/reactions`;

    // No avatar → no face to stamp with.
    const noAvatar = await post(b, base, { kind: 'stamp' });
    expect(noAvatar.statusCode).toBe(409);
    expect(noAvatar.json()).toMatchObject({ error: 'stamp_no_avatar' });

    await giveAvatar(b.userId);
    expect((await post(b, base, { kind: 'stamp' })).statusCode).toBe(204);
    // PK-enforced cap: the second stamp is an idempotent 204, not a second row.
    expect((await post(b, base, { kind: 'stamp' })).statusCode).toBe(204);

    // kind='emoji' may never spoof the sentinel.
    const spoof = await post(b, base, { emoji: STAMP_REACTION_KEY });
    expect(spoof.statusCode).toBe(400);

    // The stamp never consumes one of the 8 distinct-emoji slots.
    for (let i = 0; i < 8; i++) {
      expect((await post(b, base, { emoji: `e${i}` })).statusCode).toBe(204);
    }
    const ninth = await post(b, base, { emoji: 'e9' });
    expect(ninth.statusCode).toBe(409);
    expect(ninth.json()).toMatchObject({ error: 'reaction_limit' });

    // DTO truth: stamps are faces (UserLite[]), reactions are emoji chips only.
    const list = await get(a, `/api/conversations/${convId}/messages?after_seq=0`);
    const dto = (list.json() as { messages: Message[] }).messages.find((m) => m.seq === msg.seq)!;
    expect(dto.stamps.map((u) => u.id)).toEqual([b.userId]);
    expect(dto.reactions).toHaveLength(8);
    expect(dto.reactions.some((r) => r.emoji === STAMP_REACTION_KEY)).toBe(false);

    // Removing the stamp = DELETE the URL-encoded sentinel; idempotent.
    const delRes = await del(b, `${base}/${encodeURIComponent(STAMP_REACTION_KEY)}`);
    expect(delRes.statusCode).toBe(204);
    const after = await get(a, `/api/conversations/${convId}/messages?after_seq=0`);
    const dto2 = (after.json() as { messages: Message[] }).messages.find((m) => m.seq === msg.seq)!;
    expect(dto2.stamps).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it('vibe checks: reply aggregation, one reply per user, shape validation', async () => {
    const a = await register(`v4vibea${run}`);
    const b = await register(`v4vibeb${run}`);
    const c = await register(`v4vibec${run}`);
    const convId = await createGroup(a, [b, c]);

    // body is the prompt — required.
    const noPrompt = await post(a, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'vibe_check',
    });
    expect(noPrompt.statusCode).toBe(400);
    expect(noPrompt.json()).toMatchObject({ error: 'prompt_required' });

    const vibeRes = await post(a, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'vibe_check',
      body: 'doodle your current mood',
    });
    expect(vibeRes.statusCode).toBe(201);
    const vibe = (vibeRes.json() as { message: Message }).message;
    expect(vibe.vibe).toMatchObject({ prompt: 'doodle your current mood', reply_count: 0 });

    // Stamp reply: type text, no body, no attachments, stamp+vibe_reply_seq.
    const replyB = await post(b, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      metadata: { vibe_reply_seq: vibe.seq, stamp: true },
    });
    expect(replyB.statusCode).toBe(201);
    const replyBMsg = (replyB.json() as { message: Message }).message;
    expect(replyBMsg.metadata).toMatchObject({ vibe_reply_seq: vibe.seq, stamp: true });

    const replyC = await post(c, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      metadata: { vibe_reply_seq: vibe.seq, stamp: true },
    });
    expect(replyC.statusCode).toBe(201);

    // ONE reply per user per vibe check.
    const again = await post(b, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      metadata: { vibe_reply_seq: vibe.seq, stamp: true },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'vibe_already_replied' });

    // Shape validation: stamp without vibe_reply_seq; stamp with a body;
    // a plain-text reply (not image/doodle/stamp); doodle on a non-image.
    for (const [payload, code] of [
      [{ type: 'text', metadata: { stamp: true } }, 'bad_metadata'],
      [{ type: 'text', body: 'hi', metadata: { vibe_reply_seq: vibe.seq, stamp: true } }, 'bad_metadata'],
      [{ type: 'text', body: 'hi', metadata: { vibe_reply_seq: vibe.seq } }, 'bad_vibe_reply'],
      [{ type: 'text', body: 'hi', metadata: { doodle: true } }, 'bad_metadata'],
    ] as const) {
      const res = await post(b, `/api/conversations/${convId}/messages`, {
        client_msg_id: randomUUID(),
        ...payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: code });
    }

    // Replying to a non-vibe message → 404.
    const plain = await sendText(a, convId, 'not a vibe');
    const badTarget = await post(b, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      metadata: { vibe_reply_seq: plain.seq, stamp: true },
    });
    expect(badTarget.statusCode).toBe(404);

    // Aggregation on the vibe message DTO, viewer-specific my_reply_seq.
    const listB = await get(b, `/api/conversations/${convId}/messages?after_seq=0`);
    const vibeDtoB = (listB.json() as { messages: Message[] }).messages.find(
      (m) => m.seq === vibe.seq,
    )!;
    expect(vibeDtoB.vibe!.reply_count).toBe(2);
    expect(vibeDtoB.vibe!.replies.map((r) => r.user.id).sort()).toEqual(
      [b.userId, c.userId].sort(),
    );
    expect(vibeDtoB.vibe!.replies.every((r) => r.kind === 'stamp' && r.thumb_url === null)).toBe(
      true,
    );
    expect(vibeDtoB.vibe!.my_reply_seq).toBe(replyBMsg.seq);

    const listA = await get(a, `/api/conversations/${convId}/messages?after_seq=0`);
    const vibeDtoA = (listA.json() as { messages: Message[] }).messages.find(
      (m) => m.seq === vibe.seq,
    )!;
    expect(vibeDtoA.vibe!.my_reply_seq).toBeNull();
  });

  // -------------------------------------------------------------------------
  it('tic-tac-toe: server-validated moves reject every illegal move', async () => {
    const a = await register(`v4ttta${run}`);
    const b = await register(`v4tttb${run}`);
    const c = await register(`v4tttc${run}`);
    const convId = await createDm(a, b);

    // DM: opponent implied — supplying one is a bad_opponent.
    const explicit = await post(a, `/api/conversations/${convId}/games/ttt`, {
      client_msg_id: randomUUID(),
      opponent_id: b.userId,
    });
    expect(explicit.statusCode).toBe(400);

    const clientMsgId = randomUUID();
    const created = await post(a, `/api/conversations/${convId}/games/ttt`, {
      client_msg_id: clientMsgId,
    });
    expect(created.statusCode).toBe(201);
    const game = (created.json() as { message: Message }).message;
    expect(game.type).toBe('game_ttt');
    expect(game.metadata.game).toMatchObject({
      players: { x: a.userId, o: b.userId },
      turn: 'x',
      winner: null,
    });

    // Idempotent replay → 200 with the same message.
    const replay = await post(a, `/api/conversations/${convId}/games/ttt`, {
      client_msg_id: clientMsgId,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { message: Message }).message.id).toBe(game.id);

    const move = (who: Session, cell: number) =>
      post(who, `/api/games/${game.id}/move`, { cell });

    // Not your turn (challenger is x and moves first).
    const early = await move(b, 0);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'game_not_your_turn' });

    // Non-players get the bad-id 404 shape.
    expect((await move(c, 0)).statusCode).toBe(404);

    expect((await move(a, 0)).statusCode).toBe(200);
    // Double-move by the same player.
    const dbl = await move(a, 1);
    expect(dbl.statusCode).toBe(409);
    expect(dbl.json()).toMatchObject({ error: 'game_not_your_turn' });
    // Taken cell.
    const taken = await move(b, 0);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'game_cell_taken' });
    // Out-of-range cell is schema-rejected.
    expect((await post(a, `/api/games/${game.id}/move`, { cell: 9 })).statusCode).toBe(400);

    // Play x to a win: x on 0,1,2 — o on 3,4.
    expect((await move(b, 3)).statusCode).toBe(200);
    expect((await move(a, 1)).statusCode).toBe(200);
    expect((await move(b, 4)).statusCode).toBe(200);
    const win = await move(a, 2);
    expect(win.statusCode).toBe(200);
    const finished = (win.json() as { message: Message }).message;
    expect(finished.metadata.game!.winner).toBe('x');

    // Any move after the win → game_over.
    const over = await move(b, 5);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'game_over' });
  });

  // -------------------------------------------------------------------------
  it('scheduled delivery is idempotent under concurrent workers', async () => {
    const a = await register(`v4scheda${run}`);
    const b = await register(`v4schedb${run}`);
    const convId = await createDm(a, b);

    const createRes = await post(a, `/api/conversations/${convId}/scheduled-messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'from the past',
      metadata: { capsule: true },
      deliver_at: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(createRes.statusCode).toBe(201);
    const scheduled = (createRes.json() as { scheduled: ScheduledMessage }).scheduled;
    expect(scheduled.status).toBe('pending');
    expect(scheduled.metadata).toMatchObject({ capsule: true });

    // The pending schedule is private — only the author lists it.
    const mine = await get(a, '/api/scheduled-messages');
    expect(
      (mine.json() as { scheduled: ScheduledMessage[] }).scheduled.some(
        (s) => s.id === scheduled.id,
      ),
    ).toBe(true);
    const theirs = await get(b, '/api/scheduled-messages');
    expect(
      (theirs.json() as { scheduled: ScheduledMessage[] }).scheduled.some(
        (s) => s.id === scheduled.id,
      ),
    ).toBe(false);

    // Five concurrent "workers" race the claim — exactly one delivers.
    const { deliverScheduledMessage } = await import('../src/modules/scheduled/service.js');
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => deliverScheduledMessage(scheduled.id)),
    );
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'noop')).toHaveLength(4);

    const msgs = await get(b, `/api/conversations/${convId}/messages?after_seq=0`);
    const delivered = (msgs.json() as { messages: Message[] }).messages.filter(
      (m) => m.body === 'from the past',
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.metadata).toMatchObject({ capsule: true });

    const after = await get(a, '/api/scheduled-messages');
    const row = (after.json() as { scheduled: ScheduledMessage[] }).scheduled.find(
      (s) => s.id === scheduled.id,
    )!;
    expect(row.status).toBe('sent');
    expect(row.sent_seq).toBe(delivered[0]!.seq);

    // Cancelling after the send → 409 scheduled_sent.
    const cancel = await del(a, `/api/scheduled-messages/${scheduled.id}`);
    expect(cancel.statusCode).toBe(409);

    // Out-of-window deliver_at is rejected.
    const tooSoon = await post(a, `/api/conversations/${convId}/scheduled-messages`, {
      client_msg_id: randomUUID(),
      type: 'text',
      body: 'now',
      deliver_at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(tooSoon.statusCode).toBe(400);
    expect(tooSoon.json()).toMatchObject({ error: 'deliver_at_out_of_range' });
  });

  // -------------------------------------------------------------------------
  it('audio schedule whose recording fails the §1.20 cap cancels at delivery', async () => {
    const a = await register(`v4schfa${run}`);
    const b = await register(`v4schfb${run}`);
    const convId = await createDm(a, b);

    const { db, schema } = await import('../src/db/index.js');
    const { and, eq, isNull } = await import('drizzle-orm');

    // A still-'pending' voice recording — exactly the window the schedule
    // route accepts (the worker's ffprobe verdict lands during the ≥60s lead).
    const attId = randomUUID();
    await db.insert(schema.attachments).values({
      id: attId,
      uploaderId: a.userId,
      kind: 'audio',
      originalKey: `test/${attId}.ogg`,
      mime: 'audio/ogg',
      sizeBytes: 1024,
      status: 'pending',
    });

    const createRes = await post(a, `/api/conversations/${convId}/scheduled-messages`, {
      client_msg_id: randomUUID(),
      type: 'audio',
      attachment_ids: [attId],
      deliver_at: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(createRes.statusCode).toBe(201);
    const scheduled = (createRes.json() as { scheduled: ScheduledMessage }).scheduled;

    // The media worker rejects the recording (over MAX_AUDIO_DURATION_S).
    await db
      .update(schema.attachments)
      .set({ status: 'failed' })
      .where(eq(schema.attachments.id, attId));

    // Delivery must cancel, not bind + fan out the failed recording.
    const { deliverScheduledMessage } = await import('../src/modules/scheduled/service.js');
    expect(await deliverScheduledMessage(scheduled.id)).toBe('cancelled');

    const after = await get(a, '/api/scheduled-messages');
    const row = (after.json() as { scheduled: ScheduledMessage[] }).scheduled.find(
      (s) => s.id === scheduled.id,
    )!;
    expect(row.status).toBe('cancelled');

    // No message reached the conversation; the attachment is orphaned for GC.
    const msgs = await get(b, `/api/conversations/${convId}/messages?after_seq=0`);
    expect(
      (msgs.json() as { messages: Message[] }).messages.some((m) => m.type === 'audio'),
    ).toBe(false);
    const [att] = await db
      .select()
      .from(schema.attachments)
      .where(
        and(eq(schema.attachments.id, attId), isNull(schema.attachments.messageId)),
      )
      .limit(1);
    expect(att).toBeDefined();
    expect(att!.scheduledMessageId).toBeNull();
  });

  // -------------------------------------------------------------------------
  it('TTL sweep tombstones expired messages, preserves seqs, spares system rows', async () => {
    const a = await register(`v4ttla${run}`);
    const b = await register(`v4ttlb${run}`);
    const convId = await createDm(a, b);
    const m1 = await sendText(a, convId, 'old one');
    const m2 = await sendText(b, convId, 'old two');
    // A reaction that the sweep must remove with the message.
    expect(
      (
        await post(b, `/api/conversations/${convId}/messages/${m1.seq}/reactions`, {
          emoji: '🔥',
        })
      ).statusCode,
    ).toBe(204);

    // Turn disappearing on (DM: any participant) — announces a system message.
    const set = await patch(a, `/api/conversations/${convId}/disappearing`, { ttl_s: 3600 });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { conversation: Conversation }).conversation.disappear_ttl_s).toBe(3600);
    // Idempotent re-set: no second system message.
    await patch(a, `/api/conversations/${convId}/disappearing`, { ttl_s: 3600 });

    // Group permission: non-admin may not set it.
    const g = await createGroup(a, [b]);
    const denied = await patch(b, `/api/conversations/${g}/disappearing`, { ttl_s: 3600 });
    expect(denied.statusCode).toBe(403);

    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    // Backdate the two texts past the TTL; the system announcement stays fresh.
    await db.execute(sql`
      UPDATE messages SET created_at = now() - interval '2 hours'
      WHERE conversation_id = ${convId} AND type = 'text'
    `);

    const before = await get(a, `/api/conversations/${convId}`);
    const lastSeqBefore = (before.json() as { conversation: Conversation }).conversation.last_seq;

    const { runDisappearSweep } = await import('../src/jobs/timers.js');
    await runDisappearSweep();
    // Second run: idempotent (already-tombstoned rows are not re-swept).
    await runDisappearSweep();

    const list = await get(a, `/api/conversations/${convId}/messages?after_seq=0`);
    const msgs = (list.json() as { messages: Message[] }).messages;
    const t1 = msgs.find((m) => m.seq === m1.seq)!;
    const t2 = msgs.find((m) => m.seq === m2.seq)!;
    // Tombstoned: deleted_at set, body NULLed, metadata emptied, type survives,
    // the seq is NEVER reused or removed.
    expect(t1.deleted_at).not.toBeNull();
    expect(t1.body).toBeNull();
    expect(t1.metadata).toEqual({});
    expect(t1.type).toBe('text');
    expect(t1.reactions).toEqual([]);
    expect(t2.deleted_at).not.toBeNull();

    // System messages are exempt — the disappear_changed announcement persists
    // (only ONE: the idempotent re-set was silent).
    const sys = msgs.filter(
      (m) => m.type === 'system' && m.metadata.system?.event === 'disappear_changed',
    );
    expect(sys).toHaveLength(1);
    expect(sys[0]!.deleted_at).toBeNull();
    expect(sys[0]!.metadata.system).toMatchObject({ ttl_s: 3600 });

    // last_seq untouched; the next send continues the gapless counter.
    const after = await get(a, `/api/conversations/${convId}`);
    expect((after.json() as { conversation: Conversation }).conversation.last_seq).toBe(
      lastSeqBefore,
    );
    const next = await sendText(a, convId, 'fresh');
    expect(next.seq).toBe(lastSeqBefore + 1);
  });

  // -------------------------------------------------------------------------
  it('puzzle: server-scored guesses, unforgeable result share, friends view', async () => {
    const a = await register(`v4puza${run}`);
    const b = await register(`v4puzb${run}`);
    const convId = await createDm(a, b);

    // Sharing before finishing → 409 puzzle_unfinished.
    const early = await post(a, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'puzzle_result',
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'puzzle_unfinished' });

    const today = new Date().toISOString().slice(0, 10);
    const { config } = await import('../src/config.js');
    const word = wordForDate(today, config.puzzleSecret);

    // One wrong-ish guess first (any 5 letters are accepted — no dictionary).
    const wrong = word === 'zesty' ? 'about' : 'zesty';
    const g1 = await post(a, '/api/puzzle/guess', { guess: wrong });
    expect(g1.statusCode).toBe(200);
    expect(g1.json()).toMatchObject({ date: today, solved: false, correct: false, remaining: 5 });

    const g2 = await post(a, '/api/puzzle/guess', { guess: word });
    expect(g2.statusCode).toBe(200);
    expect(g2.json()).toMatchObject({ solved: true, correct: true, remaining: 0 });

    // Done → further guesses are 409.
    const g3 = await post(a, '/api/puzzle/guess', { guess: word });
    expect(g3.statusCode).toBe(409);
    expect(g3.json()).toMatchObject({ error: 'puzzle_done' });

    // Result share: server-built grid (scores only, never letters); the
    // client body is ignored.
    const share = await post(a, `/api/conversations/${convId}/messages`, {
      client_msg_id: randomUUID(),
      type: 'puzzle_result',
      body: 'spoiler attempt: the word is ' + word,
    });
    expect(share.statusCode).toBe(201);
    const shared = (share.json() as { message: Message }).message;
    expect(shared.body).toBeNull();
    expect(shared.metadata.puzzle).toMatchObject({
      date: today,
      attempts_used: 2,
      solved: true,
    });
    expect(shared.metadata.puzzle!.grid).toHaveLength(2);
    expect(shared.metadata.puzzle!.grid[1]).toBe('ggggg');
    expect(JSON.stringify(shared.metadata.puzzle)).not.toContain(word);

    // Friends view: DM partner B sees A's posted result (opt-in by posting),
    // A (who hasn't received any partner post) sees none.
    const friendsB = await get(b, '/api/puzzle/today/friends');
    expect(friendsB.statusCode).toBe(200);
    const entries = (
      friendsB.json() as { friends: { user: { id: string }; result: { solved: boolean } }[] }
    ).friends;
    expect(entries.some((e) => e.user.id === a.userId && e.result.solved)).toBe(true);

    const friendsA = await get(a, '/api/puzzle/today/friends');
    expect(
      (friendsA.json() as { friends: { user: { id: string } }[] }).friends.some(
        (e) => e.user.id === b.userId,
      ),
    ).toBe(false);
  });
});
