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
  SetSharedAppearanceRequestSchema,
  SetSharedBackgroundRequestSchema,
  UpdatePrefsRequestSchema,
  type ConversationPrefs,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { attachmentDto } from '../../lib/dto.js';
import { badRequest, forbidden } from '../../lib/errors.js';
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
  // v1.0a (#95): the conversation-level shared background, served through
  // the same read clients already use for backgrounds.
  let sharedBackground: ConversationPrefs['shared_background'] = null;
  const [conv] = await db
    .select({
      bg: schema.conversations.sharedBackgroundAttachmentId,
      theme: schema.conversations.sharedTheme,
      wallpaper: schema.conversations.sharedWallpaper,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (conv?.bg) {
    const [att] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, conv.bg))
      .limit(1);
    if (att) sharedBackground = attachmentDto(att);
  }
  return {
    conversation_id: convId,
    theme: (row?.theme ?? null) as ConversationPrefs['theme'],
    wallpaper: (row?.wallpaper ?? null) as ConversationPrefs['wallpaper'],
    nicknames,
    background,
    shared_background: sharedBackground,
    // #95b: the conversation-wide palette (my theme/wallpaper above override).
    shared_theme: (conv?.theme ?? null) as ConversationPrefs['shared_theme'],
    shared_wallpaper: (conv?.wallpaper ?? null) as ConversationPrefs['shared_wallpaper'],
  };
}

/** v1.0a (#95): the §1.60 background validation, shared by the personal and
 * the conversation-wide setter — mine, image/video, ready, video caps. */
async function validateBackgroundAttachment(
  attachmentId: string,
  userId: string,
): Promise<void> {
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId))
    .limit(1);
  const ok =
    att !== undefined &&
    att.uploaderId === userId &&
    att.status === 'ready' &&
    ((att.kind === 'image' && att.sizeBytes <= MAX_IMAGE_BYTES) ||
      (att.kind === 'video' &&
        att.sizeBytes <= CHAT_BG_VIDEO_MAX_BYTES &&
        att.durationMs !== null &&
        att.durationMs <= CHAT_BG_VIDEO_MAX_DURATION_S * 1000));
  if (!ok) throw badRequest('bad_background');
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
        await validateBackgroundAttachment(b.background_attachment_id, user.id);
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

  // v1.0a (#95) PATCH /api/conversations/:id/background — the background the
  // WHOLE conversation sees. DM/channel: any active member; group: admins
  // (403 not_admin). Validation = §1.60; null clears. Fans conv.background
  // to every ACTIVE member (conversation-level state, unlike prefs.updated).
  app.patch(
    '/api/conversations/:id/background',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: SetSharedBackgroundRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await requireActiveParticipant(convId, user.id);
      const [conv] = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (!conv) throw badRequest('bad_conversation');
      if (conv.type === 'group' && part.role !== 'owner' && part.role !== 'admin') {
        throw forbidden('not_admin');
      }
      const attId = req.body.attachment_id;
      if (attId !== null) await validateBackgroundAttachment(attId, user.id);
      await db
        .update(schema.conversations)
        .set({ sharedBackgroundAttachmentId: attId })
        .where(eq(schema.conversations.id, convId));

      let background: ConversationPrefs['shared_background'] = null;
      if (attId !== null) {
        const [att] = await db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.id, attId))
          .limit(1);
        if (att) background = attachmentDto(att);
      }
      const members = await db
        .select({ userId: schema.conversationParticipants.userId })
        .from(schema.conversationParticipants)
        .where(
          and(
            eq(schema.conversationParticipants.conversationId, convId),
            sql`${schema.conversationParticipants.leftAt} IS NULL`,
          ),
        );
      await publishToUsers(
        members.map((m) => m.userId),
        { t: 'conv.background', d: { conversation_id: convId, background } },
      );
      return { background };
    },
  );

  // #95b PATCH /api/conversations/:id/appearance — theme + wallpaper the WHOLE
  // conversation sees. Same setter rule as the shared background (DM/channel:
  // any active member; group: admins → 403 not_admin). Omitted = unchanged,
  // null = clear. Fans conv.appearance to every ACTIVE member; each member's
  // own prefs.theme/wallpaper still override for their view.
  app.patch(
    '/api/conversations/:id/appearance',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: SetSharedAppearanceRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await requireActiveParticipant(convId, user.id);
      const [conv] = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (!conv) throw badRequest('bad_conversation');
      if (conv.type === 'group' && part.role !== 'owner' && part.role !== 'admin') {
        throw forbidden('not_admin');
      }
      const theme = req.body.theme === undefined ? conv.sharedTheme : req.body.theme;
      const wallpaper = req.body.wallpaper === undefined ? conv.sharedWallpaper : req.body.wallpaper;
      await db
        .update(schema.conversations)
        .set({ sharedTheme: theme, sharedWallpaper: wallpaper })
        .where(eq(schema.conversations.id, convId));
      const members = await db
        .select({ userId: schema.conversationParticipants.userId })
        .from(schema.conversationParticipants)
        .where(
          and(
            eq(schema.conversationParticipants.conversationId, convId),
            sql`${schema.conversationParticipants.leftAt} IS NULL`,
          ),
        );
      const out = {
        theme: theme as ConversationPrefs['shared_theme'],
        wallpaper: wallpaper as ConversationPrefs['shared_wallpaper'],
      };
      await publishToUsers(
        members.map((m) => m.userId),
        { t: 'conv.appearance', d: { conversation_id: convId, ...out } },
      );
      return out;
    },
  );
}
