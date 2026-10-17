// v0.4 worker queue `timers` (API.md §1.25/§1.26, ADR-010):
//   disappear-sweep   — repeatable every DISAPPEAR_SWEEP_INTERVAL_S: TOMBSTONES
//                       expired messages in TTL'd conversations (deleted_at
//                       set, body NULLed, metadata emptied, attachments +
//                       dependent reaction/poll rows removed, MinIO objects
//                       deleted). The message row — and its seq — is NEVER
//                       deleted or reused, so sync cursors, watermarks, unread
//                       math and pagination survive untouched (ADR-003).
//                       System messages are exempt.
//   scheduled-deliver — delayed per scheduled row (jobId scheduled:<id>).
//   scheduled-sweep   — repeatable minute safety net over scheduled_due_idx.
import { eq, sql } from 'drizzle-orm';
import {
  DISAPPEAR_SWEEP_INTERVAL_S,
  MOOD_SWEEP_INTERVAL_S,
  MOOD_SWING_INTERVAL_S,
  MOOD_SWING_JITTER_S,
  STORY_SWEEP_INTERVAL_S,
  type MoodSwingEntry,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import {
  activeParticipantUserIds,
  broadcastUserUpdatedOf,
  messageDtos,
  publishConversationToUsers,
  publishUserUpdated,
  rawToMsgRow,
  type MsgRow,
} from '../lib/dto.js';
import { runCallRingSweep, runMissedCall } from '../modules/calls/service.js';
import { deliverScheduledMessage } from '../modules/scheduled/service.js';
import { publishMessageUpdated } from '../modules/messages/service.js';
import { runListingSweep } from '../modules/listings/service.js';
import { runStorySweep } from '../modules/stories/service.js';
import type { TimersJob } from '../queues.js';
import { deleteAttachmentObjects } from './gc.js';
import { publishToUsers } from '../ws/events.js';

export { DISAPPEAR_SWEEP_INTERVAL_S, MOOD_SWEEP_INTERVAL_S, STORY_SWEEP_INTERVAL_S };

// Tombstones per conversation per run — bounds one sweep's fan-out; the next
// run (1 min later) continues where this one stopped.
const SWEEP_BATCH_PER_CONVERSATION = 200;

/** Tombstone ONE expired message: dependent rows go, the row and seq stay.
 * Returns whether a §1.32 pin was removed with it (the caller owes a
 * conv.updated when so). */
async function tombstoneMessage(msg: MsgRow): Promise<boolean> {
  // Attachment rows + objects (shared content-hash keys are ref-checked).
  const atts = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, msg.id));

  let pinRemoved = false;
  await db.transaction(async (tx) => {
    // Dependent rows keyed by (conversation_id, seq): the message row
    // survives, so FK cascades never fire on their own (§1.25).
    await tx.execute(sql`
      DELETE FROM message_reactions
      WHERE conversation_id = ${msg.conversationId} AND seq = ${msg.seq}::bigint
    `);
    await tx.execute(sql`
      DELETE FROM polls
      WHERE conversation_id = ${msg.conversationId} AND seq = ${msg.seq}::bigint
    `);
    // v0.5a (§1.32): tombstoning a pinned message removes its pin in the SAME
    // transaction.
    const pins = (await tx.execute(sql`
      DELETE FROM conversation_pins
      WHERE conversation_id = ${msg.conversationId} AND seq = ${msg.seq}::bigint
      RETURNING seq
    `)) as unknown as { seq: number }[];
    pinRemoved = pins.length > 0;
    await tx.execute(sql`DELETE FROM attachments WHERE message_id = ${msg.id}`);
    await tx.execute(sql`
      UPDATE messages SET deleted_at = now(), body = NULL, metadata = '{}'::jsonb
      WHERE id = ${msg.id} AND deleted_at IS NULL
    `);
  });

  // Objects after commit (rows are gone, so the ref check sees only others).
  // Refcount-guarded (§1.31): forwarded/recap re-references keep them alive.
  for (const att of atts) {
    await deleteAttachmentObjects(att);
  }
  return pinRemoved;
}

