// The gapless per-conversation seq transaction (ARCHITECTURE §1, SCHEMA.sql):
// UPDATE conversations SET last_seq = last_seq + 1 ... RETURNING locks the row
// and serializes writers per conversation; the database guarantees total order.
import { sql } from 'drizzle-orm';
import { OFFLINE_GRACE_S, type Message, type MessageMetadata, type MessageType } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { activeParticipantUserIds, messageDtos, type MsgRow } from '../../lib/dto.js';
import { badRequest } from '../../lib/errors.js';
import { enqueuePush } from '../../queues.js';
import { presenceKey, redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { registry } from '../../ws/registry.js';

export interface InsertMessageOpts {
  conversationId: string;
  senderId: string | null;
  clientMsgId?: string | null;
  type: MessageType;
  body: string | null;
  metadata: MessageMetadata;
  attachmentIds?: string[];
}

export async function insertMessage(opts: InsertMessageOpts): Promise<MsgRow> {
  return db.transaction(async (tx) => {
    const [conv] = await tx
      .update(schema.conversations)
      .set({
        lastSeq: sql`${schema.conversations.lastSeq} + 1`,
        lastMessageAt: new Date(),
      })
      .where(sql`${schema.conversations.id} = ${opts.conversationId}`)
      .returning({ lastSeq: schema.conversations.lastSeq });
    if (!conv) throw badRequest('conversation_not_found');
    const seq = conv.lastSeq;

    const [msg] = await tx
      .insert(schema.messages)
      .values({
        id: newId(),
        conversationId: opts.conversationId,
        seq,
        senderId: opts.senderId,
        clientMsgId: opts.clientMsgId ?? null,
        type: opts.type,
        body: opts.body,
        metadata: opts.metadata,
      })
      .returning();

    if (opts.senderId) {
      // Raise the sender's own watermarks to the new seq.
      await tx.execute(sql`
        UPDATE conversation_participants SET
          last_delivered_seq = GREATEST(last_delivered_seq, ${seq}::bigint),
          last_read_seq = GREATEST(last_read_seq, ${seq}::bigint)
        WHERE conversation_id = ${opts.conversationId} AND user_id = ${opts.senderId}
      `);
    }

    const ids = opts.attachmentIds ?? [];
    if (ids.length > 0) {
      // Must be the sender's own unbound attachments; binding clears
      // share_import_id (API.md §1.5).
      const bound = (await tx.execute(sql`
        UPDATE attachments SET message_id = ${msg!.id}, share_import_id = NULL
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
          AND uploader_id = ${opts.senderId}
          AND message_id IS NULL
        RETURNING id
      `)) as unknown as { id: string }[];
      if (bound.length !== ids.length) throw badRequest('invalid_attachments');
    }

    return msg!;
  });
}

/** Fan out msg.new over Redis and enqueue push jobs for offline participants. */
export async function fanOutNewMessage(msg: MsgRow): Promise<Message> {
  const [dto] = await messageDtos([msg]);
  const participantIds = await activeParticipantUserIds(msg.conversationId);
  await publishToUsers(participantIds, {
    t: 'msg.new',
    d: { conversation_id: msg.conversationId, message: dto! },
  });

  if (msg.senderId) {
    const others = participantIds.filter((id) => id !== msg.senderId);
    // API.md §2.9: a push job is enqueued when the user has NO LIVE SOCKET at
    // send time — the in-process registry is the exact truth for that (api is
    // single-replica, ARCHITECTURE §3). Redis presence is NOT used to decide
    // the enqueue: it lags a disconnect by the 15 s offline grace (and up to
    // the 60 s key TTL), which used to silently swallow pushes sent in that
    // window (skipped jobs are never re-enqueued).
    const offline = others.filter((id) => !registry.userHasSockets(id));
    if (offline.length > 0) {
      // A user who just dropped still holds the presence key through the
      // grace window, and the worker's guard (a) would skip the job for good.
      // Delay only those jobs past the grace so the guard reads post-grace
      // truth: reconnected → correctly skipped; really gone → push delivered.
      const pipeline = redis.pipeline();
      for (const id of offline) pipeline.exists(presenceKey(id));
      const results = (await pipeline.exec()) ?? [];
      await Promise.all(
        offline.map((userId, i) =>
          enqueuePush(
            {
              user_id: userId,
              conversation_id: msg.conversationId,
              message_id: msg.id,
              seq: msg.seq,
            },
            { delayMs: results[i]?.[1] === 1 ? (OFFLINE_GRACE_S + 2) * 1000 : 0 },
          ),
        ),
      );
    }
  }
  return dto!;
}

export async function sendSystemMessage(
  conversationId: string,
  event: string,
  body: string,
  actorId?: string,
  targetId?: string,
): Promise<Message> {
  const msg = await insertMessage({
    conversationId,
    senderId: null,
    type: 'system',
    body,
    metadata: {
      system: {
        event,
        ...(actorId ? { actor_id: actorId } : {}),
        ...(targetId ? { target_id: targetId } : {}),
      },
    },
  });
  return fanOutNewMessage(msg);
}
