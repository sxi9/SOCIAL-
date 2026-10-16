// Reports (v0.3 — API.md §1.14). An audit log for the future admin dashboard
// (FEATURES #54): targets are stored WITHOUT foreign keys so a report survives
// deletion of what it reports. No fan-out, no notification to anyone, ever.
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CreateReportRequestSchema, REPORT_RATE_PER_HOUR } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { hasJoin, isBeaconVisibleTo, loadBeacon } from '../beacons/service.js';

export async function reportRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.14 POST /api/reports — target must be referenceable by the reporter
  // (message: §1.5 visibility floor; beacon: §1.15-visible or previously
  // joined; user: exists). Rate 10/hour/user.
  app.post(
    '/api/reports',
    { preHandler: requireAuth, schema: { body: CreateReportRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`report:${user.id}`, REPORT_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const body = req.body;

      const values: typeof schema.reports.$inferInsert = {
        id: newId(),
        reporterId: user.id,
        kind: body.kind,
        reason: body.reason,
      };

      if (body.kind === 'user') {
        const [target] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, body.user_id))
          .limit(1);
        if (!target) throw notFound();
        values.targetUserId = body.user_id;
      } else if (body.kind === 'message') {
        const part = await getParticipant(body.conversation_id, user.id);
        if (!part || part.leftAt !== null) throw notFound();
        const m = schema.messages;
        const [msg] = await db
          .select({ seq: m.seq })
          .from(m)
          .where(
            and(
              eq(m.conversationId, body.conversation_id),
              eq(m.seq, body.seq),
              gt(m.seq, part.joinSeq),
            ),
          )
          .limit(1);
        if (!msg) throw notFound();
        values.targetConversationId = body.conversation_id;
        values.targetSeq = body.seq;
      } else {
        const beacon = await loadBeacon(body.beacon_id);
        if (!beacon) throw notFound();
        const referenceable =
          (await isBeaconVisibleTo(beacon, user)) || (await hasJoin(beacon.id, user.id));
        if (!referenceable) throw notFound();
        values.targetBeaconId = body.beacon_id;
      }

      const [row] = await db.insert(schema.reports).values(values).returning();
      return reply.status(201).send({ id: row!.id });
    },
  );
}
