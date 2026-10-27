// Reactions (v0.2 — API.md §1.12 + §2.3) and avatar stamps (v0.4 — §1.19).
// Durable writes are REST (idempotent POST/DELETE → 204); each EFFECTIVE
// add/remove fans out one small reaction.updated delta frame via the Redis
// `events` channel — deliberately not a msg.updated DTO re-ship. Idempotent
// no-ops emit nothing; reconnect truth is the DTO aggregate for emoji chips
// and Message.stamps for stamp faces, never frame replay.
//
// A stamp is a message_reactions row with kind='stamp' and the ':stamp:'
// sentinel (STAMP_REACTION_KEY) in the emoji column — the existing PK
// (conversation_id, seq, user_id, emoji) enforces the one-stamp-per-user-per-
// message cap with zero new state. The 8-distinct-emoji cap counts
// kind='emoji' rows ONLY: a stamp never eats an emoji slot.
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddReactionRequestSchema,
  REACTIONS_PER_USER_PER_MESSAGE_MAX,
  ReactionEmojiSchema,
  STAMP_REACTION_KEY,
  type ReactionKind,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, ghostCtxFor, userLiteDto } from '../../lib/dto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { maskUserLite } from '../../lib/ghost.js';
import { publishReactionUpdated } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import type { ReactionUpdatedEvent } from '@socialchat/shared';

/** v0.8b (§1.68): reaction.updated deltas carry user_id AND the actor's
 * UserLite face (recipients cannot always resolve it locally — channel
 * members are never in conv.participants). Inside a 👻 ghost group both are
 * identities, so non-admin members (except the reactor on their own frame)
 * receive the PSEUDO-ID and the MASK face instead. */
async function fanReactionUpdated(convId: string, d: ReactionUpdatedEvent['d']): Promise<void> {
  const [conv] = await db
    .select({ visibility: schema.conversations.visibility })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (conv?.visibility !== 'ghost') {
    return publishReactionUpdated(await activeParticipantUserIds(convId), d);
  }
  const rows = (await db.execute(sql`
    SELECT user_id, role FROM conversation_participants
    WHERE conversation_id = ${convId} AND left_at IS NULL
  `)) as unknown as { user_id: string; role: string }[];
  // The mask of the ACTOR does not depend on who is looking, so one ctx
  // (no viewer) serves every masked recipient.
  const ctx = (await ghostCtxFor({ id: convId, visibility: 'ghost' }, null))!;
  const maskedFace = maskUserLite(ctx, d.user_id);
  const masked = { ...d, user_id: maskedFace.id, user: maskedFace };
  const realTo = rows
    .filter((r) => r.role === 'admin' || r.user_id === d.user_id)
    .map((r) => r.user_id);
  const maskedTo = rows
    .filter((r) => r.role !== 'admin' && r.user_id !== d.user_id)
    .map((r) => r.user_id);
  if (realTo.length > 0) await publishReactionUpdated(realTo, d);
  if (maskedTo.length > 0) await publishReactionUpdated(maskedTo, masked);
}

const mr = schema.messageReactions;
const m = schema.messages;

const SeqParams = z.object({
  id: z.string().uuid(),
  seq: z.coerce.number().int().positive(),
});
// :emoji arrives URL-encoded; find-my-way decodes it before validation.
const EmojiParams = SeqParams.extend({ emoji: ReactionEmojiSchema });

/**
 * Reactions require an ACTIVE participant and a message visible under the
 * §1.5 window: seq > my join_seq (active members have no left_seq ceiling).
 * Anything else — unknown conversation, departed member, invisible or unknown
 * seq — is one undifferentiated 404 not_found.
 */
async function requireVisibleMessage(convId: string, seq: number, userId: string): Promise<void> {
  const part = await getParticipant(convId, userId);
  if (!part || part.leftAt !== null) throw notFound();
  const [row] = await db
    .select({ seq: m.seq })
    .from(m)
    .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, part.joinSeq)))
    .limit(1);
  if (!row) throw notFound();
}

/** §1.14 + v0.4 task rule: no stamps across blocked pairs — a stamp into a
 * frozen DM is 404-shaped like a send. Shared groups keep working (§1.19). */
async function requireUnfrozenForStamp(convId: string, userId: string): Promise<void> {
  const [conv] = await db
    .select({ type: schema.conversations.type })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (conv?.type !== 'dm') return;
  const peer = (await activeParticipantUserIds(convId)).find((id) => id !== userId);
  if (peer && (await isBlockedPair(userId, peer))) throw notFound();
}

