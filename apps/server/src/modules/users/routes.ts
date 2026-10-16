import { eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  UpdateMeRequestSchema,
  USER_SEARCH_LIMIT,
  UserSearchQuerySchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { avatarDto, coParticipantUserIds, userPrivateDto, userPublicDto } from '../../lib/dto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseMultipart } from '../../lib/multipart.js';
import { enqueueAvatar } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { stashAvatarSource } from '../uploads/pipeline.js';

async function broadcastUserUpdated(userId: string): Promise<void> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!row) return;
  const peers = await coParticipantUserIds(userId);
  await publishToUsers(peers, { t: 'user.updated', d: { user: userPublicDto(row) } });
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/api/users/me', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { user: userPrivateDto(user) };
  });

  app.patch(
    '/api/users/me',
    { preHandler: requireAuth, schema: { body: UpdateMeRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const patch: Partial<typeof schema.users.$inferInsert> = { updatedAt: new Date() };
      if (req.body.display_name !== undefined) patch.displayName = req.body.display_name;
      if (req.body.bio !== undefined) patch.bio = req.body.bio;
      if (req.body.avatar_motion !== undefined) patch.avatarMotion = req.body.avatar_motion;
      const [updated] = await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, user.id))
        .returning();
      await broadcastUserUpdated(user.id);
      return { user: userPrivateDto(updated!) };
    },
  );

  // §1.2 avatar upload → 202, completion arrives as WS user.updated.
  app.post('/api/users/me/avatar', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    let stashed: { rawKey: string; mime: string } | null = null;
    await parseMultipart(
      req,
      async (fieldname, file, _info) => {
        if (fieldname !== 'file' || stashed) {
          file.resume();
          return;
        }
        stashed = await stashAvatarSource(file);
      },
      { maxFiles: 1 },
    );
    const result = stashed as { rawKey: string; mime: string } | null;
    if (!result) throw badRequest('missing_file');

    const [updated] = await db
      .update(schema.users)
      .set({ avatarStatus: 'processing', updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .returning();
    await enqueueAvatar({ target: { user_id: user.id }, raw_key: result.rawKey, mime: result.mime });
    return reply.status(202).send({ avatar: avatarDto(updated!) });
  });

  app.delete('/api/users/me/avatar', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const [updated] = await db
      .update(schema.users)
      .set({
        avatarStatus: 'none',
        avatarStaticKey: null,
        avatarAnimatedKey: null,
        avatarVersion: sql`${schema.users.avatarVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, user.id))
      .returning();
    await broadcastUserUpdated(user.id);
    return { avatar: avatarDto(updated!) };
  });

  // §1.2 user search — prefix ILIKE on username/display_name, limit 20.
  app.get(
    '/api/users',
    { preHandler: requireAuth, schema: { querystring: UserSearchQuerySchema } },
    async (req) => {
      const q = req.query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      const rows = await db
        .select()
        .from(schema.users)
        .where(or(ilike(schema.users.username, `${q}%`), ilike(schema.users.displayName, `${q}%`)))
        .limit(USER_SEARCH_LIMIT);
      return { users: rows.map(userPublicDto) };
    },
  );

  app.get(
    '/api/users/:username',
    { preHandler: requireAuth, schema: { params: z.object({ username: z.string() }) } },
    async (req) => {
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!row) throw notFound('user_not_found');
      return { user: userPublicDto(row) };
    },
  );
}
