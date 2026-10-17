// v0.6 Bored Roulette — the REST half (API.md §1.45, ADR-015): queue
// join/leave and the keep handshake. Pairing and the hard-delete sweep run in
// the worker (jobs/discovery.ts → service.ts). The provisional DM is a real
// `dm` conversation with metadata.origin='roulette' + expires_at; the other
// party's keep state is NEVER serialized (the DTO's roulette.kept is the
// viewer's own).
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RouletteKeepRequestSchema } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import {
  activeParticipantUserIds,
  convMetadata,
  loadConversationDto,
  publishConversationToUsers,
  viewCtxFor,
} from '../../lib/dto.js';
import { forbidden, gone, notFound } from '../../lib/errors.js';
import { redis } from '../../redis.js';
import { authed, requireAuth } from '../auth/guard.js';
import { fanOutNewMessage } from '../messages/service.js';
import { insertSystemMessageTx, liveOptinOf, ROULETTE_QUEUE_KEY } from './service.js';

const convs = schema.conversations;

export async function rouletteRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.45 POST /api/roulette/join — requires a live discovery opt-in; the
  // Redis sorted-set entry lapses after ROULETTE_QUEUE_TTL_S (pairing prunes),
  // so a stale queue never matches someone who wandered off. Idempotent
  // re-join refreshes the entry (ZADD updates the score).
  app.post('/api/roulette/join', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const optin = await liveOptinOf(user.id);
    if (!optin) throw forbidden('discovery_not_opted_in');
    await redis.zadd(ROULETTE_QUEUE_KEY, Date.now(), user.id);
    return { status: 'queued' as const };
  });

  // §1.45 DELETE /api/roulette/join — leave the queue. Idempotent.
  app.delete('/api/roulette/join', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    await redis.zrem(ROULETTE_QUEUE_KEY, user.id);
    return reply.status(204).send();
  });

  // §1.45 POST /api/roulette/keep — guarded append of me to
  // metadata.roulette.kept_by while the window lives. Both kept → the SAME
  // transaction clears expires_at, collapses the rider to {origin:'roulette'},
  // lands the roulette_kept system message; conv.updated fans out after
  // commit. One keep → permanent:false, and the other party learns nothing.
  app.post(
    '/api/roulette/keep',
    { preHandler: requireAuth, schema: { body: RouletteKeepRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const convId = req.body.conversation_id;

      interface KeepResult {
        permanent: boolean;
        changed: boolean;
        msg?: Awaited<ReturnType<typeof insertSystemMessageTx>>;
      }
      const result = await db.transaction(async (tx): Promise<KeepResult> => {
        const [conv] = await tx
          .select()
          .from(convs)
          .where(sql`${convs.id} = ${convId}`)
          .for('update')
          .limit(1);
        // Not mine / already hard-deleted / not a roulette DM: all 404 (§1.14
        // shape — the keep endpoint confirms nothing about other people's
        // conversations).
        if (!conv) throw notFound('not_found');
        const [mine] = (await tx.execute(sql`
          SELECT 1 AS one FROM conversation_participants
          WHERE conversation_id = ${convId} AND user_id = ${user.id} AND left_at IS NULL
          LIMIT 1
        `)) as unknown as { one: number }[];
        if (!mine) throw notFound('not_found');
        const meta = convMetadata(conv);
        if (meta.origin !== 'roulette') throw notFound('not_found');

        // Already permanent (both kept earlier): idempotent.
        if (!conv.expiresAt || !meta.roulette) {
          if (!conv.expiresAt && !meta.roulette) return { permanent: true, changed: false };
          throw notFound('not_found');
        }
        if (conv.expiresAt.getTime() <= Date.now()) throw gone('roulette_expired');

        const keptBy = new Set(meta.roulette.kept_by ?? []);
        keptBy.add(user.id);
        const participants = await activeParticipantUserIds(convId);
        const bothKept =
          participants.length === 2 && participants.every((id) => keptBy.has(id));

        if (bothKept) {
          await tx.execute(sql`
            UPDATE conversations
            SET metadata = '{"origin":"roulette"}'::jsonb, expires_at = NULL
            WHERE id = ${convId} AND expires_at > now()
          `);
          const msg = await insertSystemMessageTx(
            tx,
            convId,
            'roulette_kept',
            'you both kept this chat — it is permanent now',
          );
          return { permanent: true, changed: true, msg };
        }
        await tx.execute(sql`
          UPDATE conversations
          SET metadata = jsonb_set(metadata, '{roulette,kept_by}', ${JSON.stringify([...keptBy])}::jsonb)
          WHERE id = ${convId} AND expires_at > now()
        `);
        return { permanent: false, changed: true };
      });

      if (result.permanent && result.changed && result.msg) {
        await fanOutNewMessage(result.msg);
        await publishConversationToUsers(
          convId,
          await activeParticipantUserIds(convId),
          'conv.updated',
        );
      }
      const dto = await loadConversationDto(convId, await viewCtxFor(user));
      if (!dto) throw notFound('not_found');
      return { conversation: dto, permanent: result.permanent };
    },
  );
}
