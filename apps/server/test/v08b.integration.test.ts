// v0.8b tests (API.md §1.62–§1.69, ADR-019/ADR-020, FEATURES #77/#78/#79a/
// #79c/#79d/#81). The binding safety rules, pinned:
//   - the anonymous sender's identity NEVER reaches the recipient's DTOs
//     before reveal, refusals are byte-identical, and a report ATTACHES the
//     real identity server-side;
//   - the wave nudge claims wave_nudged_at ONLY when the visible pool is
//     ≥ NUDGE_MIN_POOL (below it the claim stays open);
//   - 👻 ghost groups serialize MASKS (pseudo-ids, mask names) to non-admin
//     members while group admins see real identities;
//   - a PUBLIC group's share page exposes ONLY seq > public_since_seq;
//   - a share token dies with its object;
//   - canvas overlays cap at OVERLAYS_PER_USER and a canvas ban answers the
//     same 403 canvas_closed as a closed canvas;
//   - an admin takedown notifies the author NEUTRALLY via the Support
//     conversation (sender_id NULL, never a named admin);
//   - an admin support reply lands as an ordinary message in the per-user
//     Support conversation and flips the ticket to 'answered'.
// Infra-gated like the other suites (Postgres+Redis; skips cleanly without).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NUDGE_MIN_POOL,
  OVERLAYS_PER_USER,
  SUPPORT_CONVERSATION_TITLE,
  type AnonThread,
  type Conversation,
  type Message,
  type SharePage,
  type StoryOverlay,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 23) & 0xffffff;
  return `21.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('v0.8b community pack', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;
  let nudge: typeof import('../src/modules/discovery/nudge.js');

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
    const sid = res.cookies.find((c) => c.name === 'sid')?.value;
    const body = res.json() as { user: { id: string } };
    return { sid: sid!, userId: body.user.id, username };
  }

  function get(me: Session, url: string) {
    return app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  }
  function anon(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
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

  async function connect(a: Session, b: Session): Promise<void> {
    const req = await post(a, `/api/users/${b.userId}/connect`);
    expect([200, 201]).toContain(req.statusCode);
    const conn = (req.json() as { connection: { id: string; status: string } }).connection;
    if (conn.status === 'accepted') return;
    const acc = await post(b, `/api/connections/${conn.id}/accept`);
    expect(acc.statusCode).toBe(200);
  }

  async function makeAdmin(me: Session): Promise<void> {
    await db.execute(sqlTag`UPDATE users SET is_admin = true WHERE id = ${me.userId}`);
  }

  async function insertReadyAttachment(uploaderId: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(schema.attachments).values({
      id,
      uploaderId,
      kind: 'image',
      originalKey: `test/${id}`,
      mime: 'image/png',
      sizeBytes: 1234,
      status: 'ready',
    });
    return id;
  }

  async function createGroup(admin: Session, members: Session[], title: string): Promise<Conversation> {
    const res = await post(admin, '/api/conversations', {
      type: 'group',
      title,
      user_ids: members.map((m) => m.userId),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { conversation: Conversation }).conversation;
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

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    ({ db, schema } = await import('../src/db/index.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));
    nudge = await import('../src/modules/discovery/nudge.js');
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // §1.62 anonymous reveal game
  // ---------------------------------------------------------------------------

  describe('anonymous reveal game (§1.62)', () => {
    let sender: Session;
    let recipient: Session;
    let stranger: Session;
    let threadId: string;
    let messageId: string;

    beforeAll(async () => {
      sender = await register(`b8as${run}`);
      recipient = await register(`b8ar${run}`);
      stranger = await register(`b8ax${run}`);
      await connect(sender, recipient);
    });

    it('opens a thread to a connection; refusals are byte-identical 404s', async () => {
      // stranger → recipient: default 'connections' unmet → 404 anon_unavailable.
      const refused = await post(stranger, '/api/anon/threads', {
        user_id: recipient.userId,
        body: 'hello?',
      });
      expect(refused.statusCode).toBe(404);
      expect((refused.json() as { error: string }).error).toBe('anon_unavailable');
      // 'nobody' refuses a CONNECTION with the same bytes.
      await patch(recipient, '/api/users/me/settings', { anon_messages: 'nobody' });
      const refused2 = await post(sender, '/api/anon/threads', {
        user_id: recipient.userId,
        body: 'guess who',
      });
      expect(refused2.statusCode).toBe(404);
      expect(refused2.body).toBe(refused.body);
      await patch(recipient, '/api/users/me/settings', { anon_messages: 'connections' });

      const res = await post(sender, '/api/anon/threads', {
        user_id: recipient.userId,
        body: 'guess who 🎭',
      });
      expect(res.statusCode).toBe(201);
      threadId = (res.json() as { thread: AnonThread }).thread.id;
    });

    it("the sender's identity never reaches the recipient's DTOs pre-reveal", async () => {
      const list = await get(recipient, '/api/anon/threads');
      expect(list.statusCode).toBe(200);
      const thread = (list.json() as { threads: AnonThread[] }).threads.find((t) => t.id === threadId)!;
      expect(thread.role).toBe('recipient');
      expect(thread.counterpart).toBeNull(); // the whole game
      // No identity anywhere in the serialized payload.
      expect(list.body).not.toContain(sender.userId);
      expect(list.body).not.toContain(sender.username);

      const msgs = await get(recipient, `/api/anon/threads/${threadId}/messages`);
      expect(msgs.statusCode).toBe(200);
      expect(msgs.body).not.toContain(sender.userId);
      expect(msgs.body).not.toContain(sender.username);
      const parsed = msgs.json() as { messages: { id: string; from_sender: boolean; body: string }[] };
      messageId = parsed.messages[0]!.id;
      expect(parsed.messages[0]!.from_sender).toBe(true);

      // The sender meanwhile always sees the recipient (they chose them).
      const senderList = await get(sender, '/api/anon/threads');
      const senderThread = (senderList.json() as { threads: AnonThread[] }).threads.find(
        (t) => t.id === threadId,
      )!;
      expect(senderThread.role).toBe('sender');
      expect(senderThread.counterpart?.id).toBe(recipient.userId);
    });

    it('a timer set keeps the counterpart hidden until reveal; reveal shows it', async () => {
      const reqReveal = await post(recipient, `/api/anon/threads/${threadId}/request-reveal`);
      expect(reqReveal.statusCode).toBe(200);
      const setRes = await post(sender, `/api/anon/threads/${threadId}/set-reveal`, {
        mode: 'timer',
        timer_s: 3600,
      });
      expect(setRes.statusCode).toBe(200);
      const mid = await get(recipient, '/api/anon/threads');
      const t = (mid.json() as { threads: AnonThread[] }).threads.find((x) => x.id === threadId)!;
      expect(t.reveal_mode).toBe('timer');
      expect(t.reveal_timer_s).toBe(3600);
      expect(t.counterpart).toBeNull();

      const reveal = await post(sender, `/api/anon/threads/${threadId}/reveal`);
      expect(reveal.statusCode).toBe(200);
      const after = await get(recipient, '/api/anon/threads');
      const revealed = (after.json() as { threads: AnonThread[] }).threads.find(
        (x) => x.id === threadId,
      )!;
      expect(revealed.counterpart?.id).toBe(sender.userId);
      expect(revealed.revealed_at).not.toBeNull();
    });

    it('reporting an anonymous message ATTACHES the real sender identity', async () => {
      const res = await post(recipient, '/api/reports', {
        kind: 'anon_message',
        thread_id: threadId,
        message_id: messageId,
        reason: 'creepy',
      });
      expect(res.statusCode).toBe(201);
      const reportId = (res.json() as { id: string }).id;
      const [row] = (await db.execute(sqlTag`
        SELECT target_user_id, target_anon_thread_id, target_anon_message_id
        FROM reports WHERE id = ${reportId}
      `)) as unknown as {
        target_user_id: string;
        target_anon_thread_id: string;
        target_anon_message_id: string;
      }[];
      expect(row!.target_user_id).toBe(sender.userId); // the SERVER-attached identity
      expect(row!.target_anon_thread_id).toBe(threadId);
      expect(row!.target_anon_message_id).toBe(messageId);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.63 wave-nudge pool guard
  // ---------------------------------------------------------------------------

  describe('wave nudge pool guard (§1.63)', () => {
    it('drops silently below NUDGE_MIN_POOL and claims once at/above it', async () => {
      // Pool arithmetic needs a clean slate — stale opt-ins from earlier runs
      // would inflate the visible pool.
      await db.execute(sqlTag`DELETE FROM discovery_optins`);
      await db.execute(sqlTag`DELETE FROM discovery_waves`);
      const target = await register(`b8nt${run}`);
      await put(target, '/api/discovery/optin', { scope: 'public', note: 'bored' });

      // Pool of NUDGE_MIN_POOL - 1 → the claim must stay open.
      const pool: Session[] = [];
      for (let i = 0; i < NUDGE_MIN_POOL - 1; i += 1) {
        const u = await register(`b8np${i}${run}`);
        await put(u, '/api/discovery/optin', { scope: 'public', note: 'hey' });
        pool.push(u);
      }
      await nudge.runWaveNudge(target.userId);
      let [optin] = (await db.execute(sqlTag`
        SELECT wave_nudged_at FROM discovery_optins WHERE user_id = ${target.userId}
      `)) as unknown as { wave_nudged_at: Date | null }[];
      expect(optin!.wave_nudged_at).toBeNull(); // too small — no nudge, claim open

      // One more card makes the pool big enough — the claim lands exactly once.
      const extra = await register(`b8npx${run}`);
      await put(extra, '/api/discovery/optin', { scope: 'public', note: 'yo' });
      await nudge.runWaveNudge(target.userId);
      [optin] = (await db.execute(sqlTag`
        SELECT wave_nudged_at FROM discovery_optins WHERE user_id = ${target.userId}
      `)) as unknown as { wave_nudged_at: Date | null }[];
      expect(optin!.wave_nudged_at).not.toBeNull();

      // Batching IS the claim: a second run in the same opt-in changes nothing.
      const first = optin!.wave_nudged_at;
      await nudge.runWaveNudge(target.userId);
      const [again] = (await db.execute(sqlTag`
        SELECT wave_nudged_at FROM discovery_optins WHERE user_id = ${target.userId}
      `)) as unknown as { wave_nudged_at: Date | null }[];
      expect(new Date(again!.wave_nudged_at!).getTime()).toBe(new Date(first!).getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // §1.68 ghost masks
  // ---------------------------------------------------------------------------

  describe('👻 ghost masks (§1.68)', () => {
    let admin: Session;
    let m1: Session;
    let m2: Session;
    let convId: string;

    beforeAll(async () => {
      admin = await register(`b8ga${run}`);
      m1 = await register(`b8gm1${run}`);
      m2 = await register(`b8gm2${run}`);
      const conv = await createGroup(admin, [m1, m2], 'midnight club');
      convId = conv.id;
      const sw = await patch(admin, `/api/conversations/${convId}/visibility`, {
        visibility: 'ghost',
        confirm: true,
      });
      expect(sw.statusCode).toBe(200);
      expect((sw.json() as { conversation: Conversation }).conversation.visibility).toBe('ghost');
    });

    it('members see masks (pseudo-ids, mask names); admins see real identity', async () => {
      await sendMessage(m1, convId, 'who am i though');

      // m2 (non-admin) reads: sender is a pseudo-id, never m1's real id.
      const msgs = await get(m2, `/api/conversations/${convId}/messages?before_seq=999999&limit=10`);
      expect(msgs.statusCode).toBe(200);
      expect(msgs.body).not.toContain(m1.userId);
      expect(msgs.body).not.toContain(m1.username);
      const texts = (msgs.json() as { messages: Message[] }).messages.filter((m) => m.type === 'text');
      expect(texts[0]!.sender_id).not.toBe(m1.userId);
      expect(texts[0]!.sender_id).toMatch(/^[0-9a-f-]{36}$/);

      // m2's conversation DTO: participants are masked, with mask_emoji set.
      const conv = await get(m2, `/api/conversations/${convId}`);
      const dto = (conv.json() as { conversation: Conversation }).conversation;
      const others = dto.participants.filter((p) => p.user.id !== m2.userId);
      for (const p of others) {
        expect(p.user.id).not.toBe(m1.userId);
        expect(p.user.id).not.toBe(admin.userId);
        expect(p.user.username).toBe('');
        expect(p.user.display_name).not.toContain('Real ');
        expect(p.last_read_seq).toBe(0); // receipts-off shape
      }
      expect(conv.body).not.toContain(m1.username);

      // The admin sees real identities (abuse handling, ADR-020).
      const adminMsgs = await get(admin, `/api/conversations/${convId}/messages?before_seq=999999&limit=10`);
      const adminTexts = (adminMsgs.json() as { messages: Message[] }).messages.filter(
        (m) => m.type === 'text',
      );
      expect(adminTexts[0]!.sender_id).toBe(m1.userId);
      const adminConv = await get(admin, `/api/conversations/${convId}`);
      expect(adminConv.body).toContain(m1.userId);
    });

    it('reaction faces wear the mask for non-admins (reactors ride the stamps rule)', async () => {
      // Emoji chips ship reactor FACES (Audit P0 / PSYCHOLOGY rule 3) — inside a
      // ghost group those are identities, so ghostMessageDto masks them exactly
      // like stamps. m2 reacts; m1 (non-admin) must see a masked face only.
      const sent = await sendMessage(m1, convId, 'react to me');
      const r = await post(m2, `/api/conversations/${convId}/messages/${sent.seq}/reactions`, {
        emoji: '👍',
      });
      expect(r.statusCode).toBe(204);

      const msgs = await get(m1, `/api/conversations/${convId}/messages?before_seq=999999&limit=10`);
      expect(msgs.statusCode).toBe(200);
      const msg = (msgs.json() as { messages: Message[] }).messages.find((m) => m.seq === sent.seq)!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.has_more).toBe(false);
      const face = msg.reactions[0]!.reactors[0]!;
      expect(face.id).not.toBe(m2.userId);
      expect(face.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(face.username).toBe('');
      expect(face.mask_emoji).not.toBeNull();
      expect(msgs.body).not.toContain(m2.userId);
      expect(msgs.body).not.toContain(m2.username);

      // The reactor's OWN face stays real to them (viewer identity is never
      // masked), with mine = true; the admin sees everyone real (ADR-020).
      const own = await get(m2, `/api/conversations/${convId}/messages?before_seq=999999&limit=10`);
      const ownMsg = (own.json() as { messages: Message[] }).messages.find((m) => m.seq === sent.seq)!;
      expect(ownMsg.reactions[0]!.mine).toBe(true);
      expect(ownMsg.reactions[0]!.reactors[0]!.id).toBe(m2.userId);
      const adminMsgs = await get(admin, `/api/conversations/${convId}/messages?before_seq=999999&limit=10`);
      const adminMsg = (adminMsgs.json() as { messages: Message[] }).messages.find((m) => m.seq === sent.seq)!;
      expect(adminMsg.reactions[0]!.reactors[0]!.id).toBe(m2.userId);
      expect(adminMsg.reactions[0]!.reactors[0]!.mask_emoji).toBeNull();
    });

    it('an idempotent send replay masks reactor faces too (the 200 path, not just the 201)', async () => {
      // The replay DTO is rebuilt from the row at replay time, so a reaction
      // that landed between the original send and the retry rides it — it
      // must wear the mask exactly like the fresh 201 (audit review, 2026-10-27).
      const cid = crypto.randomUUID();
      const first = await post(m1, `/api/conversations/${convId}/messages`, {
        client_msg_id: cid,
        type: 'text',
        body: 'retry me',
      });
      expect(first.statusCode).toBe(201);
      const seq = (first.json() as { message: Message }).message.seq;
      const r = await post(m2, `/api/conversations/${convId}/messages/${seq}/reactions`, { emoji: '🔥' });
      expect(r.statusCode).toBe(204);

      const replay = await post(m1, `/api/conversations/${convId}/messages`, {
        client_msg_id: cid,
        type: 'text',
        body: 'retry me',
      });
      expect(replay.statusCode).toBe(200);
      const msg = (replay.json() as { message: Message }).message;
      expect(msg.seq).toBe(seq);
      expect(msg.reactions).toHaveLength(1);
      const face = msg.reactions[0]!.reactors[0]!;
      expect(face.id).not.toBe(m2.userId);
      expect(face.username).toBe('');
      expect(face.mask_emoji).not.toBeNull();
      expect(replay.body).not.toContain(m2.userId);
      expect(replay.body).not.toContain(m2.username);
    });

    it('ghost is a one-way door and masks are re-pickable (unique per group)', async () => {
      const back = await patch(admin, `/api/conversations/${convId}/visibility`, {
        visibility: 'private',
        confirm: true,
      });
      expect(back.statusCode).toBe(400);
      expect((back.json() as { error: string }).error).toBe('ghost_is_forever');

      const mine = await put(m1, `/api/conversations/${convId}/mask`, {
        mask_name: `walrus${run}`.slice(0, 32),
        mask_emoji: '🦭',
      });
      expect(mine.statusCode).toBe(200);
      const taken = await put(m2, `/api/conversations/${convId}/mask`, {
        mask_name: `WALRUS${run}`.slice(0, 32), // case-insensitive collision
        mask_emoji: '🦊',
      });
      expect(taken.statusCode).toBe(409);
      expect((taken.json() as { error: string }).error).toBe('mask_taken');
    });

    it('seen-by is suppressed entirely and ghost joins answer 404', async () => {
      const [msg] = (await db.execute(sqlTag`
        SELECT seq FROM messages WHERE conversation_id = ${convId} AND type = 'text'
        ORDER BY seq DESC LIMIT 1
      `)) as unknown as { seq: number }[];
      const receipts = await get(
        m1,
        `/api/conversations/${convId}/messages/${Number(msg!.seq)}/receipts`,
      );
      expect(receipts.statusCode).toBe(200);
      expect(receipts.json()).toEqual({ seen: [], delivered: [] });

      const outsider = await register(`b8go${run}`);
      const join = await post(outsider, `/api/conversations/${convId}/join`);
      expect(join.statusCode).toBe(404); // unlisted means unlisted
    });
  });

  // ---------------------------------------------------------------------------
  // §1.67/§1.68 public group page + share tokens
  // ---------------------------------------------------------------------------

  describe('public group page & share tokens (§1.67/§1.68)', () => {
    let admin: Session;
    let member: Session;
    let convId: string;
    let token: string;

    beforeAll(async () => {
      admin = await register(`b8pa${run}`);
      member = await register(`b8pm${run}`);
      const conv = await createGroup(admin, [member], 'secret history');
      convId = conv.id;
      await sendMessage(member, convId, 'PRE-SWITCH secret');
      const sw = await patch(admin, `/api/conversations/${convId}/visibility`, {
        visibility: 'public',
        confirm: true,
        description: 'now open to the world',
      });
      expect(sw.statusCode).toBe(200);
      const dto = (sw.json() as { conversation: Conversation }).conversation;
      expect(dto.visibility).toBe('public');
      expect(dto.public_since_seq).not.toBeNull();
      await sendMessage(member, convId, 'POST-SWITCH hello world');
      const mint = await post(admin, '/api/share-links', { type: 'group', id: convId });
      expect(mint.statusCode).toBe(200);
      token = (mint.json() as { share_link: { token: string } }).share_link.token;
    });

    it('the live page exposes ONLY messages after the switch', async () => {
      const res = await anon('GET', `/api/share/${token}/public`);
      expect(res.statusCode).toBe(200);
      const page = (res.json() as { page: SharePage }).page;
      expect(page.type).toBe('group_live');
      if (page.type !== 'group_live') return;
      expect(page.description).toBe('now open to the world');
      const bodies = page.messages.map((m) => m.body);
      expect(bodies).toContain('POST-SWITCH hello world');
      expect(res.body).not.toContain('PRE-SWITCH secret'); // history never retro-exposed
      // System noise never renders either.
      expect(page.messages.every((m) => m.type !== 'system')).toBe(true);
    });

    it('switching away from public revokes the token (same shape as unknown)', async () => {
      const sw = await patch(admin, `/api/conversations/${convId}/visibility`, {
        visibility: 'invite_only',
      });
      expect(sw.statusCode).toBe(200);
      const res = await anon('GET', `/api/share/${token}/public`);
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('share_not_found');
      // A fresh mint on the invite_only group serves the CARD only.
      const remint = await post(admin, '/api/share-links', { type: 'group', id: convId });
      expect(remint.statusCode).toBe(200);
      const t2 = (remint.json() as { share_link: { token: string } }).share_link.token;
      const card = await anon('GET', `/api/share/${t2}/public`);
      expect(card.statusCode).toBe(200);
      const page = (card.json() as { page: SharePage }).page;
      expect(page.type).toBe('group_card');
      expect(card.body).not.toContain('POST-SWITCH'); // the card never carries messages
    });

    it('GET /api/share-links/mine lists my open links with a label and live flag; revoke removes', async () => {
      // §1b plumbing (2026-10-27). Mint-or-return gives the group's one open
      // token (the invite_only card link from the previous test).
      const mint = await post(admin, '/api/share-links', { type: 'group', id: convId });
      expect(mint.statusCode).toBe(200);
      const link = (mint.json() as { share_link: { token: string; preview: string } }).share_link;
      expect(link.preview).toBe('full');

      const mine = await get(admin, '/api/share-links/mine');
      expect(mine.statusCode).toBe(200);
      const list = (mine.json() as { share_links: { token: string; label: string; live: boolean; object: { type: string } }[] }).share_links;
      const row = list.find((l) => l.token === link.token);
      expect(row).toBeDefined();
      expect(row!.object.type).toBe('group');
      expect(row!.label.startsWith('Group · ')).toBe(true);
      expect(row!.live).toBe(true); // invite_only still serves the card
      expect((row as unknown as { preview: string }).preview).toBe('full'); // ListItem extends ShareLink
      expect(list[0]!.token).toBe(link.token); // newest first

      // Another member's list never shows an admin-minted link they did not mint.
      const theirs = await get(member, '/api/share-links/mine');
      expect(theirs.statusCode).toBe(200);
      expect((theirs.json() as { share_links: { token: string }[] }).share_links.some((l) => l.token === link.token)).toBe(false);

      const gone = await del(admin, `/api/share-links/${link.token}`);
      expect(gone.statusCode).toBe(204);
      const after = await get(admin, '/api/share-links/mine');
      expect((after.json() as { share_links: { token: string }[] }).share_links.some((l) => l.token === link.token)).toBe(false);
    });

    it('a post share token dies with the post', async () => {
      const author = await register(`b8ps${run}`);
      const created = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'share me',
      });
      expect(created.statusCode).toBe(201);
      const postId = (created.json() as { post: { id: string } }).post.id;
      const mint = await post(author, '/api/share-links', { type: 'post', id: postId });
      expect(mint.statusCode).toBe(200);
      const t = (mint.json() as { share_link: { token: string } }).share_link.token;
      expect((await anon('GET', `/api/share/${t}/public`)).statusCode).toBe(200);
      expect((await del(author, `/api/posts/${postId}`)).statusCode).toBe(204);
      const after = await anon('GET', `/api/share/${t}/public`);
      expect(after.statusCode).toBe(404); // revoked route-side with the object
      const [row] = (await db.execute(sqlTag`
        SELECT revoked_at FROM share_tokens WHERE token = ${t}
      `)) as unknown as { revoked_at: Date | null }[];
      expect(row!.revoked_at).not.toBeNull();
    });

    it('a friends-only post: the AUTHOR mints a token (teaser by default), nobody else can', async () => {
      // §1b (decision 11, 2026-10-27): non-public objects share by capability
      // token with a sharer-side Teaser/Full choice; the page shows the thing,
      // hides the people, gates the action.
      const author = await register(`b8pf${run}`);
      const other = await register(`b8pg${run}`);
      const longBody = `private-ish ${'word '.repeat(80)}END`;
      const created = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'friends_of',
        body: longBody,
      });
      const postId = (created.json() as { post: { id: string } }).post.id;

      // A stranger (not friends-of) cannot even see it → 404-shaped.
      const strangerMint = await post(other, '/api/share-links', { type: 'post', id: postId });
      expect(strangerMint.statusCode).toBe(404);

      // The author mints: default teaser, carried on the ShareLink.
      const mint = await post(author, '/api/share-links', { type: 'post', id: postId });
      expect(mint.statusCode).toBe(200);
      const link = (mint.json() as { share_link: { token: string; preview: string } }).share_link;
      expect(link.preview).toBe('teaser');

      // The public page is a TEASER: trimmed body, the object id for the
      // deep link, no poll, and `preview` on the wire.
      const page = await anon('GET', `/api/share/${link.token}/public`);
      expect(page.statusCode).toBe(200);
      const p = (page.json() as { page: SharePage }).page;
      expect(p.type).toBe('post');
      if (p.type !== 'post') return;
      expect(p.id).toBe(postId);
      expect(p.preview).toBe('teaser');
      expect(p.body.length).toBeLessThan(longBody.length);
      expect(p.body.endsWith('…')).toBe(true);
      expect(page.body).not.toContain('END');

      // Revoke + re-mint as Full: the whole body, preview 'full'.
      expect((await del(author, `/api/share-links/${link.token}`)).statusCode).toBe(204);
      const full = await post(author, '/api/share-links', { type: 'post', id: postId, preview: 'full' });
      expect(full.statusCode).toBe(200);
      const t2 = (full.json() as { share_link: { token: string; preview: string } }).share_link;
      expect(t2.preview).toBe('full');
      const fullPage = (await anon('GET', `/api/share/${t2.token}/public`)).json() as { page: SharePage };
      expect(fullPage.page.type === 'post' && fullPage.page.preview).toBe('full');
      expect(fullPage.page.type === 'post' && fullPage.page.body).toBe(longBody);

      // A PUBLIC object ignores the choice — always 'full'.
      const pub = await post(author, '/api/posts', { kind: 'text', audience: 'public', body: 'open' });
      const pubId = (pub.json() as { post: { id: string } }).post.id;
      const pubMint = await post(author, '/api/share-links', { type: 'post', id: pubId, preview: 'teaser' });
      expect((pubMint.json() as { share_link: { preview: string } }).share_link.preview).toBe('full');

      // A FRIEND can see the friends-only post but is not its owner → 400
      // not_public (the §1b owner-only rule), distinct from the stranger's 404.
      const friend = await register(`b8ph${run}`);
      await connect(author, friend);
      const friendMint = await post(friend, '/api/share-links', { type: 'post', id: postId });
      expect(friendMint.statusCode).toBe(400);
      expect((friendMint.json() as { error: string }).error).toBe('not_public');

      // /mine: the owner's token on a non-public post is LIVE (existence +
      // unbanned author decide, not publicness).
      const mine = await get(author, '/api/share-links/mine');
      const row = (mine.json() as { share_links: { token: string; live: boolean }[] }).share_links.find(
        (l) => l.token === t2.token,
      );
      expect(row?.live).toBe(true);
    });

    it('a friends-audience plan: the HOST mints a teaser (coarse area, no exact spot); a friend cannot', async () => {
      const host = await register(`b8pj${run}`);
      const friend = await register(`b8pk${run}`);
      await connect(host, friend);
      const now = Date.now();
      const created = await post(host, '/api/beacons', {
        vibe: 'chai',
        audience: 'friends',
        note: 'chai at the usual place',
        starts_at: new Date(now).toISOString(),
        expires_at: new Date(now + 2 * 3600 * 1000).toISOString(),
        location: { label: 'Exact Corner Cafe', lat: 12.97, lng: 77.59 },
      });
      expect(created.statusCode).toBe(201);
      const beaconId = (created.json() as { beacon: { id: string } }).beacon.id;

      // The friend sees the plan (friends audience) but may not mint it.
      const friendMint = await post(friend, '/api/share-links', { type: 'beacon', id: beaconId });
      expect(friendMint.statusCode).toBe(400);
      expect((friendMint.json() as { error: string }).error).toBe('not_public');

      const mint = await post(host, '/api/share-links', { type: 'beacon', id: beaconId });
      expect(mint.statusCode).toBe(200);
      const link = (mint.json() as { share_link: { token: string; preview: string } }).share_link;
      expect(link.preview).toBe('teaser');
      const page = await anon('GET', `/api/share/${link.token}/public`);
      expect(page.statusCode).toBe(200);
      const p = (page.json() as { page: SharePage }).page;
      expect(p.type).toBe('beacon');
      if (p.type !== 'beacon') return;
      expect(p.id).toBe(beaconId);
      expect(p.preview).toBe('teaser');
      expect(p.location_label).toBeNull(); // the exact spot stays behind sign-in
      expect(page.body).not.toContain('Exact Corner Cafe');
      expect(p.note).toBe('chai at the usual place');
      expect(typeof p.needs).toBe('number');
    });

    it('non-user share-page reports store reporter NULL + the resolved target', async () => {
      const author = await register(`b8pr${run}`);
      const created = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'report me',
      });
      const postId = (created.json() as { post: { id: string } }).post.id;
      const mint = await post(author, '/api/share-links', { type: 'post', id: postId });
      const t = (mint.json() as { share_link: { token: string } }).share_link.token;
      const rep = await anon('POST', `/api/share/${t}/report`, { reason: 'spam page' });
      expect(rep.statusCode).toBe(204);
      const [row] = (await db.execute(sqlTag`
        SELECT reporter_id, kind, target_object_type, target_object_id, reporter_ip
        FROM reports WHERE kind = 'share_page' AND target_object_id = ${postId}
      `)) as unknown as {
        reporter_id: string | null;
        kind: string;
        target_object_type: string;
        target_object_id: string;
        reporter_ip: string | null;
      }[];
      expect(row!.reporter_id).toBeNull();
      expect(row!.target_object_type).toBe('post');
      expect(row!.reporter_ip).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // §1.66 canvas caps + bans
  // ---------------------------------------------------------------------------

  describe('canvas stories (§1.66)', () => {
    let author: Session;
    let friend: Session;
    let storyId: string;

    beforeAll(async () => {
      author = await register(`b8ca${run}`);
      friend = await register(`b8cf${run}`);
      await connect(author, friend);
      const att = await insertReadyAttachment(author.userId);
      const res = await post(author, '/api/stories', {
        attachment_id: att,
        caption: 'draw on me',
        canvas_mode: 'open',
      });
      expect(res.statusCode).toBe(201);
      storyId = (res.json() as { story: { id: string } }).story.id;
    });

    it('caps live+pending overlays per contributor at OVERLAYS_PER_USER', async () => {
      for (let i = 0; i < OVERLAYS_PER_USER; i += 1) {
        const res = await post(friend, `/api/stories/${storyId}/overlays`, {
          payload: { kind: 'emoji', emoji: '🎨', x: 0.1 * (i + 1), y: 0.5, scale: 1 },
        });
        expect(res.statusCode).toBe(201);
        expect((res.json() as { overlay: StoryOverlay }).overlay.status).toBe('live');
      }
      const sixth = await post(friend, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'text', text: 'one too many', x: 0.5, y: 0.5 },
      });
      expect(sixth.statusCode).toBe(409);
      expect((sixth.json() as { error: string }).error).toBe('overlay_limit');

      // Removal frees the cap.
      const overlays = (await db.execute(sqlTag`
        SELECT id FROM story_overlays WHERE story_id = ${storyId} AND author_id = ${friend.userId}
        ORDER BY created_at ASC LIMIT 1
      `)) as unknown as { id: string }[];
      const rm = await del(friend, `/api/stories/${storyId}/overlays/${overlays[0]!.id}`);
      expect(rm.statusCode).toBe(204);
      const again = await post(friend, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'text', text: 'fits now', x: 0.5, y: 0.5 },
      });
      expect(again.statusCode).toBe(201);
    });

    it('a canvas ban answers the SAME 403 canvas_closed as a closed canvas', async () => {
      const ban = await put(author, `/api/users/${friend.userId}/canvas-ban`);
      expect(ban.statusCode).toBe(204);
      const banned = await post(friend, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'text', text: 'let me in', x: 0.2, y: 0.2 },
      });
      expect(banned.statusCode).toBe(403);
      expect((banned.json() as { error: string }).error).toBe('canvas_closed');

      // Byte-identical to canvas_mode 'off' for an unbanned viewer.
      await del(author, `/api/users/${friend.userId}/canvas-ban`);
      const off = await patch(author, `/api/stories/${storyId}`, { canvas_mode: 'off' });
      expect(off.statusCode).toBe(200);
      const closed = await post(friend, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'text', text: 'knock knock', x: 0.2, y: 0.2 },
      });
      expect(closed.statusCode).toBe(403);
      expect(closed.body).toBe(banned.body);
    });

    it('approve mode holds viewer overlays as pending until the author approves', async () => {
      await patch(author, `/api/stories/${storyId}`, { canvas_mode: 'approve' });
      // Free one cap slot (the author's one-tap remove works on any overlay).
      const mine = (await db.execute(sqlTag`
        SELECT id FROM story_overlays
        WHERE story_id = ${storyId} AND author_id = ${friend.userId} AND status IN ('live','pending')
        ORDER BY created_at ASC LIMIT 1
      `)) as unknown as { id: string }[];
      expect((await del(author, `/api/stories/${storyId}/overlays/${mine[0]!.id}`)).statusCode).toBe(204);
      const res = await post(friend, `/api/stories/${storyId}/overlays`, {
        payload: { kind: 'emoji', emoji: '⭐', x: 0.9, y: 0.9, scale: 2 },
      });
      expect(res.statusCode).toBe(201);
      const overlay = (res.json() as { overlay: StoryOverlay }).overlay;
      expect(overlay.status).toBe('pending');
      const approve = await post(
        author,
        `/api/stories/${storyId}/overlays/${overlay.id}/approve`,
      );
      expect(approve.statusCode).toBe(200);
      expect((approve.json() as { overlay: StoryOverlay }).overlay.status).toBe('live');
    });
  });

  // ---------------------------------------------------------------------------
  // §1.69 admin: takedown + support inbox
  // ---------------------------------------------------------------------------

  describe('admin takedown & support (§1.69)', () => {
    let admin: Session;
    let author: Session;

    beforeAll(async () => {
      admin = await register(`b8ta${run}`);
      author = await register(`b8tu${run}`);
      await makeAdmin(admin);
    });

    it('a takedown removes the post and notifies the author NEUTRALLY', async () => {
      const created = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'rule-breaking post',
      });
      const postId = (created.json() as { post: { id: string } }).post.id;
      const td = await post(admin, `/api/admin/content/post/${postId}/takedown`, {
        reason: 'spam',
      });
      expect(td.statusCode).toBe(200);
      const [gone] = (await db.execute(sqlTag`
        SELECT count(*)::int AS n FROM posts WHERE id = ${postId}
      `)) as unknown as { n: number }[];
      expect(Number(gone!.n)).toBe(0);

      // The author's Support conversation holds the neutral notice —
      // sender_id NULL, never a named admin, exact copy per §1.69.
      const sync = await get(author, '/api/sync');
      const convs = (sync.json() as { conversations: (Conversation & { last_message: Message | null })[] })
        .conversations;
      const support = convs.find((c) => c.title === SUPPORT_CONVERSATION_TITLE)!;
      expect(support).toBeDefined();
      expect(support.last_message?.sender_id).toBeNull();
      expect(support.last_message?.body).toBe('A moderator removed your post. Reason: spam');
      expect(support.last_message?.body).not.toContain(admin.username);
      expect((support.last_message?.metadata as { support?: unknown }).support).toBeDefined();
    });

    it('a support reply lands as a Support-conversation message + answered status', async () => {
      const ticketRes = await post(author, '/api/support/tickets', {
        category: 'bug',
        body: 'the send button wobbles',
      });
      expect(ticketRes.statusCode).toBe(201);
      const ticketId = (ticketRes.json() as { ticket: { id: string } }).ticket.id;

      const inbox = await get(admin, '/api/admin/support');
      expect(inbox.statusCode).toBe(200);
      expect(inbox.body).toContain(ticketId);

      const reply = await post(admin, `/api/admin/support/${ticketId}/reply`, {
        body: 'thanks — fixed in the next update!',
      });
      expect(reply.statusCode).toBe(200);
      expect((reply.json() as { ticket: { status: string } }).ticket.status).toBe('answered');

      const sync = await get(author, '/api/sync');
      const convs = (sync.json() as { conversations: (Conversation & { last_message: Message | null })[] })
        .conversations;
      const support = convs.find((c) => c.title === SUPPORT_CONVERSATION_TITLE)!;
      expect(support.last_message?.body).toBe('thanks — fixed in the next update!');
      expect(support.last_message?.sender_id).toBeNull();
      expect(
        (support.last_message?.metadata as { support?: { ticket_id: string | null } }).support
          ?.ticket_id,
      ).toBe(ticketId);

      // The user replying in the Support conversation re-opens the ticket.
      await sendMessage(author, support.id, 'still wobbling on tuesdays');
      const [row] = (await db.execute(sqlTag`
        SELECT status FROM support_tickets WHERE id = ${ticketId}
      `)) as unknown as { status: string }[];
      expect(row!.status).toBe('open');
    });

    it('the context viewer opens ONLY on reporter consent', async () => {
      const a = await register(`b8cx${run}`);
      const b = await register(`b8cy${run}`);
      const dm = await post(a, '/api/conversations', { type: 'dm', user_id: b.userId });
      const convId = (dm.json() as { conversation: Conversation }).conversation.id;
      const msg = await sendMessage(b, convId, 'the reported words');

      // Without consent: the viewer answers 404 report_context_unavailable.
      const noConsent = await post(a, '/api/reports', {
        kind: 'message',
        conversation_id: convId,
        seq: msg.seq,
        reason: 'mean',
      });
      const noConsentId = (noConsent.json() as { id: string }).id;
      const denied = await get(admin, `/api/admin/reports/${noConsentId}/context`);
      expect(denied.statusCode).toBe(404);
      expect((denied.json() as { error: string }).error).toBe('report_context_unavailable');

      // With include_context: the ± radius slice, bodies included.
      const consented = await post(a, '/api/reports', {
        kind: 'message',
        conversation_id: convId,
        seq: msg.seq,
        reason: 'mean',
        include_context: true,
      });
      const consentedId = (consented.json() as { id: string }).id;
      const ctx = await get(admin, `/api/admin/reports/${consentedId}/context`);
      expect(ctx.statusCode).toBe(200);
      const body = ctx.json() as {
        context: { messages: { seq: number; body: string | null; reported: boolean }[] };
      };
      const reported = body.context.messages.find((m) => m.reported)!;
      expect(reported.body).toBe('the reported words');
    });
  });
});
