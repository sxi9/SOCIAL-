// Scheduled messages & time capsules (v0.4 — API.md §1.26, ADR-010).
// Delivery is worker-driven (queue `timers`): a delayed job per row plus a
// minute safety sweep. The claim is the guarded UPDATE ... WHERE
// status='pending' executed INSIDE the same transaction as the real §1.5
// message insert (seq bump, author-watermark raise, attachment binding), so a
// job retry or a sweep/job race can never deliver twice. Undeliverable rows
// (author left, DM frozen by a §1.14 block, conversation gone, voice note
// whose recording the media worker rejected per §1.20) flip to 'cancelled' —
// never a partial send, no error to anyone.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ScheduledMessage } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { attachmentDto, type AttRow, type MsgRow } from '../../lib/dto.js';
import { publishToUsers } from '../../ws/events.js';
import { fanOutNewMessage } from '../messages/service.js';

export type ScheduledRow = typeof schema.scheduledMessages.$inferSelect;

const sm = schema.scheduledMessages;
const iso = (d: Date): string => d.toISOString();

export function scheduledDto(row: ScheduledRow, atts: AttRow[]): ScheduledMessage {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    type: row.type as ScheduledMessage['type'],
    body: row.body,
    attachments: atts.map(attachmentDto),
    metadata: (row.metadata ?? {}) as ScheduledMessage['metadata'],
    deliver_at: iso(row.deliverAt),
    status: row.status as ScheduledMessage['status'],
    created_at: iso(row.createdAt),
    sent_at: row.sentAt ? iso(row.sentAt) : null,
    sent_seq: row.sentSeq,
  };
}

/** Attachments grouped by scheduled_message_id (kept bound after delivery so
 * the author's list keeps rendering them). */
export async function loadScheduledAttachments(ids: string[]): Promise<Map<string, AttRow[]>> {
  const map = new Map<string, AttRow[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.scheduledMessageId, ids))
    .orderBy(asc(schema.attachments.createdAt));
  for (const row of rows) {
    if (!row.scheduledMessageId) continue;
    const list = map.get(row.scheduledMessageId) ?? [];
    list.push(row);
    map.set(row.scheduledMessageId, list);
  }
  return map;
}

/** §2.3 scheduled.updated — to the AUTHOR's own sockets ONLY, on every
 * create/cancel/send (a pending schedule is private until delivery). */
export async function publishScheduledUpdated(row: ScheduledRow): Promise<void> {
  const atts = await loadScheduledAttachments([row.id]);
  await publishToUsers([row.authorId], {
    t: 'scheduled.updated',
    d: { scheduled: scheduledDto(row, atts.get(row.id) ?? []) },
  });
}

export type DeliveryOutcome = 'sent' | 'cancelled' | 'noop';

/**
 * Idempotent delivery (worker `timers` queue; also called by the sweep and by
 * tests). SELECT ... FOR UPDATE on the row serializes concurrent workers: the
 * loser blocks, then re-reads a non-pending status and no-ops. The message
 * insert and the status='pending'-guarded claim commit atomically.
 */
