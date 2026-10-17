// Chat themes, wallpapers & nicknames (v0.4 — API.md §1.24, ADR-010).
// ALL PERSONAL: per (conversation, user), visible to that user only, synced
// across their devices via prefs.updated (OWN sockets only — no other
// participant ever receives a frame about them). PATCH semantics: omitted =
// unchanged; explicit null resets a theme/wallpaper or removes a nickname.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CHAT_BG_VIDEO_MAX_BYTES,
  CHAT_BG_VIDEO_MAX_DURATION_S,
  MAX_IMAGE_BYTES,
  UpdatePrefsRequestSchema,
  type ConversationPrefs,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { attachmentDto } from '../../lib/dto.js';
import { badRequest } from '../../lib/errors.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant, requireActiveParticipant } from '../conversations/routes.js';

const IdParams = z.object({ id: z.string().uuid() });
const prefs = schema.conversationPrefs;
const nicks = schema.memberNicknames;

async function loadPrefs(convId: string, userId: string): Promise<ConversationPrefs> {
  const [row] = await db
    .select()
    .from(prefs)
    .where(and(eq(prefs.conversationId, convId), eq(prefs.userId, userId)))
    .limit(1);
  const nickRows = await db
    .select()
    .from(nicks)
    .where(and(eq(nicks.conversationId, convId), eq(nicks.ownerId, userId)));
  const nicknames: Record<string, string> = {};
  for (const n of nickRows) nicknames[n.targetId] = n.nickname;
  // v0.8a (§1.60): resolve the background to the full Attachment (poster
  // thumb_url included) — owner-only by construction, this read is mine.
  let background: ConversationPrefs['background'] = null;
  if (row?.backgroundAttachmentId) {
    const [att] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, row.backgroundAttachmentId))
      .limit(1);
    if (att) background = attachmentDto(att);
  }
  return {
    conversation_id: convId,
    theme: (row?.theme ?? null) as ConversationPrefs['theme'],
    wallpaper: (row?.wallpaper ?? null) as ConversationPrefs['wallpaper'],
    nicknames,
    background,
  };
}

export async function prefsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.24 GET /api/conversations/:id/prefs — mine for this conversation.
  app.get(
    '/api/conversations/:id/prefs',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      return { prefs: await loadPrefs(req.params.id, user.id) };
    },
  );

  // §1.24 PATCH /api/conversations/:id/prefs.
  app.patch(
    '/api/conversations/:id/prefs',
    { preHandler: requireAuth, schema: { params: IdParams, body: UpdatePrefsRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const convId = req.params.id;
      await requireActiveParticipant(convId, user.id);
      const b = req.body;

      // Nickname targets must be participants (past or present) of the
      // conversation (§1.24) — checked before anything is written.
      const nickEntries = Object.entries(b.nicknames ?? {});
      for (const [targetId] of nickEntries) {
        const target = await getParticipant(convId, targetId);
        if (!target) throw badRequest('bad_nickname_target');
      }

      // v0.8a (§1.60): the GIF/video chat background — MY OWN upload only,
      // validated before anything is written, else 400 bad_background: mine
      // (uploader_id = me), kind image (GIFs included, ≤ MAX_IMAGE_BYTES) or
      // video, status 'ready' (a pending video has no probed duration yet),
      // and for video within the §1.60 size/duration caps. One attachment may
      // back several of my chats; clearing is an explicit null.
      if (b.background_attachment_id !== undefined && b.background_attachment_id !== null) {
        const [att] = await db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.id, b.background_attachment_id))
          .limit(1);
        const ok =
          att !== undefined &&
          att.uploaderId === user.id &&
          att.status === 'ready' &&
          ((att.kind === 'image' && att.sizeBytes <= MAX_IMAGE_BYTES) ||
            (att.kind === 'video' &&
              att.sizeBytes <= CHAT_BG_VIDEO_MAX_BYTES &&
              att.durationMs !== null &&
              att.durationMs <= CHAT_BG_VIDEO_MAX_DURATION_S * 1000));
        if (!ok) throw badRequest('bad_background');
      }

      if (b.theme !== undefined || b.wallpaper !== undefined || b.background_attachment_id !== undefined) {
        // Upsert only the provided fields; the other columns stay as stored.
        const setTheme = b.theme !== undefined;
        const setWallpaper = b.wallpaper !== undefined;
        const setBackground = b.background_attachment_id !== undefined;
        await db.execute(sql`
          INSERT INTO conversation_prefs (conversation_id, user_id, theme, wallpaper, background_attachment_id)
          VALUES (${convId}, ${user.id}, ${b.theme ?? null}, ${b.wallpaper ?? null}, ${b.background_attachment_id ?? null})
          ON CONFLICT (conversation_id, user_id) DO UPDATE SET
            theme = ${setTheme ? sql`EXCLUDED.theme` : sql`conversation_prefs.theme`},
            wallpaper = ${setWallpaper ? sql`EXCLUDED.wallpaper` : sql`conversation_prefs.wallpaper`},
            background_attachment_id = ${setBackground ? sql`EXCLUDED.background_attachment_id` : sql`conversation_prefs.background_attachment_id`},
            updated_at = now()
        `);
      }

      for (const [targetId, nickname] of nickEntries) {
        if (nickname === null) {
          await db
            .delete(nicks)
            .where(
              and(
                eq(nicks.conversationId, convId),
                eq(nicks.ownerId, user.id),
                eq(nicks.targetId, targetId),
              ),
            );
        } else {
          await db.execute(sql`
            INSERT INTO member_nicknames (conversation_id, owner_id, target_id, nickname)
            VALUES (${convId}, ${user.id}, ${targetId}, ${nickname})
            ON CONFLICT (conversation_id, owner_id, target_id)
              DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = now()
          `);
        }
      }

      const dto = await loadPrefs(convId, user.id);
      // §2.3 prefs.updated — to the OWNER's own sockets ONLY (personal state).
      await publishToUsers([user.id], {
        t: 'prefs.updated',
        d: { conversation_id: convId, prefs: dto },
      });
      return { prefs: dto };
    },
  );
}
