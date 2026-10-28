// Wave 1.7 (AUDIT-PLAN §1.7, API.md §1.13 dm_policy; migration 0015):
// who may open a DM with whom, and what a not-yet-accepted DM withholds.
//
//   everyone     → the DM opens as it always did
//   connections  → an accepted §1.28 connection opens it; anyone else gets
//                  a PARKED DM — created, visible in the recipient's
//                  Requests row, but no push, no ring, no receipts or
//                  typing either way, until the recipient accepts
//   nobody       → refused, in the surface's own §1.14 404 shape
//
// An EXISTING DM is never closed by a later policy change (the
// anon_messages lesson): the gate runs only when a conversation is about
// to be created. Match / roulette / invite / rescue DMs never pass here —
// their rows take the column default (accepted).
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DM_REQUEST_MESSAGES_MAX } from '@socialchat/shared';
import { db, schema } from '../db/index.js';

export type DmGate = 'open' | 'parked' | 'refused';

/** Accepted §1.28 connection between the two — literally that, not friends-of. */
export async function isConnected(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM connections cx
    WHERE cx.status = 'accepted'
      AND ((cx.requester_id = ${a} AND cx.addressee_id = ${b})
        OR (cx.addressee_id = ${a} AND cx.requester_id = ${b}))
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/** What `creatorId` opening a NEW DM with `target` gets. */
export async function dmGateFor(
  creatorId: string,
  target: { id: string; dmPolicy: string },
): Promise<DmGate> {
  if (target.dmPolicy === 'everyone') return 'open';
  if (target.dmPolicy === 'nobody') return 'refused';
  return (await isConnected(creatorId, target.id)) ? 'open' : 'parked';
}

/** Has every active member of the conversation accepted it? (DMs: both.) */
export async function allAccepted(convId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT bool_and(accepted_at IS NOT NULL) AS ok
    FROM conversation_participants
    WHERE conversation_id = ${convId} AND left_at IS NULL
  `)) as unknown as { ok: boolean | null }[];
  return row?.ok !== false;
}

/** The active members who have accepted — the delivery set for pushes. */
export async function acceptedParticipantUserIds(convId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.conversationParticipants.userId })
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, convId),
        isNull(schema.conversationParticipants.leftAt),
        sql`${schema.conversationParticipants.acceptedAt} IS NOT NULL`,
      ),
    );
  return rows.map((r) => r.userId);
}

/** A stranger may send this many messages into a parked DM; then it waits. */
export async function requestSendAllowed(convId: string, senderId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM messages
    WHERE conversation_id = ${convId} AND sender_id = ${senderId}
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0) < DM_REQUEST_MESSAGES_MAX;
}

/** Mark `userId`'s row accepted; true when it was pending until now. */
export async function acceptConversation(convId: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE conversation_participants SET accepted_at = now()
    WHERE conversation_id = ${convId} AND user_id = ${userId}
      AND left_at IS NULL AND accepted_at IS NULL
    RETURNING user_id
  `)) as unknown as { user_id: string }[];
  return rows.length > 0;
}
