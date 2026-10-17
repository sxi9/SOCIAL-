import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UPLOAD_RATE_PER_HOUR } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { attachmentDto, type AttRow } from '../../lib/dto.js';
import { badRequest, notFound, rateLimited } from '../../lib/errors.js';
import { parseMultipart } from '../../lib/multipart.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueMedia } from '../../queues.js';
import { getObjectStream } from '../../s3.js';
import { friendsOfPairCond } from '../../lib/friends.js';
import { authed, requireAuth } from '../auth/guard.js';
import { processUploadStream, type ProcessedFile } from './pipeline.js';

const SERVABLE_KEY_RE = /^(media|avatar|preview)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.6 POST /api/uploads — streaming multipart, field `file`.
  app.post('/api/uploads', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    // M8 rate-limit sweep: checked before the stream is consumed.
    const rate = await fixedWindow(`uploads:${user.id}`, UPLOAD_RATE_PER_HOUR, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    let processed: ProcessedFile | null = null;

    const fields = await parseMultipart(
      req,
      async (fieldname, file, info) => {
        if (fieldname !== 'file' || processed) {
          file.resume();
          return;
        }
        processed = await processUploadStream(file, info.filename);
      },
      { maxFiles: 1 },
    );
    const result = processed as ProcessedFile | null;
    if (!result) throw badRequest('missing_file');

    let shareImportId: string | null = null;
    if (fields.share_import_id) {
      const parsedId = z.string().uuid().safeParse(fields.share_import_id);
      if (!parsedId.success) throw badRequest('bad_share_import_id');
      const [imp] = await db
        .select({ id: schema.shareImports.id })
        .from(schema.shareImports)
        .where(
          and(
            eq(schema.shareImports.id, parsedId.data),
            eq(schema.shareImports.userId, user.id),
            eq(schema.shareImports.status, 'open'),
          ),
        )
        .limit(1);
      if (!imp) throw notFound('share_import_not_found');
      shareImportId = imp.id;
    }

    const [row] = await db
      .insert(schema.attachments)
      .values({
        id: newId(),
        uploaderId: user.id,
        shareImportId,
        kind: result.kind,
        originalKey: result.originalKey,
        thumbKey: result.thumbKey,
        blurhash: result.blurhash,
        mime: result.mime,
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        width: result.width,
        height: result.height,
        status: result.status,
      })
      .returning();

    // Video poster/dims and audio duration+waveform (§1.20) hydrate in the
    // worker's `media` queue; the DTO goes out 'pending' and the client gets
    // attachment.ready / msg.updated when the job lands.
    if (result.kind === 'video' || result.kind === 'audio') {
      await enqueueMedia({ attachment_id: row!.id });
    }

    return reply.status(201).send({ attachment: attachmentDto(row!) });
  });

  // §1.6 GET /api/uploads/:id — poll fallback for attachment.ready.
  app.get(
    '/api/uploads/:id',
    { preHandler: requireAuth, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db
        .select()
        .from(schema.attachments)
        .where(and(eq(schema.attachments.id, req.params.id), eq(schema.attachments.uploaderId, user.id)))
        .limit(1);
      if (!row) throw notFound('attachment_not_found');
      return { attachment: attachmentDto(row) };
    },
  );

  // §1.6 GET /api/media/:key — auth-checked streaming proxy from MinIO.
  app.get('/api/media/*', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    const key = (req.params as Record<string, string>)['*'] ?? '';
    if (!SERVABLE_KEY_RE.test(key)) throw notFound();
    // §1.69 (#81b): support-ticket screenshots are readable by active §1.41
    // admins (same gate as requireAdmin) — the ACL branch below uses this.
    const isActiveAdmin =
      user.isAdmin === true && user.suspendedAt === null && user.bannedAt === null;

    let fileAttachment: AttRow | null = null;
    if (key.startsWith('media/')) {
      // Requester must own the object or share a conversation with it
      // (avatars/previews are readable by any authed user). The participant
      // check applies the same visibility model as the history endpoints
      // (API.md §1.5/§1.6): seq above the join_seq floor, and for departed
      // members only messages up to their leave (seq <= left_seq).
      const rows = (await db.execute(sql`
        SELECT a.* FROM attachments a
        WHERE (a.original_key = ${key} OR a.thumb_key = ${key})
          AND (
            a.uploader_id = ${user.id}
            OR EXISTS (
              SELECT 1 FROM messages m
              JOIN conversation_participants p ON p.conversation_id = m.conversation_id
              WHERE m.id = a.message_id AND p.user_id = ${user.id}
                AND m.seq > p.join_seq
                AND (p.left_at IS NULL OR m.seq <= COALESCE(p.left_seq, 0))
            )
            -- §1.36/§1.49: feed attachments are readable by the post's
            -- audience — the author's friends-of set, or ANY authed user for
            -- audience='public' posts (non-banned author), minus §1.14 blocks
            -- both directions (mirrors requireVisiblePost in modules/feed).
            OR EXISTS (
              SELECT 1 FROM posts po
              WHERE po.id = a.post_id
                AND (
                  ${friendsOfPairCond(user.id, sql`po.author_id`)}
                  OR (po.audience = 'public' AND NOT EXISTS (
                    SELECT 1 FROM users bu
                    WHERE bu.id = po.author_id AND bu.banned_at IS NOT NULL))
                )
                AND NOT EXISTS (
                  SELECT 1 FROM blocks bl
                  WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = po.author_id)
                     OR (bl.blocker_id = po.author_id AND bl.blocked_id = ${user.id}))
            )
            -- §1.51: comment-bound attachments (GIF/image comments) resolve
            -- through the parent post's visibility — friends-of OR
            -- audience='public' (non-banned author), minus §1.14 blocks
            -- against BOTH the post author and the comment author (a blocked
            -- commenter's media is as invisible as their comment).
            OR EXISTS (
              SELECT 1 FROM post_comments pc
              JOIN posts po ON po.id = pc.post_id
              WHERE pc.id = a.comment_id
                AND (
                  po.author_id = ${user.id}
                  OR ${friendsOfPairCond(user.id, sql`po.author_id`)}
                  OR (po.audience = 'public' AND NOT EXISTS (
                    SELECT 1 FROM users bu
                    WHERE bu.id = po.author_id AND bu.banned_at IS NOT NULL))
                )
                AND NOT EXISTS (
                  SELECT 1 FROM blocks bl
                  WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = po.author_id)
                     OR (bl.blocker_id = po.author_id AND bl.blocked_id = ${user.id}))
                AND NOT EXISTS (
                  SELECT 1 FROM blocks bl
                  WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = pc.author_id)
                     OR (bl.blocker_id = pc.author_id AND bl.blocked_id = ${user.id}))
            )
            -- §1.34: story media — unexpired, viewer in the author's audience.
            OR EXISTS (
              SELECT 1 FROM stories st
              WHERE st.attachment_id = a.id AND st.expires_at > now()
                AND ${friendsOfPairCond(user.id, sql`st.author_id`)}
                AND NOT EXISTS (
                  SELECT 1 FROM blocks bl
                  WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = st.author_id)
                     OR (bl.blocker_id = st.author_id AND bl.blocked_id = ${user.id}))
            )
            -- §1.69 (#81b): support-ticket screenshots — the user's CONSENTED
            -- submission to the operator, rendered in the admin inbox, so
            -- active §1.41 admins read them (the ticket owner already passes
            -- via uploader_id above).
            OR (${isActiveAdmin} AND EXISTS (
              SELECT 1 FROM support_tickets stk WHERE stk.attachment_id = a.id
            ))
            -- §1.37: profile GIF strip — the profile page is readable by any
            -- authed user except blocked pairs (which 404 the whole page).
            OR EXISTS (
              SELECT 1 FROM profile_media pm
              WHERE pm.attachment_id = a.id
                AND NOT EXISTS (
                  SELECT 1 FROM blocks bl
                  WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = pm.user_id)
                     OR (bl.blocker_id = pm.user_id AND bl.blocked_id = ${user.id}))
            )
          )
        LIMIT 1
      `)) as unknown as Record<string, unknown>[];
      const row = rows[0];
      if (!row) throw notFound();
      if (row.kind === 'file' && row.original_key === key) {
        fileAttachment = {
          kind: 'file',
          mime: String(row.mime),
          fileName: (row.file_name as string | null) ?? null,
        } as AttRow;
      }
    }

    let obj;
    try {
      obj = await getObjectStream(key, req.headers.range);
    } catch {
      throw notFound();
    }

    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('accept-ranges', 'bytes');
    if (obj.contentLength !== undefined) reply.header('content-length', String(obj.contentLength));
    if (obj.contentRange) {
      reply.status(206);
      reply.header('content-range', obj.contentRange);
    }
    const mime = fileAttachment?.mime ?? obj.contentType ?? 'application/octet-stream';
    reply.header('content-type', mime);
    if (fileAttachment) {
      // Generic files are always download-only (ARCHITECTURE §5).
      const name = fileAttachment.fileName ? `; filename="${fileAttachment.fileName.replace(/"/g, '')}"` : '';
      reply.header('content-disposition', `attachment${name}`);
    }
    return reply.send(obj.body);
  });
}
