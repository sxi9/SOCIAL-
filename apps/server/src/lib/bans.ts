// Conversation bans (AUDIT-PLAN §2.5 admin half, migration 0016): an admin
// removing a member writes one; every re-entry door reads it INVISIBLY (the
// §1.14 shape — a banned person gets the same answer as someone the group
// never existed for); an admin re-adding, approving or unbanning lifts it.
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export async function isBannedFrom(convId: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM conversation_bans
    WHERE conversation_id = ${convId} AND user_id = ${userId}
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/** Ban (idempotent) and drop any pending join request in the same breath,
 * so the admins' queue stays truthful. Returns the dropped request's
 * created_at when there was one (the caller fans the queue shrink). */
export async function banMember(
  convId: string,
  userId: string,
  bannedBy: string,
): Promise<{ droppedRequestAt: Date | null }> {
  await db.execute(sql`
    INSERT INTO conversation_bans (conversation_id, user_id, banned_by)
    VALUES (${convId}, ${userId}, ${bannedBy})
    ON CONFLICT (conversation_id, user_id) DO NOTHING
  `);
  const dropped = (await db.execute(sql`
    DELETE FROM group_join_requests
    WHERE conversation_id = ${convId} AND user_id = ${userId}
    RETURNING created_at
  `)) as unknown as { created_at: string | Date }[];
  return { droppedRequestAt: dropped[0] ? new Date(dropped[0].created_at) : null };
}

/** Lift a ban; true when one existed. */
export async function unbanMember(convId: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    DELETE FROM conversation_bans
    WHERE conversation_id = ${convId} AND user_id = ${userId}
    RETURNING user_id
  `)) as unknown as { user_id: string }[];
  return rows.length > 0;
}

/** Lift bans for several users at once (an admin adding them back). */
export async function unbanMembers(convId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.execute(sql`
    DELETE FROM conversation_bans
    WHERE conversation_id = ${convId}
      AND user_id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
}