export async function deliverScheduledMessage(id: string): Promise<DeliveryOutcome> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sm)
      .where(and(eq(sm.id, id), eq(sm.status, 'pending')))
      .for('update');
    if (!row) return { outcome: 'noop' as const };

    // Re-check deliverability AT SEND TIME (§1.26 + task rule): author still
    // an active participant, conversation still there, DM not frozen by a block.
    const [conv] = await tx
      .select({ id: schema.conversations.id, type: schema.conversations.type })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, row.conversationId))
      .limit(1);
    const [part] = await tx
      .select()
      .from(schema.conversationParticipants)
      .where(
        and(
          eq(schema.conversationParticipants.conversationId, row.conversationId),
          eq(schema.conversationParticipants.userId, row.authorId),
        ),
      )
      .limit(1);
    let deliverable = Boolean(conv && part && part.leftAt === null);
    if (deliverable && conv!.type === 'dm') {
      const peers = await tx
        .select({ userId: schema.conversationParticipants.userId })
        .from(schema.conversationParticipants)
        .where(eq(schema.conversationParticipants.conversationId, row.conversationId));
      const peer = peers.map((p) => p.userId).find((uid) => uid !== row.authorId);
      if (peer && (await isBlockedPair(row.authorId, peer))) deliverable = false;
    }

    // §1.20 duration cap, re-checked AT DELIVERY TIME inside this transaction:
    // schedule-create deliberately accepts a still-'pending' recording, and the
    // media worker's ffprobe verdict (over MAX_AUDIO_DURATION_S → 'failed')
    // lands during the ≥60 s lead (SCHEDULED_MIN_LEAD_S). Binding a 'failed'
    // attachment here would make the cap advisory via the scheduled path, so a
    // voice note whose sole recording was rejected cancels instead of sending
    // (same never-bindable rule as the direct §1.5 send).
    if (deliverable && row.type === 'audio') {
      const [att] = await tx
        .select({ kind: schema.attachments.kind, status: schema.attachments.status })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.scheduledMessageId, id),
            isNull(schema.attachments.messageId),
          ),
        )
        .limit(1);
      if (!att || att.kind !== 'audio' || att.status === 'failed') deliverable = false;
    }

    if (!deliverable) {
      const [cancelled] = await tx
        .update(sm)
        .set({ status: 'cancelled' })
        .where(eq(sm.id, id))
        .returning();
      // Orphan the attachments so the nightly GC reaps them.
      await tx.execute(sql`
        UPDATE attachments SET scheduled_message_id = NULL
        WHERE scheduled_message_id = ${id} AND message_id IS NULL
      `);
      return { outcome: 'cancelled' as const, row: cancelled! };
    }

    // The §1.5 seq transaction, inline: bump → insert → raise author
    // watermarks → bind attachments → claim.
    const [bumped] = await tx
      .update(schema.conversations)
      .set({
        lastSeq: sql`${schema.conversations.lastSeq} + 1`,
        lastMessageAt: new Date(),
      })
      .where(eq(schema.conversations.id, row.conversationId))
      .returning({ lastSeq: schema.conversations.lastSeq });
    const seq = bumped!.lastSeq;

    const [msg] = await tx
      .insert(schema.messages)
      .values({
        id: newId(),
        conversationId: row.conversationId,
        seq,
        senderId: row.authorId,
        // Deliberately NOT the scheduled client_msg_id: that uuid namespaces
        // the SCHEDULE's create-idempotency, not a live send.
        clientMsgId: null,
        type: row.type,
        body: row.body,
        metadata: row.metadata ?? {},
      })
      .returning();

    await tx.execute(sql`
      UPDATE conversation_participants SET
        last_delivered_seq = GREATEST(last_delivered_seq, ${seq}::bigint),
        last_read_seq = GREATEST(last_read_seq, ${seq}::bigint)
      WHERE conversation_id = ${row.conversationId} AND user_id = ${row.authorId}
    `);

    // Bind the waiting attachments to the real message; scheduled_message_id
    // stays so the author's scheduled list keeps rendering them.
    await tx.execute(sql`
      UPDATE attachments SET message_id = ${msg!.id}, share_import_id = NULL
      WHERE scheduled_message_id = ${id} AND message_id IS NULL
    `);

    // The idempotent claim — guarded on status, inside this same transaction.
    const [sent] = await tx
      .update(sm)
      .set({ status: 'sent', sentAt: new Date(), sentSeq: seq })
      .where(and(eq(sm.id, id), eq(sm.status, 'pending')))
      .returning();
    return { outcome: 'sent' as const, row: sent!, msg: msg! as MsgRow };
  });

  if (result.outcome === 'sent') {
    await fanOutNewMessage(result.msg);
    await publishScheduledUpdated(result.row);
  } else if (result.outcome === 'cancelled') {
    await publishScheduledUpdated(result.row);
  }
  return result.outcome;
}
