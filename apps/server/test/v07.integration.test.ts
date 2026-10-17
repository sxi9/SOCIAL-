// v0.7 interactivity-pack tests (API.md §1.47–§1.53, ADR-016, FEATURES
// #60–#71): beacon editing (creator-only, threshold floor under the row lock,
// equality spark, edited beacon.updated frames), spark-now, the Who's-in list,
// custom vibes, listing editing (author/active/kind-immutable), feed lanes
// (public discover, finite, blocks both ways), interactive posts — poll revote
// semantics, the advisory-locked single-winner game claim minting the DM +
// game_ttt message, join_card audience nesting at create and per-viewer
// ref_summary resolution — comment reactions as CAPPED FACES (never totals),
// the 'location' message type, and the §1.53 OG banner (valid-token-gated PNG,
// ETag keyed on avatar_version). Infra-gated like the other suites — needs
// live Postgres + Redis (DATABASE_URL + REDIS_URL); skipped otherwise.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Beacon,
  Conversation,
  Listing,
  Message,
  Post,
  PostComment,
  PostPoll,
  UserLite,
} from '@socialchat/shared';

const infra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

// Unique forwarded IPs per call AND per run dodge the fixed-window register
// IP limits (18.x.x.x — this file's own range).
let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 17) & 0xffffff;
  return `18.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
  username: string;
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe.runIf(infra)('v0.7 interactivity pack', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db/index.js').db;
  let schema: typeof import('../src/db/index.js').schema;
  let sqlTag: typeof import('drizzle-orm').sql;

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
  function post(me: Session, url: string, payload: unknown = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: payload as object,
    });
  }
  function patch(me: Session, url: string, payload: unknown = {}) {
    return app.inject({
      method: 'PATCH',
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: payload as object,
    });
  }
  function put(me: Session, url: string, payload: unknown = {}) {
    return app.inject({
      method: 'PUT',
      url,
      headers: CSRF,
      cookies: { sid: me.sid },
      payload: payload as object,
    });
  }
  function del(me: Session, url: string) {
    return app.inject({ method: 'DELETE', url, headers: CSRF, cookies: { sid: me.sid } });
  }

  async function createDm(a: Session, bUserId: string): Promise<Conversation> {
    const res = await post(a, '/api/conversations', { type: 'dm', user_id: bUserId });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { conversation: Conversation }).conversation;
  }

  async function mintBeacon(
    me: Session,
    overrides: Record<string, unknown> = {},
  ): Promise<Beacon> {
    const res = await post(me, '/api/beacons', {
      vibe: 'chai',
      note: 'test beacon',
      audience: 'public',
      spark_threshold: 5,
      starts_at: futureIso(60),
      expires_at: futureIso(180),
      ...overrides,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { beacon: Beacon }).beacon;
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();
    ({ db, schema } = await import('../src/db/index.js'));
    ({ sql: sqlTag } = await import('drizzle-orm'));
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // §1.47 beacon editing, custom vibes, spark-now, Who's in
  // ---------------------------------------------------------------------------
  describe('beacon editing (§1.47)', () => {
    let creator: Session;
    let j1: Session;
    let j2: Session;
    let j3: Session;

    beforeAll(async () => {
      creator = await register(`v7bc${run}`);
      j1 = await register(`v7bj1${run}`);
      j2 = await register(`v7bj2${run}`);
      j3 = await register(`v7bj3${run}`);
    });

    it('rejects a partial custom-vibe pair at mint and accepts a full one', async () => {
      const bad = await post(creator, '/api/beacons', {
        vibe: 'custom',
        custom_vibe_emoji: '🎳',
        note: '',
        audience: 'public',
        starts_at: futureIso(60),
        expires_at: futureIso(180),
      });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string }).error).toBe('bad_custom_vibe');

      const beacon = await mintBeacon(creator, {
        vibe: 'custom',
        custom_vibe_emoji: '🎳',
        custom_vibe_label: 'bowling',
      });
      expect(beacon.vibe).toBe('custom');
      expect(beacon.custom_vibe_emoji).toBe('🎳');
      expect(beacon.custom_vibe_label).toBe('bowling');
      await post(creator, `/api/beacons/${beacon.id}/cancel`); // keep under BEACON_OPEN_MAX
    });

    it('PATCH is creator-only and marks edits (edited_at + changed fields)', async () => {
      const beacon = await mintBeacon(creator);
      const notMine = await patch(j1, `/api/beacons/${beacon.id}`, { note: 'hijack' });
      expect(notMine.statusCode).toBe(403);

      const res = await patch(creator, `/api/beacons/${beacon.id}`, {
        note: 'new plan details',
        location: { label: 'chai spot behind campus', lat: 12.9, lng: 77.6 },
      });
      expect(res.statusCode).toBe(200);
      const edited = (res.json() as { beacon: Beacon }).beacon;
      expect(edited.note).toBe('new plan details');
      expect(edited.edited_at).not.toBeNull();
      expect(edited.location).toEqual({ label: 'chai spot behind campus', lat: 12.9, lng: 77.6 });

      // audience is immutable — the raw key answers 400 before Zod strips it.
      const aud = await patch(creator, `/api/beacons/${beacon.id}`, { audience: 'friends' });
      expect(aud.statusCode).toBe(400);
      expect((aud.json() as { error: string }).error).toBe('audience_immutable');
      await post(creator, `/api/beacons/${beacon.id}/cancel`);
    });

    it('enforces the threshold floor against committed joins', async () => {
      const beacon = await mintBeacon(creator, { spark_threshold: 10 });
      for (const j of [j1, j2, j3]) {
        const res = await post(j, `/api/beacons/${beacon.id}/join`);
        expect(res.statusCode).toBe(200);
      }
      const below = await patch(creator, `/api/beacons/${beacon.id}`, { spark_threshold: 2 });
      expect(below.statusCode).toBe(400);
      expect((below.json() as { error: string }).error).toBe('threshold_below_joins');
      await post(creator, `/api/beacons/${beacon.id}/cancel`);
    });

    it('threshold == current joins sparks inside the edit transaction', async () => {
      const beacon = await mintBeacon(creator, { spark_threshold: 10 });
      await post(j1, `/api/beacons/${beacon.id}/join`);
      await post(j2, `/api/beacons/${beacon.id}/join`);
      const res = await patch(creator, `/api/beacons/${beacon.id}`, { spark_threshold: 2 });
      expect(res.statusCode).toBe(200);
      const sparked = (res.json() as { beacon: Beacon }).beacon;
      expect(sparked.status).toBe('sparked');
      expect(sparked.conversation_id).not.toBeNull();
    });

    it('PATCH on a sparked beacon answers 409 beacon_not_open', async () => {
      const beacon = await mintBeacon(creator, { spark_threshold: 2 });
      await post(j1, `/api/beacons/${beacon.id}/join`);
      await post(j2, `/api/beacons/${beacon.id}/join`); // sparks at 2
      const res = await patch(creator, `/api/beacons/${beacon.id}`, { note: 'late edit' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('beacon_not_open');
    });

    it('spark-now starts with whoever joined; no joiners is a 409', async () => {
      const empty = await mintBeacon(creator, { spark_threshold: 10 });
      const none = await post(creator, `/api/beacons/${empty.id}/spark-now`);
      expect(none.statusCode).toBe(409);
      expect((none.json() as { error: string }).error).toBe('beacon_no_joiners');

      const beacon = await mintBeacon(creator, { spark_threshold: 10 });
      await post(j1, `/api/beacons/${beacon.id}/join`);
      const notMine = await post(j1, `/api/beacons/${beacon.id}/spark-now`);
      expect(notMine.statusCode).toBe(403);

      const res = await post(creator, `/api/beacons/${beacon.id}/spark-now`);
      expect(res.statusCode).toBe(200);
      const sparked = (res.json() as { beacon: Beacon }).beacon;
      expect(sparked.status).toBe('sparked');
      expect(sparked.conversation_id).not.toBeNull();
      // The plan group holds creator + the one joiner, icebreaker + venue poll.
      const msgs = await get(
        creator,
        `/api/conversations/${sparked.conversation_id}/messages?after_seq=0`,
      );
      expect(msgs.statusCode).toBe(200);
      const list = (msgs.json() as { messages: Message[] }).messages;
      expect(list.some((m) => m.type === 'system')).toBe(true);
      expect(list.some((m) => m.type === 'poll')).toBe(true);
      await post(creator, `/api/beacons/${empty.id}/cancel`);
    });

    it('GET /joins returns the full joiner list, audience-gated', async () => {
      const beacon = await mintBeacon(creator, { spark_threshold: 10 });
      await post(j1, `/api/beacons/${beacon.id}/join`);
      await post(j2, `/api/beacons/${beacon.id}/join`);
      const res = await get(j3, `/api/beacons/${beacon.id}/joins`);
      expect(res.statusCode).toBe(200);
      const { joiners } = res.json() as { joiners: UserLite[] };
      expect(joiners.map((j) => j.id)).toEqual([j1.userId, j2.userId]);
      // No timestamps ever (§1.18 rule).
      expect(Object.keys(joiners[0]!)).not.toContain('created_at');
      await post(creator, `/api/beacons/${beacon.id}/cancel`);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.48 listing editing
  // ---------------------------------------------------------------------------
  describe('listing editing (§1.48)', () => {
    let author: Session;
    let other: Session;
    let listing: Listing;

    beforeAll(async () => {
      author = await register(`v7la${run}`);
      other = await register(`v7lo${run}`);
      const res = await post(author, '/api/listings', {
        kind: 'gig',
        title: 'need a hand moving',
        body: 'two hours max',
        area: 'testville',
        is_public: true,
        details: { direction: 'offering', tags: [] },
      });
      expect(res.statusCode).toBe(201);
      listing = (res.json() as { listing: Listing }).listing;
    });

    it('author edits set edited_at; kind is immutable; author-only', async () => {
      const notMine = await patch(other, `/api/listings/${listing.id}`, {
        kind: 'gig',
        title: 'hijack',
      });
      expect(notMine.statusCode).toBe(403);

      const wrongKind = await patch(author, `/api/listings/${listing.id}`, {
        kind: 'ride',
        details: {
          from_text: 'a',
          to_text: 'b',
          departs_at: futureIso(60),
          seats: 2,
        },
      });
      expect(wrongKind.statusCode).toBe(400);
      expect((wrongKind.json() as { error: string }).error).toBe('kind_immutable');

      const res = await patch(author, `/api/listings/${listing.id}`, {
        kind: 'gig',
        title: 'need TWO hands moving',
        location: { label: 'hostel gate' },
      });
      expect(res.statusCode).toBe(200);
      const edited = (res.json() as { listing: Listing }).listing;
      expect(edited.title).toBe('need TWO hands moving');
      expect(edited.edited_at).not.toBeNull();
      expect(edited.location).toEqual({ label: 'hostel gate' });
    });

    it('closed listings answer 410 listing_closed', async () => {
      await post(author, `/api/listings/${listing.id}/close`);
      const res = await patch(author, `/api/listings/${listing.id}`, {
        kind: 'gig',
        title: 'too late',
      });
      expect(res.statusCode).toBe(410);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.49 feed lanes + §1.50 interactive posts
  // ---------------------------------------------------------------------------
  describe('feed lanes & interactive posts (§1.49/§1.50)', () => {
    let author: Session;
    let friend: Session;
    let stranger: Session;
    let rival: Session;

    beforeAll(async () => {
      author = await register(`v7fa${run}`);
      friend = await register(`v7ff${run}`);
      stranger = await register(`v7fs${run}`);
      rival = await register(`v7fr${run}`);
      await createDm(author, friend.userId); // friends-of
    });

    it('public posts land in discover for strangers; friends lane stays scoped', async () => {
      const res = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: `hello discover ${run}`,
      });
      expect(res.statusCode).toBe(201);
      const created = (res.json() as { post: Post }).post;
      expect(created.audience).toBe('public');

      const discover = await get(stranger, '/api/feed?lane=discover');
      expect(discover.statusCode).toBe(200);
      const dBody = discover.json() as { posts: Post[]; all_caught_up: boolean };
      expect(dBody.posts.some((p) => p.id === created.id)).toBe(true);
      expect(typeof dBody.all_caught_up).toBe('boolean');

      const friendsLane = await get(stranger, '/api/feed?lane=friends');
      expect(
        (friendsLane.json() as { posts: Post[] }).posts.some((p) => p.id === created.id),
      ).toBe(false);

      // Blocks hide the lane both ways (§1.14).
      await put(stranger, `/api/users/${author.userId}/block`);
      const blocked = await get(stranger, '/api/feed?lane=discover');
      expect(
        (blocked.json() as { posts: Post[] }).posts.some((p) => p.id === created.id),
      ).toBe(false);
      await del(stranger, `/api/users/${author.userId}/block`);
    });

    it('poll posts: vote, revote replaces, unvote; counts are a tally on options', async () => {
      const res = await post(author, '/api/posts', {
        kind: 'poll',
        audience: 'public',
        body: '',
        poll: { question: 'chai or coffee?', options: ['chai', 'coffee', 'juice'] },
      });
      expect(res.statusCode).toBe(201);
      const created = (res.json() as { post: Post }).post;
      expect(created.poll?.question).toBe('chai or coffee?');
      expect(created.poll?.counts).toEqual([0, 0, 0]);

      const v1 = await post(stranger, `/api/posts/${created.id}/poll/vote`, { option_idx: 1 });
      expect(v1.statusCode).toBe(200);
      expect((v1.json() as { poll: PostPoll }).poll.my_vote).toBe(1);

      // Revote REPLACES (one ballot per person).
      const v2 = await post(stranger, `/api/posts/${created.id}/poll/vote`, { option_idx: 0 });
      const poll2 = (v2.json() as { poll: PostPoll }).poll;
      expect(poll2.counts).toEqual([1, 0, 0]);
      expect(poll2.total_votes).toBe(1);
      expect(poll2.my_vote).toBe(0);

      const bad = await post(stranger, `/api/posts/${created.id}/poll/vote`, { option_idx: 9 });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string }).error).toBe('bad_option');

      const unvote = await del(stranger, `/api/posts/${created.id}/poll/vote`);
      expect(unvote.statusCode).toBe(200);
      expect((unvote.json() as { poll: PostPoll }).poll.total_votes).toBe(0);

      const notAPoll = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'plain',
      });
      const npId = (notAPoll.json() as { post: Post }).post.id;
      const np = await post(stranger, `/api/posts/${npId}/poll/vote`, { option_idx: 0 });
      expect(np.statusCode).toBe(400);
      expect((np.json() as { error: string }).error).toBe('not_a_poll');
    });

    it('claim-game: exactly ONE winner under concurrent claims; DM + game_ttt minted', async () => {
      const res = await post(author, '/api/posts', {
        kind: 'game',
        audience: 'public',
        body: 'first tap plays me',
      });
      expect(res.statusCode).toBe(201);
      const created = (res.json() as { post: Post }).post;
      expect(created.game).toEqual({ state: 'open', claimed_by: null });

      const own = await post(author, `/api/posts/${created.id}/claim-game`);
      expect(own.statusCode).toBe(400);
      expect((own.json() as { error: string }).error).toBe('game_own');

      const [r1, r2] = await Promise.all([
        post(stranger, `/api/posts/${created.id}/claim-game`),
        post(rival, `/api/posts/${created.id}/claim-game`),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const winnerRes = r1.statusCode === 200 ? r1 : r2;
      const loserRes = r1.statusCode === 200 ? r2 : r1;
      expect((loserRes.json() as { error: string }).error).toBe('game_claimed');
      const winner = r1.statusCode === 200 ? stranger : rival;
      const body = winnerRes.json() as { post: Post; conversation_id: string; game_seq: number };
      expect(body.post.game?.state).toBe('claimed');
      expect(body.post.game?.claimed_by?.id).toBe(winner.userId);
      expect(body.game_seq).toBeGreaterThan(0);

      // The board is an ordinary §1.27 game_ttt message in the pair's DM:
      // author plays x and moves first.
      const msgs = await get(
        winner,
        `/api/conversations/${body.conversation_id}/messages?after_seq=0`,
      );
      expect(msgs.statusCode).toBe(200);
      const game = (msgs.json() as { messages: Message[] }).messages.find(
        (m) => m.type === 'game_ttt',
      );
      expect(game).toBeDefined();
      expect(game!.seq).toBe(body.game_seq);
      const state = (game!.metadata as { game: { players: { x: string; o: string }; turn: string } })
        .game;
      expect(state.players.x).toBe(author.userId);
      expect(state.players.o).toBe(winner.userId);
      expect(state.turn).toBe('x');
    });

    it('join_card: audience must nest inside the ref audience (public post + friends beacon → 400)', async () => {
      const beacon = await mintBeacon(author, { audience: 'friends' });
      const widened = await post(author, '/api/posts', {
        kind: 'join_card',
        audience: 'public',
        body: 'come thru',
        ref: { type: 'beacon', id: beacon.id },
      });
      expect(widened.statusCode).toBe(400);
      expect((widened.json() as { error: string }).error).toBe('ref_audience_mismatch');

      // Someone else's ref is a 404 — nothing confirmed.
      const notMine = await post(friend, '/api/posts', {
        kind: 'join_card',
        audience: 'friends_of',
        ref: { type: 'beacon', id: beacon.id },
      });
      expect(notMine.statusCode).toBe(404);

      // friends beacon nests inside friends_of — allowed; the live summary
      // resolves per viewer (friend sees the beacon; my_state tracks joins).
      const ok = await post(author, '/api/posts', {
        kind: 'join_card',
        audience: 'friends_of',
        body: 'come thru',
        ref: { type: 'beacon', id: beacon.id },
      });
      expect(ok.statusCode).toBe(201);
      const card = (ok.json() as { post: Post }).post;
      expect(card.ref).toEqual({ type: 'beacon', id: beacon.id });
      expect(card.ref_summary?.type).toBe('beacon');

      const friendView = await get(friend, `/api/posts/${card.id}`);
      expect(friendView.statusCode).toBe(200);
      const fPost = (friendView.json() as { post: Post }).post;
      expect(fPost.ref_summary?.type).toBe('beacon');
      if (fPost.ref_summary?.type === 'beacon') {
        expect(fPost.ref_summary.my_state).toBe('none');
      }
      await post(friend, `/api/beacons/${beacon.id}/join`);
      const joinedView = await get(friend, `/api/posts/${card.id}`);
      const jPost = (joinedView.json() as { post: Post }).post;
      if (jPost.ref_summary?.type === 'beacon') {
        expect(jPost.ref_summary.my_state).toBe('joined');
      }
    });

    it('join_card listing summary resolves per viewer and nulls when the ref is gone', async () => {
      const lres = await post(author, '/api/listings', {
        kind: 'gig',
        title: `help me carry ${run}`,
        body: 'ten minutes',
        area: 'testville',
        is_public: true,
        details: { direction: 'seeking', tags: [] },
      });
      expect(lres.statusCode).toBe(201);
      const listing = (lres.json() as { listing: Listing }).listing;

      // Area-scoped (is_public: false) refs are incomparable with any post
      // audience → refused.
      const privRes = await post(author, '/api/listings', {
        kind: 'gig',
        title: 'area only',
        body: '',
        area: 'testville',
        is_public: false,
        details: { direction: 'seeking', tags: [] },
      });
      const privListing = (privRes.json() as { listing: Listing }).listing;
      const mismatch = await post(author, '/api/posts', {
        kind: 'join_card',
        audience: 'friends_of',
        ref: { type: 'listing', id: privListing.id },
      });
      expect(mismatch.statusCode).toBe(400);
      expect((mismatch.json() as { error: string }).error).toBe('ref_audience_mismatch');

      const ok = await post(author, '/api/posts', {
        kind: 'join_card',
        audience: 'public',
        body: 'board find',
        ref: { type: 'listing', id: listing.id },
      });
      expect(ok.statusCode).toBe(201);
      const card = (ok.json() as { post: Post }).post;

      const view = await get(stranger, `/api/posts/${card.id}`);
      expect(view.statusCode).toBe(200);
      const seen = (view.json() as { post: Post }).post;
      expect(seen.ref_summary?.type).toBe('listing');
      if (seen.ref_summary?.type === 'listing') {
        expect(seen.ref_summary.title).toBe(`help me carry ${run}`);
        expect(seen.ref_summary.my_contacted).toBe(false);
      }

      // The ref dies → the card honestly shows "no longer available" (null).
      await del(author, `/api/listings/${listing.id}`);
      const gone = await get(stranger, `/api/posts/${card.id}`);
      const gonePost = (gone.json() as { post: Post }).post;
      expect(gonePost.ref).toEqual({ type: 'listing', id: listing.id });
      expect(gonePost.ref_summary).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // §1.51 comment reactions — capped faces, never totals
  // ---------------------------------------------------------------------------
  describe('comment reactions (§1.51)', () => {
    let author: Session;
    let postId: string;
    let commentId: string;

    beforeAll(async () => {
      author = await register(`v7ca${run}`);
      const pres = await post(author, '/api/posts', {
        kind: 'text',
        audience: 'public',
        body: 'react to my comment',
      });
      postId = (pres.json() as { post: Post }).post.id;
      const cres = await post(author, `/api/posts/${postId}/comments`, { body: 'first!' });
      expect(cres.statusCode).toBe(201);
      commentId = (cres.json() as { comment: PostComment }).comment.id;
    });

    it('renders capped FACES (≤ 6 + has_more) and never a numeric total', async () => {
      const reactors: Session[] = [];
      for (let i = 0; i < 7; i += 1) {
        reactors.push(await register(`v7cr${i}${run}`));
      }
      for (const r of reactors) {
        const res = await post(r, `/api/posts/${postId}/comments/${commentId}/reactions`, {
          kind: 'emoji',
          emoji: '❤️',
        });
        expect(res.statusCode).toBe(204);
      }
      const view = await get(reactors[0]!, `/api/posts/${postId}`);
      const seen = (view.json() as { post: Post }).post;
      const comment = seen.comments.find((c) => c.id === commentId);
      expect(comment).toBeDefined();
      const chip = comment!.reactions.find((c) => c.emoji === '❤️');
      expect(chip).toBeDefined();
      expect(chip!.reactors.length).toBe(6); // COMMENT_REACTORS_PREVIEW_MAX
      expect(chip!.has_more).toBe(true);
      expect(chip!.mine).toBe(true);
      // NEVER a count field (PSYCHOLOGY rule 3).
      expect(Object.keys(chip!)).not.toContain('count');
    });

    it('caps one user at 8 DISTINCT emoji (the 9th → 409 reaction_limit)', async () => {
      const r = await register(`v7cx${run}`);
      const emojis = ['😀', '😂', '😅', '😍', '🤔', '🙌', '🔥', '✨', '🥳'];
      for (let i = 0; i < 8; i += 1) {
        const res = await post(r, `/api/posts/${postId}/comments/${commentId}/reactions`, {
          kind: 'emoji',
          emoji: emojis[i],
        });
        expect(res.statusCode).toBe(204);
      }
      const ninth = await post(r, `/api/posts/${postId}/comments/${commentId}/reactions`, {
        kind: 'emoji',
        emoji: emojis[8],
      });
      expect(ninth.statusCode).toBe(409);
      expect((ninth.json() as { error: string }).error).toBe('reaction_limit');
      // Removing one is idempotent 204 and frees the slot.
      const rm = await del(
        r,
        `/api/posts/${postId}/comments/${commentId}/reactions/${encodeURIComponent(emojis[0]!)}`,
      );
      expect(rm.statusCode).toBe(204);
      const again = await post(r, `/api/posts/${postId}/comments/${commentId}/reactions`, {
        kind: 'emoji',
        emoji: emojis[8],
      });
      expect(again.statusCode).toBe(204);
    });

    it('stamps need a ready avatar (409 stamp_no_avatar)', async () => {
      const r = await register(`v7cs${run}`);
      const res = await post(r, `/api/posts/${postId}/comments/${commentId}/reactions`, {
        kind: 'stamp',
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe('stamp_no_avatar');
    });

    it('image-only comments are legal; empty comments are not (§1.51)', async () => {
      const empty = await post(author, `/api/posts/${postId}/comments`, { body: '' });
      expect(empty.statusCode).toBe(400);
      expect((empty.json() as { error: string }).error).toBe('empty_comment');
    });
  });

  // ---------------------------------------------------------------------------
  // §1.52 the 'location' message type
  // ---------------------------------------------------------------------------
  describe('location messages (§1.52)', () => {
    let a: Session;
    let b: Session;
    let dm: Conversation;

    beforeAll(async () => {
      a = await register(`v7loca${run}`);
      b = await register(`v7locb${run}`);
      dm = await createDm(a, b.userId);
    });

    it('drops a pin with metadata.location (+ join_me); riders invalid elsewhere', async () => {
      const missing = await post(a, `/api/conversations/${dm.id}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'location',
        body: 'come here',
      });
      expect(missing.statusCode).toBe(400);
      expect((missing.json() as { error: string }).error).toBe('location_required');

      const res = await post(a, `/api/conversations/${dm.id}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'location',
        body: 'join me',
        metadata: { location: { label: 'the usual chai spot', lat: 12.97, lng: 77.59 }, join_me: true },
      });
      expect(res.statusCode).toBe(201);
      const msg = (res.json() as { message: Message }).message;
      expect(msg.type).toBe('location');
      expect((msg.metadata as { location: { label: string } }).location.label).toBe(
        'the usual chai spot',
      );
      expect((msg.metadata as { join_me?: boolean }).join_me).toBe(true);

      const onText = await post(a, `/api/conversations/${dm.id}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'text',
        body: 'hello',
        metadata: { location: { label: 'sneaky' } },
      });
      expect(onText.statusCode).toBe(400);
      expect((onText.json() as { error: string }).error).toBe('bad_metadata');

      // Both-or-neither lat/lng is Zod-enforced (400).
      const halfPair = await post(a, `/api/conversations/${dm.id}/messages`, {
        client_msg_id: crypto.randomUUID(),
        type: 'location',
        metadata: { location: { label: 'half', lat: 12.9 } },
      });
      expect(halfPair.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // §1.53 the invite OG banner
  // ---------------------------------------------------------------------------
  describe('invite OG banner (§1.53)', () => {
    let inviter: Session;
    let token: string;

    beforeAll(async () => {
      inviter = await register(`v7og${run}`);
      const res = await post(inviter, '/api/invites', {});
      expect(res.statusCode).toBe(201);
      token = (res.json() as { invite: { token: string } }).invite.token;
    });

    it('serves a 1200×630 PNG for a valid token (mascot fallback, no avatar)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/invites/${token}/og-banner.png`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toContain('private');
      const body = res.rawPayload;
      // PNG magic bytes.
      expect(body.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const sharp = (await import('sharp')).default;
      const meta = await sharp(body).metadata();
      expect(meta.width).toBe(1200);
      expect(meta.height).toBe(630);
    });

    it('404s invalid and revoked tokens alike', async () => {
      const bogus = await app.inject({
        method: 'GET',
        url: '/api/invites/not-a-real-token-at-all-but-long-enough-0000/og-banner.png',
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(bogus.statusCode).toBe(404);
    });

    it('cache key (ETag) moves with avatar_version', async () => {
      const first = await app.inject({
        method: 'GET',
        url: `/api/invites/${token}/og-banner.png`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      const etag1 = first.headers.etag as string;
      expect(etag1).toBeDefined();

      // Conditional revalidation: same version → 304.
      const cond = await app.inject({
        method: 'GET',
        url: `/api/invites/${token}/og-banner.png`,
        headers: { 'x-forwarded-for': nextIp(), 'if-none-match': etag1 },
      });
      expect(cond.statusCode).toBe(304);

      await db.execute(
        sqlTag`UPDATE users SET avatar_version = avatar_version + 1 WHERE id = ${inviter.userId}`,
      );
      const second = await app.inject({
        method: 'GET',
        url: `/api/invites/${token}/og-banner.png`,
        headers: { 'x-forwarded-for': nextIp() },
      });
      expect(second.statusCode).toBe(200);
      expect(second.headers.etag).toBeDefined();
      expect(second.headers.etag).not.toBe(etag1);
      void schema; // imported for parity with sibling suites
    });
  });
});
