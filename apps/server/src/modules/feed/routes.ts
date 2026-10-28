// Feed routes (v0.5a — API.md §1.36; v0.7 — §1.49/§1.50/§1.51, ADR-016). The
// finite feed: keyset pagination to a HARD all_caught_up end in BOTH lanes
// (friends = my friends-of set + me, every audience; discover = audience
// 'public' instance-wide minus blocks/bans — no ranking, no recommendations,
// no wraparound); reactions and comments fan out NO live frames (viewers
// reconcile from GET when THEY return — no approval pings, PSYCHOLOGY rules
// 3/4); post.new keeps the friends-of recipient set for public posts too (the
// discover lane is pull-only) and never pushes.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddCommentReactionRequestSchema,
  AddPostReactionRequestSchema,
  CreateCommentRequestSchema,
  CreatePostRequestSchema,
  FeedQuerySchema,
  ListCommentsQuerySchema,
  POST_CREATE_RATE_PER_HOUR,
  COMMENT_RATE_PER_HOUR,
  REACTION_RATE_PER_MINUTE,
  PostPollVoteRequestSchema,
  REACTIONS_PER_USER_PER_COMMENT_MAX,
  REACTIONS_PER_USER_PER_POST_MAX,
  ReactionEmojiSchema,
  STAMP_REACTION_KEY,
  TTT_BOARD_CELLS,
  type GameTttState,
  type PostRef,
  type ReactionKind,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { recordActivity } from '../../lib/activity.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { friendsOfIds } from '../../lib/friends.js';
import { publishConversationToUsers, rawToMsgRow, type MsgRow, userHidden } from '../../lib/dto.js';
import { badRequest, conflict, gone, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { revokeShareTokensFor } from '../sharepages/service.js';
import { fanOutNewMessage } from '../messages/service.js';
import { isListingLive, loadListingWithAuthor } from '../listings/service.js';
import { loadBeacon } from '../beacons/service.js';
import {
  commentDtoFor,
  commentDtosFor,
  loadPost,
  pollDtoFor,
  postDtos,
  type PostRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const posts = schema.posts;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep === -1) throw badRequest('bad_cursor');
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) {
    throw badRequest('bad_cursor');
  }
  return { ts, id };
}

/** §1.36/§1.49 visibility: mine; or author in my friends-of set; or (v0.7) an
 * audience='public' post by any non-banned author not blocked w.r.t. me.
 * Unknown / out-of-audience / blocked / banned are one identical 404. */
async function requireVisiblePost(id: string, meId: string): Promise<PostRow> {
  const row = await loadPost(id);
  if (!row) throw notFound('not_found');
  if (row.authorId !== meId) {
    if (row.audience === 'public') {
      const [author] = await db
        .select({ bannedAt: schema.users.bannedAt, deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, row.authorId))
        .limit(1);
      if (!author || userHidden(author)) throw notFound('not_found');
      if (await isBlockedPair(meId, row.authorId)) throw notFound('not_found');
    } else {
      // friends_of: friendsOfIds is already minus blocks and bans.
      const friends = await friendsOfIds(meId);
      if (!friends.has(row.authorId)) throw notFound('not_found');
    }
  }
  return row;
}

/**
 * §1.50 join_card create validation: the ref must be MINE (404, nothing
 * confirmed), LIVE (410 ref_closed), and the post audience must nest inside
 * the ref's (400 ref_audience_mismatch — the binding audience-intersection
 * table; incomparable pairs refuse).
 */
