// Support machinery (v0.8b — API.md §1.69, FEATURES #81b, ADR-020). The
// dialogue is an ordinary conversation so delivery, push, unread and receipts
// come free: a per-user "Bored Chat Support" conversation (type 'group',
// created_by NULL, metadata.support = true, the user as SOLE member — no
// dm_key, no second human), lazily created on first delivery. Operator
// messages are sender_id NULL + metadata.support {ticket_id} — clients render
// the Support brand, never a named admin. Takedown notices ride the same
// channel. Admins never appear as participants; they read via the ticket
// viewer and speak via replies (consent is structural — the user is talking
// TO the operator).
import { and, eq, sql } from 'drizzle-orm';
import { OFFLINE_GRACE_S, SUPPORT_CONVERSATION_TITLE, type SupportTicket } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { attachmentDto, publishConversationToUsers, type ConvRow } from '../../lib/dto.js';
import { enqueuePushBulk } from '../../queues.js';
import { presenceKey, redis } from '../../redis.js';
import { registry } from '../../ws/registry.js';
import { fanOutNewMessage, insertMessage } from '../messages/service.js';

export type SupportTicketRow = typeof schema.supportTickets.$inferSelect;

export async function supportTicketDto(row: SupportTicketRow): Promise<SupportTicket> {
  let attachment = null;
  if (row.attachmentId) {
    const [att] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, row.attachmentId))
      .limit(1);
    if (att) attachment = attachmentDto(att);
  }
  return {
    id: row.id,
    category: row.category as SupportTicket['category'],
    body: row.body,
    attachment,
    status: row.status as SupportTicket['status'],
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Find-or-create the user's Support conversation (lazily, §1.69). */
export async function ensureSupportConversation(userId: string): Promise<ConvRow> {
  const rows = (await db.execute(sql`
    SELECT c.id FROM conversations c
    JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ${userId}
    WHERE c.metadata @> '{"support": true}'::jsonb
    LIMIT 1
  `)) as unknown as { id: string }[];
  if (rows.length > 0) {
    const [conv] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, rows[0]!.id))
      .limit(1);
    if (conv) return conv;
  }
  const convId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(schema.conversations).values({
      id: convId,
      type: 'group',
      title: SUPPORT_CONVERSATION_TITLE,
      createdBy: null,
      metadata: { support: true },
    });
    await tx.insert(schema.conversationParticipants).values({
      conversationId: convId,
      userId,
      role: 'member',
    });
  });
  await publishConversationToUsers(convId, [userId], 'conv.new');
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  return conv!;
}

/**
 * One operator message into the user's Support conversation (ticket replies
 * AND takedown notices): sender_id NULL + metadata.support {ticket_id} —
 * a message like any other, so msg.new fan-out and §2.9 push apply (the push
 * title is the conversation title: the Support brand, never a named admin).
 */
export async function sendSupportMessage(
  userId: string,
  body: string,
  ticketId: string | null,
): Promise<void> {
  const conv = await ensureSupportConversation(userId);
  const msg = await insertMessage({
    conversationId: conv.id,
    senderId: null,
    type: 'text',
    body,
    metadata: { support: { ticket_id: ticketId } },
  });
  await fanOutNewMessage(msg);
  // fanOutNewMessage skips push for sender-less rows (system messages never
  // push) — a support answer DOES push like any message (§1.69), so enqueue
  // here with the same offline + presence-grace posture.
  if (!registry.userHasSockets(userId)) {
    const inGrace = (await redis.exists(presenceKey(userId))) === 1;
    await enqueuePushBulk([
      {
        job: {
          user_id: userId,
          conversation_id: conv.id,
          message_id: msg.id,
          seq: msg.seq,
        },
        delayMs: inGrace ? (OFFLINE_GRACE_S + 2) * 1000 : 0,
      },
    ]);
  }
}

/** The user replied in their Support conversation: re-open their most recent
 * non-closed ticket, else the latest closed one (route-side, §1.69). */
export async function reopenTicketOnUserReply(userId: string): Promise<void> {
  const open = (await db.execute(sql`
    UPDATE support_tickets SET status = 'open', updated_at = now()
    WHERE id = (
      SELECT id FROM support_tickets
      WHERE user_id = ${userId} AND status <> 'closed'
      ORDER BY created_at DESC LIMIT 1
    )
    RETURNING id
  `)) as unknown as { id: string }[];
  if (open.length > 0) return;
  await db.execute(sql`
    UPDATE support_tickets SET status = 'open', updated_at = now()
    WHERE id = (
      SELECT id FROM support_tickets
      WHERE user_id = ${userId} AND status = 'closed'
      ORDER BY created_at DESC LIMIT 1
    )
  `);
}

/** Is this conversation a Support conversation (metadata rider)? */
export function isSupportConversation(conv: Pick<ConvRow, 'metadata'>): boolean {
  return Boolean((conv.metadata as { support?: boolean } | null)?.support);
}

/** Validate the optional screenshot: mine, kind image, ready, unbound. */
export async function validSupportAttachment(
  attachmentId: string,
  userId: string,
): Promise<boolean> {
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(
      and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.uploaderId, userId)),
    )
    .limit(1);
  return Boolean(att && att.kind === 'image' && att.status === 'ready' && att.messageId === null);
}
