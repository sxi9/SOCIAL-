// FRIENDS-OF (v0.5a — API.md §1.28, ADR-011): THE audience primitive of the
// social layer = accepted connections ∪ dm-partners, minus §1.14 blocks —
// resolved at read/fan-out time, NEVER stored. It powers stories (§1.34), the
// feed (§1.36), and upgrades the beacons 'friends' audience and the
// beacon_default_audience setting (both keep the stored enum value 'friends'
// but resolve here from v0.5a on). show_last_seen / group_add_policy
// 'dm_partners' are untouched — they still mean DM partners literally.
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * SQL fragment: `other` (a column expression or bound value) is in `meId`'s
 * friends-of set BEFORE block filtering — callers compose their own §1.14
 * block clause (every existing beacon query already carries one).
 */
export function friendsOfPairCond(meId: string, other: SQL): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM conversation_participants fp1
      JOIN conversation_participants fp2 ON fp2.conversation_id = fp1.conversation_id
      JOIN conversations fc ON fc.id = fp1.conversation_id AND fc.type = 'dm'
      WHERE fp1.user_id = ${meId} AND fp2.user_id = ${other}
        AND fp1.left_at IS NULL AND fp2.left_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM connections cx
      WHERE cx.status = 'accepted'
        AND ((cx.requester_id = ${meId} AND cx.addressee_id = ${other})
          OR (cx.addressee_id = ${meId} AND cx.requester_id = ${other}))))`;
}

/** The full friends-of set of `userId`, minus blocks (either direction). */
export async function friendsOfIds(userId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT other_id FROM (
      SELECT CASE WHEN c.requester_id = ${userId} THEN c.addressee_id ELSE c.requester_id END AS other_id
      FROM connections c
      WHERE c.status = 'accepted' AND (c.requester_id = ${userId} OR c.addressee_id = ${userId})
      UNION
      SELECT other.user_id AS other_id
      FROM conversation_participants mine
      JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
      JOIN conversations conv ON conv.id = mine.conversation_id AND conv.type = 'dm'
      WHERE mine.user_id = ${userId} AND mine.left_at IS NULL
        AND other.left_at IS NULL AND other.user_id <> ${userId}
    ) t
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks bl
      WHERE (bl.blocker_id = ${userId} AND bl.blocked_id = t.other_id)
         OR (bl.blocker_id = t.other_id AND bl.blocked_id = ${userId}))
  `)) as unknown as { other_id: string }[];
  return new Set(rows.map((r) => r.other_id));
}

/** Is `b` in `a`'s friends-of set (symmetric), minus blocks? */
export async function isFriendOf(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = (await db.execute(sql`
    SELECT 1 AS one
    WHERE ${friendsOfPairCond(a, sql`${b}::uuid`)}
      AND NOT EXISTS (
        SELECT 1 FROM blocks bl
        WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b})
           OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}
