// Blocks (v0.3 — API.md §1.14, ADR-009). The management surface is the
// blocker's own list; everywhere else enforcement is 404-shaped (identical to
// the resource never existing) or reuses the shared 403 group_add_denied, so
// no response ever confirms a block. Blocking does NOT leave shared groups or
// delete history.
import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { userLiteDto } from '../../lib/dto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function blockRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.14 PUT /api/users/:id/block — 204, idempotent re-block 204.
  app.put(
    '/api/users/:id/block',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      if (req.params.id === user.id) throw badRequest('block_self');
      const [target] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, req.params.id))
        .limit(1);
      if (!target) throw notFound();
      await db.execute(sql`
        INSERT INTO blocks (blocker_id, blocked_id)
        VALUES (${user.id}, ${req.params.id})
        ON CONFLICT DO NOTHING
      `);
      return reply.status(204).send();
    },
  );

  // §1.14 DELETE /api/users/:id/block — 204, idempotent.
  app.delete(
    '/api/users/:id/block',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      if (req.params.id === user.id) throw badRequest('block_self');
      await db.execute(sql`
        DELETE FROM blocks WHERE blocker_id = ${user.id} AND blocked_id = ${req.params.id}
      `);
      return reply.status(204).send();
    },
  );

  // §1.14 GET /api/users/me/blocks — my block list, newest first, UserLite
  // only (the management surface; no timestamps exposed).
  app.get('/api/users/me/blocks', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select({ u: schema.users })
      .from(schema.blocks)
      .innerJoin(schema.users, eq(schema.blocks.blockedId, schema.users.id))
      .where(eq(schema.blocks.blockerId, user.id))
      .orderBy(desc(schema.blocks.createdAt));
    return { users: rows.map((r) => userLiteDto(r.u)) };
  });
}
