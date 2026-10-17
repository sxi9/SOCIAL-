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
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import {
  avatarDto,
  coParticipantUserIds,
  publishUserUpdated,
  userPrivateDto,
  userPublicDto,
  viewCtxFor,
} from '../../lib/dto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseMultipart } from '../../lib/multipart.js';
import { enqueueAvatar } from '../../queues.js';
import { authed, requireAuth } from '../auth/guard.js';
import { loadTrust } from '../listings/reviews.js';
import { loadProfile } from '../profiles/routes.js';
import { stashAvatarSource } from '../uploads/pipeline.js';

async function broadcastUserUpdated(userId: string): Promise<void> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!row) return;
  const peers = await coParticipantUserIds(userId);
  // §1.14: blocked co-members get the frame with last_seen_at clamped.
  await publishUserUpdated(row, peers);
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
      // v0.3 (§1.13): self-declared coarse area — identity, not a setting.
      // OWNER-PRIVATE (UserPrivate only, FEATURES #30); null clears it (and
      // with it all 'area' beacon visibility, both directions).
      if (req.body.area !== undefined) patch.area = req.body.area;
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
  // §1.14: blocked pairs are excluded in BOTH directions (the blocker manages
  // the relationship from GET /api/users/me/blocks).
  app.get(
    '/api/users',
    { preHandler: requireAuth, schema: { querystring: UserSearchQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const q = req.query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      const blocked = await blockedSetOf(user.id);
      const rows = await db
        .select()
        .from(schema.users)
        .where(or(ilike(schema.users.username, `${q}%`), ilike(schema.users.displayName, `${q}%`)))
        .limit(USER_SEARCH_LIMIT + blocked.size);
      const ctx = await viewCtxFor(user);
      return {
        users: rows
          // §1.41: banned accounts are publicly invisible — search included.
          .filter((row) => !blocked.has(row.id) && row.bannedAt === null)
          .slice(0, USER_SEARCH_LIMIT)
          .map((row) => userPublicDto(row, ctx)),
      };
    },
  );

  app.get(
    '/api/users/:username',
    { preHandler: requireAuth, schema: { params: z.object({ username: z.string() }) } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!row) throw notFound('user_not_found');
      // §1.41: a banned account's profile 404s for everyone but its owner —
      // byte-identical to never existing (serialization-side; unban restores).
      if (row.id !== user.id && row.bannedAt !== null) throw notFound('user_not_found');
      // §1.14: profile 404 in BOTH directions — identical to never existing.
      if (await isBlockedPair(user.id, row.id)) throw notFound('user_not_found');
      // v0.5a (§1.37): the profile page grows a `profile` sibling — additive;
      // UserPublic itself stays lean (it rides every participant list).
      // v0.5b (§1.40): + `trust` — count/avg over ALL reviews, recent minus
      // reviewers blocked w.r.t. the viewer (§2.11 serialization filtering).
      return {
        user: userPublicDto(row, await viewCtxFor(user)),
        profile: await loadProfile(row.id, row.interests),
        trust: await loadTrust(row.id, user.id),
      };
    },
  );
}
