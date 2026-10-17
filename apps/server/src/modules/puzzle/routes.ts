// Daily word puzzle — routes (v0.4, API.md §1.27). Guesses are scored
// server-side only; responses never contain the word. Sharing a grid into a
// chat (type='puzzle_result', built in modules/messages) is the ONLY
// leaderboard-like surface: the friends view merely echoes what DM partners
// already posted, ordered by USERNAME — never by score or speed, no streaks,
// no rankings, ever (PSYCHOLOGY never-build list).
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  PUZZLE_MAX_GUESSES,
  PuzzleGuessRequestSchema,
  type PuzzleAttempt,
  type PuzzleFriendEntry,
  type PuzzleResultMetadata,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { recordActivity } from '../../lib/activity.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { dmPartnerIdsOf, userLiteDto } from '../../lib/dto.js';
import { conflict } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import { parseGuesses, scoreGuess, utcToday, wordForDate } from './service.js';

const pa = schema.puzzleAttempts;

interface TodayState {
  date: string;
  attempts: PuzzleAttempt[];
  solved: boolean;
  remaining: number;
}

function stateOf(date: string, guesses: PuzzleAttempt[], solved: boolean): TodayState {
  return {
    date,
    attempts: guesses,
    solved,
    remaining: solved ? 0 : Math.max(0, PUZZLE_MAX_GUESSES - guesses.length),
  };
}

export async function puzzleRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.27 GET /api/puzzle/today — my state (empty attempts = not started).
  app.get('/api/puzzle/today', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const today = utcToday();
    const [row] = await db
      .select()
      .from(pa)
      .where(and(eq(pa.userId, user.id), eq(pa.puzzleDate, today)))
      .limit(1);
    return stateOf(today, parseGuesses(row?.guesses), row?.solved ?? false);
  });

  // §1.27 POST /api/puzzle/guess — appended transactionally, one row per
  // (user, UTC day); 409 puzzle_done when solved or out of guesses.
  app.post(
    '/api/puzzle/guess',
    { preHandler: requireAuth, schema: { body: PuzzleGuessRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const today = utcToday();
      const guess = req.body.guess;

      return db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO puzzle_attempts (user_id, puzzle_date)
          VALUES (${user.id}, ${today}) ON CONFLICT DO NOTHING
        `);
        const rows = (await tx.execute(sql`
          SELECT guesses, solved FROM puzzle_attempts
          WHERE user_id = ${user.id} AND puzzle_date = ${today} FOR UPDATE
        `)) as unknown as { guesses: unknown; solved: boolean }[];
        const guesses = parseGuesses(rows[0]?.guesses);
        if (rows[0]?.solved || guesses.length >= PUZZLE_MAX_GUESSES) {
          throw conflict('puzzle_done');
        }

        const score = scoreGuess(guess, wordForDate(today));
        const correct = score === 'ggggg';
        const next = [...guesses, { guess, score }];
        await tx.execute(sql`
          UPDATE puzzle_attempts
          SET guesses = ${JSON.stringify(next)}::jsonb, solved = ${correct}, updated_at = now()
          WHERE user_id = ${user.id} AND puzzle_date = ${today}
        `);
        // v0.8a (§1.59): a FINISHED attempt (solved or out of guesses) →
        // puzzle_played, once per user per UTC day by construction (the row
        // locks above; a finished attempt 409s every later guess). The ref is
        // the player's own NO-SPOILER facts — no letters, no word (the §1.27
        // PuzzleResult floor). Written inside the guess transaction through
        // THE one helper.
        if (correct || next.length >= PUZZLE_MAX_GUESSES) {
          await recordActivity(tx, {
            user_id: user.id,
            kind: 'puzzle_played',
            ref: { date: today, solved: correct, attempts_used: next.length },
          });
        }
        return { ...stateOf(today, next, correct), correct };
      });
    },
  );

  // §1.27 GET /api/puzzle/today/friends — DM partners (minus §1.14 blocks)
  // who OPTED IN by posting a puzzle_result for today into a conversation I'm
  // an active participant of; their latest such post. Ordered by username.
  app.get('/api/puzzle/today/friends', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const today = utcToday();
    const partnerIds = await dmPartnerIdsOf(user.id);
    const blocked = await blockedSetOf(user.id);
    const eligible = [...partnerIds].filter((id) => !blocked.has(id));
    if (eligible.length === 0) return { friends: [] };

    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (msg.sender_id)
        msg.sender_id, msg.metadata -> 'puzzle' AS puzzle, u.*
      FROM messages msg
      JOIN conversation_participants me
        ON me.conversation_id = msg.conversation_id
       AND me.user_id = ${user.id} AND me.left_at IS NULL
      JOIN users u ON u.id = msg.sender_id
      WHERE msg.type = 'puzzle_result'
        AND msg.deleted_at IS NULL
        AND msg.seq > me.join_seq
        AND msg.metadata -> 'puzzle' ->> 'date' = ${today}
        AND msg.sender_id IN (${sql.join(eligible.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY msg.sender_id, msg.created_at DESC
    `)) as unknown as (Record<string, unknown> & {
      sender_id: string;
      puzzle: PuzzleResultMetadata;
    })[];

    const friends: (PuzzleFriendEntry & { username: string })[] = rows.map((r) => {
      const lite: UserLite = userLiteDto({
        id: r.id as string,
        username: r.username as string,
        displayName: r.display_name as string,
        avatarStatus: r.avatar_status as string,
        avatarVersion: Number(r.avatar_version),
        avatarStaticKey: (r.avatar_static_key as string | null) ?? null,
        avatarAnimatedKey: (r.avatar_animated_key as string | null) ?? null,
        nameStyle: ((r.name_style as string | undefined) ?? 'none'), // v0.8a §1.58
      } as Parameters<typeof userLiteDto>[0]);
      return { user: lite, result: r.puzzle, username: lite.username };
    });
    friends.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
    return { friends: friends.map(({ user: u, result }) => ({ user: u, result })) };
  });
}
