import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ClaimShareImportRequestSchema,
  SHARE_STASH_MAX_BYTES,
  SHARE_STASH_MAX_PER_IP,
  SHARE_STASH_TTL_S,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { notFound, rateLimited, tooLarge } from '../../lib/errors.js';
import { sanitizeFileName } from '../../lib/media.js';
import { parseMultipart } from '../../lib/multipart.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { SNIFF_BYTES, sniffMime } from '../../lib/sniff.js';
import { redis } from '../../redis.js';
import { deleteObject, getObjectBuffer, putObject } from '../../s3.js';
import { authed, requireAuth } from '../auth/guard.js';
import {
  bufferRest,
  collectHead,
  processUploadBuffer,
  processUploadStream,
  type ProcessedFile,
} from '../uploads/pipeline.js';
import { createShareImport, shareImportDto } from './service.js';

const IdParams = z.object({ id: z.string().uuid() });

interface StashFile {
  key: string;
  mime: string;
  fileName: string | null;
  size: number;
}

interface StashPayload {
  title?: string;
  text?: string;
  url?: string;
  files: StashFile[];
}

const stashKey = (id: string) => `stash:${id}`;

export async function shareRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.8 POST /api/share-imports — row persisted the moment the POST lands;
  // unfurl enqueued eagerly when a URL is present.
  app.post('/api/share-imports', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    const files: ProcessedFile[] = [];
    const fields = await parseMultipart(req, async (_fieldname, file, info) => {
      files.push(await processUploadStream(file, info.filename));
    });
    const row = await createShareImport(
      user.id,
      { title: fields.title ?? fields.share_title, text: fields.text ?? fields.share_text, url: fields.url ?? fields.share_url },
      files,
    );
    return reply.status(201).send({ import: await shareImportDto(row) });
  });

  app.get(
    '/api/share-imports/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db
        .select()
        .from(schema.shareImports)
        .where(and(eq(schema.shareImports.id, req.params.id), eq(schema.shareImports.userId, user.id)))
        .limit(1);
      if (!row) throw notFound('share_import_not_found');
      return { import: await shareImportDto(row) };
    },
  );

  // §1.8 DELETE — marks consumed (composer after send, or on discard).
  app.delete(
    '/api/share-imports/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db
        .update(schema.shareImports)
        .set({ status: 'consumed', consumedAt: new Date() })
        .where(and(eq(schema.shareImports.id, req.params.id), eq(schema.shareImports.userId, user.id)))
        .returning({ id: schema.shareImports.id });
      if (!row) throw notFound('share_import_not_found');
      return reply.status(204).send();
    },
  );

  // §1.8 POST /api/share-stash — UNAUTHENTICATED, hard-limited: ≤ 30 MB total,
  // ≤ 3 open stashes/IP, 30-min Redis TTL, objects under stash/.
  app.post('/api/share-stash', async (req, reply) => {
    const rate = await fixedWindow(`stash:${req.ip}`, SHARE_STASH_MAX_PER_IP, SHARE_STASH_TTL_S);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);

    const stashId = newId();
    const stashedFiles: StashFile[] = [];
    let budget = SHARE_STASH_MAX_BYTES;

    const fields = await parseMultipart(
      req,
      async (_fieldname, file, info) => {
        if (budget <= 0) throw tooLarge();
        const head = await collectHead(file, SNIFF_BYTES);
        const buf = await bufferRest(file, head, budget);
        budget -= buf.length;
        const sniff = sniffMime(buf);
        const key = `stash/${stashId}/${stashedFiles.length}.${sniff.ext}`;
        await putObject(key, buf, sniff.mime);
        stashedFiles.push({
          key,
          mime: sniff.mime,
          fileName: sanitizeFileName(info.filename),
          size: buf.length,
        });
      },
      { maxFiles: 10 },
    );

    const payload: StashPayload = {
      title: fields.title ?? fields.share_title,
      text: fields.text ?? fields.share_text,
      url: fields.url ?? fields.share_url,
      files: stashedFiles,
    };
    await redis.set(stashKey(stashId), JSON.stringify(payload), 'EX', SHARE_STASH_TTL_S);
    return reply.status(201).send({ stash_id: stashId });
  });

  // §1.8 POST /api/share-imports/claim — promotes a stash to a real import.
  app.post(
    '/api/share-imports/claim',
    { preHandler: requireAuth, schema: { body: ClaimShareImportRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const raw = await redis.get(stashKey(req.body.stash_id));
      if (!raw) throw notFound('stash_not_found');
      const payload = JSON.parse(raw) as StashPayload;

      const files: ProcessedFile[] = [];
      for (const f of payload.files) {
        const buf = await getObjectBuffer(f.key);
        files.push(await processUploadBuffer(buf, f.fileName ?? undefined));
      }

      const row = await createShareImport(
        user.id,
        { title: payload.title, text: payload.text, url: payload.url },
        files,
      );

      await redis.del(stashKey(req.body.stash_id));
      for (const f of payload.files) await deleteObject(f.key);
      return reply.status(201).send({ import: await shareImportDto(row) });
    },
  );
}
