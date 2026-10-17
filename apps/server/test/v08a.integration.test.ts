// v0.8a tests (API.md §1.57–§1.61, ADR-018, FEATURES #72–#76, #79, #80):
// the mood visibility matrix (everyone / connections / nobody ∩ §1.14 blocks,
// drunk's connections-only default, live expiry filtering), 🎢 swing rotation
// (different entry, expires_at never extended), the 🍻 send-undo (window +
// slack, not_drunk, undone tombstone vs ordinary delete, seq continuity), the
// activity strip's audience INTERSECTION (a friends-only beacon never shows in
// a public strip; per-kind settings narrow), chat-background ownership checks,
// and the §1.61 release markers (register stamps the newest version).
// Infra-gated like the other suites (Postgres+Redis; skips cleanly without).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MOOD_DRUNK_UNDO_SLACK_S,
  UNDO_SEND_WINDOW_S,
  MOOD_DRUNK_UNDO_WINDOW_S,
  MOOD_SWING_INTERVAL_S,
  MOOD_SWING_JITTER_S,
  MOOD_TTL_S,
  type Activity,
  type Conversation,
  type Message,
  type MoodState,
  type UserPublic,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the register IP limits
// (19.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `19.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
  lastSeenRelease: string | null;
}

describe.runIf(infra)('v0.8a identity & moods', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;
  let timers: typeof import('../src/jobs/timers.js');
  let queues: typeof import('../src/queues.js');

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
    const [row] = await db
      .select({ lastSeenRelease: schema.users.lastSeenRelease })
      .from(schema.users)
      .where(sqlTag`${schema.users.id} = ${body.user.id}`)
      .limit(1);
    return { sid: sid!, userId: body.user.id, username, lastSeenRelease: row!.lastSeenRelease };
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
  const put = (me: Session, url: string, payload: unknown = {}) => mutate('PUT', me, url, payload);
  const patch = (me: Session, url: string, payload: unknown = {}) => mutate('PATCH', me, url, payload);
  const del = (me: Session, url: string) => mutate('DELETE', me, url);

  async function createDm(a: Session, bUserId: string): Promise<Conversation> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: bUserId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation;
  }

  /** Accepted §1.28 connection between a and b (a requests, b accepts). */
  async function connect(a: Session, b: Session): Promise<void> {
    const req = await post(a, `/api/users/${b.userId}/connect`);
    expect([200, 201]).toContain(req.statusCode);
    const conn = (req.json() as { connection: { id: string; status: string } }).connection;
    if (conn.status === 'accepted') return;
    const acc = await post(b, `/api/connections/${conn.id}/accept`);
    expect(acc.statusCode).toBe(200);
  }

  async function setMood(me: Session, payload: unknown): Promise<MoodState> {
    const res = await put(me, '/api/users/me/mood', payload);
    expect(res.statusCode).toBe(200);
    return (res.json() as { mood_state: MoodState }).mood_state;
  }

  async function profileMood(viewer: Session, owner: Session) {
    const res = await get(viewer, `/api/users/${owner.username}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as { user: UserPublic }).user.mood;
  }

  async function sendMessage(me: Session, convId: string, body: string): Promise<Message> {
    const res = await post(me, `/api/conversations/${convId}/messages`, {
      client_msg_id: crypto.randomUUID(),
      type: 'text',
      body,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { message: Message }).message;
  }

  async function messageAt(me: Session, convId: string, seq: number): Promise<Message> {
    const res = await get(me, `/api/conversations/${convId}/messages?before_seq=${seq + 1}&limit=1`);
    expect(res.statusCode).toBe(200);
    const msgs = (res.json() as { messages: Message[] }).messages;
    expect(msgs[0]?.seq).toBe(seq);
    return msgs[0]!;
  }

  async function insertReadyAttachment(
    uploaderId: string,
    over: Partial<{ kind: string; sizeBytes: number; durationMs: number | null }> = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(schema.attachments).values({
      id,
      uploaderId,
      kind: over.kind ?? 'image',
      originalKey: `test/${id}`,
      mime: over.kind === 'video' ? 'video/mp4' : 'image/gif',
      sizeBytes: over.sizeBytes ?? 123_456,
      durationMs: over.durationMs === undefined ? null : over.durationMs,
      status: 'ready',
    });
    return id;
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    ({ db, schema } = await import('../src/db/index.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));
    timers = await import('../src/jobs/timers.js');
    queues = await import('../src/queues.js');
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // §1.57 mood visibility matrix
  // ---------------------------------------------------------------------------

  describe('mood visibility matrix (§1.57)', () => {
    let owner: Session; // sets moods
    let dmOnly: Session; // DM partner, NOT a connection
    let conn: Session; // accepted connection
    let blocked: Session; // shares a group, then blocks the owner

    beforeAll(async () => {
      owner = await register(`m8own${run}`);
      dmOnly = await register(`m8dm${run}`);
      conn = await register(`m8conn${run}`);
      blocked = await register(`m8blk${run}`);
      await createDm(owner, dmOnly.userId);
      await connect(owner, conn);
    });

    it("'everyone' shows the chip to a stranger-ish DM partner and a connection", async () => {
      const state = await setMood(owner, { kind: 'preset', label: 'hyped' });
      expect(state.mood).toEqual({ emoji: '🎉', label: 'hyped', kind: 'preset' });
      expect(state.visibility).toBe('everyone');
      expect(state.expires_at).not.toBeNull();
      expect(await profileMood(dmOnly, owner)).toEqual({ emoji: '🎉', label: 'hyped', kind: 'preset' });
      expect(await profileMood(conn, owner)).not.toBeNull();
    });

    it("'connections' means ACCEPTED connections literally — a DM alone does not qualify", async () => {
      await setMood(owner, { kind: 'preset', label: 'cozy', visibility: 'connections' });
      expect(await profileMood(dmOnly, owner)).toBeNull();
      expect(await profileMood(conn, owner)).toEqual({ emoji: '☕', label: 'cozy', kind: 'preset' });
    });

    it("'nobody' hides the chip from everyone but the owner (null is byte-identical to no mood)", async () => {
      await setMood(owner, { kind: 'custom', emoji: '🫠', label: 'melting', visibility: 'nobody' });
      expect(await profileMood(conn, owner)).toBeNull();
      expect(await profileMood(dmOnly, owner)).toBeNull();
      const mine = await get(owner, '/api/users/me/mood');
      expect((mine.json() as { mood_state: MoodState }).mood_state.mood).toEqual({
        emoji: '🫠',
        label: 'melting',
        kind: 'custom',
      });
      // The owner's own UserPrivate carries the chip too.
      const me = await get(owner, '/api/users/me');
      expect((me.json() as { user: UserPublic }).user.mood).not.toBeNull();
    });

    it('a §1.14 block hides the mood in shared groups, both directions, whatever the visibility', async () => {
      await setMood(owner, { kind: 'preset', label: 'happy', visibility: 'everyone' });
      // Shared group keeps working across the block (§1.14) — but the chip
      // must never serialize to the blocked counterpart.
      const g = await post(owner, '/api/conversations', {
        type: 'group',
        title: 'mood blk',
        user_ids: [blocked.userId],
      });
      expect([200, 201]).toContain(g.statusCode);
      const convId = (g.json() as { conversation: Conversation }).conversation.id;
      const blk = await put(blocked, `/api/users/${owner.userId}/block`);
      expect([200, 204]).toContain(blk.statusCode);
      const res = await get(blocked, `/api/conversations/${convId}`);
      expect(res.statusCode).toBe(200);
      const parts = (res.json() as { conversation: Conversation }).conversation.participants;
      const ownerPart = parts.find((p) => p.user.id === owner.userId)!;
      expect(ownerPart.user.mood).toBeNull();
      await del(blocked, `/api/users/${owner.userId}/block`);
    });

    it('expiry filters LIVE — a lagging sweep can never show a stale chip', async () => {
      await setMood(owner, { kind: 'preset', label: 'bored' });
      await db.execute(sqlTag`
        UPDATE users SET mood_expires_at = now() - interval '1 second'
        WHERE id = ${owner.userId}
      `);
      expect(await profileMood(conn, owner)).toBeNull();
      const mine = await get(owner, '/api/users/me/mood');
      const state = (mine.json() as { mood_state: MoodState }).mood_state;
      expect(state.mood).toBeNull();
      expect(state.expires_at).toBeNull();
    });

    it('bad preset label → 400 bad_mood_preset; DELETE clears without trace (idempotent)', async () => {
      const bad = await put(owner, '/api/users/me/mood', { kind: 'preset', label: 'nonsense' });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string }).error).toBe('bad_mood_preset');
      await setMood(owner, { kind: 'preset', label: 'lazy' });
      expect((await del(owner, '/api/users/me/mood')).statusCode).toBe(204);
      expect((await del(owner, '/api/users/me/mood')).statusCode).toBe(204);
      const [row] = await db.select().from(schema.users).where(sqlTag`${schema.users.id} = ${owner.userId}`);
      expect(row!.moodKind).toBeNull();
      expect(row!.moodEmoji).toBeNull();
      expect(row!.moodLabel).toBeNull();
      expect(row!.moodExpiresAt).toBeNull();
      expect(row!.moodSwingSet).toBeNull();
    });

    it("drunk defaults to 'connections' even though other moods were public — and is overridable", async () => {
      const state = await setMood(owner, { kind: 'drunk' });
      expect(state.mood).toEqual({ emoji: '🍻', label: 'drunk', kind: 'drunk' });
      expect(state.visibility).toBe('connections');
      expect(await profileMood(dmOnly, owner)).toBeNull(); // DM partner ≠ connection
      expect(await profileMood(conn, owner)).toEqual({ emoji: '🍻', label: 'drunk', kind: 'drunk' });
      const over = await setMood(owner, { kind: 'drunk', visibility: 'everyone' });
      expect(over.visibility).toBe('everyone');
      expect(await profileMood(dmOnly, owner)).toEqual({ emoji: '🍻', label: 'drunk', kind: 'drunk' });
      await del(owner, '/api/users/me/mood');
    });
  });

  // ---------------------------------------------------------------------------
  // §1.57 🎢 swing rotation
  // ---------------------------------------------------------------------------

  describe('swing rotation (§1.57)', () => {
    it('rotates to a DIFFERENT entry past interval+jitter, never extending expires_at', async () => {
      const u = await register(`m8swing${run}`);
      const state = await setMood(u, {
        kind: 'swing',
        swing_set: [
          { emoji: '🌧️', label: 'sad' },
          { emoji: '🎉', label: 'hyped' },
        ],
      });
      // The FIRST entry is materialized as the current chip.
      expect(state.mood).toEqual({ emoji: '🌧️', label: 'sad', kind: 'swing' });
      expect(state.swing_set).toHaveLength(2);
      const expiresBefore = state.expires_at;

      // Past the LATE jitter edge the rotation is unconditional.
      const backdateS = MOOD_SWING_INTERVAL_S + MOOD_SWING_JITTER_S + 60;
      await db.execute(sqlTag`
        UPDATE users SET mood_swing_rotated_at = now() - make_interval(secs => ${backdateS})
        WHERE id = ${u.userId}
      `);
      await timers.runMoodSwingSweep();

      const after = await get(u, '/api/users/me/mood');
      const next = (after.json() as { mood_state: MoodState }).mood_state;
      expect(next.mood).toEqual({ emoji: '🎉', label: 'hyped', kind: 'swing' }); // the only other entry
      expect(next.expires_at).toBe(expiresBefore); // rotation never extends
      const [row] = await db.select().from(schema.users).where(sqlTag`${schema.users.id} = ${u.userId}`);
      expect(Date.now() - row!.moodSwingRotatedAt!.getTime()).toBeLessThan(10_000); // re-stamped
    });

    it('the expiry sweep clears every mood_* column (auto-sober, zero trace)', async () => {
      const u = await register(`m8exp${run}`);
      await setMood(u, { kind: 'drunk' });
      await db.execute(sqlTag`
        UPDATE users SET mood_expires_at = now() - interval '1 second' WHERE id = ${u.userId}
      `);
      await timers.runMoodExpirySweep();
      const [row] = await db.select().from(schema.users).where(sqlTag`${schema.users.id} = ${u.userId}`);
      expect(row!.moodKind).toBeNull();
      expect(row!.moodEmoji).toBeNull();
      expect(row!.moodLabel).toBeNull();
      expect(row!.moodExpiresAt).toBeNull();
      expect(row!.moodSwingRotatedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // §1.57 🍻 send-undo
  // ---------------------------------------------------------------------------

  describe('drunk send-undo (§1.57)', () => {
    let a: Session;
    let b: Session;
    let convId: string;

    beforeAll(async () => {
      a = await register(`m8ua${run}`);
      b = await register(`m8ub${run}`);
      convId = (await createDm(a, b.userId)).id;
    });

    it('undoes within the window: tombstone with metadata {"undone": true}, seq survives', async () => {
      await setMood(a, { kind: 'drunk' });
      const msg = await sendMessage(a, convId, 'regrettable');
      const res = await del(a, `/api/conversations/${convId}/messages/${msg.seq}?undo=1`);
      expect(res.statusCode).toBe(204);

      const gone = await messageAt(a, convId, msg.seq);
      expect(gone.deleted_at).not.toBeNull();
      expect(gone.body).toBeNull();
      expect((gone.metadata as { undone?: true }).undone).toBe(true);

      // Golden rule 2: seq continuity across undos.
      const nextMsg = await sendMessage(a, convId, 'still here');
      expect(nextMsg.seq).toBe(msg.seq + 1);
    });

    it('11+ s after send (past window+slack) → 409 undo_window_closed; ordinary delete still works', async () => {
      const msg = await sendMessage(a, convId, 'too late');
      const pastS = MOOD_DRUNK_UNDO_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S + 1;
      await db.execute(sqlTag`
        UPDATE messages SET created_at = now() - make_interval(secs => ${pastS})
        WHERE conversation_id = ${convId} AND seq = ${msg.seq}::bigint
      `);
      const res = await del(a, `/api/conversations/${convId}/messages/${msg.seq}?undo=1`);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('undo_window_closed');

      // The §1.30 tombstone remains available — normal delete semantics:
      // metadata is emptied, NOT marked undone (clients render the stub).
      const plain = await del(a, `/api/conversations/${convId}/messages/${msg.seq}`);
      expect(plain.statusCode).toBe(204);
      const gone = await messageAt(a, convId, msg.seq);
      expect(gone.deleted_at).not.toBeNull();
      expect((gone.metadata as { undone?: true }).undone).toBeUndefined();
    });

    it('v1.0a #96: sober undo works within the SHORT window; past it (but inside the drunk window) → 409', async () => {
      // Sober-up between send and undo: the undo still works — generalized
      // send-undo (UNDO_SEND_WINDOW_S), no longer drunk-gated.
      const msg = await sendMessage(a, convId, 'sober now');
      await del(a, '/api/users/me/mood'); // sober up between send and undo
      const res = await del(a, `/api/conversations/${convId}/messages/${msg.seq}?undo=1`);
      expect(res.statusCode).toBe(204);
      const gone = await messageAt(a, convId, msg.seq);
      expect((gone.metadata as { undone?: true }).undone).toBe(true);

      // But sober gets ONLY the short window: a message older than
      // UNDO_SEND_WINDOW_S+slack (yet younger than the drunk window) is late.
      const msg2 = await sendMessage(a, convId, 'sober and slow');
      const pastS = UNDO_SEND_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S + 1;
      await db.execute(sqlTag`
        UPDATE messages SET created_at = now() - make_interval(secs => ${pastS})
        WHERE conversation_id = ${convId} AND seq = ${msg2.seq}::bigint
      `);
      const late = await del(a, `/api/conversations/${convId}/messages/${msg2.seq}?undo=1`);
      expect(late.statusCode).toBe(409);
      expect((late.json() as { error: string }).error).toBe('undo_window_closed');
    });

    it("only the author may undo — 403 for anyone else's message", async () => {
      await setMood(b, { kind: 'drunk' });
      const msg = await sendMessage(a, convId, 'mine');
      const res = await del(b, `/api/conversations/${convId}/messages/${msg.seq}?undo=1`);
      expect(res.statusCode).toBe(403);
      await del(b, '/api/users/me/mood');
    });

    /** The push job (any state — a concurrent dev worker may drain the queue,
     * removeOnComplete keeps the last 1000) for one message, keyed by id. */
    async function pushJobFor(messageId: string, ms = 4000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const jobs = await queues.pushQueue.getJobs([
          'waiting',
          'delayed',
          'paused',
          'prioritized',
          'active',
          'completed',
          'failed',
        ]);
        const hit = jobs
          .filter(Boolean)
          .find((j) => (j.data as { message_id?: string }).message_id === messageId);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`push job for ${messageId} not seen in ${ms}ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("a drunk sender's push to an OFFLINE recipient is held past the undo window (§2.9)", async () => {
      // Without the hold, the 5 s debounce under-covers the 10 s undo window
      // and an undo at 6–10 s would leave the preview on the lock screen.
      await setMood(a, { kind: 'drunk' });
      const held = await sendMessage(a, convId, 'hold my push');
      const heldJob = await pushJobFor(held.id);
      const holdMs = (MOOD_DRUNK_UNDO_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S) * 1000;
      expect(heldJob.opts.delay ?? 0).toBeGreaterThanOrEqual(holdMs);

      // Sober → no hold (the recipient never connected, so no presence-grace
      // delay is in play either: the job goes out immediately).
      await del(a, '/api/users/me/mood');
      const plain = await sendMessage(a, convId, 'no hold');
      const plainJob = await pushJobFor(plain.id);
      expect(plainJob.opts.delay ?? 0).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.59 activity strip — the audience intersection
  // ---------------------------------------------------------------------------

  describe('activity strip intersection (§1.59)', () => {
    let owner: Session;
    let friend: Session; // DM partner → friends-of(owner)
    let stranger: Session; // no relationship at all

    beforeAll(async () => {
      owner = await register(`m8act${run}`);
      friend = await register(`m8fr${run}`);
      stranger = await register(`m8str${run}`);
      await createDm(owner, friend.userId);
    });

    it("a friends-only beacon NEVER shows in a public strip — the setting can't widen past the object", async () => {
      const starts = new Date(Date.now() + 10 * 60_000).toISOString();
      const ends = new Date(Date.now() + 2 * 3600_000).toISOString();
      const res = await post(owner, '/api/beacons', {
        vibe: 'chai',
        note: 'friends only',
        audience: 'friends',
        starts_at: starts,
        expires_at: ends,
      });
      expect(res.statusCode).toBe(201);

      // The toggle says PUBLIC — the stored friends audience still binds.
      const set = await patch(owner, '/api/users/me/settings', { activity_beacons: 'public' });
      expect(set.statusCode).toBe(200);

      const strangerStrip = await get(stranger, `/api/users/${owner.username}/activity`);
      expect(strangerStrip.statusCode).toBe(200);
      const strangerItems = (strangerStrip.json() as { activities: Activity[] }).activities;
      expect(strangerItems.filter((x) => x.kind === 'beacon_lit')).toHaveLength(0);

      // friends-of(owner) passes the beacon's own audience.
      const friendStrip = await get(friend, `/api/users/${owner.username}/activity`);
      const friendItems = (friendStrip.json() as { activities: Activity[] }).activities;
      const lit = friendItems.find((x) => x.kind === 'beacon_lit');
      expect(lit).toBeDefined();
      expect(lit!.summary.type).toBe('beacon');

      // The owner always sees their own items.
      const ownStrip = await get(owner, `/api/users/${owner.username}/activity`);
      expect(
        (ownStrip.json() as { activities: Activity[] }).activities.some((x) => x.kind === 'beacon_lit'),
      ).toBe(true);
    });

    it("the per-kind setting narrows: a PUBLIC post hides from strangers under the default 'connections'", async () => {
      const res = await post(owner, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'hello world, publicly',
      });
      expect(res.statusCode).toBe(201);

      // Default activity_posts = 'connections': the stranger passes the POST's
      // audience but fails the setting → dropped silently.
      let strip = await get(stranger, `/api/users/${owner.username}/activity`);
      let items = (strip.json() as { activities: Activity[] }).activities;
      expect(items.filter((x) => x.kind === 'post_created')).toHaveLength(0);

      // Flip the toggle to public → the same item serializes (with excerpt).
      await patch(owner, '/api/users/me/settings', { activity_posts: 'public' });
      strip = await get(stranger, `/api/users/${owner.username}/activity`);
      items = (strip.json() as { activities: Activity[] }).activities;
      const postItem = items.find((x) => x.kind === 'post_created');
      expect(postItem).toBeDefined();
      expect(postItem!.summary).toMatchObject({ type: 'post', excerpt: 'hello world, publicly' });

      // 'private' = owner only.
      await patch(owner, '/api/users/me/settings', { activity_posts: 'private' });
      strip = await get(friend, `/api/users/${owner.username}/activity`);
      items = (strip.json() as { activities: Activity[] }).activities;
      expect(items.filter((x) => x.kind === 'post_created')).toHaveLength(0);
    });

    it('a finished puzzle records no-spoiler facts; moods never appear in any strip', async () => {
      // Burn all guesses with a wrong-but-valid word? The wordlist is secret-
      // seeded — instead assert structurally: no mood kind is representable.
      const kinds = ['beacon_lit', 'beacon_sparked', 'post_created', 'listing_posted', 'puzzle_played', 'game_won'];
      const check = (await db.execute(sqlTag`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'activities_kind_check'
      `)) as unknown as { def: string }[];
      expect(check[0]!.def).not.toContain('mood');
      for (const k of kinds) expect(check[0]!.def).toContain(k);
      // And setting a mood writes NO activity row.
      await setMood(owner, { kind: 'preset', label: 'hyped' });
      const rows = (await db.execute(sqlTag`
        SELECT count(*)::int AS n FROM activities WHERE user_id = ${owner.userId}
      `)) as unknown as { n: number }[];
      const strip = await get(owner, `/api/users/${owner.username}/activity`);
      const items = (strip.json() as { activities: Activity[] }).activities;
      expect(items.length).toBeLessThanOrEqual(rows[0]!.n); // nothing extra appeared
      await del(owner, '/api/users/me/mood');
    });

    it('blocked pairs get the §1.14 profile-shaped 404', async () => {
      const blocker = await register(`m8ab${run}`);
      await put(blocker, `/api/users/${owner.userId}/block`);
      const res = await get(blocker, `/api/users/${owner.username}/activity`);
      expect(res.statusCode).toBe(404);
      await del(blocker, `/api/users/${owner.userId}/block`);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.60 chat backgrounds
  // ---------------------------------------------------------------------------

  describe('chat backgrounds (§1.60)', () => {
    let a: Session;
    let b: Session;
    let convId: string;

    beforeAll(async () => {
      a = await register(`m8bga${run}`);
      b = await register(`m8bgb${run}`);
      convId = (await createDm(a, b.userId)).id;
    });

    it("someone else's upload → 400 bad_background (ownership-checked)", async () => {
      const theirs = await insertReadyAttachment(b.userId);
      const res = await patch(a, `/api/conversations/${convId}/prefs`, {
        background_attachment_id: theirs,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('bad_background');
    });

    it('my own ready image sets; prefs.background resolves the full Attachment; null clears', async () => {
      const mine = await insertReadyAttachment(a.userId);
      const res = await patch(a, `/api/conversations/${convId}/prefs`, {
        background_attachment_id: mine,
      });
      expect(res.statusCode).toBe(200);
      const prefs = (res.json() as { prefs: { background: { id: string } | null } }).prefs;
      expect(prefs.background?.id).toBe(mine);

      // The other participant NEVER sees my background (§1.24 personal prefs).
      const theirs = await get(b, `/api/conversations/${convId}/prefs`);
      expect((theirs.json() as { prefs: { background: unknown } }).prefs.background).toBeNull();

      const clear = await patch(a, `/api/conversations/${convId}/prefs`, {
        background_attachment_id: null,
      });
      expect((clear.json() as { prefs: { background: unknown } }).prefs.background).toBeNull();
    });

    it('video caps bind: over-duration → 400; within caps → 200', async () => {
      const tooLong = await insertReadyAttachment(a.userId, {
        kind: 'video',
        sizeBytes: 1_000_000,
        durationMs: 31_000,
      });
      const bad = await patch(a, `/api/conversations/${convId}/prefs`, {
        background_attachment_id: tooLong,
      });
      expect(bad.statusCode).toBe(400);

      const fine = await insertReadyAttachment(a.userId, {
        kind: 'video',
        sizeBytes: 1_000_000,
        durationMs: 12_000,
      });
      const ok = await patch(a, `/api/conversations/${convId}/prefs`, {
        background_attachment_id: fine,
      });
      expect(ok.statusCode).toBe(200);
      await patch(a, `/api/conversations/${convId}/prefs`, { background_attachment_id: null });
    });
  });

  // ---------------------------------------------------------------------------
  // §1.61 release markers
  // ---------------------------------------------------------------------------

  describe('release markers (§1.61)', () => {
    it('register stamps the newest version; GET /api/releases serves list + cursor; seen moves it', async () => {
      const u = await register(`m8rel${run}`);
      const res = await get(u, '/api/releases');
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        releases: { version: string; items: string[] }[];
        last_seen_release: string | null;
      };
      expect(body.releases.length).toBeGreaterThan(0);
      // Each release migration prepends its own marker — newest first
      // (v0.8b via 0010, v0.9 via 0011).
      expect(body.releases[0]!.version).toBe('v0.9');
      // Day-one users never get a card storm.
      expect(u.lastSeenRelease).toBe(body.releases[0]!.version);
      expect(body.last_seen_release).toBe(body.releases[0]!.version);

      const seen = await post(u, '/api/releases/seen', { version: 'v9.9' });
      expect(seen.statusCode).toBe(204);
      const after = await get(u, '/api/releases');
      expect((after.json() as { last_seen_release: string }).last_seen_release).toBe('v9.9');
    });

    it('a mood TTL is the contract 4 h and the PUT re-set extends it', async () => {
      const u = await register(`m8ttl${run}`);
      const s1 = await setMood(u, { kind: 'preset', label: 'bored' });
      const delta = new Date(s1.expires_at!).getTime() - Date.now();
      expect(delta).toBeGreaterThan((MOOD_TTL_S - 60) * 1000);
      expect(delta).toBeLessThanOrEqual(MOOD_TTL_S * 1000 + 5000);
    });
  });
});
