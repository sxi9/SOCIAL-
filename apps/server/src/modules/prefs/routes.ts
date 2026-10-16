// Chat themes, wallpapers & nicknames (v0.4 — API.md §1.24, ADR-010).
// ALL PERSONAL: per (conversation, user), visible to that user only, synced
// across their devices via prefs.updated (OWN sockets only — no other
// participant ever receives a frame about them). PATCH semantics: omitted =
// unchanged; explicit null resets a theme/wallpaper or removes a nickname.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UpdatePrefsRequestSchema, type ConversationPrefs } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
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
  return {
    conversation_id: convId,
    theme: (row?.theme ?? null) as ConversationPrefs['theme'],
    wallpaper: (row?.wallpaper ?? null) as ConversationPrefs['wallpaper'],
    nicknames,
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

      if (b.theme !== undefined || b.wallpaper !== undefined) {
        // Upsert only the provided fields; the other column stays as stored.
        const setTheme = b.theme !== undefined;
        const setWallpaper = b.wallpaper !== undefined;
        await db.execute(sql`
          INSERT INTO conversation_prefs (conversation_id, user_id, theme, wallpaper)
          VALUES (${convId}, ${user.id}, ${b.theme ?? null}, ${b.wallpaper ?? null})
          ON CONFLICT (conversation_id, user_id) DO UPDATE SET
            theme = ${setTheme ? sql`EXCLUDED.theme` : sql`conversation_prefs.theme`},
            wallpaper = ${setWallpaper ? sql`EXCLUDED.wallpaper` : sql`conversation_prefs.wallpaper`},
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
