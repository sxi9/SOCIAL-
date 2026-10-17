// Pins (v0.5a — API.md §1.32). ≤ MAX_PINS per conversation, checked under the
// conversation row lock (409 pin_limit). Permission: DM → any active
// participant; group → admin; channel → owner/admin. Pins ride the
// Conversation DTO (created_at ASC — a stable board, not a feed); every
// EFFECTIVE change fans out conv.updated. Tombstoning a pinned message
// (§1.30 delete / §1.25 sweep) removes its pin in the same transaction.
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MAX_PINS, PinMessageRequestSchema } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { isBlockedPair } from '../../lib/blocks.js';
import {
  activeParticipantUserIds,
  publishConversationToUsers,
  type ConvRow,
  type PartRow,
} from '../../lib/dto.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';

const IdParams = z.object({ id: z.string().uuid() });
const PinParams = z.object({ id: z.string().uuid(), seq: z.coerce.number().int().positive() });
const m = schema.messages;

/** §1.32 permission matrix — DM: any active participant; group: admin;
 * channel: owner/admin. */
function requirePinPermission(conv: ConvRow, part: PartRow): void {
  if (conv.type === 'dm') return;
  if (conv.type === 'group' && part.role === 'admin') return;
  if (conv.type === 'channel' && (part.role === 'owner' || part.role === 'admin')) return;
  throw forbidden();
}

async function loadContext(convId: string, userId: string): Promise<{ conv: ConvRow; part: PartRow }> {
  const part = await getParticipant(convId, userId);
  if (!part || part.leftAt !== null) throw notFound('conversation_not_found');
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!conv) throw notFound('conversation_not_found');
  // §1.14/§1.30: pins are a write surface — in a DM frozen by a block it
  // 404s like every other write (otherwise pin/unpin would remain a working
  // contact channel across the block, fanning conv.updated with pinned_by).
  if (conv.type === 'dm') {
    const peer = (await activeParticipantUserIds(convId)).find((id) => id !== userId);
    if (peer && (await isBlockedPair(userId, peer))) throw notFound('conversation_not_found');
  }
  return { conv, part };
}

export async function pinRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.32 POST /api/conversations/:id/pins {seq} — idempotent re-pin 204.
  app.post(
    '/api/conversations/:id/pins',
    { preHandler: requireAuth, schema: { params: IdParams, body: PinMessageRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const { conv, part } = await loadContext(convId, user.id);
      requirePinPermission(conv, part);

      const seq = req.body.seq;
      // Target must be visible (§1.5 floor) and not tombstoned → 404.
      const [target] = await db
        .select({ seq: m.seq, deletedAt: m.deletedAt })
        .from(m)
        .where(and(eq(m.conversationId, convId), eq(m.seq, seq), gt(m.seq, part.joinSeq)))
        .limit(1);
      if (!target || target.deletedAt !== null) throw notFound();

      // Cap checked under the conversation ROW LOCK so two concurrent 10th
      // pins cannot both land (§1.32).
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM conversations WHERE id = ${convId} FOR UPDATE`);
        const existing = (await tx.execute(sql`
          SELECT seq FROM conversation_pins
          WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
        `)) as unknown as { seq: number }[];
        if (existing.length > 0) return false; // idempotent re-pin, no event
        const count = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM conversation_pins WHERE conversation_id = ${convId}
        `)) as unknown as { n: number }[];
        if ((count[0]?.n ?? 0) >= MAX_PINS) throw conflict('pin_limit');
        await tx.execute(sql`
          INSERT INTO conversation_pins (conversation_id, seq, pinned_by)
          VALUES (${convId}, ${seq}::bigint, ${user.id})
          ON CONFLICT DO NOTHING
        `);
        return true;
      });

      if (inserted) {
        await publishConversationToUsers(
          convId,
          await activeParticipantUserIds(convId),
          'conv.updated',
        );
      }
      return reply.status(204).send();
    },
  );

  // §1.32 DELETE /api/conversations/:id/pins/:seq — idempotent unpin, same
  // permission rule.
  app.delete(
    '/api/conversations/:id/pins/:seq',
    { preHandler: requireAuth, schema: { params: PinParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const { id: convId, seq } = req.params;
      const { conv, part } = await loadContext(convId, user.id);
      requirePinPermission(conv, part);

      const deleted = (await db.execute(sql`
        DELETE FROM conversation_pins
        WHERE conversation_id = ${convId} AND seq = ${seq}::bigint
        RETURNING seq
      `)) as unknown as { seq: number }[];
      if (deleted.length > 0) {
        await publishConversationToUsers(
          convId,
          await activeParticipantUserIds(convId),
          'conv.updated',
        );
      }
      return reply.status(204).send();
    },
  );
}
