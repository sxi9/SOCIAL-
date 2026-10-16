// Scheduled messages & time capsules — routes (v0.4, API.md §1.26). A pending
// schedule is PRIVATE: only the author can see it exists; every state change
// emits scheduled.updated to the author's own sockets for cross-device sync.
// A time capsule is the same row with metadata.capsule = true.
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateScheduledRequestSchema,
  SCHEDULED_CREATE_RATE_PER_HOUR,
  SCHEDULED_MAX_HORIZON_S,
  SCHEDULED_MIN_LEAD_S,
  SCHEDULED_PENDING_MAX_PER_USER,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds } from '../../lib/dto.js';
import { badRequest, conflict, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueScheduledDelivery } from '../../queues.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import {
  loadScheduledAttachments,
  publishScheduledUpdated,
  scheduledDto,
  type ScheduledRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const sm = schema.scheduledMessages;

async function findByClientMsgId(authorId: string, clientMsgId: string): Promise<ScheduledRow | null> {
  const [row] = await db
    .select()
    .from(sm)
    .where(and(eq(sm.authorId, authorId), sql`${sm.clientMsgId} = ${clientMsgId}::uuid`))
    .limit(1);
  return row ?? null;
}

async function toDto(row: ScheduledRow) {
  const atts = await loadScheduledAttachments([row.id]);
  return scheduledDto(row, atts.get(row.id) ?? []);
}

export async function scheduledRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.26 POST /api/conversations/:id/scheduled-messages.
  app.post(
    '/api/conversations/:id/scheduled-messages',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateScheduledRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound('conversation_not_found');

      // §1.14: a DM frozen by a block refuses schedules 404-shaped, like sends
      // (delivery re-checks again at send time anyway).
      const [conv] = await db
        .select({ type: schema.conversations.type })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (conv?.type === 'dm') {
        const peer = (await activeParticipantUserIds(convId)).find((id) => id !== user.id);
        if (peer && (await isBlockedPair(user.id, peer))) throw notFound('conversation_not_found');
      }

      const body = req.body;
      const replay = await findByClientMsgId(user.id, body.client_msg_id);
      if (replay) return reply.status(200).send({ scheduled: await toDto(replay) });

      const deliverAt = new Date(body.deliver_at);
      const now = Date.now();
      if (
        deliverAt.getTime() < now + SCHEDULED_MIN_LEAD_S * 1000 ||
        deliverAt.getTime() > now + SCHEDULED_MAX_HORIZON_S * 1000
      ) {
        throw badRequest('deliver_at_out_of_range');
      }

      const text = body.body?.trim() ? body.body : null;
      const attachmentIds = body.attachment_ids ?? [];
      if (body.type === 'audio' && attachmentIds.length !== 1) {
        throw badRequest('audio_attachment_required');
      }
      if (body.type !== 'text' && body.type !== 'audio' && attachmentIds.length === 0) {
        throw badRequest('missing_attachments');
      }
      if (!text && attachmentIds.length === 0) throw badRequest('empty_message');

      const rate = await fixedWindow(`schedcreate:${user.id}`, SCHEDULED_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const metadata: Record<string, unknown> = {};
      if (body.metadata?.effect) metadata.effect = body.metadata.effect;
      if (body.metadata?.capsule) metadata.capsule = true;

      let row: ScheduledRow;
      try {
        row = await db.transaction(async (tx) => {
          // Advisory lock serializes this author's creates so the 50-pending
          // cap cannot be overshot by concurrent requests.
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${'sched:' + user.id}, 0))
          `);
          const pending = (await tx.execute(sql`
            SELECT count(*)::int AS n FROM scheduled_messages
            WHERE author_id = ${user.id} AND status = 'pending'
          `)) as unknown as { n: number }[];
          if ((pending[0]?.n ?? 0) >= SCHEDULED_PENDING_MAX_PER_USER) {
            throw conflict('scheduled_limit');
          }

          const [inserted] = await tx
            .insert(sm)
            .values({
              id: newId(),
              conversationId: convId,
              authorId: user.id,
              clientMsgId: body.client_msg_id,
              type: body.type,
              body: text,
              metadata,
              deliverAt,
            })
            .returning();

          if (attachmentIds.length > 0) {
            // Mine, unbound (not on a message, not on another schedule);
            // binding shields them from the orphan GC while they wait.
            const bound = (await tx.execute(sql`
              UPDATE attachments SET scheduled_message_id = ${inserted!.id}, share_import_id = NULL
              WHERE id IN (${sql.join(attachmentIds.map((id) => sql`${id}::uuid`), sql`, `)})
                AND uploader_id = ${user.id}
                AND message_id IS NULL AND scheduled_message_id IS NULL
              RETURNING id, kind, status
            `)) as unknown as { id: string; kind: string; status: string }[];
            if (bound.length !== attachmentIds.length) throw badRequest('invalid_attachments');
            // 'failed' = the worker rejected it (§1.20 duration cap) — never
            // bindable; 'pending' is fine (hydrates before/after delivery).
            if (
              body.type === 'audio' &&
              (bound.length !== 1 || bound[0]!.kind !== 'audio' || bound[0]!.status === 'failed')
            ) {
              throw badRequest('audio_attachment_required');
            }
          }
          return inserted!;
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          const raced = await findByClientMsgId(user.id, body.client_msg_id);
          if (raced) return reply.status(200).send({ scheduled: await toDto(raced) });
        }
        throw err;
      }

      // Delayed delivery job; the minute sweep is the safety net.
      await enqueueScheduledDelivery(row.id, deliverAt.getTime() - Date.now());
      await publishScheduledUpdated(row);
      return reply.status(201).send({ scheduled: await toDto(row) });
    },
  );

  // §1.26 GET /api/scheduled-messages — mine only, all conversations: pending
  // first by deliver_at ASC, then the latest 50 non-pending.
  app.get('/api/scheduled-messages', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const pending = await db
      .select()
      .from(sm)
      .where(and(eq(sm.authorId, user.id), eq(sm.status, 'pending')))
      .orderBy(sql`${sm.deliverAt} ASC`);
    const done = await db
      .select()
      .from(sm)
      .where(and(eq(sm.authorId, user.id), sql`${sm.status} <> 'pending'`))
      .orderBy(desc(sm.createdAt))
      .limit(50);
    const rows = [...pending, ...done];
    const atts = await loadScheduledAttachments(rows.map((r) => r.id));
    return { scheduled: rows.map((r) => scheduledDto(r, atts.get(r.id) ?? [])) };
  });

  // §1.26 DELETE /api/scheduled-messages/:id — cancel; idempotent re-cancel.
  app.delete(
    '/api/scheduled-messages/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db
        .select()
        .from(sm)
        .where(and(eq(sm.id, req.params.id), eq(sm.authorId, user.id)))
        .limit(1);
      if (!row) throw notFound();
      if (row.status === 'sent') throw conflict('scheduled_sent');
      if (row.status === 'cancelled') return reply.status(204).send();

      // Guarded: a concurrent delivery may claim first — then it is sent.
      const [cancelled] = await db
        .update(sm)
        .set({ status: 'cancelled' })
        .where(and(eq(sm.id, req.params.id), eq(sm.status, 'pending')))
        .returning();
      if (!cancelled) throw conflict('scheduled_sent');

      // Unbind + orphan the attachments for the nightly GC.
      await db.execute(sql`
        UPDATE attachments SET scheduled_message_id = NULL
        WHERE scheduled_message_id = ${req.params.id} AND message_id IS NULL
      `);
      await publishScheduledUpdated(cancelled);
      return reply.status(204).send();
    },
  );
}
