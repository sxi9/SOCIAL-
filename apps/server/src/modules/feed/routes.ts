// Feed routes (v0.5a — API.md §1.36). The finite feed: keyset pagination to a
// HARD all_caught_up end; reactions and comments fan out NO live frames
// (viewers reconcile from GET when THEY return — no approval pings,
// PSYCHOLOGY rules 3/4); post.new reaches the friends-of audience only and
// never pushes.
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddPostReactionRequestSchema,
  CreateCommentRequestSchema,
  CreatePostRequestSchema,
  FeedQuerySchema,
  ListCommentsQuerySchema,
  POST_CREATE_RATE_PER_HOUR,
  REACTIONS_PER_USER_PER_POST_MAX,
  ReactionEmojiSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { friendsOfIds } from '../../lib/friends.js';
import { userLiteDto } from '../../lib/dto.js';
import { badRequest, conflict, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { commentDto, loadPost, postDtos, type PostRow } from './service.js';

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

/** §1.36 visibility: mine, or author in my friends-of set (minus blocks by
 * construction). Unknown / out-of-audience / blocked are one identical 404. */
async function requireVisiblePost(id: string, meId: string): Promise<PostRow> {
  const row = await loadPost(id);
  if (!row) throw notFound('not_found');
  if (row.authorId !== meId) {
    const friends = await friendsOfIds(meId);
    if (!friends.has(row.authorId)) throw notFound('not_found');
  }
  return row;
}

export async function feedRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.36 POST /api/posts — audience always friends_of; NO push, ever.
  app.post(
    '/api/posts',
    { preHandler: requireAuth, schema: { body: CreatePostRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`postcreate:${user.id}`, POST_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const body = req.body.body.trim() ? req.body.body : '';
      const attachmentIds = [...new Set(req.body.attachment_ids)];
      if (!body && attachmentIds.length === 0) throw badRequest('empty_post');

      const postId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(posts).values({
          id: postId,
          authorId: user.id,
          body,
          attachmentIds,
        });
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
              AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
              AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
            RETURNING id
          `)) as unknown as { id: string }[];
          if (bound.length !== attachmentIds.length) throw badRequest('bad_attachment');
        }
      });

      const row = await loadPost(postId);
      const [dto] = await postDtos([row!], user.id);
      // post.new → the author's friends-of audience ONLY (minus blocks). The
      // author's own sockets are included for cross-device feed sync.
      const audience = [user.id, ...(await friendsOfIds(user.id))];
      await publishToUsers(audience, { t: 'post.new', d: { post: dto! } });
      return reply.status(201).send({ post: dto });
    },
  );

  // §1.36 DELETE /api/posts/:id — author only (404 otherwise). Reactions and
  // comments cascade; attachments deleted, objects refcount-guarded (§1.31).
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
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM attachments WHERE post_id = ${row.id}`);
        await tx.delete(posts).where(eq(posts.id, row.id)); // reactions/comments cascade
      });
      for (const att of atts) await deleteAttachmentObjects(att);
      return reply.status(204).send();
    },
  );

  // §1.36 GET /api/feed — created_at DESC, opaque keyset cursor, FINITE:
  // the terminal page is {next_cursor: null, all_caught_up: true} and the
  // client STOPS (no wraparound, no refetch loop).
  app.get(
    '/api/feed',
    { preHandler: requireAuth, schema: { querystring: FeedQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const { cursor, limit } = req.query;
      const friends = await friendsOfIds(user.id);
      const authorIds = [user.id, ...friends];
      const conditions = [
        sql`${posts.authorId} IN (${sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
      ];
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

  // §1.36 POST /api/posts/:id/reactions — idempotent 204; the 9th DISTINCT
  // emoji → 409 reaction_limit. NO fan-out (no approval pings).
  app.post(
    '/api/posts/:id/reactions',
    { preHandler: requireAuth, schema: { params: IdParams, body: AddPostReactionRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
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

  // §1.36 POST /api/posts/:id/comments — any viewer of the post. NO fan-out.
  app.post(
    '/api/posts/:id/comments',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateCommentRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisiblePost(req.params.id, user.id);
      const [comment] = await db
        .insert(schema.postComments)
        .values({ id: newId(), postId: row.id, authorId: user.id, body: req.body.body })
        .returning();
      return reply.status(201).send({ comment: commentDto(comment!, user) });
    },
  );

  // §1.36 DELETE /api/posts/:id/comments/:commentId — comment author or post
  // author (404 otherwise); HARD delete (comments are not on the seq log).
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
      await db.delete(schema.postComments).where(eq(schema.postComments.id, comment.id));
      return reply.status(204).send();
    },
  );

  // §1.36 GET /api/posts/:id/comments — created_at ASC (a conversation reads
  // downward), keyset cursor; blocked authors omitted.
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
      const comments = page
        .filter(({ u }) => !blocked.has(u.id))
        .map(({ c, u }) => ({
          id: c.id,
          post_id: c.postId,
          author: userLiteDto(u),
          body: c.body,
          created_at: c.createdAt.toISOString(),
        }));
      const lastRow = page[page.length - 1];
      return {
        comments,
        next_cursor: hasMore && lastRow ? encodeCursor(lastRow.c.createdAt, lastRow.c.id) : null,
      };
    },
  );
}
