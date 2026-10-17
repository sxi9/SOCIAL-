// Tic-tac-toe (v0.4 — API.md §1.27, ADR-010). A game IS a message
// (type='game_ttt') whose whole state lives in metadata.game; moves are
// SERVER-validated under a row lock and fanned out as msg.updated full-DTO
// replacements — the client never computes state. No rematch state, no win
// tallies, no records anywhere (PSYCHOLOGY rule 3).
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateTttRequestSchema,
  TTT_BOARD_CELLS,
  TttMoveRequestSchema,
  type GameTttState,
  type MessageMetadata,
  type TttSymbol,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { recordActivity } from '../../lib/activity.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { ghostMessageDto, pseudoIdFor, type GhostCtx } from '../../lib/ghost.js';
import {
  activeParticipantUserIds,
  ghostCtxFor,
  messageDtos,
  rawToMsgRow,
  type MsgRow,
} from '../../lib/dto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';
import { fanOutNewMessage, insertMessage, publishMessageUpdated } from '../messages/service.js';

const IdParams = z.object({ id: z.string().uuid() });
const MessageIdParams = z.object({ messageId: z.string().uuid() });
const m = schema.messages;

const LINES: [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function winnerOf(board: (TttSymbol | null)[]): TttSymbol | 'draw' | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]!;
  }
  if (board.every((c) => c !== null)) return 'draw';
  return null;
}

/** v0.8b (§1.68): the non-admin viewer's GhostCtx for a conversation — null
 * for anything that is not a 👻 ghost group, and for group admins (they see
 * real identities). Game DTO paths must mask like every other message path:
 * metadata.game.players carries user ids. */
async function ghostViewOf(convId: string, viewerId: string): Promise<GhostCtx | null> {
  const [conv] = await db
    .select({ id: schema.conversations.id, visibility: schema.conversations.visibility })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!conv) return null;
  const ctx = await ghostCtxFor(conv, viewerId);
  return ctx && !ctx.viewerIsAdmin ? ctx : null;
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

