// THE one activity writer (v0.8a — API.md §1.59, ADR-018, FEATURES #76): the
// requestUnfurl() chokepoint rule — no module inserts into `activities`
// directly, so the invariants live in exactly one place:
//   - ref is the MINIMAL pointer/facts jsonb (never a denormalized audience —
//     visibility is resolved live at read time, so it can never go stale);
//   - MOODS ARE NEVER RECORDED (ActivityKind has no mood value and the DB
//     CHECK structurally excludes one — PSYCHOLOGY: no trace);
//   - rows are written inside the OWNING module's transaction (beacon mint /
//     spark, post create, listing create, puzzle finish, ttt win), so an
//     activity can never exist without its object having committed.
// No WS event, no push — the strip is pull-only (§1.38 doctrine). Rows older
// than ACTIVITY_RETENTION_DAYS are hard-deleted by the nightly gc sweep.
import { sql, type SQL } from 'drizzle-orm';
import type { ActivityKind } from '@socialchat/shared';
import { newId } from '../ids.js';

/** Structural executor: the db handle or any transaction within one. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface ActivityEntry {
  user_id: string;
  kind: ActivityKind;
  /** The minimal pointer/facts object (shape authority: shared §1.59):
   *  beacon_lit/beacon_sparked {beacon_id} · post_created {post_id} ·
   *  listing_posted {listing_id} · puzzle_played {date, solved,
   *  attempts_used} · game_won {conversation_id, seq, opponent_id}. */
  ref: Record<string, unknown>;
}

export async function recordActivity(tx: SqlExecutor, entry: ActivityEntry): Promise<void> {
  await tx.execute(sql`
    INSERT INTO activities (id, user_id, kind, ref)
    VALUES (${newId()}, ${entry.user_id}, ${entry.kind}, ${JSON.stringify(entry.ref)}::jsonb)
  `);
}
