// Block helpers (v0.3 — API.md §1.14, ADR-009). A blocked pair is mutual
// invisibility in EITHER direction; enforcement is 404-shaped wherever a 403
// would confirm the block exists. These helpers answer "is/are blocked w.r.t.
// a viewer" — the per-surface response shaping lives at each call site.
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** Either direction: a blocks b OR b blocks a. */
export async function isBlockedPair(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM blocks
    WHERE (blocker_id = ${a} AND blocked_id = ${b})
       OR (blocker_id = ${b} AND blocked_id = ${a})
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/** Every user blocked w.r.t. `userId` (either direction), as a Set. */
export async function blockedSetOf(userId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT blocked_id AS id FROM blocks WHERE blocker_id = ${userId}
    UNION
    SELECT blocker_id AS id FROM blocks WHERE blocked_id = ${userId}
  `)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** `ids` minus every user blocked w.r.t. `userId` (either direction). */
export async function filterBlockedFrom(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const blocked = await blockedSetOf(userId);
  if (blocked.size === 0) return ids;
  return ids.filter((id) => !blocked.has(id));
}

/**
 * All block pairs touching any of `userIds` (either column), for batch
 * per-viewer filtering (joiner piles, seen-by lists). Returned as
 * "<a>:<b>" strings in both orders for O(1) pair lookups.
 */
export async function blockPairsAmong(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const list = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT blocker_id AS a, blocked_id AS b FROM blocks
    WHERE blocker_id IN (${list}) OR blocked_id IN (${list})
  `)) as unknown as { a: string; b: string }[];
  for (const r of rows) {
    out.add(`${r.a}:${r.b}`);
    out.add(`${r.b}:${r.a}`);
  }
  return out;
}