export async function gameRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.27 POST /api/conversations/:id/games/ttt — the challenge. Challenger
  // plays x and moves first. DM: opponent implied (must be omitted); group:
  // required, an active participant; blocked pair → 404 (§1.14 404-shape).
  app.post(
    '/api/conversations/:id/games/ttt',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateTttRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const convId = req.params.id;
      const part = await getParticipant(convId, user.id);
      if (!part || part.leftAt !== null) throw notFound('conversation_not_found');

      const [conv] = await db
        .select({ type: schema.conversations.type, visibility: schema.conversations.visibility })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, convId))
        .limit(1);
      if (!conv) throw notFound('conversation_not_found');

      // v0.5a §1.35: games are not startable in channels — challenges need
      // peers, not audiences.
      if (conv.type === 'channel') throw badRequest('bad_opponent');

      // v0.8b (§1.68): 👻 ghost groups serialize MASKS to non-admin members —
      // every message DTO leaving this route must ride the same transform.
      const ghost =
        conv.visibility === 'ghost' ? await ghostViewOf(convId, user.id) : null;

      const participants = await activeParticipantUserIds(convId);
      let opponentId: string;
      if (conv.type === 'dm') {
        if (req.body.opponent_id !== undefined) throw badRequest('bad_opponent');
        const peer = participants.find((id) => id !== user.id);
        if (!peer) throw badRequest('bad_opponent');
        // §1.14: a frozen DM refuses challenges 404-shaped, like sends.
        if (await isBlockedPair(user.id, peer)) throw notFound('conversation_not_found');
        opponentId = peer;
      } else {
        let target = req.body.opponent_id;
        // §1.68: in a 👻 ghost group the client only ever SEES pseudo-ids —
        // resolve a pseudo opponent back to the real participant server-side
        // (the mapping never leaves the server).
        if (
          conv.visibility === 'ghost' &&
          target &&
          !participants.includes(target)
        ) {
          const real = participants.find((p) => pseudoIdFor(convId, p) === target);
          if (real) target = real;
        }
        if (!target || target === user.id || !participants.includes(target)) {
          throw badRequest('bad_opponent');
        }
        // No games across blocked pairs — 404-shaped (never confirms a block).
        if (await isBlockedPair(user.id, target)) throw notFound();
        opponentId = target;
      }

      const replay = await findByClientMsgId(convId, user.id, req.body.client_msg_id);
      if (replay) {
        return reply.status(200).send({ message: ghost ? ghostMessageDto(replay, ghost) : replay });
      }

      const game: GameTttState = {
        board: new Array(TTT_BOARD_CELLS).fill(null),
        players: { x: user.id, o: opponentId },
        turn: 'x',
        winner: null,
      };
      let msg;
      try {
        msg = await insertMessage({
          conversationId: convId,
          senderId: user.id,
          clientMsgId: req.body.client_msg_id,
          type: 'game_ttt',
          body: null,
          metadata: { game },
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          const raced = await findByClientMsgId(convId, user.id, req.body.client_msg_id);
          if (raced) {
            return reply
              .status(200)
              .send({ message: ghost ? ghostMessageDto(raced, ghost) : raced });
          }
        }
        throw err;
      }

      await fanOutNewMessage(msg);
      const [dto] = await messageDtos([msg], user.id);
      return reply.status(201).send({ message: ghost ? ghostMessageDto(dto!, ghost) : dto });
    },
  );

  // §1.27 POST /api/games/:messageId/move — validated under a row lock.
  // Non-players (other group members included) get the same 404 as a bad id.
  app.post(
    '/api/games/:messageId/move',
    { preHandler: requireAuth, schema: { params: MessageIdParams, body: TttMoveRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const cell = req.body.cell;

      const updated: MsgRow = await db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT * FROM messages WHERE id = ${req.params.messageId} FOR UPDATE
        `)) as unknown as Record<string, unknown>[];
        if (rows.length === 0) throw notFound();
        const row = rawToMsgRow(rows[0]!);
        if (row.type !== 'game_ttt') throw notFound();

        // Caller must be an active participant of the conversation at all —
        // outsiders get the bad-id 404 before anything game-shaped answers.
        const part = await getParticipant(row.conversationId, user.id);
        if (!part || part.leftAt !== null) throw notFound();

        const game = ((row.metadata ?? {}) as MessageMetadata).game;
        // §1.25: a game on a tombstoned message is over — the state is gone.
        if (row.deletedAt !== null || !game) throw conflict('game_over');

        const isPlayer = game.players.x === user.id || game.players.o === user.id;
        if (!isPlayer) throw notFound();

        // No games across blocked pairs: a block landing mid-game ends access.
        const opponent = game.players.x === user.id ? game.players.o : game.players.x;
        if (await isBlockedPair(user.id, opponent)) throw notFound();

        if (game.winner !== null) throw conflict('game_over');
        const mySymbol: TttSymbol = game.players.x === user.id ? 'x' : 'o';
        if (game.turn !== mySymbol) throw conflict('game_not_your_turn');
        if (game.board[cell] !== null) throw conflict('game_cell_taken');

        const board = [...game.board];
        board[cell] = mySymbol;
        const next: GameTttState = {
          board,
          players: game.players,
          turn: mySymbol === 'x' ? 'o' : 'x',
          winner: winnerOf(board),
        };
        const metadata = { ...((row.metadata ?? {}) as MessageMetadata), game: next };
        const [after] = await tx
          .update(m)
          .set({ metadata, editedAt: new Date() })
          .where(eq(m.id, row.id))
          .returning();
        // v0.8a (§1.59): a server-validated win → game_won, the WINNER's row
        // only (a draw records nothing — no loser rows, no tallies), inside
        // the move transaction through THE one helper. §1.27 and §1.50 boards
        // alike land here (the claim-game challenge is moved via this route).
        // The strip read re-checks the §1.5 conversation-participant floor.
        if (next.winner === 'x' || next.winner === 'o') {
          const winnerId = next.winner === 'x' ? game.players.x : game.players.o;
          const loserId = next.winner === 'x' ? game.players.o : game.players.x;
          // v0.8b (§1.68): recordActivity SKIPS 👻 ghost conversations
          // entirely — a game_won strip item would leak masked membership.
          const ghostRows = (await tx.execute(sql`
            SELECT 1 AS one FROM conversations
            WHERE id = ${row.conversationId} AND visibility = 'ghost'
            LIMIT 1
          `)) as unknown as { one: number }[];
          if (ghostRows.length === 0) {
            await recordActivity(tx, {
              user_id: winnerId,
              kind: 'game_won',
              ref: { conversation_id: row.conversationId, seq: row.seq, opponent_id: loserId },
            });
          }
        }
        return after!;
      });

      await publishMessageUpdated(updated);
      const [dto] = await messageDtos([updated], user.id);
      // v0.8b (§1.68): the move response is a message DTO path too — mask it
      // for non-admin 👻 ghost-group members (players see their OWN id real).
      const ghost = await ghostViewOf(updated.conversationId, user.id);
      return { message: ghost ? ghostMessageDto(dto!, ghost) : dto };
    },
  );
}
