import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ListMessagesQuerySchema,
  type MessageMetadata,
  SendMessageRequestSchema,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, messageDtos, userLiteDto } from '../../lib/dto.js';
import { ApiError, badRequest, notFound } from '../../lib/errors.js';
import { extractFirstUrl } from '../../lib/urls.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import {
  lookupPreview,
  previewDto,
  requestUnfurl,
  type PreviewLookup,
} from '../previews/service.js';
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
      // Viewer-scoped DTOs: reactions[].mine is personal (API.md §1.12).
      return { messages: await messageDtos(rows, user.id) };
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

      // §1.14: an existing DM between a blocked pair stays readable but is
      // FROZEN — sends answer 404, byte-identical to an unknown conversation,
      // in both directions.
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
      const replay = await findByClientMsgId(convId, user.id, body.client_msg_id);
      if (replay) return reply.status(200).send({ message: replay });

      const text = body.body?.trim() ? body.body : null;
      const attachmentIds = body.attachment_ids ?? [];
      if (!text && attachmentIds.length === 0) throw badRequest('empty_message');
      if (body.type !== 'text' && attachmentIds.length === 0) throw badRequest('missing_attachments');

      const metadata: MessageMetadata = {};
      let pendingUnfurl: PreviewLookup | null = null;

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
              pendingUnfurl = lookup; // miss or in-flight — resolved below
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
        // Shared chokepoint: charges the 30/hour/user unfurl budget. Over
        // budget the message still sends fine — the unfurl is simply not
        // enqueued (no card). Recipients otherwise get the card later via
        // msg.updated (worker hydration).
        await requestUnfurl({
          userId: user.id,
          lookup: pendingUnfurl,
          message: { id: msg.id, conversation_id: convId },
        });
      }

      const dto = await fanOutNewMessage(msg);
      return reply.status(201).send({ message: dto });
    },
  );

  // §1.18 GET .../messages/:seq/receipts — seen-by lists, computed from the
  // §2.5 watermarks (zero new state). NO timestamps anywhere in the response;
  // both lists ordered by USERNAME, never recency (a "seen 43 min ago"
  // timestamp turns a receipt into a reply deadline — PSYCHOLOGY never-build).
  app.get(
    '/api/conversations/:id/messages/:seq/receipts',
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid(), seq: z.coerce.number().int().positive() }),
      },
    },
    async (req) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      // Reciprocity (§1.13c): a receipts-off viewer gets no seen-by lists.
      if (!user.readReceipts) throw new ApiError(403, 'read_receipts_off');

      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound();
      const [msg] = await db
        .select({ seq: m.seq, senderId: m.senderId })
        .from(m)
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, part.joinSeq)))
        .limit(1);
      if (!msg) throw notFound();

      const cp = schema.conversationParticipants;
      const rows = await db
        .select({ p: cp, u: schema.users })
        .from(cp)
        .innerJoin(schema.users, eq(cp.userId, schema.users.id))
        .where(and(eq(cp.conversationId, convId), sql`${cp.leftAt} IS NULL`));
      const blocked = await blockedSetOf(user.id);

      const seen: { username: string; lite: UserLite }[] = [];
      const delivered: { username: string; lite: UserLite }[] = [];
      for (const { p, u } of rows) {
        if (u.id === msg.senderId) continue; // sender excluded
        if (blocked.has(u.id)) continue; // blocked pairs omitted (§1.14)
        // Receipts-off users cap at `delivered`, whatever their true state.
        if (u.readReceipts && p.lastReadSeq >= seq) {
          seen.push({ username: u.username, lite: userLiteDto(u) });
        } else if (p.lastDeliveredSeq >= seq) {
          delivered.push({ username: u.username, lite: userLiteDto(u) });
        }
      }
      const byUsername = (a: { username: string }, b: { username: string }) =>
        a.username.toLowerCase().localeCompare(b.username.toLowerCase());
      seen.sort(byUsername);
      delivered.sort(byUsername);
      return { seen: seen.map((s) => s.lite), delivered: delivered.map((d) => d.lite) };
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
  const [dto] = await messageDtos([row], senderId);
  return dto ?? null;
}
