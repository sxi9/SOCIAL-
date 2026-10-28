// "My gallery" (v1.0a — #94, SPECS §v1.0a). A PRIVATE view over MY OWN
// media: attachments I uploaded that are bound anywhere (messages, posts,
// listings, comments, stories, profile media, chat backgrounds) or kept by a
// gallery save (today: the story auto-saver — sweep expiry moves story media
// here instead of destroying it). Nothing here grants anyone else access —
// it is the uploader reading their uploads; every URL stays behind the §1.6
// auth-checked proxy. Deleting a SAVE re-orphans the attachment into the
// ordinary 24 h GC; bound media is deleted where it lives, not here.
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GalleryQuerySchema, type GalleryItem } from '@socialchat/shared';
import { db } from '../../db/index.js';
import { attachmentDto, type AttRow } from '../../lib/dto.js';
import { authed, requireAuth } from '../auth/guard.js';

const AttachmentIdParams = z.object({ attachmentId: z.string().uuid() });

export async function galleryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // #94 GET /api/users/me/gallery — newest first, keyset cursor on
  // (created_at, id). `kind` narrows to image/video; `saved` to saves only.
  app.get(
    '/api/users/me/gallery',
    { preHandler: requireAuth, schema: { querystring: GalleryQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const q = req.query;
      const cursorCond = (() => {
        if (!q.cursor) return sql``;
        const [ts, id] = q.cursor.split('_');
        const at = new Date(Number(ts));
        if (Number.isNaN(at.getTime()) || !id) return sql``;
        return sql`AND (a.created_at, a.id) < (${at}, ${id}::uuid)`;
      })();
      const rows = (await db.execute(sql`
        SELECT a.*, gs.source AS save_source
        FROM attachments a
        LEFT JOIN gallery_saves gs
          ON gs.attachment_id = a.id AND gs.user_id = ${user.id}
        WHERE a.uploader_id = ${user.id}
          AND a.status = 'ready'
          AND a.kind IN ('image', 'video')
          ${q.kind ? sql`AND a.kind = ${q.kind}` : sql``}
          ${q.saved ? sql`AND gs.attachment_id IS NOT NULL` : sql``}
          AND (
            gs.attachment_id IS NOT NULL
            OR a.message_id IS NOT NULL
            OR a.post_id IS NOT NULL
            OR a.listing_id IS NOT NULL
            OR a.comment_id IS NOT NULL
            OR a.scheduled_message_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = a.id)
            OR EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = a.id)
            OR EXISTS (SELECT 1 FROM conversation_prefs p WHERE p.background_attachment_id = a.id AND p.user_id = ${user.id})
            OR EXISTS (SELECT 1 FROM conversations cb WHERE cb.shared_background_attachment_id = a.id)
          )
          ${cursorCond}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${q.limit + 1}
      `)) as unknown as (Record<string, unknown> & { save_source: string | null })[];

      const page = rows.slice(0, q.limit);
      const items: GalleryItem[] = page.map((r) => ({
        attachment: attachmentDto(rawAttRow(r)),
        saved: r.save_source !== null,
        source: (r.save_source as GalleryItem['source']) ?? null,
        created_at: new Date(r.created_at as string).toISOString(),
      }));
      const last = page[page.length - 1];
      const next_cursor =
        rows.length > q.limit && last
          ? `${new Date(last.created_at as string).getTime()}_${last.id as string}`
          : null;
      return { items, next_cursor };
    },
  );

  // #94 DELETE /api/users/me/gallery/:attachmentId — remove MY save row
  // (204, idempotent). The attachment re-orphans into the normal GC unless
  // something else still binds it. Never deletes bound media.
  app.delete(
    '/api/users/me/gallery/:attachmentId',
    { preHandler: requireAuth, schema: { params: AttachmentIdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      await db.execute(sql`
        DELETE FROM gallery_saves
        WHERE user_id = ${user.id} AND attachment_id = ${req.params.attachmentId}
      `);
      return reply.status(204).send();
    },
  );
}

/** Raw SELECT a.* rows are snake_case; rebuild the AttRow the DTO needs. */
function rawAttRow(r: Record<string, unknown>): AttRow {
  return {
    ...(r as object),
    id: r.id as string,
    uploaderId: r.uploader_id as string,
    kind: r.kind as string,
    originalKey: r.original_key as string,
    thumbKey: (r.thumb_key as string | null) ?? null,
    blurhash: (r.blurhash as string | null) ?? null,
    mime: r.mime as string,
    fileName: (r.file_name as string | null) ?? null,
    sizeBytes: Number(r.size_bytes),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    waveform: r.waveform ?? null,
    status: r.status as string,
    createdAt: new Date(r.created_at as string),
  } as AttRow;
}
