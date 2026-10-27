// Polls (v0.3 — API.md §1.17). A poll IS a message (type 'poll') riding the
// gapless seq log; the poll row is keyed by the message identity
// (conversation_id, seq) — the reactions pattern. Votes UPSERT on
// (poll_id, user_id): revoting replaces. Each EFFECTIVE vote change fans out
// one poll.updated delta frame (not a msg.updated re-ship); reconnect truth is
// message.poll. No per-voter lists and no vote timestamps in any payload —
// a poll is a decision tool, not a scoreboard.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreatePollRequestSchema,
  VotePollRequestSchema,
  type Message,
  type Poll,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, loadPollsFor, messageDtos } from '../../lib/dto.js';
import { ApiError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ghostMessageDtos } from '../../lib/ghost.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { ghostViewOf } from '../messages/routes.js';
import { fanOutNewMessage, insertMessage } from '../messages/service.js';

const IdParams = z.object({ id: z.string().uuid() });
const m = schema.messages;
const p = schema.polls;
const pv = schema.pollVotes;

type PollRow = typeof schema.polls.$inferSelect;

async function loadPollDto(row: PollRow, viewerId: string): Promise<Poll> {
  const map = await loadPollsFor(
    [{ conversationId: row.conversationId, seq: row.seq }],
    viewerId,
  );
  return map.get(`${row.conversationId}:${row.seq}`)!;
}

/**
 * Vote authorization: active participant of the poll's conversation with the
 * message inside the §1.5 visibility floor — anything else is one
 * undifferentiated 404 not_found.
 */
async function requireVotablePoll(pollId: string, userId: string): Promise<PollRow> {
  const [row] = await db.select().from(p).where(eq(p.id, pollId)).limit(1);
  if (!row) throw notFound();
  const part = await getParticipant(row.conversationId, userId);
  if (!part || part.leftAt !== null) throw notFound();
  if (row.seq <= part.joinSeq) throw notFound();
  return row;
}

function assertOpen(row: PollRow): void {
  if (row.closesAt && row.closesAt.getTime() <= Date.now()) throw conflict('poll_closed');
}

async function fanPollUpdated(row: PollRow, userId: string, optionIdx: number | null): Promise<void> {
  // Aggregate counts (never voter lists) — one delta per effective change.
  const voteRows = (await db.execute(sql`
    SELECT option_idx, count(*)::int AS n FROM poll_votes WHERE poll_id = ${row.id}
    GROUP BY option_idx
  `)) as unknown as { option_idx: number; n: number }[];
  const options = row.options as string[];
  const counts = options.map((_, i) => {
    const hit = voteRows.find((v) => Number(v.option_idx) === i);
    return hit ? Number(hit.n) : 0;
  });
  const recipients = await activeParticipantUserIds(row.conversationId);
  const base = {
    poll_id: row.id,
    conversation_id: row.conversationId,
    seq: row.seq,
    counts,
    total_votes: counts.reduce((a, b) => a + b, 0),
  };
  // §1.17 (binding): no per-voter lists anywhere. user_id/option_idx exist
  // ONLY so the voter's other devices can reconcile my_vote, so they ride the
  // voter's own frame exclusively — every other participant receives
  // aggregates only (otherwise any online client could accumulate a complete
  // per-voter ballot map from the deltas).
  await publishToUsers([userId], {
    t: 'poll.updated',
    d: { ...base, user_id: userId, option_idx: optionIdx },
  });
  await publishToUsers(
    recipients.filter((id) => id !== userId),
    { t: 'poll.updated', d: base },
  );
}

export async function pollRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.17 POST /api/conversations/:id/polls — the §1.5 send transaction with
  // the polls row inserted atomically; 200 idempotent replay via client_msg_id.
  app.post(
    '/api/conversations/:id/polls',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreatePollRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound('conversation_not_found');

      // §1.14: a frozen DM refuses sends 404-shaped, polls included.
      const [conv] = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type === 'dm') {
        const others = await activeParticipantUserIds(convId);
        const peer = others.find((id) => id !== user.id);
        if (peer && (await isBlockedPair(user.id, peer))) throw notFound('conversation_not_found');
      }
      // v0.5a §1.35: polls are sends — owner/admin only in channels.
      if (conv.type === 'channel' && part.role !== 'owner' && part.role !== 'admin') {
        throw new ApiError(403, 'channel_read_only');
      }

      // §1.68: a poll IS a message — every DTO returned here (replay, race,
      // fresh) is the creator's own copy with other ghost members masked
      // (reactions[].reactors carry faces).
      const ghost = conv.visibility === 'ghost' ? await ghostViewOf(convId, user.id, part.role) : null;
      const own = (d: Message): Message => (ghost ? ghostMessageDtos([d], ghost)[0]! : d);

      const replay = await findPollMessageByClientMsgId(convId, user.id, req.body.client_msg_id);
      if (replay) return reply.status(200).send({ message: own(replay) });

      const closesAt = req.body.closes_at ? new Date(req.body.closes_at) : null;
      let msg;
      try {
        msg = await insertMessage({
          conversationId: convId,
          senderId: user.id,
          clientMsgId: req.body.client_msg_id,
          type: 'poll',
          body: req.body.question,
          metadata: {},
          withinTx: async (tx, inserted) => {
            await tx.insert(p).values({
              id: newId(),
              conversationId: convId,
              seq: inserted.seq,
              question: req.body.question,
              options: req.body.options,
              closesAt,
            });
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          const raced = await findPollMessageByClientMsgId(convId, user.id, req.body.client_msg_id);
          if (raced) return reply.status(200).send({ message: own(raced) });
        }
        throw err;
      }

      await fanOutNewMessage(msg);
      const [dto] = await messageDtos([msg], user.id);
      return reply.status(201).send({ message: own(dto!) });
    },
  );

  // §1.17 POST /api/polls/:id/vote — UPSERT; revoting replaces.
  app.post(
    '/api/polls/:id/vote',
    { preHandler: requireAuth, schema: { params: IdParams, body: VotePollRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVotablePoll(req.params.id, user.id);
      assertOpen(row);
      const options = row.options as string[];
      // Route-enforced upper bound → the documented 400 bad_option.
      if (req.body.option_idx >= options.length) throw badRequest('bad_option');

      const changed = (await db.execute(sql`
        INSERT INTO poll_votes (poll_id, user_id, option_idx)
        VALUES (${row.id}, ${user.id}, ${req.body.option_idx})
        ON CONFLICT (poll_id, user_id) DO UPDATE SET option_idx = EXCLUDED.option_idx
        WHERE poll_votes.option_idx IS DISTINCT FROM EXCLUDED.option_idx
        RETURNING option_idx
      `)) as unknown as { option_idx: number }[];

      if (changed.length > 0) await fanPollUpdated(row, user.id, req.body.option_idx);
      return { poll: await loadPollDto(row, user.id) };
    },
  );

  // §1.17 DELETE /api/polls/:id/vote — unvote; idempotent.
  app.delete(
    '/api/polls/:id/vote',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVotablePoll(req.params.id, user.id);
      assertOpen(row);
      const deleted = (await db.execute(sql`
        DELETE FROM poll_votes WHERE poll_id = ${row.id} AND user_id = ${user.id}
        RETURNING option_idx
      `)) as unknown as { option_idx: number }[];
      if (deleted.length > 0) await fanPollUpdated(row, user.id, null);
      return { poll: await loadPollDto(row, user.id) };
    },
  );
}

async function findPollMessageByClientMsgId(convId: string, senderId: string, clientMsgId: string) {
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
