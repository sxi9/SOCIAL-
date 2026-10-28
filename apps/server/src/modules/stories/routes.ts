// Stories routes (v0.5a — API.md §1.34). Every surface is friends-of scoped
// and 404-shaped across blocks; the view list is author-only with NO
// timestamps and NO counts (the list IS the information).
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateOverlayRequestSchema,
  CreateRecapStoryRequestSchema,
  CreateStoryRequestSchema,
  OVERLAY_RATE_PER_HOUR,
  OVERLAYS_PER_USER,
  STORY_CREATE_RATE_PER_HOUR,
  STORY_REPLY_RATE_PER_HOUR,
  STORY_TTL_S,
  StoryReplyRequestSchema,
  UpdateStoryRequestSchema,
  type AfterglowMetadata,
  type MessageMetadata,
  type StoryViewerActivity,
  type Story,
  type StoryAuthorGroup,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { ensureDm } from '../../lib/dm.js';
import { requestSendAllowed } from '../../lib/dmPolicy.js';
import { friendsOfIds, isFriendOf } from '../../lib/friends.js';
import { userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { fanOutNewMessage, insertMessage } from '../messages/service.js';
import {
  fanStoryNew,
  fanStoryUpdated,
  hardDeleteStory,
  loadOverlayRowsFor,
  overlayDto,
  overlaysForViewer,
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
  canvasMode: 'off' | 'open' | 'approve' = 'off',
): Promise<{ story: Story }> {
  const now = new Date();
  const [row] = await db
    .insert(st)
    .values({
      id: newId(),
      authorId: user.id,
      attachmentId: att.id,
      caption,
      // v0.8b (§1.66): the canvas invitation — DEFAULT 'off', author's choice.
      canvasMode,
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
            isNull(schema.attachments.listingId),
            // v0.7 (§1.51): feed-comment images bind via comment_id.
            isNull(schema.attachments.commentId),
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
      return reply
        .status(201)
        .send(await createStory(user, att, req.body.caption, req.body.canvas_mode));
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
    // v0.8b (§1.66): the viewer's overlay slices — live (minus blocked
    // authors) + pending only where I am the overlay author or story author.
    const overlayRows = await loadOverlayRowsFor(rows.map((r) => r.s.id));
    const myBlocked = await blockedSetOf(user.id);

    const mine: Story[] = [];
    const byAuthor = new Map<string, { username: string; author: UserRow; stories: Story[]; anyUnviewed: boolean }>();
    for (const { s, u, a } of rows) {
      const overlays = overlaysForViewer(
        overlayRows.get(s.id) ?? [],
        user.id,
        s.authorId,
        myBlocked,
      );
      const dto = storyDto(s, u, a, s.authorId === user.id ? true : viewed.has(s.id), overlays);
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
      const blocked = await blockedSetOf(user.id);
      // §1.79: the list is views ∪ anyone who reacted/replied/drew — a
      // reaction without a recorded view (offline view POST) still names
      // the person. One row per face, NO timestamps, NO totals.
      // Candidate set built STORY-side (three indexed lookups), never a walk
      // over users.
      const raw = (await db.execute(sql`
        WITH who AS (
          SELECT viewer_id AS uid FROM story_views WHERE story_id = ${row.id}
          UNION
          SELECT viewer_id FROM story_activity WHERE story_id = ${row.id}
          UNION
          SELECT author_id FROM story_overlays WHERE story_id = ${row.id} AND status IN ('live','pending')
        )
        SELECT w.uid,
               sa.emoji, COALESCE(sa.replied, false) AS replied,
               EXISTS (
                 SELECT 1 FROM story_overlays so
                 WHERE so.story_id = ${row.id} AND so.author_id = w.uid AND so.status IN ('live','pending')
               ) AS drew
        FROM who w
        LEFT JOIN story_activity sa ON sa.story_id = ${row.id} AND sa.viewer_id = w.uid
        WHERE w.uid <> ${user.id}
      `)) as unknown as { uid: string; emoji: string | null; replied: boolean; drew: boolean }[];
      const userRows = raw.length
        ? await db.select().from(schema.users).where(inArray(schema.users.id, raw.map((r) => r.uid)))
        : [];
      const userById = new Map(userRows.map((u) => [u.id, u]));
      const viewers: { username: string; lite: UserLite; act: StoryViewerActivity | null }[] = raw
        .filter((r) => !blocked.has(r.uid) && userById.has(r.uid))
        .map(({ uid, emoji, replied, drew }) => {
          const u = userById.get(uid)!;
          return {
            username: u.username,
            lite: userLiteDto(u),
            act: emoji || replied || drew ? { user_id: u.id, emoji: emoji ?? null, replied, drew } : null,
          };
        });
      viewers.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
      return {
        viewers: viewers.map((v) => v.lite),
        activity: viewers.flatMap((v) => (v.act ? [v.act] : [])),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // v0.8b §1.66 — canvas stories (ADR-020, FEATURES #79a).
  // ---------------------------------------------------------------------------

  // PATCH /api/stories/:id {canvas_mode} — author only (404 otherwise).
  // Switching to 'off' keeps existing overlays visible (they were invited);
  // it stops NEW ones. Fans story.updated.
  app.patch(
    '/api/stories/:id',
    { preHandler: requireAuth, schema: { params: IdParams, body: UpdateStoryRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadStory(req.params.id);
      if (!row || row.authorId !== user.id || row.expiresAt.getTime() <= Date.now()) {
        throw notFound('story_not_found');
      }
      const [updated] = await db
        .update(st)
        .set({
          ...(req.body.canvas_mode !== undefined ? { canvasMode: req.body.canvas_mode } : {}),
          // §1.79 "Edit": the caption while the story lives.
          ...(req.body.caption !== undefined ? { caption: req.body.caption.trim() } : {}),
        })
        .where(eq(st.id, row.id))
        .returning();
      await fanStoryUpdated(updated!);
      const [author] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
      const [att] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, row.attachmentId))
        .limit(1);
      const overlayRows = (await loadOverlayRowsFor([row.id])).get(row.id) ?? [];
      return {
        story: storyDto(
          updated!,
          author!,
          att!,
          true,
          overlaysForViewer(overlayRows, user.id, row.authorId, await blockedSetOf(user.id)),
        ),
      };
    },
  );

  // POST /api/stories/:id/overlays — viewer must be in the story's audience
  // (else the §1.34 404). 403 canvas_closed when canvas_mode 'off' AND,
  // byte-identically, when the viewer is canvas-banned (a ban is never
  // confirmable). Cap OVERLAYS_PER_USER live+pending per (story, contributor)
  // counted under the story row lock → 409 overlay_limit.
  app.post(
    '/api/stories/:id/overlays',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateOverlayRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisibleStory(req.params.id, user.id);
      // Expired own story: the author can still see it (§1.34) but the canvas
      // is gone with the audience.
      if (row.expiresAt.getTime() <= Date.now()) throw notFound('story_not_found');

      // The ban check FIRST, and byte-identical to a closed canvas (§1.66).
      if (user.id !== row.authorId) {
        const banned = (await db.execute(sql`
          SELECT 1 AS one FROM story_canvas_bans
          WHERE owner_id = ${row.authorId} AND banned_user_id = ${user.id}
          LIMIT 1
        `)) as unknown as { one: number }[];
        if (banned.length > 0) throw forbidden('canvas_closed');
      }
      if (row.canvasMode === 'off') throw forbidden('canvas_closed');

      const rate = await fixedWindow(`overlay:${user.id}`, OVERLAY_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const payload = req.body.payload;
      const status =
        user.id === row.authorId ? 'live' : row.canvasMode === 'approve' ? 'pending' : 'live';

      const overlayId = newId();
      await db.transaction(async (tx) => {
        // The TROUBLESHOOTING counter-race pattern: count under the story row
        // lock so two concurrent 5th overlays cannot both land.
        await tx.execute(sql`SELECT 1 FROM stories WHERE id = ${row.id} FOR UPDATE`);
        const [count] = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM story_overlays
          WHERE story_id = ${row.id} AND author_id = ${user.id}
            AND status IN ('live','pending')
        `)) as unknown as { n: number }[];
        if (Number(count?.n ?? 0) >= OVERLAYS_PER_USER) throw conflict('overlay_limit');
        await tx.execute(sql`
          INSERT INTO story_overlays (id, story_id, author_id, kind, payload, status)
          VALUES (${overlayId}, ${row.id}, ${user.id}, ${payload.kind},
                  ${JSON.stringify(payload)}::jsonb, ${status})
        `);
      });

      const [overlayRow] = await db
        .select()
        .from(schema.storyOverlays)
        .where(eq(schema.storyOverlays.id, overlayId))
        .limit(1);
      // Live updates: a pending overlay fans only to its author + the story
      // author; live ones to the whole audience (§1.66).
      await fanStoryUpdated(row, status === 'pending' ? { pendingOnlyAuthorId: user.id } : {});
      return reply.status(201).send({ overlay: overlayDto(overlayRow!, user) });
    },
  );

  // DELETE .../overlays/:overlayId — the STORY AUTHOR (any overlay) or the
  // OVERLAY AUTHOR (their own). Sets status 'removed' (tombstone: reports
  // must outlive moderation; serializes to nobody, frees the cap). Idempotent.
  app.delete(
    '/api/stories/:id/overlays/:overlayId',
    {
      preHandler: requireAuth,
      schema: { params: z.object({ id: z.string().uuid(), overlayId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await loadStory(req.params.id);
      if (!row) throw notFound('story_not_found');
      const [overlay] = await db
        .select()
        .from(schema.storyOverlays)
        .where(
          and(
            eq(schema.storyOverlays.id, req.params.overlayId),
            eq(schema.storyOverlays.storyId, row.id),
          ),
        )
        .limit(1);
      if (!overlay) throw notFound('not_found');
      if (user.id !== row.authorId && user.id !== overlay.authorId) throw notFound('not_found');
      if (overlay.status !== 'removed') {
        await db
          .update(schema.storyOverlays)
          .set({ status: 'removed' })
          .where(eq(schema.storyOverlays.id, overlay.id));
        await fanStoryUpdated(row);
      }
      return reply.status(204).send();
    },
  );

  // POST .../overlays/:overlayId/approve — story author only: pending → live.
  app.post(
    '/api/stories/:id/overlays/:overlayId/approve',
    {
      preHandler: requireAuth,
      schema: { params: z.object({ id: z.string().uuid(), overlayId: z.string().uuid() }) },
    },
    async (req) => {
      const { user } = authed(req);
      const row = await loadStory(req.params.id);
      if (!row || row.authorId !== user.id) throw notFound('story_not_found');
      const [overlay] = await db
        .select({ o: schema.storyOverlays, u: schema.users })
        .from(schema.storyOverlays)
        .innerJoin(schema.users, eq(schema.storyOverlays.authorId, schema.users.id))
        .where(
          and(
            eq(schema.storyOverlays.id, req.params.overlayId),
            eq(schema.storyOverlays.storyId, row.id),
          ),
        )
        .limit(1);
      if (!overlay) throw notFound('not_found');
      if (overlay.o.status !== 'pending') throw conflict('overlay_not_pending');
      const [updated] = await db
        .update(schema.storyOverlays)
        .set({ status: 'live' })
        .where(eq(schema.storyOverlays.id, overlay.o.id))
        .returning();
      await fanStoryUpdated(row);
      return { overlay: overlayDto(updated!, overlay.u) };
    },
  );

  // PUT/DELETE /api/users/:id/canvas-ban — ban/unban :id from ALL my
  // canvases, present and future (idempotent). Enforced INVISIBLY at overlay
  // create (the 403 canvas_closed shape).
  app.put(
    '/api/users/:id/canvas-ban',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      if (req.params.id === user.id) throw badRequest('block_self');
      const [target] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, req.params.id))
        .limit(1);
      if (!target) throw notFound('user_not_found');
      await db.execute(sql`
        INSERT INTO story_canvas_bans (owner_id, banned_user_id)
        VALUES (${user.id}, ${req.params.id})
        ON CONFLICT DO NOTHING
      `);
      return reply.status(204).send();
    },
  );

  app.delete(
    '/api/users/:id/canvas-ban',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      if (req.params.id === user.id) throw badRequest('block_self');
      await db.execute(sql`
        DELETE FROM story_canvas_bans
        WHERE owner_id = ${user.id} AND banned_user_id = ${req.params.id}
      `);
      return reply.status(204).send();
    },
  );

  // GET /api/users/me/canvas-bans — my list (the §1.14 blocks-list pattern;
  // faces by username, no timestamps).
  app.get('/api/users/me/canvas-bans', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select({ u: schema.users })
      .from(schema.storyCanvasBans)
      .innerJoin(schema.users, eq(schema.storyCanvasBans.bannedUserId, schema.users.id))
      .where(eq(schema.storyCanvasBans.ownerId, user.id));
    const sorted = rows
      .map(({ u }) => u)
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
    return { users: sorted.map((u) => userLiteDto(u)) };
  });

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

  // §1.79 POST /api/stories/:id/reply — a reply (text / voice / image) or a
  // one-emoji reaction to SOMEONE ELSE's live story. It lands as an ordinary
  // DM message to the author (metadata.story_ref, server-written) through
  // the §1.13 DM gate: 'parked' still delivers (into their Requests, capped
  // like any request → 400 dm_request_pending past the cap); 'refused'
  // (dm_policy nobody) answers the surface's own 404 story_not_found, the
  // same bytes a block or a stranger gets (§1.14: the setting is never
  // confirmable). The author's named list learns "reacted 😂 / replied"
  // from story_activity; nobody else ever sees it. Own story → 400 own_story.
  app.post(
    '/api/stories/:id/reply',
    { preHandler: requireAuth, schema: { params: IdParams, body: StoryReplyRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await requireVisibleStory(req.params.id, user.id);
      if (row.authorId === user.id) throw badRequest('own_story');
      if (row.expiresAt.getTime() <= Date.now()) throw notFound('story_not_found');
      const rate = await fixedWindow(`storyreply:${user.id}`, STORY_REPLY_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      // Validate the payload BEFORE any DM side effect (create / re-seat /
      // conv.new) so a refused request leaves nothing behind.
      const emoji = req.body.emoji ?? null;
      const text = req.body.body?.trim() ?? '';
      let type: 'text' | 'image' | 'audio' = 'text';
      const attachmentIds: string[] = [];
      if (req.body.attachment_id) {
        const [att] = await db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.id, req.body.attachment_id))
          .limit(1);
        if (!att || att.uploaderId !== user.id || att.status === 'failed') throw badRequest('bad_attachment');
        if (att.kind !== 'audio' && att.kind !== 'image') throw badRequest('bad_attachment');
        if (att.messageId || att.postId || att.listingId || att.commentId || att.scheduledMessageId) {
          throw badRequest('bad_attachment');
        }
        type = att.kind;
        attachmentIds.push(att.id);
      }

      const dm = await ensureDm(user.id, row.authorId);
      if (!dm) throw notFound('story_not_found');
      if (dm.gate === 'parked' && !(await requestSendAllowed(dm.conversationId, user.id))) {
        throw badRequest('dm_request_pending');
      }

      const metadata: MessageMetadata = {
        story_ref: { story_id: row.id, author_id: row.authorId, emoji, caption: row.caption },
      };
      let msg;
      try {
        msg = await insertMessage({
          conversationId: dm.conversationId,
          senderId: user.id,
          type,
          // A reaction's body IS the emoji (push text / older clients); a
          // text reply its words; media replies carry no body.
          body: emoji ?? (type === 'text' ? text : null),
          metadata,
          attachmentIds,
          // The activity row commits WITH the message: a story deleted or
          // swept meanwhile fails the FK and rolls the whole send back.
          withinTx: async (tx) => {
            await tx.execute(sql`
              INSERT INTO story_activity (story_id, viewer_id, emoji, replied)
              VALUES (${row.id}, ${user.id}, ${emoji}, ${emoji === null})
              ON CONFLICT (story_id, viewer_id) DO UPDATE SET
                emoji = COALESCE(EXCLUDED.emoji, story_activity.emoji),
                replied = story_activity.replied OR EXCLUDED.replied
            `);
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23503') throw notFound('story_not_found');
        throw err;
      }
      await fanOutNewMessage(msg);
      return reply.status(201).send({ conversation_id: dm.conversationId, message_id: msg.id });
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
