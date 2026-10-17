// Accepted §1.28 connections — the v0.8a visibility primitive for moods
// ('connections' visibility, API.md §1.57) and the activity strip
// ('connections' per-kind setting, §1.59). LITERALLY accepted connection
// rows, NOT friends-of: a DM alone does not qualify (ADR-018 — "people I
// said yes to"). Blocks are NOT folded in here; callers run their own §1.14
// clause (moodDto checks view.blockedIds; the activity read 404s blocked
// pairs before anything serializes).
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** Every user holding an ACCEPTED connection with `userId`. */
export async function connectionIdsOf(userId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT CASE WHEN c.requester_id = ${userId} THEN c.addressee_id ELSE c.requester_id END AS other_id
    FROM connections c
    WHERE c.status = 'accepted' AND (c.requester_id = ${userId} OR c.addressee_id = ${userId})
  `)) as unknown as { other_id: string }[];
  return new Set(rows.map((r) => r.other_id));
}

/**
 * All ACCEPTED connection pairs between `owners` and `viewers`, as
 * "<owner>:<viewer>" strings in both orders — the blockPairsAmong pattern,
 * for batch per-recipient mood stamping on conversation fan-out (§1.57).
 */
export async function acceptedPairsBetween(
  owners: string[],
  viewers: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (owners.length === 0 || viewers.length === 0) return out;
  const oList = sql.join(owners.map((id) => sql`${id}::uuid`), sql`, `);
  const vList = sql.join(viewers.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT requester_id AS a, addressee_id AS b FROM connections
    WHERE status = 'accepted'
      AND ((requester_id IN (${oList}) AND addressee_id IN (${vList}))
        OR (addressee_id IN (${oList}) AND requester_id IN (${vList})))
  `)) as unknown as { a: string; b: string }[];
  for (const r of rows) {
    out.add(`${r.a}:${r.b}`);
    out.add(`${r.b}:${r.a}`);
  }
  return out;
}