export async function runDisappearSweep(): Promise<void> {
  const convs = (await db.execute(sql`
    SELECT id, disappear_ttl_s FROM conversations WHERE disappear_ttl_s IS NOT NULL
  `)) as unknown as { id: string; disappear_ttl_s: number }[];

  for (const conv of convs) {
    // The sweep compares against the CURRENT TTL (§1.25): turning it on
    // applies to old messages too; turning it off stops everything.
    const rows = (await db.execute(sql`
      SELECT * FROM messages
      WHERE conversation_id = ${conv.id}
        AND deleted_at IS NULL AND type <> 'system'
        AND created_at < now() - (${conv.disappear_ttl_s}::int * interval '1 second')
      ORDER BY created_at ASC
      LIMIT ${SWEEP_BATCH_PER_CONVERSATION}
    `)) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;

    const recipients = await activeParticipantUserIds(conv.id);
    // Vibe messages whose replies tombstoned this run — re-shipped once after
    // the batch so the collage drops the dead tiles (§1.23).
    const vibeParents = new Set<number>();
    let anyPinRemoved = false;

    for (const raw of rows) {
      const msg = rawToMsgRow(raw);
      const meta = (msg.metadata ?? {}) as { vibe_reply_seq?: number };
      if (typeof meta.vibe_reply_seq === 'number') vibeParents.add(meta.vibe_reply_seq);

      if (await tombstoneMessage(msg)) anyPinRemoved = true;

      // One msg.updated per tombstone (offline clients reconcile via sync +
      // history refetch, where tombstones arrive as ordinary DTOs).
      const [fresh] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, msg.id))
        .limit(1);
      if (fresh) {
        const [dto] = await messageDtos([fresh]);
        if (dto) {
          await publishToUsers(recipients, {
            t: 'msg.updated',
            d: { conversation_id: conv.id, message: dto },
          });
        }
      }
    }

    // §1.32: pin removals ride ONE conv.updated per sweep batch.
    if (anyPinRemoved) {
      await publishConversationToUsers(conv.id, recipients, 'conv.updated');
    }

    for (const parentSeq of vibeParents) {
      const [parent] = await db
        .select()
        .from(schema.messages)
        .where(
          sql`${schema.messages.conversationId} = ${conv.id} AND ${schema.messages.seq} = ${parentSeq}::bigint`,
        )
        .limit(1);
      if (parent && parent.deletedAt === null) await publishMessageUpdated(parent);
    }
  }
}

// ---------------------------------------------------------------------------
// v0.8a moods (API.md §1.57, ADR-018): the expiry sweep and 🎢 swing rotation.
// Reads already filter mood_expires_at > now() LIVE, so these are bookkeeping
// plus the user.updated goodbye/morph frame — a lagging run can never show a
// stale chip. Moods NEVER push and leave NO trace (auto-sober included: the
// drunk chip vanishes under the same zero-trace rule).
// ---------------------------------------------------------------------------

/** Clears every mood_* column where the mood has expired (walked via
 * users_mood_expiry_idx) and fans one user.updated per user. A mood that was
 * 'nobody'-visible says goodbye to the owner's own sockets only — others
 * never knew, so no frame reaches them (the §1.57 fan-out skip). */
export async function runMoodExpirySweep(): Promise<void> {
  const cleared = (await db.execute(sql`
    WITH expired AS (
      SELECT id, mood_visibility FROM users
      WHERE mood_expires_at IS NOT NULL AND mood_expires_at <= now()
      FOR UPDATE SKIP LOCKED
    )
    UPDATE users u SET
      mood_emoji = NULL, mood_label = NULL, mood_kind = NULL,
      mood_visibility = 'everyone', mood_swing_set = NULL,
      mood_expires_at = NULL, mood_swing_rotated_at = NULL
    FROM expired e WHERE u.id = e.id
    RETURNING u.id, e.mood_visibility AS old_visibility
  `)) as unknown as { id: string; old_visibility: string }[];
  for (const row of cleared) {
    if (row.old_visibility === 'nobody') {
      const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, row.id)).limit(1);
      if (fresh) await publishUserUpdated(fresh, [row.id]);
    } else {
      await broadcastUserUpdatedOf(row.id);
    }
  }
}

/** 🎢 Swing rotation: each swinging user rotates to a random DIFFERENT entry
 * of their swing_set every MOOD_SWING_INTERVAL_S ± uniform jitter. Candidates
 * come off users_mood_swing_idx once they pass the window's EARLY edge; each
 * then draws a uniform target in [interval−jitter, interval+jitter] and
 * rotates when its elapsed time passes it — past the LATE edge the rotation
 * is unconditional (deterministic for tests). Rotation materializes
 * mood_emoji/mood_label (kind stays 'swing' — clients morph the chip on
 * user.updated), re-stamps mood_swing_rotated_at and NEVER extends
 * mood_expires_at. */
