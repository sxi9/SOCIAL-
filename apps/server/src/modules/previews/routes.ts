import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreatePreviewRequestSchema } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { badRequest, notFound, rateLimited } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import { addPreviewWaiter, lookupPreview, previewDto, requestUnfurl } from './service.js';

export async function previewRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.7 POST /api/previews — cache lookup; the fetch runs in the WORKER,
  // never the API process. Rate 30/hour/user.
  app.post(
    '/api/previews',
    { preHandler: requireAuth, schema: { body: CreatePreviewRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      let lookup;
      try {
        lookup = await lookupPreview(req.body.url);
      } catch {
        throw badRequest('bad_url');
      }

      if (lookup.state === 'ok' && lookup.row) {
        return reply
          .status(200)
          .send({ status: 'ok', url_hash: lookup.hash, preview: previewDto(lookup.row) });
      }
      if (lookup.state === 'failed') {
        // Negative-cached (1h) — stops retry storms.
        return reply.status(200).send({ status: 'failed', url_hash: lookup.hash });
      }
      // Shared chokepoint: charges the 30/hour/user budget and enqueues.
      const result = await requestUnfurl({ userId: user.id, lookup });
      if (result.outcome === 'rate_limited') throw rateLimited(result.retryAfterS);
      // Whoever gets a 202 (first requester or a later one landing on an
      // in-flight row) is owed the preview.ready WS event.
      await addPreviewWaiter(lookup.hash, user.id);
      return reply.status(202).send({ status: 'pending', url_hash: lookup.hash });
    },
  );

  // §1.7 GET /api/previews/:url_hash — poll fallback.
  app.get(
    '/api/previews/:url_hash',
    {
      preHandler: requireAuth,
      schema: { params: z.object({ url_hash: z.string().regex(/^[0-9a-f]{64}$/) }) },
    },
    async (req) => {
      const [row] = await db
        .select()
        .from(schema.linkPreviews)
        .where(eq(schema.linkPreviews.urlHash, req.params.url_hash))
        .limit(1);
      if (!row) throw notFound('preview_not_found');
      if (row.status === 'ok') return { status: 'ok', preview: previewDto(row) };
      return { status: row.status };
    },
  );
}