async function holdsReaction(
  convId: string,
  seq: number,
  userId: string,
  emoji: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(mr)
    .where(
      and(eq(mr.conversationId, convId), eq(mr.seq, seq), eq(mr.userId, userId), eq(mr.emoji, emoji)),
    )
    .limit(1);
  return row !== undefined;
}

export async function reactionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.12/§1.19 POST .../messages/:seq/reactions {kind?, emoji?} → 204
  // idempotent; 409 reaction_limit at the 9th DISTINCT emoji; stamps need my
  // avatar 'ready' (409 stamp_no_avatar) and never consume an emoji slot.
  app.post(
    '/api/conversations/:id/messages/:seq/reactions',
    { preHandler: requireAuth, schema: { params: SeqParams, body: AddReactionRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const kind: ReactionKind = req.body.kind;
      // kind='stamp' stores the sentinel; kind='emoji' must not spoof it (the
      // DB stamp_key_check would reject the row anyway — fail cleanly here).
      if (kind === 'emoji' && req.body.emoji === STAMP_REACTION_KEY) {
        throw badRequest('bad_emoji');
      }
      const emoji = kind === 'stamp' ? STAMP_REACTION_KEY : req.body.emoji!;
      await requireVisibleMessage(convId, seq, user.id);

      // Re-adding a reaction you already hold: 204, no event — and never a
      // 409, even at the cap or with a since-deleted avatar.
      if (await holdsReaction(convId, seq, user.id, emoji)) return reply.status(204).send();

      if (kind === 'stamp') {
        await requireUnfrozenForStamp(convId, user.id);
        // §1.19: there must be a face to stamp with.
        if (user.avatarStatus !== 'ready') throw conflict('stamp_no_avatar');
      }

      // Guarded insert, serialized per (conversation, seq, user): the
      // distinct-emoji cap is a count-then-insert, so two concurrent adds of
      // DIFFERENT emoji could both count 7 and both land. A transaction-scoped
      // advisory lock on the triple serializes them; ON CONFLICT still absorbs
      // a concurrent duplicate of the SAME reaction. Stamps skip the cap (the
      // PK on the sentinel row IS the one-per-user-per-message cap).
      const capGuard =
        kind === 'emoji'
          ? sql`WHERE (
              SELECT count(*) FROM message_reactions
              WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
                AND user_id = ${user.id} AND kind = 'emoji'
            ) < ${REACTIONS_PER_USER_PER_MESSAGE_MAX}`
          : sql``;
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${convId}::text || ':' || ${seq}::text || ':' || ${user.id}::text, 0)
          )
        `);
        return (await tx.execute(sql`
          INSERT INTO message_reactions (conversation_id, seq, user_id, emoji, kind)
          SELECT ${convId}::uuid, ${seq}::bigint, ${user.id}::uuid, ${emoji}, ${kind}
          ${capGuard}
          ON CONFLICT DO NOTHING
          RETURNING emoji
        `)) as unknown as { emoji: string }[];
      });

      if (inserted.length === 0) {
        // Either a concurrent duplicate landed first (idempotent → 204) or
        // this would be the 9th distinct emoji.
        if (await holdsReaction(convId, seq, user.id, emoji)) return reply.status(204).send();
        throw conflict('reaction_limit');
      }

      // Effective add → one reaction.updated delta to all active participants
      // (a one-actor delta: recipients add this user's face to the chip).
      await fanReactionUpdated(convId, {
        conversation_id: convId,
        seq,
        kind,
        emoji,
        user_id: user.id,
        user: userLiteDto(user),
        removed: false,
      });
      return reply.status(204).send();
    },
  );

  // §1.12 DELETE .../reactions/:emoji → 204 idempotent (deleting a reaction
  // you don't hold is 204, no event). For a stamp, :emoji is the URL-encoded
  // ':stamp:' sentinel (§1.19).
  app.delete(
    '/api/conversations/:id/messages/:seq/reactions/:emoji',
    { preHandler: requireAuth, schema: { params: EmojiParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq, emoji } = req.params;
      await requireVisibleMessage(convId, seq, user.id);

      const deleted = (await db.execute(sql`
        DELETE FROM message_reactions
        WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
          AND user_id = ${user.id} AND emoji = ${emoji}
        RETURNING kind
      `)) as unknown as { kind: ReactionKind }[];

      if (deleted.length > 0) {
        // Effective remove: recipients drop this user's face; an emptied chip
        // (or the stamp face) disappears client-side.
        await fanReactionUpdated(convId, {
          conversation_id: convId,
          seq,
          kind: deleted[0]!.kind,
          emoji,
          user_id: user.id,
          user: userLiteDto(user),
          removed: true,
        });
      }
      return reply.status(204).send();
    },
  );
}