export async function runMoodSwingSweep(): Promise<void> {
  const minS = MOOD_SWING_INTERVAL_S - MOOD_SWING_JITTER_S;
  const maxS = MOOD_SWING_INTERVAL_S + MOOD_SWING_JITTER_S;
  const due = (await db.execute(sql`
    SELECT id FROM users
    WHERE mood_kind = 'swing'
      AND mood_expires_at > now()
      AND mood_swing_rotated_at IS NOT NULL
      AND mood_swing_rotated_at <= now() - make_interval(secs => ${minS})
  `)) as unknown as { id: string }[];
  for (const { id } of due) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!u || u.moodKind !== 'swing' || !u.moodSwingRotatedAt) continue;
    if (!u.moodExpiresAt || u.moodExpiresAt.getTime() <= Date.now()) continue;
    const elapsedS = (Date.now() - u.moodSwingRotatedAt.getTime()) / 1000;
    const targetS = minS + Math.random() * (maxS - minS);
    if (elapsedS < targetS && elapsedS < maxS) continue;

    const set = (u.moodSwingSet ?? []) as MoodSwingEntry[];
    const others = set.filter((e) => !(e.emoji === u.moodEmoji && e.label === u.moodLabel));
    const next = others[Math.floor(Math.random() * others.length)] ?? set[0];
    if (!next) continue;
    const updated = (await db.execute(sql`
      UPDATE users SET mood_emoji = ${next.emoji}, mood_label = ${next.label},
        mood_swing_rotated_at = now()
      WHERE id = ${id} AND mood_kind = 'swing'
      RETURNING id, mood_visibility
    `)) as unknown as { id: string; mood_visibility: string }[];
    if (updated.length === 0) continue;
    // The morph frame — 'nobody' swings morph for the owner alone (§1.57).
    if (updated[0]!.mood_visibility === 'nobody') {
      const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      if (fresh) await publishUserUpdated(fresh, [id]);
    } else {
      await broadcastUserUpdatedOf(id);
    }
  }
}

export async function runScheduledSweep(): Promise<void> {
  const due = (await db.execute(sql`
    SELECT id FROM scheduled_messages
    WHERE status = 'pending' AND deliver_at <= now()
    ORDER BY deliver_at ASC
    LIMIT 500
  `)) as unknown as { id: string }[];
  for (const row of due) {
    await deliverScheduledMessage(row.id);
  }
}

export async function processTimersJob(name: string, job: TimersJob): Promise<void> {
  switch (name) {
    case 'disappear-sweep':
      return runDisappearSweep();
    case 'scheduled-sweep':
      return runScheduledSweep();
    // v0.5a (§1.34): expired stories HARD-delete silently — no fan-out, no
    // "story expired" event; they drop out of the next GET.
    case 'story-sweep':
      return runStorySweep();
    // v0.5b (§1.38): hourly listing expiry — status BOOKKEEPING only (board
    // reads filter expires_at live); no fan-out, no notification, ever.
    case 'listing-sweep':
      return runListingSweep();
    case 'scheduled-deliver': {
      const id = (job as { scheduled_id?: string }).scheduled_id;
      if (id) await deliverScheduledMessage(id);
      return;
    }
    // v0.6 (§1.42): the 45 s ring timeout (delayed per call) + its repeatable
    // safety sweep over calls_ringing_idx. The flip is a guarded UPDATE, so
    // job/sweep/cancel races can never double-run the missed-call machinery.
    case 'call-ring-timeout': {
      const id = (job as { call_id?: string }).call_id;
      if (id) await runMissedCall(id);
      return;
    }
    case 'call-ring-sweep':
      return runCallRingSweep();
    // v0.8a (§1.57): mood expiry (bookkeeping behind the live read filter) +
    // 🎢 swing rotation. No push, no trace — ever.
    case 'mood-sweep':
      return runMoodExpirySweep();
    case 'mood-swing-sweep':
      return runMoodSwingSweep();
    default:
      throw new Error(`timers: unknown job ${name}`);
  }
}