async function validateJoinCardRef(
  ref: PostRef,
  meId: string,
  postAudience: 'friends_of' | 'public',
): Promise<void> {
  if (ref.type === 'beacon') {
    const row = await loadBeacon(ref.id);
    if (!row || row.creatorId !== meId) throw notFound('not_found');
    if (row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) {
      throw gone('ref_closed');
    }
    // beacon friends → post friends_of only; beacon public → either;
    // beacon area → incomparable with both (friends ≠ area).
    const ok =
      (row.audience === 'friends' && postAudience === 'friends_of') || row.audience === 'public';
    if (!ok) throw badRequest('ref_audience_mismatch');
    return;
  }
  const row = await loadListingWithAuthor(ref.id);
  if (!row || row.l.authorId !== meId) throw notFound('not_found');
  if (!isListingLive(row.l)) throw gone('ref_closed');
  // listing is_public:false (area-scoped) is incomparable with both post
  // audiences; is_public:true nests either.
  if (!row.l.isPublic) throw badRequest('ref_audience_mismatch');
}

export async function feedRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.36/§1.50 POST /api/posts — NO push, ever. Per-kind shape rules are
  // route-enforced (400 bad_post_shape / empty_post / ref_audience_mismatch).
  app.post(
    '/api/posts',
    { preHandler: requireAuth, schema: { body: CreatePostRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`postcreate:${user.id}`, POST_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const kind = req.body.kind;
      const audience = req.body.audience;
      const body = req.body.body.trim() ? req.body.body : '';
      const attachmentIds = [...new Set(req.body.attachment_ids)];

      // §1.50 create-shape rules (400 bad_post_shape): only 'text' carries
      // attachments; 'poll' requires poll; 'game' forbids poll/ref; 'join_card'
      // requires ref. poll/ref on the wrong kind refuse too.
      if (kind !== 'text' && attachmentIds.length > 0) throw badRequest('bad_post_shape');
      if ((kind === 'poll') !== (req.body.poll !== undefined)) throw badRequest('bad_post_shape');
      if ((kind === 'join_card') !== (req.body.ref !== undefined)) {
        throw badRequest('bad_post_shape');
      }
      if (kind === 'text' && !body && attachmentIds.length === 0) throw badRequest('empty_post');

      if (kind === 'join_card') {
        await validateJoinCardRef(req.body.ref!, user.id, audience);
      }

      const postId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(posts).values({
          id: postId,
          authorId: user.id,
          kind,
          audience,
          body,
          attachmentIds,
          ref: kind === 'join_card' ? req.body.ref! : null,
          location: req.body.location ?? null,
        });
        if (kind === 'poll') {
          await tx.insert(schema.postPolls).values({
            postId,
            question: req.body.poll!.question,
            options: req.body.poll!.options,
          });
        }
        // v0.8a (§1.59): POST /api/posts → post_created, inside the create
        // transaction through THE one helper. Pointer only — the strip read
        // re-checks §1.36/§1.49 post visibility live.
        await recordActivity(tx, { user_id: user.id, kind: 'post_created', ref: { post_id: postId } });
        if (attachmentIds.length > 0) {
          // Mine, unbound, any kind but 'file' → else 400 bad_attachment
          // (rolls the post back). post_id is the binding/GC shield. Unbound
          // also means not already someone's story or profile media (those
          // bind through their own tables): §1.31 re-use mints a NEW row, so
          // a row shared across surfaces can never be hard-deleted out from
          // under the other surface.
          const bound = (await tx.execute(sql`
            UPDATE attachments SET post_id = ${postId}, share_import_id = NULL
            WHERE id IN (${sql.join(attachmentIds.map((id) => sql`${id}::uuid`), sql`, `)})
              AND uploader_id = ${user.id}
              AND kind <> 'file'
              AND message_id IS NULL
              AND scheduled_message_id IS NULL
              AND post_id IS NULL
              AND listing_id IS NULL
              AND comment_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
              AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
            RETURNING id
          `)) as unknown as { id: string }[];
          if (bound.length !== attachmentIds.length) throw badRequest('bad_attachment');
        }
      });

      const row = await loadPost(postId);
      const [dto] = await postDtos([row!], user.id);
      // post.new → the author's friends-of audience ONLY (minus blocks), for
      // public posts too — the discover lane is PULL-ONLY (§1.49, binding).
      // The author's own sockets are included for cross-device feed sync.
      const audienceIds = [user.id, ...(await friendsOfIds(user.id))];
      // Golden rule 5: `ref_summary` is VIEWER-specific (joiner faces filtered
      // by the viewer's blocks, beacon visibility resolved per viewer,
      // my_state) — the DTO above is resolved FOR THE AUTHOR. Fanning it as-is
      // would hand a recipient who is in a blocked pair with a current joiner
      // that joiner's face and a live summary of a beacon that is
      // §1.14-invisible to them (every REST read answers ref_summary: null
      // for that viewer). So the WS frame goes out with ref_summary stripped
      // and each client resolves ITS OWN view via GET /api/posts/:id (the
      // §1.36 reconcile read); the author's 201 body keeps the full summary.
      const wirePost = dto!.kind === 'join_card' ? { ...dto!, ref_summary: null } : dto!;
      await publishToUsers(audienceIds, { t: 'post.new', d: { post: wirePost } });
      return reply.status(201).send({ post: dto });
    },
  );

  // §1.36 DELETE /api/posts/:id — author only (404 otherwise). Reactions,
  // comments, polls and votes cascade; attachments (the post's AND its
  // comments') deleted, objects refcount-guarded (§1.31).
  app.delete(
    '/api/posts/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await loadPost(req.params.id);
      if (!row || row.authorId !== user.id) throw notFound('not_found');
      const atts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.postId, row.id));
      // v0.7 (§1.51): comment attachments die with the post's comments.
      const commentAtts = await db
        .select()
        .from(schema.attachments)
        .where(
          sql`${schema.attachments.commentId} IN (SELECT id FROM post_comments WHERE post_id = ${row.id})`,
        );
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM attachments WHERE post_id = ${row.id}`);
        await tx.execute(sql`
          DELETE FROM attachments
          WHERE comment_id IN (SELECT id FROM post_comments WHERE post_id = ${row.id})
        `);
        // v0.8b (§1.67): deleting the object revokes its share token in the
        // SAME transaction — the page and every gated media URL die with it.
        await revokeShareTokensFor(tx, 'post', row.id);
        await tx.delete(posts).where(eq(posts.id, row.id)); // reactions/comments/polls cascade
      });
      for (const att of atts) await deleteAttachmentObjects(att);
      for (const att of commentAtts) await deleteAttachmentObjects(att);
      return reply.status(204).send();
    },
  );

  // §1.36/§1.49 GET /api/feed — created_at DESC, opaque keyset cursor, FINITE
  // in BOTH lanes: the terminal page is {next_cursor: null, all_caught_up:
  // true} and the client STOPS (no wraparound, no refetch loop, no ranking).
  app.get(
    '/api/feed',
    { preHandler: requireAuth, schema: { querystring: FeedQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const { lane, cursor, limit } = req.query;
      const conditions = [];
      if (lane === 'discover') {
        // audience='public' instance-wide (posts_discover_idx), minus §1.14
        // blocks both ways and §1.41 banned authors — my own included (one
        // lane is a superset filter, not a dedupe puzzle).
        conditions.push(sql`${posts.audience} = 'public'`);
        conditions.push(sql`(
          ${posts.authorId} = ${user.id}
          OR (
            NOT EXISTS (SELECT 1 FROM users bu WHERE bu.id = ${posts.authorId} AND (bu.banned_at IS NOT NULL OR bu.deactivated_at IS NOT NULL))
            AND NOT EXISTS (
              SELECT 1 FROM blocks bl
              WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = ${posts.authorId})
                 OR (bl.blocker_id = ${posts.authorId} AND bl.blocked_id = ${user.id}))
          ))`);
      } else {
        const friends = await friendsOfIds(user.id);
        const authorIds = [user.id, ...friends];
        conditions.push(
          sql`${posts.authorId} IN (${sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        );
      }
      if (cursor) {
        const { ts, id } = decodeCursor(cursor);
        conditions.push(sql`(${posts.createdAt}, ${posts.id}) < (${ts}::timestamptz, ${id}::uuid)`);
      }
      const rows = await db
        .select()
        .from(posts)
        .where(and(...conditions))
        .orderBy(sql`${posts.createdAt} DESC`, sql`${posts.id} DESC`)
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const dtos = await postDtos(page, user.id);
      const last = page[page.length - 1];
      return {
        posts: dtos,
        next_cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        all_caught_up: !hasMore,
      };
    },
  );

  // §1.36 GET /api/posts/:id — the single-post reconcile read.
  app.get(
    '/api/posts/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const [dto] = await postDtos([row], user.id);
      return { post: dto };
    },
  );

  // ---------------------------------------------------------------------------
  // v0.7 §1.50 poll votes — UPSERT on (post, me): revoting replaces (§1.17
  // semantics). DELETE unvotes. Both answer the fresh aggregate; NO fan-out
  // (feed surfaces reconcile on pull).
  // ---------------------------------------------------------------------------

  app.post(
    '/api/posts/:id/poll/vote',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: PostPollVoteRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      if (row.kind !== 'poll') throw badRequest('not_a_poll');
      const poll = await pollDtoFor(row.id, user.id);
      if (!poll) throw badRequest('not_a_poll');
      if (req.body.option_idx >= poll.options.length) throw badRequest('bad_option');
      await db.execute(sql`
        INSERT INTO post_poll_votes (post_id, user_id, option_idx)
        VALUES (${row.id}, ${user.id}, ${req.body.option_idx})
        ON CONFLICT (post_id, user_id)
        DO UPDATE SET option_idx = EXCLUDED.option_idx, created_at = now()
      `);
      return { poll: await pollDtoFor(row.id, user.id) };
    },
  );

  app.delete(
    '/api/posts/:id/poll/vote',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      if (row.kind !== 'poll') throw badRequest('not_a_poll');
      await db.execute(sql`
        DELETE FROM post_poll_votes WHERE post_id = ${row.id} AND user_id = ${user.id}
      `);
      return { poll: await pollDtoFor(row.id, user.id) };
    },
  );

  // ---------------------------------------------------------------------------
  // v0.7 §1.50 claim-game — FIRST claimer wins, atomically: advisory lock on
  // the post id + the guarded UPDATE ... WHERE game_claimed_by IS NULL (the
  // spark/TROUBLESHOOTING counter-race pattern). The SAME transaction mints
  // the dm_key DM (create-or-dedupe) and the ordinary §1.27 game_ttt message
  // (sender = claimer; author plays x and moves first — they threw the
  // gauntlet). Blocked pairs can never reach the DM-create: requireVisiblePost
  // 404s them before anything game-shaped answers.
  // ---------------------------------------------------------------------------

  app.post(
    '/api/posts/:id/claim-game',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      if (row.kind !== 'game') throw badRequest('not_a_game');
      if (row.authorId === user.id) throw badRequest('game_own');
      // Belt: the visibility gate above covers blocks for public posts and
      // friends-of posts alike; re-check so a mid-request block cannot slip
      // a blocked pair into a brand-new DM.
      if (await isBlockedPair(user.id, row.authorId)) throw notFound('not_found');

      const dmKey = [user.id, row.authorId].sort().join(':');
      const outcome = await db.transaction(async (tx) => {
        // Serialize claimers on this post (the reactions-cap pattern).
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended('post_game:' || ${row.id}::text, 0))
        `);
        const claimed = (await tx.execute(sql`
          UPDATE posts SET game_claimed_by = ${user.id}
          WHERE id = ${row.id} AND game_claimed_by IS NULL
          RETURNING id
        `)) as unknown as { id: string }[];
        if (claimed.length === 0) return 'claimed' as const;

        // §1.4 DM create-or-dedupe via dm_key, inside the claim transaction.
        let convId: string;
        let createdDm = false;
        const insertedConv = (await tx.execute(sql`
          INSERT INTO conversations (id, type, dm_key, created_by)
          VALUES (${newId()}, 'dm', ${dmKey}, ${user.id})
          ON CONFLICT (dm_key) DO NOTHING
          RETURNING id
        `)) as unknown as { id: string }[];
        if (insertedConv.length > 0) {
          convId = insertedConv[0]!.id;
          createdDm = true;
          await tx.execute(sql`
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES (${convId}, ${user.id}), (${convId}, ${row.authorId})
          `);
        } else {
          const [existing] = (await tx.execute(sql`
            SELECT id, last_seq FROM conversations WHERE dm_key = ${dmKey} LIMIT 1
          `)) as unknown as { id: string; last_seq: number }[];
          convId = existing!.id;
          // A departed party re-entering through a claim is a NEW join: reset
          // left_at and floor their history at the current seq (the §1.11
          // re-join semantics).
          await tx.execute(sql`
            INSERT INTO conversation_participants (conversation_id, user_id, join_seq)
            VALUES (${convId}, ${user.id}, ${Number(existing!.last_seq)}),
                   (${convId}, ${row.authorId}, ${Number(existing!.last_seq)})
            ON CONFLICT (conversation_id, user_id) DO UPDATE
              SET left_at = NULL, left_seq = NULL,
                  join_seq = CASE
                    WHEN conversation_participants.left_at IS NULL
                      THEN conversation_participants.join_seq
                    ELSE EXCLUDED.join_seq
                  END
          `);
        }

        // The ordinary §1.27 game_ttt message, on the seq log: author = x,
        // moves first; claimer = o and the message sender.
        const game: GameTttState = {
          board: new Array(TTT_BOARD_CELLS).fill(null),
          players: { x: row.authorId, o: user.id },
          turn: 'x',
          winner: null,
        };
        const [conv] = (await tx.execute(sql`
          UPDATE conversations
          SET last_seq = last_seq + 1, last_message_at = now()
          WHERE id = ${convId}
          RETURNING last_seq
        `)) as unknown as { last_seq: number }[];
        const seq = Number(conv!.last_seq);
        const msgId = newId();
        await tx.execute(sql`
          INSERT INTO messages (id, conversation_id, seq, sender_id, type, body, metadata)
          VALUES (${msgId}, ${convId}, ${seq}, ${user.id}, 'game_ttt', NULL, ${JSON.stringify({ game })}::jsonb)
        `);
        const [msgRaw] = (await tx.execute(sql`
          SELECT * FROM messages WHERE id = ${msgId}
        `)) as unknown as Record<string, unknown>[];
        return { convId, createdDm, seq, msgRaw: msgRaw! };
      });

      if (outcome === 'claimed') throw conflict('game_claimed');

      // Post-commit duties: the ordinary DM machinery fan-out (conv.new for a
      // brand-new DM, msg.new + §2.9 push for the challenge message) — nothing
      // feed-specific; the feed itself reconciles on pull (§1.36 doctrine).
      if (outcome.createdDm) {
        await publishConversationToUsers(outcome.convId, [user.id, row.authorId], 'conv.new');
      }
      const msg: MsgRow = rawToMsgRow(outcome.msgRaw);
      await fanOutNewMessage(msg);

      const fresh = await loadPost(row.id);
      const [dto] = await postDtos([fresh!], user.id);
      return { post: dto, conversation_id: outcome.convId, game_seq: outcome.seq };
    },
  );

  // §1.36 POST /api/posts/:id/reactions — idempotent 204; the 9th DISTINCT
  // emoji → 409 reaction_limit. NO fan-out (no approval pings).
  app.post(
    '/api/posts/:id/reactions',
    { preHandler: requireAuth, schema: { params: IdParams, body: AddPostReactionRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const rate = await fixedWindow(`react:${user.id}`, REACTION_RATE_PER_MINUTE, 60); // §1.5
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const emoji = req.body.emoji;

      const held = (await db.execute(sql`
        SELECT 1 AS one FROM post_reactions
        WHERE post_id = ${row.id} AND user_id = ${user.id} AND emoji = ${emoji}
        LIMIT 1
      `)) as unknown as { one: number }[];
      if (held.length > 0) return reply.status(204).send(); // idempotent

      // Count-then-insert under an advisory lock (the §1.12 pattern) so two
      // concurrent adds of DIFFERENT emoji cannot both pass the cap at 7.
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${row.id}::text || ':' || ${user.id}::text, 0)
          )
        `);
        return (await tx.execute(sql`
          INSERT INTO post_reactions (post_id, user_id, emoji)
          SELECT ${row.id}::uuid, ${user.id}::uuid, ${emoji}
          WHERE (
            SELECT count(*) FROM post_reactions
            WHERE post_id = ${row.id} AND user_id = ${user.id}
          ) < ${REACTIONS_PER_USER_PER_POST_MAX}
          ON CONFLICT DO NOTHING
          RETURNING emoji
        `)) as unknown as { emoji: string }[];
      });
      if (inserted.length === 0) {
        const raced = (await db.execute(sql`
          SELECT 1 AS one FROM post_reactions
          WHERE post_id = ${row.id} AND user_id = ${user.id} AND emoji = ${emoji}
          LIMIT 1
        `)) as unknown as { one: number }[];
        if (raced.length > 0) return reply.status(204).send();
        throw conflict('reaction_limit');
      }
      return reply.status(204).send();
    },
  );

  // §1.36 DELETE /api/posts/:id/reactions/:emoji — idempotent 204.
  app.delete(
    '/api/posts/:id/reactions/:emoji',
    {
      preHandler: requireAuth,
      schema: { params: IdParams.extend({ emoji: ReactionEmojiSchema }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      await db.execute(sql`
        DELETE FROM post_reactions
        WHERE post_id = ${row.id} AND user_id = ${user.id} AND emoji = ${req.params.emoji}
      `);
      return reply.status(204).send();
    },
  );

  // §1.36/§1.51 POST /api/posts/:id/comments — any viewer of the post; v0.7
  // adds attachment_id (mine, kind image, unbound → 400 bad_attachment; a GIF
  // is just an image upload). At least one of body/attachment → else 400
  // empty_comment. NO fan-out.
  app.post(
    '/api/posts/:id/comments',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateCommentRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const rate = await fixedWindow(`comment:${user.id}`, COMMENT_RATE_PER_HOUR, 3600); // §1.5
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const body = req.body.body.trim() ? req.body.body : '';
      const attachmentId = req.body.attachment_id ?? null;
      if (!body && !attachmentId) throw badRequest('empty_comment');

      const commentId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(schema.postComments).values({
          id: commentId,
          postId: row.id,
          authorId: user.id,
          body,
          attachmentId,
        });
        if (attachmentId) {
          // Bind via attachments.comment_id (the GC-shield pattern): mine,
          // kind 'image', unbound anywhere → else 400 bad_attachment (the
          // whole comment rolls back).
          const bound = (await tx.execute(sql`
            UPDATE attachments SET comment_id = ${commentId}, share_import_id = NULL
            WHERE id = ${attachmentId}::uuid
              AND uploader_id = ${user.id}
              AND kind = 'image'
              AND message_id IS NULL AND scheduled_message_id IS NULL
              AND post_id IS NULL AND listing_id IS NULL AND comment_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
              AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
            RETURNING id
          `)) as unknown as { id: string }[];
          if (bound.length !== 1) throw badRequest('bad_attachment');
        }
      });
      const [comment] = await db
        .select()
        .from(schema.postComments)
        .where(eq(schema.postComments.id, commentId))
        .limit(1);
      return reply.status(201).send({ comment: await commentDtoFor(comment!, user, user.id) });
    },
  );

  // §1.36/§1.51 DELETE /api/posts/:id/comments/:commentId — comment author or
  // post author (404 otherwise); HARD delete (comments are not on the seq
  // log). v0.7: the comment's attachment dies with it (row + objects,
  // refcount-guarded §1.31). Reactions cascade.
  app.delete(
    '/api/posts/:id/comments/:commentId',
    {
      preHandler: requireAuth,
      schema: { params: IdParams.extend({ commentId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const [comment] = await db
        .select()
        .from(schema.postComments)
        .where(
          and(
            eq(schema.postComments.id, req.params.commentId),
            eq(schema.postComments.postId, row.id),
          ),
        )
        .limit(1);
      if (!comment) throw notFound('not_found');
      if (comment.authorId !== user.id && row.authorId !== user.id) throw notFound('not_found');
      const atts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.commentId, comment.id));
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM attachments WHERE comment_id = ${comment.id}`);
        await tx.delete(schema.postComments).where(eq(schema.postComments.id, comment.id));
      });
      for (const att of atts) await deleteAttachmentObjects(att);
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // v0.7 §1.51 comment reactions — the §1.19 machinery re-applied. Idempotent
  // both ways (204); the 9th DISTINCT emoji → 409 reaction_limit (stamps never
  // consume a slot — the PK on the ':stamp:' sentinel row IS the one-stamp
  // cap); stamps need MY avatar 'ready' (409 stamp_no_avatar). NO fan-out, no
  // push — §1.36 doctrine; blocked pairs 404 at the post-visibility gate.
  // ---------------------------------------------------------------------------

  const CommentParams = IdParams.extend({ commentId: z.string().uuid() });

  async function requireVisibleComment(
    postId: string,
    commentId: string,
    meId: string,
  ): Promise<{ post: PostRow; commentId: string }> {
    const post = await requireVisiblePost(postId, meId);
    const [comment] = await db
      .select({ id: schema.postComments.id, authorId: schema.postComments.authorId })
      .from(schema.postComments)
      .where(
        and(eq(schema.postComments.id, commentId), eq(schema.postComments.postId, post.id)),
      )
      .limit(1);
    if (!comment) throw notFound('not_found');
    // A comment by someone blocked w.r.t. me is invisible to me (§1.14) —
    // reacting to it must 404 like it never existed.
    if (comment.authorId !== meId && (await isBlockedPair(meId, comment.authorId))) {
      throw notFound('not_found');
    }
    return { post, commentId: comment.id };
  }

  app.post(
    '/api/posts/:id/comments/:commentId/reactions',
    {
      preHandler: requireAuth,
      schema: { params: CommentParams, body: AddCommentReactionRequestSchema },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`react:${user.id}`, REACTION_RATE_PER_MINUTE, 60); // §1.5 (shared budget)
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const kind: ReactionKind = req.body.kind;
      if (kind === 'emoji' && req.body.emoji === STAMP_REACTION_KEY) {
        throw badRequest('bad_emoji');
      }
      const emoji = kind === 'stamp' ? STAMP_REACTION_KEY : req.body.emoji!;
      const { commentId } = await requireVisibleComment(
        req.params.id,
        req.params.commentId,
        user.id,
      );

      const held = (await db.execute(sql`
        SELECT 1 AS one FROM comment_reactions
        WHERE comment_id = ${commentId} AND user_id = ${user.id}
          AND emoji = ${emoji} AND kind = ${kind}
        LIMIT 1
      `)) as unknown as { one: number }[];
      if (held.length > 0) return reply.status(204).send(); // idempotent

      if (kind === 'stamp' && user.avatarStatus !== 'ready') throw conflict('stamp_no_avatar');

      // Count-then-insert under an advisory lock on (comment, user): the
      // distinct-emoji cap counts kind='emoji' rows ONLY (§1.19 verbatim).
      const capGuard =
        kind === 'emoji'
          ? sql`WHERE (
              SELECT count(*) FROM comment_reactions
              WHERE comment_id = ${commentId} AND user_id = ${user.id} AND kind = 'emoji'
            ) < ${REACTIONS_PER_USER_PER_COMMENT_MAX}`
          : sql``;
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${commentId}::text || ':' || ${user.id}::text, 0)
          )
        `);
        return (await tx.execute(sql`
          INSERT INTO comment_reactions (comment_id, user_id, emoji, kind)
          SELECT ${commentId}::uuid, ${user.id}::uuid, ${emoji}, ${kind}
          ${capGuard}
          ON CONFLICT DO NOTHING
          RETURNING emoji
        `)) as unknown as { emoji: string }[];
      });
      if (inserted.length === 0) {
        const raced = (await db.execute(sql`
          SELECT 1 AS one FROM comment_reactions
          WHERE comment_id = ${commentId} AND user_id = ${user.id}
            AND emoji = ${emoji} AND kind = ${kind}
          LIMIT 1
        `)) as unknown as { one: number }[];
        if (raced.length > 0) return reply.status(204).send();
        throw conflict('reaction_limit');
      }
      return reply.status(204).send();
    },
  );

  // DELETE .../reactions/:emoji — idempotent 204; for a stamp, :emoji is the
  // URL-encoded ':stamp:' sentinel (which also selects kind='stamp' via the
  // DB shape CHECK — the sentinel never stores as kind='emoji').
  app.delete(
    '/api/posts/:id/comments/:commentId/reactions/:emoji',
    {
      preHandler: requireAuth,
      schema: { params: CommentParams.extend({ emoji: ReactionEmojiSchema }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const { commentId } = await requireVisibleComment(
        req.params.id,
        req.params.commentId,
        user.id,
      );
      await db.execute(sql`
        DELETE FROM comment_reactions
        WHERE comment_id = ${commentId} AND user_id = ${user.id} AND emoji = ${req.params.emoji}
      `);
      return reply.status(204).send();
    },
  );

  // §1.36/§1.51 GET /api/posts/:id/comments — created_at ASC (a conversation
  // reads downward), keyset cursor; blocked authors omitted; v0.7 DTOs carry
  // attachment + reaction faces.
  app.get(
    '/api/posts/:id/comments',
    { preHandler: requireAuth, schema: { params: IdParams, querystring: ListCommentsQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const { cursor, limit } = req.query;
      const pc = schema.postComments;
      const conditions = [eq(pc.postId, row.id)];
      if (cursor) {
        const { ts, id } = decodeCursor(cursor);
        conditions.push(sql`(${pc.createdAt}, ${pc.id}) > (${ts}::timestamptz, ${id}::uuid)`);
      }
      const rows = await db
        .select({ c: pc, u: schema.users })
        .from(pc)
        .innerJoin(schema.users, eq(pc.authorId, schema.users.id))
        .where(and(...conditions))
        .orderBy(sql`${pc.createdAt} ASC`, sql`${pc.id} ASC`)
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const blocked = await blockedSetOf(user.id);
      const visible = page
        .filter(({ u }) => !blocked.has(u.id))
        .map(({ c, u }) => ({
          id: c.id,
          postId: c.postId,
          authorId: c.authorId,
          body: c.body,
          attachmentId: c.attachmentId,
          createdAt: c.createdAt,
          author: u,
        }));
      const comments = await commentDtosFor(visible, user.id, blocked);
      const lastRow = page[page.length - 1];
      return {
        comments,
        next_cursor: hasMore && lastRow ? encodeCursor(lastRow.c.createdAt, lastRow.c.id) : null,
      };
    },
  );
}
