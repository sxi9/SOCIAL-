// Find-or-create the DM between two users from OUTSIDE the conversations
// router (handoff §1.79: a story reply lands in the author's DM). The same
// rules as POST /api/conversations {type:'dm'} — dm_key dedupes creation
// races, a blocked pair is refused in the caller's own 404 shape, the §1.13
// dm_policy gate parks or refuses, a peer who left is re-seated. Returns
// null when the DM may not be opened (refused / blocked): the CALLER picks
// the 404-shaped error for its surface (never a 403 that confirms a block).
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { newId } from '../ids.js';
import { isBlockedPair } from './blocks.js';
import { dmGateFor, type DmGate } from './dmPolicy.js';
import { publishConversationToUsers } from './dto.js';

const convs = schema.conversations;
const cp = schema.conversationParticipants;

export interface EnsuredDm {
  conversationId: string;
  created: boolean;
  gate: DmGate;
}

export async function ensureDm(meId: string, peerId: string): Promise<EnsuredDm | null> {
  if (meId === peerId) return null;
  const [peer] = await db
    .select({ id: schema.users.id, dmPolicy: schema.users.dmPolicy })
    .from(schema.users)
    .where(eq(schema.users.id, peerId))
    .limit(1);
  if (!peer) return null;
  if (await isBlockedPair(meId, peerId)) return null;

  const dmKey = [meId, peerId].sort().join(':');
  const [existing] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
  if (existing) {
    const [peerRow] = await db
      .select()
      .from(cp)
      .where(sql`${cp.conversationId} = ${existing.id} AND ${cp.userId} = ${peerId}`)
      .limit(1);
    let gate: DmGate = 'open';
    if (peerRow && peerRow.leftAt !== null) {
      gate = await dmGateFor(meId, peer);
      if (gate === 'refused') return null;
      await db.execute(sql`
        UPDATE conversation_participants SET
          left_at = NULL, left_seq = NULL,
          joined_at = now(),
          join_seq = (SELECT last_seq FROM conversations WHERE id = ${existing.id}),
          accepted_at = ${gate === 'parked' ? sql`NULL` : sql`now()`}
        WHERE conversation_id = ${existing.id} AND user_id = ${peerId}
      `);
      await publishConversationToUsers(existing.id, [peerId], 'conv.new');
    } else if (peerRow && peerRow.acceptedAt === null) {
      gate = 'parked';
    }
    // My own row may have been left (I deleted the chat) or still parked
    // (THEY requested me): writing into it is my acceptance — the Wave 1.7
    // send rule (messages/service.ts requireSendable), mirrored here.
    const [mineRow] = await db
      .select()
      .from(cp)
      .where(sql`${cp.conversationId} = ${existing.id} AND ${cp.userId} = ${meId}`)
      .limit(1);
    if (mineRow && (mineRow.leftAt !== null || mineRow.acceptedAt === null)) {
      await db.execute(sql`
        UPDATE conversation_participants SET
          left_at = NULL, left_seq = NULL,
          joined_at = CASE WHEN left_at IS NOT NULL THEN now() ELSE joined_at END,
          join_seq = CASE WHEN left_at IS NOT NULL THEN (SELECT last_seq FROM conversations WHERE id = ${existing.id}) ELSE join_seq END,
          accepted_at = COALESCE(accepted_at, now())
        WHERE conversation_id = ${existing.id} AND user_id = ${meId}
      `);
      await publishConversationToUsers(existing.id, [meId], 'conv.updated');
    }
    return { conversationId: existing.id, created: false, gate };
  }

  const gate = await dmGateFor(meId, peer);
  if (gate === 'refused') return null;
  const convId = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(convs).values({ id: convId, type: 'dm', dmKey, createdBy: meId });
      await tx.insert(cp).values([
        { conversationId: convId, userId: meId },
        { conversationId: convId, userId: peerId, ...(gate === 'parked' ? { acceptedAt: null } : {}) },
      ]);
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const [raced] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
      if (raced) return { conversationId: raced.id, created: false, gate };
    }
    throw err;
  }
  await publishConversationToUsers(convId, [meId, peerId], 'conv.new');
  return { conversationId: convId, created: true, gate };
}
