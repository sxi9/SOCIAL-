// v0.5b local-board + admin tests (API.md §1.38–§1.41, ADR-012/ADR-013):
// listing visibility matrix (same-area / public / blocked, board and direct
// GET alike); the contact→review gate (no contact DM → 403, self-review →
// 400, duplicate → 409) + profile trust; gig team-up claim; admin guard
// 404-shaped for non-admins; suspend = sessions revoked + login 403;
// invites_enabled=false blocks mint AND accept; the nightly IP-retention GC
// nulls only aged rows. Infra-gated like the other suites — needs live
// Postgres + Redis (DATABASE_URL + REDIS_URL); skipped otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdminReport,
  AdminUserRow,
  Conversation,
  InvitePrivate,
  Listing,
  Message,
  PersonReview,
  Trust,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (16.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 11) & 0xffffff;
  return `16.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

describe.runIf(infra)('v0.5b local board + admin', () => {
  let app: FastifyInstance;
  // Loaded dynamically so the suite stays importable without infra.
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;

  const AREA_A = `testville-${run}`;
  const AREA_B = `elsewhere-${run}`;

  let author: Session; // area A
  let neighbor: Session; // area A — sees A's private cards
  let bystander: Session; // area A — never contacts (the gate's 403 case)
  let faraway: Session; // area B
  let blocked: Session; // area A, blocked by author
  let admin: Session;
  let target: Session; // suspend/ban target

  async function register(username: string, inviteToken?: string): Promise<Session> {
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
    const body = res.json() as { user: { id: string } };
    return { sid: sid!, userId: body.user.id, username };
  }

  async function setArea(me: Session, area: string): Promise<void> {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: { area },
    });
    expect(res.statusCode).toBe(200);
  }

  async function createListing(
    me: Session,
    payload: Record<string, unknown>,
  ): Promise<Listing> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { listing: Listing }).listing;
  }

  function get(me: Session, url: string) {
    return app.inject({ method: 'GET', url, cookies: { sid: me.sid } });
  }

  function post(me: Session, url: string, payload: unknown = {}) {
    return app.inject({ method: 'POST', url, headers: CSRF, cookies: { sid: me.sid }, payload: payload as object });
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    ({ db, schema } = await import('../src/db/index.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));

    author = await register(`vb_author_${run}`);
    neighbor = await register(`vb_neigh_${run}`);
    bystander = await register(`vb_bystd_${run}`);
    faraway = await register(`vb_far_${run}`);
    blocked = await register(`vb_blkd_${run}`);
    admin = await register(`vb_admin_${run}`);
    target = await register(`vb_target_${run}`);

    await setArea(author, AREA_A);
    await setArea(neighbor, AREA_A);
    await setArea(bystander, AREA_A);
    await setArea(faraway, AREA_B);
    await setArea(blocked, AREA_A);

    // author blocks `blocked` (PUT §1.14) — invisibility both ways.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${blocked.userId}/block`,
      headers: CSRF,
      cookies: { sid: author.sid },
    });
    expect(res.statusCode).toBe(204);

    // Adminhood is CLI-only — the test flips the flag the way the CLI does.
    await db
      .update(schema.users)
      .set({ isAdmin: true })
      .where(sqlTag`${schema.users.id} = ${admin.userId}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------
  // §1.38 visibility matrix
  // ---------------------------------------------------------------------
  describe('listing visibility matrix', () => {
    let privateListing: Listing;
    let publicListing: Listing;

    it('creates a private (same-area) and a public card', async () => {
      privateListing = await createListing(author, {
        kind: 'gig',
        title: `band practice ${run}`,
        body: 'need a drummer',
        details: { direction: 'seeking', tags: ['music'] },
      });
      expect(privateListing.area).toBe(AREA_A);
      expect(privateListing.is_public).toBe(false);
      expect(privateListing.expires_at).not.toBeNull();

      publicListing = await createListing(author, {
        kind: 'ride',
        title: `airport run ${run}`,
        is_public: true,
        price_text: 'split petrol',
        details: {
          from_text: 'testville',
          to_text: 'airport',
          departs_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
          seats: 3,
        },
      });
      expect(publicListing.is_public).toBe(true);
      // Ride expiry IS departs_at, denormalized at write time.
      expect(publicListing.expires_at).toBe(publicListing.details && (publicListing.details as { departs_at: string }).departs_at);
    });

    it('a past departs_at is refused', async () => {
      const res = await post(author, '/api/listings', {
        kind: 'ride',
        title: 'time machine',
        details: {
          from_text: 'a',
          to_text: 'b',
          departs_at: new Date(Date.now() - 3600_000).toISOString(),
          seats: 1,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('departs_at_past');
    });

    it('same-area viewer sees the private card on the board and by id', async () => {
      const board = await get(neighbor, '/api/listings');
      expect(board.statusCode).toBe(200);
      const ids = (board.json() as { listings: Listing[] }).listings.map((l) => l.id);
      expect(ids).toContain(privateListing.id);

      const one = await get(neighbor, `/api/listings/${privateListing.id}`);
      expect(one.statusCode).toBe(200);
    });

    it('a foreign-area viewer never sees the private card — board, filter, or id', async () => {
      const board = await get(faraway, '/api/listings');
      const ids = (board.json() as { listings: Listing[] }).listings.map((l) => l.id);
      expect(ids).not.toContain(privateListing.id);

      // Even filtering INTO the author's area shows only is_public cards.
      const filtered = await get(faraway, `/api/listings?area=${encodeURIComponent(AREA_A)}`);
      const fids = (filtered.json() as { listings: Listing[] }).listings.map((l) => l.id);
      expect(fids).not.toContain(privateListing.id);
      expect(fids).toContain(publicListing.id);

      const one = await get(faraway, `/api/listings/${privateListing.id}`);
      expect(one.statusCode).toBe(404);
      expect(one.json().error).toBe('listing_not_found');

      // The public card IS directly readable cross-area.
      const pub = await get(faraway, `/api/listings/${publicListing.id}`);
      expect(pub.statusCode).toBe(200);
    });

    it('blocked pairs see nothing — not even public cards (404-shaped)', async () => {
      const board = await get(blocked, '/api/listings');
      const ids = (board.json() as { listings: Listing[] }).listings.map((l) => l.id);
      expect(ids).not.toContain(privateListing.id);
      expect(ids).not.toContain(publicListing.id);

      const one = await get(blocked, `/api/listings/${publicListing.id}`);
      expect(one.statusCode).toBe(404);
      expect(one.json().error).toBe('listing_not_found');

      // ...and a blocked contact attempt is the identical 404.
      const contact = await post(blocked, `/api/listings/${publicListing.id}/contact`);
      expect(contact.statusCode).toBe(404);
      expect(contact.json().error).toBe('listing_not_found');
    });

    it('the author cannot contact their own listing', async () => {
      const res = await post(author, `/api/listings/${privateListing.id}/contact`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('listing_own');
    });
  });

  // ---------------------------------------------------------------------
  // §1.39 contact (+ idempotency, listing_ref) and §1.40 review gate
  // ---------------------------------------------------------------------
  describe('contact, team-up and the review gate', () => {
    let gig: Listing;
    let dmId: string;

    it('contact creates the DM + ONE listing_contact system message; re-contact is idempotent', async () => {
      gig = await createListing(author, {
        kind: 'gig',
        title: `mural crew ${run}`,
        details: { direction: 'seeking', tags: [] },
      });
      const first = await post(neighbor, `/api/listings/${gig.id}/contact`);
      expect(first.statusCode).toBe(201);
      dmId = (first.json() as { conversation_id: string }).conversation_id;

      const again = await post(neighbor, `/api/listings/${gig.id}/contact`);
      expect(again.statusCode).toBe(200);
      expect((again.json() as { conversation_id: string }).conversation_id).toBe(dmId);

      const msgs = await get(neighbor, `/api/conversations/${dmId}/messages?after_seq=0`);
      expect(msgs.statusCode).toBe(200);
      const contactMsgs = (msgs.json() as { messages: Message[] }).messages.filter(
        (m) => m.type === 'system' && m.metadata.listing_ref?.listing_id === gig.id,
      );
      expect(contactMsgs).toHaveLength(1); // ONE context message, ever
      expect(contactMsgs[0]!.metadata.listing_ref).toEqual({
        listing_id: gig.id,
        kind: 'gig',
        title: gig.title,
      });
      expect(contactMsgs[0]!.body).toBe(`asked about: ${gig.title}`);
    });

    it('my_contacted flips for the contacter only', async () => {
      const mine = await get(neighbor, `/api/listings/${gig.id}`);
      expect((mine.json() as { listing: Listing }).listing.my_contacted).toBe(true);
      const theirs = await get(bystander, `/api/listings/${gig.id}`);
      expect((theirs.json() as { listing: Listing }).listing.my_contacted).toBe(false);
    });

    it('no contact DM → 403 review_not_eligible', async () => {
      const res = await post(bystander, `/api/listings/${gig.id}/reviews`, { rating: 5 });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('review_not_eligible');
    });

    it('self-review → 400 bad_subject', async () => {
      // A contacter's subject is always the author — naming yourself is a 400.
      const res = await post(neighbor, `/api/listings/${gig.id}/reviews`, {
        subject_id: neighbor.userId,
        rating: 5,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_subject');

      // The author must name a contacter; naming themselves is the same 400.
      const own = await post(author, `/api/listings/${gig.id}/reviews`, {
        subject_id: author.userId,
        rating: 5,
      });
      expect(own.statusCode).toBe(400);
      expect(own.json().error).toBe('bad_subject');
      // ...and omitting the subject as the author is too.
      const omitted = await post(author, `/api/listings/${gig.id}/reviews`, { rating: 5 });
      expect(omitted.statusCode).toBe(400);
      expect(omitted.json().error).toBe('bad_subject');
    });

    it('contacter reviews the author once; the duplicate is 409 review_exists', async () => {
      const res = await post(neighbor, `/api/listings/${gig.id}/reviews`, {
        rating: 5,
        body: 'great to work with',
      });
      expect(res.statusCode).toBe(201);
      const review = (res.json() as { review: PersonReview }).review;
      expect(review.listing_kind).toBe('gig');
      expect(review.reviewer.id).toBe(neighbor.userId);

      const dup = await post(neighbor, `/api/listings/${gig.id}/reviews`, { rating: 1 });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('review_exists');
    });

    it('the author reviews the contacter back (subject_id required)', async () => {
      const res = await post(author, `/api/listings/${gig.id}/reviews`, {
        subject_id: neighbor.userId,
        rating: 4,
      });
      expect(res.statusCode).toBe(201);
    });

    it('profile trust aggregates (count shows; avg hides under 3 reviews)', async () => {
      const res = await get(neighbor, `/api/users/${author.username}`);
      expect(res.statusCode).toBe(200);
      const trust = (res.json() as { trust: Trust }).trust;
      expect(trust.review_count).toBe(1);
      expect(trust.avg_rating).toBeNull(); // TRUST_AVG_MIN_REVIEWS = 3
      expect(trust.recent).toHaveLength(1);
      expect(trust.recent[0]!.rating).toBe(5);

      const list = await get(bystander, `/api/users/${author.username}/reviews`);
      expect(list.statusCode).toBe(200);
      expect((list.json() as { reviews: PersonReview[] }).reviews).toHaveLength(1);
    });

    it('team-up: author-only, gig-only, pool-only, once per listing', async () => {
      // Picks must come from the contact pool.
      const badPick = await post(author, `/api/listings/${gig.id}/team-up`, {
        user_ids: [bystander.userId],
      });
      expect(badPick.statusCode).toBe(400);
      expect(badPick.json().error).toBe('bad_team_pick');

      const contacts = await get(author, `/api/listings/${gig.id}/contacts`);
      expect(contacts.statusCode).toBe(200);
      expect(
        (contacts.json() as { contacts: { id: string }[] }).contacts.map((c) => c.id),
      ).toEqual([neighbor.userId]);

      const res = await post(author, `/api/listings/${gig.id}/team-up`, {
        user_ids: [neighbor.userId],
      });
      expect(res.statusCode).toBe(201);
      const conv = (res.json() as { conversation: Conversation }).conversation;
      expect(conv.type).toBe('group');
      expect(conv.title).toBe(gig.title);
      // Founders see the whole plan — join_seq 0.
      expect(conv.participants.every((p) => p.join_seq === 0)).toBe(true);

      const second = await post(author, `/api/listings/${gig.id}/team-up`, {
        user_ids: [neighbor.userId],
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('team_up_exists');

      // conversation_id serializes to members only.
      const asMember = await get(neighbor, `/api/listings/${gig.id}`);
      expect((asMember.json() as { listing: Listing }).listing.conversation_id).toBe(conv.id);
      const asOutsider = await get(bystander, `/api/listings/${gig.id}`);
      expect((asOutsider.json() as { listing: Listing }).listing.conversation_id).toBeNull();
    });

    it('team-up on a non-gig is 400 not_a_gig', async () => {
      const ride = await createListing(author, {
        kind: 'ride',
        title: `carpool ${run}`,
        details: {
          from_text: 'a',
          to_text: 'b',
          departs_at: new Date(Date.now() + 3600_000).toISOString(),
          seats: 2,
        },
      });
      const res = await post(author, `/api/listings/${ride.id}/team-up`, {
        user_ids: [neighbor.userId],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('not_a_gig');
    });

    it('closed listings retire from the board but stay reviewable; contact answers 410', async () => {
      const closed = await post(author, `/api/listings/${gig.id}/close`);
      expect(closed.statusCode).toBe(200);
      expect((closed.json() as { listing: Listing }).listing.status).toBe('closed');

      const board = await get(neighbor, '/api/listings');
      const ids = (board.json() as { listings: Listing[] }).listings.map((l) => l.id);
      expect(ids).not.toContain(gig.id);

      // The contacter keeps direct-read access (the DM context must stay
      // explicable) ...
      const one = await get(neighbor, `/api/listings/${gig.id}`);
      expect(one.statusCode).toBe(200);
      // ... but a NEW contact is 410 listing_closed.
      const contact = await post(bystander, `/api/listings/${gig.id}/contact`);
      expect(contact.statusCode).toBe(410);
      expect(contact.json().error).toBe('listing_closed');
    });
  });

  // ---------------------------------------------------------------------
  // §1.41 admin
  // ---------------------------------------------------------------------
  describe('admin surface', () => {
    it('the admin surface does not exist for non-admins (404)', async () => {
      for (const url of ['/api/admin/users', '/api/admin/metrics', '/api/admin/settings']) {
        const res = await get(neighbor, url);
        expect(res.statusCode).toBe(404);
      }
      const act = await post(neighbor, `/api/admin/users/${target.userId}/suspend`);
      expect(act.statusCode).toBe(404);
    });

    it('admin user list pages with buckets, storage and flags', async () => {
      const res = await get(admin, '/api/admin/users?limit=100');
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as { users: AdminUserRow[] }).users;
      const me = rows.find((u) => u.id === admin.userId);
      expect(me?.is_admin).toBe(true);
      expect(me?.last_seen_bucket).toBeDefined();
      expect(typeof me?.storage_bytes).toBe('number');
      // registration_ip still young — captured, not yet aged out.
      const t = rows.find((u) => u.id === target.userId);
      expect(t?.registration_ip).toBeTruthy();
    });

    it('suspend revokes sessions (old cookie dies) and login answers 403', async () => {
      // The target has a live session from registration.
      const before = await get(target, '/api/users/me');
      expect(before.statusCode).toBe(200);

      const res = await post(admin, `/api/admin/users/${target.userId}/suspend`, {
        note: 'spam',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { user: AdminUserRow }).user.suspended).toBe(true);

      const after = await get(target, '/api/users/me');
      expect(after.statusCode).toBe(401); // session row deleted

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: { username_or_email: target.username, password: 'password123' },
      });
      expect(login.statusCode).toBe(403);
      expect(login.json().error).toBe('account_suspended');

      // Suspended ≠ banned: the public profile stays visible.
      const profile = await get(neighbor, `/api/users/${target.username}`);
      expect(profile.statusCode).toBe(200);

      // Unsuspend restores login.
      const un = await post(admin, `/api/admin/users/${target.userId}/unsuspend`);
      expect(un.statusCode).toBe(200);
      const relogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: { username_or_email: target.username, password: 'password123' },
      });
      expect(relogin.statusCode).toBe(200);
      target.sid = relogin.cookies.find((c) => c.name === 'sid')!.value;
    });

    it('ban adds public invisibility; unban restores it', async () => {
      const res = await post(admin, `/api/admin/users/${target.userId}/ban`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { user: AdminUserRow }).user.banned).toBe(true);

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: { username_or_email: target.username, password: 'password123' },
      });
      expect(login.statusCode).toBe(403);
      expect(login.json().error).toBe('account_banned');

      const profile = await get(neighbor, `/api/users/${target.username}`);
      expect(profile.statusCode).toBe(404); // hidden at serialization time

      const un = await post(admin, `/api/admin/users/${target.userId}/unban`);
      expect(un.statusCode).toBe(200);
      const restored = await get(neighbor, `/api/users/${target.username}`);
      expect(restored.statusCode).toBe(200); // nothing stored was rewritten
    });

    it('admin mutations never target admins (bad_admin_target)', async () => {
      const res = await post(admin, `/api/admin/users/${admin.userId}/suspend`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_admin_target');
    });

    it('reports queue: metadata-only rows, close-with-note, 409 re-close', async () => {
      const created = await post(neighbor, '/api/reports', {
        kind: 'user',
        user_id: target.userId,
        reason: 'test report',
      });
      expect(created.statusCode).toBe(201);
      const reportId = (created.json() as { id: string }).id;

      const list = await get(admin, '/api/admin/reports?status=open&limit=100');
      expect(list.statusCode).toBe(200);
      const row = (list.json() as { reports: AdminReport[] }).reports.find(
        (r) => r.id === reportId,
      );
      expect(row?.target_user?.id).toBe(target.userId);
      expect(row?.reason).toBe('test report');
      expect(row && 'body' in row).toBe(false); // nothing message-shaped here

      const close = await post(admin, `/api/admin/reports/${reportId}/close`, {
        note: 'handled',
      });
      expect(close.statusCode).toBe(200);
      const closedRow = (close.json() as { report: AdminReport }).report;
      expect(closedRow.status).toBe('closed');
      expect(closedRow.close_note).toBe('handled');
      expect(closedRow.closed_by?.id).toBe(admin.userId);

      const again = await post(admin, `/api/admin/reports/${reportId}/close`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('report_closed');
    });

    it('metrics and the log ring answer', async () => {
      const metrics = await get(admin, '/api/admin/metrics');
      expect(metrics.statusCode).toBe(200);
      const m = (metrics.json() as { metrics: { users_total: number; registrations_per_day: unknown[] } }).metrics;
      expect(m.users_total).toBeGreaterThanOrEqual(7);
      expect(m.registrations_per_day).toHaveLength(30);

      const logs = await get(admin, '/api/admin/logs?limit=50');
      expect(logs.statusCode).toBe(200);
      const entries = (logs.json() as { entries: { level: string; msg: string }[] }).entries;
      // Every admin action above was ring-logged.
      expect(entries.some((e) => e.level === 'admin' && e.msg === 'admin.suspend')).toBe(true);
    });

    it('invites_enabled=false blocks mint AND accept; register degrades', async () => {
      // Pre-mint a valid invite while enabled.
      const minted = await post(neighbor, '/api/invites');
      expect(minted.statusCode).toBe(201);
      const invite = (minted.json() as { invite: InvitePrivate }).invite;

      const off = await app.inject({
        method: 'PATCH',
        url: '/api/admin/settings',
        headers: CSRF,
        cookies: { sid: admin.sid },
        payload: { invites_enabled: false },
      });
      expect(off.statusCode).toBe(200);
      expect((off.json() as { settings: { invites_enabled: boolean } }).settings.invites_enabled).toBe(false);

      const mint = await post(neighbor, '/api/invites');
      expect(mint.statusCode).toBe(403);
      expect(mint.json().error).toBe('invites_disabled');

      const accept = await post(faraway, `/api/invites/${invite.token}/accept`);
      expect(accept.statusCode).toBe(403);
      expect(accept.json().error).toBe('invites_disabled');
      // No use was claimed.
      const [row] = (await db.execute(
        sqlTag`SELECT use_count FROM invites WHERE token = ${invite.token}`,
      )) as unknown as { use_count: number }[];
      expect(Number(row!.use_count)).toBe(0);

      // §1.1: register-with-token NEVER fails — it degrades to invite: null.
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { ...CSRF, 'x-forwarded-for': nextIp() },
        payload: {
          username: `vb_degrade_${run}`,
          email: `vb_degrade_${run}@example.com`,
          password: 'password123',
          display_name: 'degrade',
          invite_token: invite.token,
        },
      });
      expect(reg.statusCode).toBe(201);
      expect((reg.json() as { invite: unknown }).invite).toBeNull();

      // Flip back on: mint + accept work again.
      await app.inject({
        method: 'PATCH',
        url: '/api/admin/settings',
        headers: CSRF,
        cookies: { sid: admin.sid },
        payload: { invites_enabled: true },
      });
      const mint2 = await post(neighbor, '/api/invites');
      expect(mint2.statusCode).toBe(201);
      const accept2 = await post(faraway, `/api/invites/${invite.token}/accept`);
      expect(accept2.statusCode).toBe(200);
    });

    it('the user export strips secrets and carries no message bodies', async () => {
      const res = await get(admin, `/api/admin/users/${neighbor.userId}/export`);
      expect(res.statusCode).toBe(200);
      const exp = (res.json() as { export: Record<string, unknown> }).export;
      expect(exp.user).toBeDefined();
      expect((exp.user as Record<string, unknown>).password_hash).toBeUndefined();
      for (const s of exp.sessions as Record<string, unknown>[]) {
        expect(s.token_hash).toBeUndefined();
      }
      expect(exp.reviews_received).toBeDefined();
      expect(exp.listings).toBeDefined();
      expect('messages' in exp).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // §1.41 IP capture + retention GC
  // ---------------------------------------------------------------------
  describe('IP capture and retention', () => {
    it('register captures the first X-Forwarded-For hop into users.registration_ip', async () => {
      const ip = nextIp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { ...CSRF, 'x-forwarded-for': ip },
        payload: {
          username: `vb_ip_${run}`,
          email: `vb_ip_${run}@example.com`,
          password: 'password123',
          display_name: 'ip test',
        },
      });
      expect(res.statusCode).toBe(201);
      const userId = (res.json() as { user: { id: string } }).user.id;
      const [row] = (await db.execute(
        sqlTag`SELECT host(registration_ip) AS rip FROM users WHERE id = ${userId}`,
      )) as unknown as { rip: string | null }[];
      expect(row!.rip).toBe(ip);
      const [sess] = (await db.execute(
        sqlTag`SELECT host(ip) AS ip FROM sessions WHERE user_id = ${userId}`,
      )) as unknown as { ip: string | null }[];
      expect(sess!.ip).toBe(ip);
    });

    it('the retention sweep nulls ONLY rows older than IP_RETENTION_DAYS', async () => {
      const { runIpRetention } = await import('../src/jobs/gc.js');
      const oldIso = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();

      // Backdate the author's user row + sessions; leave neighbor fresh.
      await db.execute(
        sqlTag`UPDATE users SET created_at = ${oldIso}::timestamptz WHERE id = ${author.userId}`,
      );
      await db.execute(
        sqlTag`UPDATE sessions SET created_at = ${oldIso}::timestamptz WHERE user_id = ${author.userId}`,
      );

      await runIpRetention();

      const [oldUser] = (await db.execute(
        sqlTag`SELECT registration_ip::text AS rip FROM users WHERE id = ${author.userId}`,
      )) as unknown as { rip: string | null }[];
      expect(oldUser!.rip).toBeNull();
      const oldSessions = (await db.execute(
        sqlTag`SELECT ip FROM sessions WHERE user_id = ${author.userId} AND ip IS NOT NULL`,
      )) as unknown as { ip: string }[];
      expect(oldSessions).toHaveLength(0);

      // Fresh rows keep theirs.
      const [freshUser] = (await db.execute(
        sqlTag`SELECT registration_ip::text AS rip FROM users WHERE id = ${neighbor.userId}`,
      )) as unknown as { rip: string | null }[];
      expect(freshUser!.rip).not.toBeNull();
      const freshSessions = (await db.execute(
        sqlTag`SELECT ip FROM sessions WHERE user_id = ${neighbor.userId} AND ip IS NOT NULL`,
      )) as unknown as { ip: string }[];
      expect(freshSessions.length).toBeGreaterThan(0);
    });
  });
});
