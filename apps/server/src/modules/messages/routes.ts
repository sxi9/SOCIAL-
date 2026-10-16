import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ListMessagesQuerySchema,
  type MessageMetadata,
  SendMessageRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { messageDtos } from '../../lib/dto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { extractFirstUrl } from '../../lib/urls.js';
import { enqueueUnfurl } from '../../queues.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { lookupPreview, markPending, previewDto } from '../previews/service.js';
import { fanOutNewMessage, insertMessage } from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const m = schema.messages;

export async function messageRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.5 GET messages — index-only walk of (conversation_id, seq) with the
  // join_seq visibility floor; departed members see history up to their leave.
  app.get(
    '/api/conversations/:id/messages',
    { preHandler: requireAuth, schema: { params: IdParams, querystring: ListMessagesQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const part = await getParticipant(req.params.id, user.id);
      if (!part) throw notFound('conversation_not_found');

      const conditions = [eq(m.conversationId, req.params.id), gt(m.seq, part.joinSeq)];
      if (part.leftAt !== null) {
        // Departed members see a clean seq prefix: seq <= seq at left_at
        // (left_seq is stamped from conversations.last_seq at leave time).
        conditions.push(lte(m.seq, part.leftSeq ?? 0));
      }

      const { after_seq, before_seq, limit } = req.query;
      let rows;
      if (after_seq !== undefined) {
        conditions.push(gt(m.seq, after_seq));
        rows = await db
          .select()
          .from(m)
          .where(and(...conditions))
          .orderBy(asc(m.seq))
          .limit(limit);
      } else {
        conditions.push(lt(m.seq, before_seq!));
        rows = await db
          .select()
          .from(m)
          .where(and(...conditions))
          .orderBy(desc(m.seq))
          .limit(limit);
      }
      return { messages: await messageDtos(rows) };
    },
  );

  // §1.5 POST message — REST-only durable send with client_msg_id idempotency.
  app.post(
    '/api/conversations/:id/messages',
    { preHandler: requireAuth, schema: { params: IdParams, body: SendMessageRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound('conversation_not_found');

      const body = req.body;
      const replay = await findByClientMsgId(convId, user.id, body.client_msg_id);
      if (replay) return reply.status(200).send({ message: replay });

      const text = body.body?.trim() ? body.body : null;
      const attachmentIds = body.attachment_ids ?? [];
      if (!text && attachmentIds.length === 0) throw badRequest('empty_message');
      if (body.type !== 'text' && attachmentIds.length === 0) throw badRequest('missing_attachments');

      const metadata: MessageMetadata = {};
      let pendingUnfurl: { url: string; hash: string } | null = null;

      if (body.metadata?.link_preview) {
        // Snapshot is validated against (and built from) the cache row, never
        // trusted from the client (API.md §1.5).
        let lookup;
        try {
          lookup = await lookupPreview(body.metadata.link_preview.url);
        } catch {
          throw badRequest('invalid_link_preview');
        }
        if (lookup.state !== 'ok' || !lookup.row) throw badRequest('invalid_link_preview');
        metadata.link_preview = previewDto(lookup.row);
      } else if (text) {
        // Any message body (text or media caption) gets the extraction
        // fallback (API.md §1.5): "first URL from body when no snapshot".
        const url = extractFirstUrl(text);
        if (url) {
          try {
            const lookup = await lookupPreview(url);
            if (lookup.state === 'ok' && lookup.row) {
              metadata.link_preview = previewDto(lookup.row);
            } else if (lookup.state !== 'failed') {
              if (lookup.state === 'miss') await markPending(lookup.hash, lookup.normalized);
              pendingUnfurl = { url: lookup.normalized, hash: lookup.hash };
            }
          } catch {
            // unparseable URL — no card
          }
        }
      }

      let msg;
      try {
        msg = await insertMessage({
          conversationId: convId,
          senderId: user.id,
          clientMsgId: body.client_msg_id,
          type: body.type,
          body: text,
          metadata,
          attachmentIds,
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          const raced = await findByClientMsgId(convId, user.id, body.client_msg_id);
          if (raced) return reply.status(200).send({ message: raced });
        }
        throw err;
      }

      if (pendingUnfurl) {
        // Recipients get the card later via msg.updated (worker hydration).
        await enqueueUnfurl({
          url: pendingUnfurl.url,
          url_hash: pendingUnfurl.hash,
          requested_by: user.id,
          message: { id: msg.id, conversation_id: convId },
        });
      }

      const dto = await fanOutNewMessage(msg);
      return reply.status(201).send({ message: dto });
    },
  );
}

async function findByClientMsgId(convId: string, senderId: string, clientMsgId: string) {
  const [row] = await db
    .select()
    .from(m)
    .where(
      and(
        eq(m.conversationId, convId),
        eq(m.senderId, senderId),
        sql`${m.clientMsgId} = ${clientMsgId}::uuid`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const [dto] = await messageDtos([row]);
  return dto ?? null;
}
