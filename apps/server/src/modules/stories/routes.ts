// Stories routes (v0.5a — API.md §1.34). Every surface is friends-of scoped
// and 404-shaped across blocks; the view list is author-only with NO
// timestamps and NO counts (the list IS the information).
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateRecapStoryRequestSchema,
  CreateStoryRequestSchema,
  STORY_CREATE_RATE_PER_HOUR,
  STORY_TTL_S,
  type AfterglowMetadata,
  type Story,
  type StoryAuthorGroup,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { friendsOfIds, isFriendOf } from '../../lib/friends.js';
import { userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';
import { badRequest, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import {
  fanStoryNew,
  hardDeleteStory,
  storyDto,
  viewedSetOf,
  type StoryRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const st = schema.stories;
const sv = schema.storyViews;

async function loadStory(id: string): Promise<StoryRow | null> {
  const [row] = await db.select().from(st).where(eq(st.id, id)).limit(1);
  return row ?? null;
}

/** §1.34 visibility: author, or unexpired + author in my friends-of set
 * (friends-of is already minus blocks). Everything else is story_not_found. */
async function requireVisibleStory(id: string, meId: string): Promise<StoryRow> {
  const row = await loadStory(id);
  if (!row) throw notFound('story_not_found');
  if (row.expiresAt.getTime() <= Date.now() && row.authorId !== meId) {
    throw notFound('story_not_found');
  }
  if (row.authorId !== meId && !(await isFriendOf(meId, row.authorId))) {
    throw notFound('story_not_found');
  }
  return row;
}

async function createStory(
  user: UserRow,
  att: AttRow,
  caption: string,
): Promise<{ story: Story }> {
  const now = new Date();
  const [row] = await db
    .insert(st)
    .values({
      id: newId(),
      authorId: user.id,
      attachmentId: att.id,
      caption,
      createdAt: now,
      expiresAt: new Date(now.getTime() + STORY_TTL_S * 1000),
    })
    .returning();
  await fanStoryNew(row!, user, att);
  return { story: storyDto(row!, user, att, false) };
}

export async function storyRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.34 POST /api/stories — one attachment + a caption, 24 h, friends-of.
  app.post(
    '/api/stories',
    { preHandler: requireAuth, schema: { body: CreateStoryRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`storycreate:${user.id}`, STORY_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      // Mine, kind image|video, unbound (no message/schedule/post/story/
      // profile binding), processing finished → else 400 bad_attachment.
      const [att] = await db
        .select()
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.id, req.body.attachment_id),
            eq(schema.attachments.uploaderId, user.id),
            isNull(schema.attachments.messageId),
            isNull(schema.attachments.scheduledMessageId),
            isNull(schema.attachments.postId),
          ),
        )
        .limit(1);
      if (
        !att ||
        (att.kind !== 'image' && att.kind !== 'video') ||
        att.status !== 'ready' ||
        (await attachmentOtherwiseBound(att.id))
      ) {
        throw badRequest('bad_attachment');
      }
      return reply.status(201).send(await createStory(user, att, req.body.caption));
    },
  );

  // §1.34 POST /api/stories/recap — the afterglow integration: share a recap
  // photo to MY story. The server RE-REFERENCES the photo (new attachment row,
  // same content-hashed objects — §1.31 rule): recap photos leave the plan
  // group only through a participant's own deliberate share.
  app.post(
    '/api/stories/recap',
    { preHandler: requireAuth, schema: { body: CreateRecapStoryRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`storycreate:${user.id}`, STORY_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const { conversation_id: convId, seq, attachment_id: attachmentId } = req.body;
      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound();
      const [msg] = await db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, convId),
            eq(schema.messages.seq, seq),
            gt(schema.messages.seq, part.joinSeq),
          ),
        )
        .limit(1);
      if (!msg || msg.deletedAt !== null) throw notFound();
      const meta = (msg.metadata ?? {}) as { afterglow?: AfterglowMetadata };
      const afterglow = meta.afterglow;
      if (!afterglow || !afterglow.photo_attachment_ids.includes(attachmentId)) throw notFound();

      const [src] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, attachmentId))
        .limit(1);
      if (!src) throw notFound();

      // Re-reference: a NEW row owned by the sharer over the SAME objects.
      const [copy] = await db
        .insert(schema.attachments)
        .values({
          id: newId(),
          uploaderId: user.id,
          kind: src.kind,
          originalKey: src.originalKey,
          thumbKey: src.thumbKey,
          blurhash: src.blurhash,
          mime: src.mime,
          fileName: src.fileName,
          sizeBytes: src.sizeBytes,
          width: src.width,
          height: src.height,
          durationMs: src.durationMs,
          waveform: src.waveform,
          status: src.status,
        })
        .returning();
      return reply.status(201).send(await createStory(user, copy!, req.body.caption));
    },
  );

  // §1.34 GET /api/stories — the finite tray: mine + my friends-of authors,
  // grouped by author (any-unviewed authors first, then all-viewed; each
  // bucket by USERNAME — no recency ranking); within an author created_at ASC.
  app.get('/api/stories', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const friends = [...(await friendsOfIds(user.id))];
    const authorIds = [user.id, ...friends];
    const rows = await db
      .select({ s: st, u: schema.users, a: schema.attachments })
      .from(st)
      .innerJoin(schema.users, eq(st.authorId, schema.users.id))
      .innerJoin(schema.attachments, eq(st.attachmentId, schema.attachments.id))
      .where(
        sql`${st.authorId} IN (${sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `)})
            AND ${st.expiresAt} > now()`,
      )
      .orderBy(asc(st.createdAt));
    const viewed = await viewedSetOf(
      user.id,
      rows.map((r) => r.s.id),
    );

    const mine: Story[] = [];
    const byAuthor = new Map<string, { username: string; author: UserRow; stories: Story[]; anyUnviewed: boolean }>();
    for (const { s, u, a } of rows) {
      const dto = storyDto(s, u, a, s.authorId === user.id ? true : viewed.has(s.id));
      if (s.authorId === user.id) {
        mine.push(dto);
        continue;
      }
      const g = byAuthor.get(s.authorId) ?? {
        username: u.username,
        author: u,
        stories: [],
        anyUnviewed: false,
      };
      g.stories.push(dto);
      if (!dto.viewed) g.anyUnviewed = true;
      byAuthor.set(s.authorId, g);
    }
    const groups = [...byAuthor.values()];
    groups.sort((a, b) => {
      if (a.anyUnviewed !== b.anyUnviewed) return a.anyUnviewed ? -1 : 1;
      return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
    });
    const groupDtos: StoryAuthorGroup[] = groups.map((g) => ({
      author: userLiteDto(g.author),
      stories: g.stories,
    }));
    return { mine, groups: groupDtos };
  });

  // §1.34 POST /api/stories/:id/view — idempotent; the author's own views are
  // never recorded.
  app.post(
    '/api/stories/:id/view',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisibleStory(req.params.id, user.id);
      if (row.authorId !== user.id) {
        await db.execute(sql`
          INSERT INTO story_views (story_id, viewer_id)
          VALUES (${row.id}, ${user.id})
          ON CONFLICT DO NOTHING
        `);
      }
      return reply.status(204).send();
    },
  );

  // §1.34 GET /api/stories/:id/views — AUTHOR ONLY (author-privacy is
  // 404-shaped). Faces by username; NO timestamps exist to serialize (the
  // table stores none); NO count — the list is the information.
  app.get(
    '/api/stories/:id/views',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadStory(req.params.id);
      if (!row || row.authorId !== user.id) throw notFound('story_not_found');
      const rows = await db
        .select({ u: schema.users })
        .from(sv)
        .innerJoin(schema.users, eq(sv.viewerId, schema.users.id))
        .where(eq(sv.storyId, row.id));
      const blocked = await blockedSetOf(user.id);
      const viewers: { username: string; lite: UserLite }[] = rows
        .filter(({ u }) => !blocked.has(u.id))
        .map(({ u }) => ({ username: u.username, lite: userLiteDto(u) }));
      viewers.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
      return { viewers: viewers.map((v) => v.lite) };
    },
  );

  // §1.34 DELETE /api/stories/:id — own stories only (404 otherwise); views
  // cascade; attachment row + objects go, refcount-guarded.
  app.delete(
    '/api/stories/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await loadStory(req.params.id);
      if (!row || row.authorId !== user.id) throw notFound('story_not_found');
      await hardDeleteStory(row);
      return reply.status(204).send();
    },
  );
}

/** Unbound also means: not already someone's story and not profile media
 * (those bind through their own tables — the migration-0005 GC note). */
async function attachmentOtherwiseBound(attachmentId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM stories WHERE attachment_id = ${attachmentId}
    UNION ALL
    SELECT 1 AS one FROM profile_media WHERE attachment_id = ${attachmentId}
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}
