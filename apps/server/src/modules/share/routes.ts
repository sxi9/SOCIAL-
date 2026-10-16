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
  /** Creator IP, kept so a claim can free that IP's open-stash slot. */
  ip?: string;
}

const stashKey = (id: string) => `stash:${id}`;
const stashIpKey = (ip: string) => `stash_ip:${ip}`;

/**
 * True "≤ 3 OPEN stashes per IP" accounting (API.md §1.8 / ARCHITECTURE §6),
 * not a posts-per-window approximation: a stash occupies a slot only while it
 * is unclaimed and unexpired. The slot is freed by a claim (ZREM below) or by
 * expiry (entries older than the TTL are pruned here), and failed/oversized
 * attempts never consume one (the ZADD happens only after the stash persists).
 */
async function openStashBudget(ip: string): Promise<{ open: number; retryAfterS: number }> {
  const key = stashIpKey(ip);
  const now = Date.now();
  await redis.zremrangebyscore(key, 0, now - SHARE_STASH_TTL_S * 1000);
  const open = await redis.zcard(key);
  let retryAfterS = SHARE_STASH_TTL_S;
  if (open > 0) {
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const score = Number(oldest[1] ?? now);
    retryAfterS = Math.max(1, Math.ceil((score + SHARE_STASH_TTL_S * 1000 - now) / 1000));
  }
  return { open, retryAfterS };
}

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
    const slots = await openStashBudget(req.ip);
    if (slots.open >= SHARE_STASH_MAX_PER_IP) throw rateLimited(slots.retryAfterS);

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
      ip: req.ip,
    };
    await redis.set(stashKey(stashId), JSON.stringify(payload), 'EX', SHARE_STASH_TTL_S);
    // Occupy an open-stash slot only once the stash actually exists.
    await redis.zadd(stashIpKey(req.ip), Date.now(), stashId);
    await redis.expire(stashIpKey(req.ip), SHARE_STASH_TTL_S);
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
      // Claiming frees the creator IP's open-stash slot.
      if (payload.ip) await redis.zrem(stashIpKey(payload.ip), req.body.stash_id);
      for (const f of payload.files) await deleteObject(f.key);
      return reply.status(201).send({ import: await shareImportDto(row) });
    },
  );
}
