// v0.6 Bored Together + Bored Roulette shared machinery (API.md §1.44/§1.45,
// ADR-015). Everything here enforces the ADR's hard rules: a single wave
// notifies NOBODY (the only reader of discovery_waves is the match
// transaction), match DMs are minted WITH their icebreaker in one
// transaction, and roulette DMs that are not kept are HARD-DELETED by the
// sweep (plus the 24 h Redis feedback tombstone that outlives them).
import { eq, sql } from 'drizzle-orm';
import {
  DISCOVERY_ICEBREAKERS,
  DISCOVERY_OPTIN_TTL_S,
  ROULETTE_QUEUE_TTL_S,
  ROULETTE_WINDOW_S,
  type DiscoveryOptin,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { friendsOfPairCond } from '../../lib/friends.js';
import { activeParticipantUserIds, viewCtxForId, loadConversationDto, type MsgRow } from '../../lib/dto.js';
import { redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { hashString } from '../beacons/service.js';
import { fanOutNewMessage } from '../messages/service.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';

export type OptinRow = typeof schema.discoveryOptins.$inferSelect;
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const ROULETTE_QUEUE_KEY = 'roulette:queue';
export const rouletteFeedbackKey = (conversationId: string): string =>
  `roulette:fb:${conversationId}`;
export const ROULETTE_FEEDBACK_TTL_S = 24 * 3600;

const convs = schema.conversations;
const cp = schema.conversationParticipants;

export function optinDto(row: OptinRow): DiscoveryOptin {
  return {
    scope: row.scope as DiscoveryOptin['scope'],
    note: row.note,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  };
}

/** The caller's LIVE opt-in (reads always join expires_at > now()). */
export async function liveOptinOf(userId: string): Promise<OptinRow | null> {
  const [row] = await db
    .select()
    .from(schema.discoveryOptins)
    .where(
      sql`${schema.discoveryOptins.userId} = ${userId} AND ${schema.discoveryOptins.expiresAt} > now()`,
    )
    .limit(1);
  return row ?? null;
}

/** Rotating icebreaker, the BEACON_ICEBREAKERS pattern (hash(conv id) % len). */
export function discoveryIcebreakerFor(conversationId: string): string {
  return DISCOVERY_ICEBREAKERS[hashString(conversationId) % DISCOVERY_ICEBREAKERS.length]!;
}

/** Inline system-message insert INSIDE an open transaction — the §1.44/§1.45
 * match and keep transactions must land their system message atomically with
 * the rows they change (insertMessage opens its own transaction, so it cannot
 * be used there). Fan out the returned row with fanOutNewMessage AFTER commit. */
export async function insertSystemMessageTx(
  tx: DbTx,
  conversationId: string,
  event: string,
  body: string,
): Promise<MsgRow> {
  const [conv] = await tx
    .update(convs)
    .set({ lastSeq: sql`${convs.lastSeq} + 1`, lastMessageAt: new Date() })
    .where(eq(convs.id, conversationId))
    .returning({ lastSeq: convs.lastSeq });
  if (!conv) throw new Error('conversation vanished mid-transaction');
  const [msg] = await tx
    .insert(schema.messages)
    .values({
      id: newId(),
      conversationId,
      seq: conv.lastSeq,
      senderId: null,
      type: 'system',
      body,
      metadata: { system: { event } },
    })
    .returning();
  return msg!;
}

/** Thrown by createMatchedDmTx for roulette when a dm_key row exists after
 * all (a raced organic DM) — the pair is skipped, never merged. */
export class DmAlreadyExistsError extends Error {}

export interface MatchedDm {
  conversationId: string;
  icebreaker: MsgRow;
  created: boolean;
}

/**
 * Mint the match DM + its rotating icebreaker system message inside the
 * caller's transaction (§1.44 mutual wave / §1.45 roulette pairing).
 * - discovery: an existing dm_key row (a DM one party had left — friends-of
 *   only excludes ACTIVE dm partners) is revived with §1.4 re-join semantics
 *   and gains origin 'discovery' only if it had no origin.
 * - roulette: the pairing pre-excluded existing dm_keys, so a conflict is a
 *   race with an organic DM → DmAlreadyExistsError (skip the pair).
 */
export async function createMatchedDmTx(
  tx: DbTx,
  userA: string,
  userB: string,
  origin: 'discovery' | 'roulette',
): Promise<MatchedDm> {
  const dmKey = [userA, userB].sort().join(':');
  const [existing] = await tx.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
  let conversationId: string;
  let created = false;

  if (existing) {
    if (origin === 'roulette') throw new DmAlreadyExistsError();
    conversationId = existing.id;
    // Revive: re-join both parties with the §1.4 re-join semantics (fresh
    // join_seq history floor), stamp origin only when none exists.
    const nowIso = new Date().toISOString();
    for (const userId of [userA, userB]) {
      await tx.execute(sql`
        INSERT INTO conversation_participants
          (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
        VALUES (${conversationId}, ${userId}, 'member', ${nowIso}::timestamptz,
                ${existing.lastSeq}::bigint, NULL, ${existing.lastSeq}::bigint, ${existing.lastSeq}::bigint)
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET
          joined_at = CASE WHEN conversation_participants.left_at IS NULL
                           THEN conversation_participants.joined_at ELSE ${nowIso}::timestamptz END,
          join_seq = CASE WHEN conversation_participants.left_at IS NULL
                          THEN conversation_participants.join_seq ELSE ${existing.lastSeq}::bigint END,
          left_at = NULL,
          left_seq = NULL,
          last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${existing.lastSeq}::bigint),
          last_read_seq = GREATEST(conversation_participants.last_read_seq, ${existing.lastSeq}::bigint)
      `);
    }
    await tx.execute(sql`
      UPDATE conversations SET metadata = metadata || '{"origin":"discovery"}'::jsonb
      WHERE id = ${conversationId} AND NOT (metadata ? 'origin')
    `);
  } else {
    conversationId = newId();
    created = true;
    await tx.insert(convs).values({
      id: conversationId,
      type: 'dm',
      dmKey,
      createdBy: null,
      metadata:
        origin === 'roulette'
          ? { origin: 'roulette', roulette: { kept_by: [] } }
          : { origin: 'discovery' },
      ...(origin === 'roulette'
        ? { expiresAt: new Date(Date.now() + ROULETTE_WINDOW_S * 1000) }
        : {}),
    });
    await tx.insert(cp).values([
      { conversationId, userId: userA },
      { conversationId, userId: userB },
    ]);
  }

  const icebreaker = await insertSystemMessageTx(
    tx,
    conversationId,
    origin === 'roulette' ? 'roulette_matched' : 'discovery_matched',
    discoveryIcebreakerFor(conversationId),
  );
  return { conversationId, icebreaker, created };
}

// ---------------------------------------------------------------------------
// Roulette worker machinery (§1.45) — called from the `discovery` queue.
// ---------------------------------------------------------------------------

/** One pair is incompatible when blocked either way, in each other's
 * friends-of set, or already sharing ANY dm_key row (which also makes the
 * provisional create collision-free). */
async function incompatiblePair(a: string, b: string): Promise<boolean> {
  const dmKey = [a, b].sort().join(':');
  const rows = (await db.execute(sql`
    SELECT 1 AS one
    WHERE EXISTS (
        SELECT 1 FROM blocks bl
        WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b})
           OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))
      OR ${friendsOfPairCond(a, sql`${b}::uuid`)}
      OR EXISTS (SELECT 1 FROM conversations dc WHERE dc.dm_key = ${dmKey})
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/**
 * §1.45 pairing pass: pops queued users whose opt-ins are still live, pairs
 * oldest-first, skipping incompatible pairs. Runs at concurrency 1 (the
 * worker registration pins it), so no two passes race the queue.
 */
export async function runRoulettePair(): Promise<void> {
  const now = Date.now();
  await redis.zremrangebyscore(ROULETTE_QUEUE_KEY, '-inf', now - ROULETTE_QUEUE_TTL_S * 1000);
  const queued = await redis.zrange(ROULETTE_QUEUE_KEY, 0, 99); // oldest first
  if (queued.length < 2) return;

  // Live, non-suspended candidates (queue order preserved).
  const liveRows = (await db.execute(sql`
    SELECT o.user_id FROM discovery_optins o
    JOIN users u ON u.id = o.user_id
    WHERE o.user_id IN (${sql.join(queued.map((id) => sql`${id}::uuid`), sql`, `)})
      AND o.expires_at > now()
      AND u.suspended_at IS NULL AND u.banned_at IS NULL
  `)) as unknown as { user_id: string }[];
  const live = new Set(liveRows.map((r) => r.user_id));
  const candidates = queued.filter((id) => live.has(id));

  const paired = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i]!;
    if (paired.has(a)) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j]!;
      if (paired.has(b)) continue;
      if (await incompatiblePair(a, b)) continue;

      let match: MatchedDm;
      try {
        match = await db.transaction((tx) => createMatchedDmTx(tx, a, b, 'roulette'));
      } catch (err) {
        if (err instanceof DmAlreadyExistsError || (err as { code?: string }).code === '23505') {
          continue; // raced an organic DM — they stay queued for others
        }
        throw err;
      }
      paired.add(a);
      paired.add(b);
      await redis.zrem(ROULETTE_QUEUE_KEY, a, b);

      // Fan-out: roulette.matched to both, viewer-stamped (kept:false), then
      // the icebreaker as ordinary msg.new. NO push — both were in the queue
      // seconds ago (§1.45).
      for (const userId of [a, b]) {
        const view = await viewCtxForId(userId);
        const dto = await loadConversationDto(match.conversationId, view);
        if (dto) {
          await publishToUsers([userId], { t: 'roulette.matched', d: { conversation: dto } });
        }
      }
      await fanOutNewMessage(match.icebreaker);
      break;
    }
  }
}

/**
 * §1.45 expiry sweep: provisional DMs past their window are HARD-DELETED —
 * messages, participants, receipts cascade; attachment objects are removed
 * refcount-guarded after the rows are gone. Before the delete the sweep
 * writes the 24 h feedback tombstone and fans roulette.expired to both
 * parties (offline clients reconcile via §2.8 — the conversation is simply
 * absent from the snapshot).
 */
export async function runRouletteSweep(): Promise<void> {
  const expired = await db
    .select()
    .from(convs)
    .where(sql`${convs.expiresAt} IS NOT NULL AND ${convs.expiresAt} <= now()`)
    .limit(200);

  for (const conv of expired) {
    const participants = await activeParticipantUserIds(conv.id);
    const atts = (await db.execute(sql`
      SELECT a.id, a.original_key, a.thumb_key FROM attachments a
      JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ${conv.id}
    `)) as unknown as { id: string; original_key: string; thumb_key: string | null }[];

    // The tombstone authorizes the late §1.45 feedback tap (the DM is gone).
    await redis.set(
      rouletteFeedbackKey(conv.id),
      JSON.stringify(participants),
      'EX',
      ROULETTE_FEEDBACK_TTL_S,
    );

    // Guarded delete: a keep that raced us cleared expires_at and survives.
    const deleted = (await db.execute(sql`
      DELETE FROM conversations
      WHERE id = ${conv.id} AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING id
    `)) as unknown as { id: string }[];
    if (deleted.length === 0) {
      await redis.del(rouletteFeedbackKey(conv.id));
      continue;
    }

    await publishToUsers(participants, {
      t: 'roulette.expired',
      d: { conversation_id: conv.id },
    });
    for (const att of atts) {
      // deleteAttachmentObjects reads id/originalKey/thumbKey only; the rows
      // are already gone (cascade), so the ref check sees only other owners.
      await deleteAttachmentObjects({
        id: att.id,
        originalKey: att.original_key,
        thumbKey: att.thumb_key,
      } as Parameters<typeof deleteAttachmentObjects>[0]);
    }
  }
}

/** §1.44 bookkeeping sweep: lapsed opt-ins and the waves that died with them
 * (reads filter live either way — the house pattern). */
export async function runDiscoverySweep(): Promise<void> {
  await db.execute(sql`DELETE FROM discovery_optins WHERE expires_at <= now()`);
  await db.execute(sql`
    DELETE FROM discovery_waves w
    WHERE w.created_at < now() - (${DISCOVERY_OPTIN_TTL_S}::int * interval '1 second')
       OR NOT EXISTS (
         SELECT 1 FROM discovery_optins o
         WHERE o.user_id = w.from_user_id AND o.expires_at > now())
  `);
}
