import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PushSubscribeRequestSchema, PushUnsubscribeRequestSchema } from '@socialchat/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { ApiError } from '../../lib/errors.js';
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

  // §1.9: unconditionally 204 — the worker may already have pruned the row
  // (404/410 or 5 failures), and unsubscribing a gone endpoint is a success.
  app.delete(
    '/api/push/subscriptions',
    { preHandler: requireAuth, schema: { body: PushUnsubscribeRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      await db
        .delete(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.endpoint, req.body.endpoint),
            eq(schema.pushSubscriptions.userId, user.id),
          ),
        );
      return reply.status(204).send();
    },
  );
}
