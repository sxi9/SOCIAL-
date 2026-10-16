// Reactions (v0.2 — API.md §1.12 + §2.3). Durable writes are REST (idempotent
// POST/DELETE → 204); each EFFECTIVE add/remove fans out one small
// reaction.updated delta frame via the Redis `events` channel — deliberately
// not a msg.updated DTO re-ship. Idempotent no-ops emit nothing; reconnect
// truth is the DTO aggregate (sync/history refetch), never frame replay.
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddReactionRequestSchema,
  REACTIONS_PER_USER_PER_MESSAGE_MAX,
  ReactionEmojiSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { activeParticipantUserIds } from '../../lib/dto.js';
import { conflict, notFound } from '../../lib/errors.js';
import { publishReactionUpdated } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';

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

async function emojiCount(convId: string, seq: number, emoji: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM message_reactions
    WHERE conversation_id = ${convId} AND seq = ${seq}::bigint AND emoji = ${emoji}
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
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

  // §1.12 POST .../messages/:seq/reactions {emoji} → 204 idempotent;
  // 409 reaction_limit at the 9th DISTINCT emoji by one user on one message.
  app.post(
    '/api/conversations/:id/messages/:seq/reactions',
    { preHandler: requireAuth, schema: { params: SeqParams, body: AddReactionRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const { emoji } = req.body;
      await requireVisibleMessage(convId, seq, user.id);

      // Re-adding an emoji you already hold: 204, no event — and never a 409,
      // even when you sit at the distinct-emoji cap.
      if (await holdsReaction(convId, seq, user.id, emoji)) return reply.status(204).send();

      // Guarded insert, serialized per (conversation, seq, user): the cap is a
      // count-then-insert, so two concurrent adds of DIFFERENT emoji could
      // both count 7 and both land, overshooting the distinct-emoji cap. A
      // transaction-scoped advisory lock on the triple serializes them (the
      // lock releases at commit, after the insert is visible to the next
      // counter); ON CONFLICT still absorbs a concurrent duplicate of the
      // SAME reaction.
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${convId}::text || ':' || ${seq}::text || ':' || ${user.id}::text, 0)
          )
        `);
        return (await tx.execute(sql`
          INSERT INTO message_reactions (conversation_id, seq, user_id, emoji)
          SELECT ${convId}::uuid, ${seq}::bigint, ${user.id}::uuid, ${emoji}
          WHERE (
            SELECT count(*) FROM message_reactions
            WHERE conversation_id = ${convId} AND seq = ${seq}::bigint AND user_id = ${user.id}
          ) < ${REACTIONS_PER_USER_PER_MESSAGE_MAX}
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

      // Effective add → one reaction.updated delta to all active participants.
      const count = await emojiCount(convId, seq, emoji);
      await publishReactionUpdated(await activeParticipantUserIds(convId), {
        conversation_id: convId,
        seq,
        emoji,
        count,
        user_id: user.id,
        removed: false,
      });
      return reply.status(204).send();
    },
  );

  // §1.12 DELETE .../reactions/:emoji → 204 idempotent (deleting a reaction
  // you don't hold is 204, no event).
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
        RETURNING emoji
      `)) as unknown as { emoji: string }[];

      if (deleted.length > 0) {
        // Effective remove; count 0 removes the chip client-side.
        const count = await emojiCount(convId, seq, emoji);
        await publishReactionUpdated(await activeParticipantUserIds(convId), {
          conversation_id: convId,
          seq,
          emoji,
          count,
          user_id: user.id,
          removed: true,
        });
      }
      return reply.status(204).send();
    },
  );
}
