import { and, asc, desc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ListMessagesQuerySchema,
  PUZZLE_MAX_GUESSES,
  SendMessageRequestSchema,
  VIBE_CHECK_PROMPT_MAX_CHARS,
  type MessageMetadata,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, messageDtos, userLiteDto } from '../../lib/dto.js';
import { ApiError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { extractFirstUrl } from '../../lib/urls.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import {
  lookupPreview,
  previewDto,
  requestUnfurl,
  type PreviewLookup,
} from '../previews/service.js';
import { parseGuesses, utcToday } from '../puzzle/service.js';
import { fanOutNewMessage, insertMessage, publishMessageUpdated } from './service.js';

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

      let text = body.body?.trim() ? body.body : null;
      let attachmentIds = body.attachment_ids ?? [];
      const rider = body.metadata ?? {};
      const isStampReply = rider.stamp === true;
      const isVibeReply = rider.vibe_reply_seq !== undefined;
      const metadata: MessageMetadata = {};

      // ---- v0.4 metadata riders, cross-validated (§1.21–§1.23, §1.27) ----
      // §1.21: doodle flags an ordinary PNG image message — image only.
      if (rider.doodle && body.type !== 'image') throw badRequest('bad_metadata');
      // §1.23: a stamp reply is valid only alongside vibe_reply_seq, and is
      // exactly {type:'text', no body, no attachments} — the tile is my avatar.
      if (isStampReply && !isVibeReply) throw badRequest('bad_metadata');
      if (isStampReply && (body.type !== 'text' || text !== null || attachmentIds.length > 0)) {
        throw badRequest('bad_metadata');
      }
      // §1.23: reply shapes are image (photo/doodle) or the stamp tile.
      if (isVibeReply && !isStampReply && body.type !== 'image') throw badRequest('bad_vibe_reply');
      if (isVibeReply) {
        // Must reference a visible (§1.5 floor), non-deleted vibe_check message
        // in this conversation → else 404 not_found.
        const [parent] = await db
          .select({ seq: m.seq })
          .from(m)
          .where(
            and(
              eq(m.conversationId, convId),
              eq(m.seq, rider.vibe_reply_seq!),
              gt(m.seq, part.joinSeq),
              eq(m.type, 'vibe_check'),
              isNull(m.deletedAt),
            ),
          )
          .limit(1);
        if (!parent) throw notFound();
        metadata.vibe_reply_seq = rider.vibe_reply_seq;
        if (isStampReply) metadata.stamp = true;
      }
      if (rider.doodle) metadata.doodle = true;
      // §1.22: sender-confirmed effect (consent is client-side but binding —
      // the server merely stores the confirmed value; the DB CHECK pins the set).
      if (rider.effect) metadata.effect = rider.effect;

      // §1.23: a vibe check's body IS the prompt.
      if (body.type === 'vibe_check') {
        if (!text) throw badRequest('prompt_required');
        if (text.length > VIBE_CHECK_PROMPT_MAX_CHARS) throw badRequest('prompt_required');
      }

      if (body.type === 'puzzle_result') {
        // §1.27: the server builds metadata.puzzle from MY stored attempt —
        // client body/attachments/metadata.puzzle are ignored (unforgeable).
        const today = utcToday();
        const [attempt] = await db
          .select()
          .from(schema.puzzleAttempts)
          .where(
            and(
              eq(schema.puzzleAttempts.userId, user.id),
              eq(schema.puzzleAttempts.puzzleDate, today),
            ),
          )
          .limit(1);
        const guesses = parseGuesses(attempt?.guesses);
        if (!attempt || (!attempt.solved && guesses.length < PUZZLE_MAX_GUESSES)) {
          throw conflict('puzzle_unfinished');
        }
        text = null;
        attachmentIds = [];
        metadata.puzzle = {
          date: today,
          attempts_used: guesses.length,
          solved: attempt.solved,
          grid: guesses.map((g) => g.score),
        };
      } else {
        const needsAttachment =
          body.type === 'image' || body.type === 'video' || body.type === 'file' || body.type === 'audio';
        if (needsAttachment && attachmentIds.length === 0) {
          throw badRequest(body.type === 'audio' ? 'audio_attachment_required' : 'missing_attachments');
        }
        if (!needsAttachment && !text && attachmentIds.length === 0 && !isStampReply) {
          throw badRequest('empty_message');
        }
      }

      // §1.20: a voice note is exactly ONE audio attachment.
      if (body.type === 'audio') {
        if (attachmentIds.length !== 1) throw badRequest('audio_attachment_required');
        const [att] = await db
          .select({ kind: schema.attachments.kind, status: schema.attachments.status })
          .from(schema.attachments)
          .where(
            and(
              eq(schema.attachments.id, attachmentIds[0]!),
              eq(schema.attachments.uploaderId, user.id),
              isNull(schema.attachments.messageId),
            ),
          )
          .limit(1);
        // status 'failed' = the worker's MAX_AUDIO_DURATION_S ffprobe cap (or a
        // probe error) rejected the recording — binding it would make the 5-min
        // cap advisory ('pending' is fine: the waveform hydrates via msg.updated).
        if (!att || att.kind !== 'audio' || att.status === 'failed') {
          throw badRequest('audio_attachment_required');
        }
      }

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
          // §1.23: ONE reply per user per vibe check. The seq transaction's
          // conversations-row lock serializes all senders in the conversation,
          // so this in-transaction recheck is race-free; a duplicate rolls the
          // whole insert (and its seq bump) back → 409 vibe_already_replied.
          withinTx: isVibeReply
            ? async (tx, inserted) => {
                const dup = (await tx.execute(sql`
                  SELECT 1 AS one FROM messages
                  WHERE conversation_id = ${convId} AND sender_id = ${user.id}
                    AND deleted_at IS NULL AND id <> ${inserted.id}
                    AND (metadata->>'vibe_reply_seq')::bigint = ${rider.vibe_reply_seq!}::bigint
                  LIMIT 1
                `)) as unknown as { one: number }[];
                if (dup.length > 0) throw conflict('vibe_already_replied');
              }
            : undefined,
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

      await fanOutNewMessage(msg);

      // §1.23: every accepted vibe reply ALSO re-ships the vibe message as a
      // full-DTO msg.updated, so the collage strip grows live.
      if (isVibeReply) {
        const [parentRow] = await db
          .select()
          .from(m)
          .where(and(eq(m.conversationId, convId), eq(m.seq, rider.vibe_reply_seq!)))
          .limit(1);
        if (parentRow) await publishMessageUpdated(parentRow);
      }

      // Viewer-scoped response (reactions.mine / poll.my_vote / vibe.my_reply_seq).
      const [dto] = await messageDtos([msg], user.id);
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
