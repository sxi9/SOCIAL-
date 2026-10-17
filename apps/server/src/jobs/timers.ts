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
import { DISAPPEAR_SWEEP_INTERVAL_S, STORY_SWEEP_INTERVAL_S } from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import {
  activeParticipantUserIds,
  messageDtos,
  publishConversationToUsers,
  rawToMsgRow,
  type MsgRow,
} from '../lib/dto.js';
import { deliverScheduledMessage } from '../modules/scheduled/service.js';
import { publishMessageUpdated } from '../modules/messages/service.js';
import { runListingSweep } from '../modules/listings/service.js';
import { runStorySweep } from '../modules/stories/service.js';
import type { TimersJob } from '../queues.js';
import { deleteAttachmentObjects } from './gc.js';
import { publishToUsers } from '../ws/events.js';

export { DISAPPEAR_SWEEP_INTERVAL_S, STORY_SWEEP_INTERVAL_S };

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
    default:
      throw new Error(`timers: unknown job ${name}`);
  }
}
