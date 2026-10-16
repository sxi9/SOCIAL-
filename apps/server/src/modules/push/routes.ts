import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PushSubscribeRequestSchema, PushUnsubscribeRequestSchema } from '@socialchat/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';

export async function pushRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/api/push/vapid', { preHandler: requireAuth }, async () => {
    if (!config.vapid) throw new ApiError(503, 'push_unconfigured');
    return { public_key: config.vapid.publicKey };
  });

  // §1.9 upsert by endpoint.
  app.post(
    '/api/push/subscriptions',
    { preHandler: requireAuth, schema: { body: PushSubscribeRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db
        .insert(schema.pushSubscriptions)
        .values({
          id: newId(),
          userId: user.id,
          endpoint: req.body.endpoint,
          p256dh: req.body.keys.p256dh,
          auth: req.body.keys.auth,
          userAgent: req.headers['user-agent'] ?? null,
        })
        .onConflictDoUpdate({
          target: schema.pushSubscriptions.endpoint,
          set: {
            userId: user.id,
            p256dh: req.body.keys.p256dh,
            auth: req.body.keys.auth,
            failCount: 0,
          },
        })
        .returning({ id: schema.pushSubscriptions.id });
      return reply.status(201).send({ id: row!.id });
    },
  );

  app.delete(
    '/api/push/subscriptions',
    { preHandler: requireAuth, schema: { body: PushUnsubscribeRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const deleted = await db
        .delete(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.endpoint, req.body.endpoint),
            eq(schema.pushSubscriptions.userId, user.id),
          ),
        )
        .returning({ id: schema.pushSubscriptions.id });
      if (deleted.length === 0) throw notFound('subscription_not_found');
      return reply.status(204).send();
    },
  );
}
