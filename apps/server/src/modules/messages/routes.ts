import { and, asc, desc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EDIT_WINDOW_S,
  EDITABLE_MESSAGE_TYPES,
  EditMessageRequestSchema,
  FORWARDABLE_MESSAGE_TYPES,
  ForwardMessageRequestSchema,
  ListMessagesQuerySchema,
  MOOD_DRUNK_UNDO_SLACK_S,
  MOOD_DRUNK_UNDO_WINDOW_S,
  PUZZLE_MAX_GUESSES,
  SendMessageRequestSchema,
  VIBE_CHECK_PROMPT_MAX_CHARS,
  type ForwardedFrom,
  type Message,
  type MessageMetadata,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, messageDtos, userLiteDto, type AttRow, type MsgRow } from '../../lib/dto.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { extractFirstUrl } from '../../lib/urls.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import {
  lookupPreview,
  previewDto,
  requestUnfurl,
  type PreviewLookup,
} from '../previews/service.js';
import { parseGuesses, utcToday } from '../puzzle/service.js';
import { publishConversationToUsers } from '../../lib/dto.js';
import {
  fanOutNewMessage,
  insertMessage,
  publishMessageUpdated,
  requireSendContext,
  resolveMentions,
} from './service.js';

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
      // §1.14 frozen DMs + §1.35 channel send permission (owner/admin only
      // → 403 channel_read_only), in 404-shape order.
      const { part } = await requireSendContext(convId, user.id);

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
      // ---- v0.7 §1.52: the 'location' drop ("📍 join me here") ----
      // metadata.location required on type 'location' (400 location_required);
      // location/join_me riders invalid on every other type (400 bad_metadata).
      if (body.type === 'location') {
        if (!rider.location) throw badRequest('location_required');
        metadata.location = rider.location;
        if (rider.join_me) metadata.join_me = true;
      } else if (rider.location !== undefined || rider.join_me !== undefined) {
        throw badRequest('bad_metadata');
      }
      if (rider.doodle) metadata.doodle = true;
      // §1.22: sender-confirmed effect (consent is client-side but binding —
      // the server merely stores the confirmed value; the DB CHECK pins the set).
      if (rider.effect) metadata.effect = rider.effect;

      // ---- v0.5a §1.29: reply_to_seq — the target must exist within my §1.5
      // visibility floor (tombstoned targets ARE repliable: the context
      // renders "message deleted"); it must be an earlier seq by construction
      // (DB CHECK reply_to_seq < seq — the fresh seq is always larger).
      const replyToSeq = body.reply_to_seq ?? null;
      if (replyToSeq !== null) {
        const [target] = await db
          .select({ seq: m.seq })
          .from(m)
          .where(and(eq(m.conversationId, convId), eq(m.seq, replyToSeq), gt(m.seq, part.joinSeq)))
          .limit(1);
        if (!target) throw notFound();
      }

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
        // v0.7 (§1.52): a location drop is complete without a body — the pin
        // itself is the content; the note stays optional.
        if (
          !needsAttachment &&
          !text &&
          attachmentIds.length === 0 &&
          !isStampReply &&
          body.type !== 'location'
        ) {
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

      // ---- v0.5a §1.33: SERVER-parsed mentions against active participants.
      // Client-sent mention values never exist (the schema has no field); the
      // tokens live in the body and the server is the only metadata writer.
      if (text) {
        const mentions = await resolveMentions(convId, text);
        if (mentions.length > 0) metadata.mentions = mentions;
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
          replyToSeq,
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
      // v0.5a (§1.35): NO seen-by exposure in channels — watermarks still
      // drive unread counts, but min-watermark math over 10k members is
      // neither cheap nor wanted.
      const [convRow] = await db
        .select({ type: schema.conversations.type })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (convRow?.type === 'channel') throw new ApiError(403, 'channel_no_receipts');
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

  // ---------------------------------------------------------------------------
  // v0.5a §1.30 — edit & delete.
  // ---------------------------------------------------------------------------

  const SeqParams = z.object({
    id: z.string().uuid(),
    seq: z.coerce.number().int().positive(),
  });

  /** Active participant + §1.14 frozen-DM gate (404-shaped), WITHOUT the
   * channel send gate: edit/delete are authorship surfaces (§1.30 — in
   * channels the same rules apply to the senders' own messages). */
  async function requireUnfrozenParticipant(convId: string, userId: string) {
    const part = await getParticipant(convId, userId);
    if (!part || part.leftAt !== null) throw notFound('conversation_not_found');
    const [conv] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, convId))
      .limit(1);
    if (!conv) throw notFound('conversation_not_found');
    if (conv.type === 'dm') {
      const peer = (await activeParticipantUserIds(convId)).find((id) => id !== userId);
      if (peer && (await isBlockedPair(userId, peer))) throw notFound('conversation_not_found');
    }
    return { conv, part };
  }

  // §1.30 PATCH .../messages/:seq {body} — author only, EDITABLE types, within
  // EDIT_WINDOW_S, not tombstoned. Re-parses §1.33 mentions (metadata is
  // rewritten) but NEVER re-pushes; keeps the link_preview snapshot; the
  // edited badge is edited_at != null (no edit history stored or served).
  app.patch(
    '/api/conversations/:id/messages/:seq',
    { preHandler: requireAuth, schema: { params: SeqParams, body: EditMessageRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const { part } = await requireUnfrozenParticipant(convId, user.id);
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, part.joinSeq)))
        .limit(1);
      if (!row) throw notFound();
      if (row.senderId !== user.id) throw forbidden();
      if (!(EDITABLE_MESSAGE_TYPES as readonly string[]).includes(row.type)) {
        throw badRequest('not_editable');
      }
      if (row.createdAt.getTime() < Date.now() - EDIT_WINDOW_S * 1000) {
        throw conflict('edit_window_closed');
      }
      if (row.deletedAt !== null) throw conflict('message_deleted');

      const metadata = { ...((row.metadata ?? {}) as MessageMetadata) };
      // §1.33: edits re-parse mentions against CURRENT active participants —
      // stored, but mention pushes fire at send time ONLY (no re-ping).
      const mentions = await resolveMentions(convId, req.body.body);
      if (mentions.length > 0) metadata.mentions = mentions;
      else delete metadata.mentions;
      // §1.30: edits never re-run unfurl; the existing snapshot stays.

      const [updated] = await db
        .update(m)
        .set({ body: req.body.body, metadata, editedAt: new Date() })
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq)))
        .returning();
      await publishMessageUpdated(updated!);
      const [dto] = await messageDtos([updated!], user.id);
      return { message: dto };
    },
  );

  // §1.30 DELETE .../messages/:seq — TOMBSTONE, never row deletion (ADR-003):
  // deleted_at set, body nulled, metadata emptied, attachments deleted (rows +
  // MinIO objects, refcount-guarded §1.31), dependent reaction/poll rows
  // removed, any §1.32 pin removed (+ conv.updated). Idempotent re-delete 204.
  //
  // v0.8a (§1.57, ADR-018): `?undo=1` is the 🍻 drunk-mode send-undo — the
  // SAME tombstone (seq survives, attachments/dependents removed identically)
  // with ONE difference: metadata becomes {"undone": true} and clients render
  // NOTHING (no "message deleted" stub — the stub is itself a trace). Undo
  // needs authorship only, never edit permission: it works on every own
  // message type, EDITABLE or not, channel messages included (system messages
  // have no author and fail the authorship check). Preconditions, in order:
  // author (403 forbidden), the sender's drunk mood live AT UNDO TIME
  // (409 not_drunk — nothing about the mood is ever stamped on the message),
  // within MOOD_DRUNK_UNDO_WINDOW_S of created_at with MOOD_DRUNK_UNDO_SLACK_S
  // skew allowance (409 undo_window_closed). The frozen-DM 404 applies as in
  // §1.30; an undone message never pushes: while the sender's drunk mood is
  // live the send path holds the push job for MOOD_DRUNK_UNDO_WINDOW_S +
  // MOOD_DRUNK_UNDO_SLACK_S, so the §2.9 worker's fresh deleted_at re-check
  // runs after the undo window has closed.
  app.delete(
    '/api/conversations/:id/messages/:seq',
    {
      preHandler: requireAuth,
      schema: { params: SeqParams, querystring: z.object({ undo: z.string().optional() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const isUndo = req.query.undo === '1' || req.query.undo === 'true';
      const { part } = await requireUnfrozenParticipant(convId, user.id);
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, part.joinSeq)))
        .limit(1);
      if (!row) throw notFound();
      // System messages have no author and are undeletable; only the author
      // tombstones their own words (channels included).
      if (row.senderId !== user.id) throw forbidden();
      if (isUndo) {
        // Drunk live AT UNDO TIME (live-expiry filter; the auth read is fresh).
        const drunkLive =
          user.moodKind === 'drunk' &&
          user.moodExpiresAt !== null &&
          user.moodExpiresAt.getTime() > Date.now();
        if (!drunkLive) throw conflict('not_drunk');
        const windowMs = (MOOD_DRUNK_UNDO_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S) * 1000;
        if (Date.now() - row.createdAt.getTime() > windowMs) {
          throw conflict('undo_window_closed');
        }
      }
      if (row.deletedAt !== null) return reply.status(204).send(); // idempotent

      const atts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.messageId, row.id));

      let pinRemoved = false;
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM message_reactions
          WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
        `);
        await tx.execute(sql`
          DELETE FROM polls WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
        `);
        const pins = (await tx.execute(sql`
          DELETE FROM conversation_pins
          WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
          RETURNING seq
        `)) as unknown as { seq: number }[];
        pinRemoved = pins.length > 0;
        await tx.execute(sql`DELETE FROM attachments WHERE message_id = ${row.id}`);
        await tx.execute(sql`
          UPDATE messages SET deleted_at = now(), body = NULL,
            metadata = ${isUndo ? sql`'{"undone": true}'::jsonb` : sql`'{}'::jsonb`}
          WHERE id = ${row.id} AND deleted_at IS NULL
        `);
      });
      // Objects AFTER commit: the refcount guard then sees only other rows
      // (§1.31 — forwarded copies keep the shared content-hashed objects alive).
      for (const att of atts) await deleteAttachmentObjects(att);

      const [fresh] = await db.select().from(m).where(eq(m.id, row.id)).limit(1);
      if (fresh) await publishMessageUpdated(fresh);
      if (pinRemoved) {
        await publishConversationToUsers(
          convId,
          await activeParticipantUserIds(convId),
          'conv.updated',
        );
      }
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // v0.5a §1.31 — forwarding. All-or-nothing across ≤ FORWARD_MAX_TARGETS;
  // attachments RE-REFERENCED (new rows, same content-hashed objects); the
  // forwarder is sender_id (never spoofs authorship); forwarded_from is a
  // snapshot that sticks through forward-of-forward chains.
  // ---------------------------------------------------------------------------

  app.post(
    '/api/conversations/:id/messages/:seq/forward',
    { preHandler: requireAuth, schema: { params: SeqParams, body: ForwardMessageRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const srcPart = await getParticipant(convId, user.id);
      if (!srcPart || srcPart.leftAt !== null) throw notFound('not_found');
      const [src] = await db
        .select()
        .from(m)
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, srcPart.joinSeq)))
        .limit(1);
      if (!src) throw notFound('not_found');
      if (src.deletedAt !== null || !(FORWARDABLE_MESSAGE_TYPES as readonly string[]).includes(src.type)) {
        throw badRequest('not_forwardable');
      }

      // ALL-OR-NOTHING target validation, byte-identical 404 for every failure
      // mode: unknown id, non-membership, channel I cannot post to, frozen DM.
      const targets = req.body.target_conversation_ids;
      for (const t of targets) {
        try {
          await requireSendContext(t, user.id, { denialShape: '404' });
        } catch (err) {
          if (err instanceof ApiError) throw notFound('not_found');
          throw err;
        }
      }

      // forwarded_from: preserved verbatim on a forward-of-forward, else a
      // snapshot of the original author at forward time (not a UserLite — no
      // avatar reach into foreign conversations).
      const srcMeta = (src.metadata ?? {}) as MessageMetadata;
      let forwardedFrom: ForwardedFrom | undefined = srcMeta.forwarded_from;
      if (!forwardedFrom && src.senderId) {
        const [author] = await db
          .select({ username: schema.users.username, displayName: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.id, src.senderId))
          .limit(1);
        if (author) {
          forwardedFrom = { username: author.username, display_name: author.displayName };
        }
      }
      // Copied: body, link_preview snapshot, doodle. NOT copied: mentions
      // (a forward never re-pings anyone), effect, reply refs, vibe/game/
      // capsule riders (§1.31).
      const metadata: MessageMetadata = {};
      if (forwardedFrom) metadata.forwarded_from = forwardedFrom;
      if (srcMeta.link_preview) metadata.link_preview = srcMeta.link_preview;
      if (srcMeta.doodle) metadata.doodle = true;

      const srcAtts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.messageId, src.id))
        .orderBy(asc(schema.attachments.createdAt));

      const out: Message[] = [];
      let createdAny = false;
      for (const targetId of targets) {
        const replay = await findByClientMsgId(targetId, user.id, req.body.client_msg_id);
        if (replay) {
          out.push(replay);
          continue;
        }
        let msg: MsgRow;
        try {
          msg = await insertMessage({
            conversationId: targetId,
            senderId: user.id,
            clientMsgId: req.body.client_msg_id,
            type: src.type as Message['type'],
            body: src.body,
            metadata,
            // §1.31: re-reference, never re-upload — new attachment rows over
            // the SAME content-hashed objects, inside the seq transaction.
            withinTx:
              srcAtts.length > 0
                ? async (tx, inserted) => {
                    for (const a of srcAtts) {
                      await tx.insert(schema.attachments).values(reRefValues(a, user.id, inserted.id));
                    }
                  }
                : undefined,
          });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            // Per-target idempotency: a partially delivered retry completes
            // the remainder without duplicating (§1.31).
            const raced = await findByClientMsgId(targetId, user.id, req.body.client_msg_id);
            if (raced) {
              out.push(raced);
              continue;
            }
          }
          throw err;
        }
        createdAny = true;
        await fanOutNewMessage(msg);
        const [dto] = await messageDtos([msg], user.id);
        out.push(dto!);
      }
      return reply.status(createdAny ? 201 : 200).send({ messages: out });
    },
  );
}

/** §1.31 re-reference: a NEW attachment row for the forwarder's message over
 * the same MinIO objects — the attachments_original_key_idx refcount guard is
 * what keeps those objects alive until the LAST referencing row goes. */
function reRefValues(a: AttRow, uploaderId: string, messageId: string) {
  return {
    id: newId(),
    uploaderId,
    messageId,
    kind: a.kind,
    originalKey: a.originalKey,
    thumbKey: a.thumbKey,
    blurhash: a.blurhash,
    mime: a.mime,
    fileName: a.fileName,
    sizeBytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    waveform: a.waveform,
    status: a.status,
  };
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
