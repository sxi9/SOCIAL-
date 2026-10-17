// The gapless per-conversation seq transaction (ARCHITECTURE §1, SCHEMA.sql):
// UPDATE conversations SET last_seq = last_seq + 1 ... RETURNING locks the row
// and serializes writers per conversation; the database guarantees total order.
import { and, eq, sql } from 'drizzle-orm';
import {
  MENTIONS_PER_MESSAGE_MAX,
  OFFLINE_GRACE_S,
  type Message,
  type MessageMetadata,
  type MessageType,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { filterBlockedFrom, isBlockedPair } from '../../lib/blocks.js';
import { activeParticipantUserIds, messageDtos, type ConvRow, type MsgRow, type PartRow } from '../../lib/dto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { enqueuePushBulk } from '../../queues.js';
import { presenceKey, redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { registry } from '../../ws/registry.js';

export interface InsertMessageOpts {
  conversationId: string;
  /** Optional caller-chosen id — v0.3 afterglow uses a DETERMINISTIC id so a
   * replayed job conflicts on messages.id and rolls the whole seq transaction
   * back (no duplicate recap, no seq gap). Default: a fresh UUIDv7. */
  id?: string;
  senderId: string | null;
  clientMsgId?: string | null;
  type: MessageType;
  body: string | null;
  metadata: MessageMetadata;
  /** v0.5a (§1.29): seq of the replied-to message in the SAME conversation
   * (validated by the route against the viewer's §1.5 floor). */
  replyToSeq?: number | null;
  attachmentIds?: string[];
  /**
   * Runs inside the seq transaction after the message row lands — v0.3 polls
   * use it to insert the polls row atomically with its message (a crash can
   * never leave a 'poll' message without a poll).
   */
  withinTx?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], msg: MsgRow) => Promise<void>;
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
        id: opts.id ?? newId(),
        conversationId: opts.conversationId,
        seq,
        senderId: opts.senderId,
        clientMsgId: opts.clientMsgId ?? null,
        type: opts.type,
        body: opts.body,
        metadata: opts.metadata,
        replyToSeq: opts.replyToSeq ?? null,
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
      // share_import_id (API.md §1.5). An attachment waiting on a pending
      // scheduled message (v0.4 §1.26) is NOT unbound — it cannot be hijacked
      // by a normal send. v0.5a: "unbound" also means no post/story/profile
      // binding (§1.31: every re-use mints a NEW row — a row shared across
      // surfaces would be hard-deleted out from under the other surface by
      // post delete / story expiry / message tombstone).
      const bound = (await tx.execute(sql`
        UPDATE attachments SET message_id = ${msg!.id}, share_import_id = NULL
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
          AND uploader_id = ${opts.senderId}
          AND message_id IS NULL
          AND scheduled_message_id IS NULL
          AND post_id IS NULL
          AND listing_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
          AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
        RETURNING id
      `)) as unknown as { id: string }[];
      if (bound.length !== ids.length) throw badRequest('invalid_attachments');
    }

    if (opts.withinTx) await opts.withinTx(tx, msg!);

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
    // §1.14 (v0.5a hard rule): no push is EVER generated between a blocked
    // pair — structural at the fan-out, re-checked by the worker's guard.
    const others = await filterBlockedFrom(
      msg.senderId,
      participantIds.filter((id) => id !== msg.senderId),
    );
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
      // Hotspot H2: one addBulk round trip for the whole offline set instead
      // of one queue.add per participant.
      await enqueuePushBulk(
        offline.map((userId, i) => ({
          job: {
            user_id: userId,
            conversation_id: msg.conversationId,
            message_id: msg.id,
            seq: msg.seq,
          },
          delayMs: results[i]?.[1] === 1 ? (OFFLINE_GRACE_S + 2) * 1000 : 0,
        })),
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
  // v0.4 (§1.25): extra system-event fields, e.g. {ttl_s} on disappear_changed.
  extra?: Record<string, unknown>,
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
        ...(extra ?? {}),
      },
    },
  });
  return fanOutNewMessage(msg);
}

// ---------------------------------------------------------------------------
// v0.5a §1.33 — @mentions. SERVER-parsed from the body at send time (and §1.30
// edit time) against the conversation's ACTIVE participants; client-sent
// values are ignored. Tokens that name nobody (or arrive past the cap) stay
// inert plain text — never an error.
// ---------------------------------------------------------------------------

const MENTION_TOKEN_REGEX = /@([a-z0-9_]{3,24})/gi;

export async function resolveMentions(convId: string, body: string | null): Promise<string[]> {
  if (!body || !body.includes('@')) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_REGEX)) {
    const t = match[1]!.toLowerCase();
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  if (tokens.length === 0) return [];
  // Look up only the named tokens among ACTIVE participants (never the whole
  // 10k-channel membership): non-participants can never be mentioned.
  const rows = (await db.execute(sql`
    SELECT u.id, lower(u.username::text) AS uname
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = ${convId} AND cp.left_at IS NULL
      AND lower(u.username::text) IN (${sql.join(tokens.map((t) => sql`${t}`), sql`, `)})
  `)) as unknown as { id: string; uname: string }[];
  const byName = new Map(rows.map((r) => [r.uname, r.id]));
  const ids: string[] = [];
  for (const t of tokens) {
    const id = byName.get(t);
    if (id && !ids.includes(id)) {
      ids.push(id);
      if (ids.length >= MENTIONS_PER_MESSAGE_MAX) break;
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// v0.5a §1.35 — shared write-surface gate. Checks, in 404-shape order:
// active participant (else not_found), DM frozen by a block (else not_found,
// §1.14), channel send permission (owner/admin only). `denialShape` lets the
// §1.31 forward path turn the channel refusal into the all-or-nothing 404.
// ---------------------------------------------------------------------------

export interface SendContext {
  conv: ConvRow;
  part: PartRow;
}

export async function requireSendContext(
  convId: string,
  userId: string,
  opts: { denialShape?: '403' | '404' } = {},
): Promise<SendContext> {
  const [part] = await db
    .select()
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, convId),
        eq(schema.conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  if (!part || part.leftAt !== null) throw notFound('conversation_not_found');
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!conv) throw notFound('conversation_not_found');
  if (conv.type === 'dm') {
    const peer = (await activeParticipantUserIds(convId)).find((id) => id !== userId);
    if (peer && (await isBlockedPair(userId, peer))) throw notFound('conversation_not_found');
  }
  if (conv.type === 'channel' && part.role !== 'owner' && part.role !== 'admin') {
    // §1.35: members read + react; only owner/admins send. Forward targets
    // refuse 404-shaped (the all-or-nothing §1.31 denial confirms nothing).
    if (opts.denialShape === '404') throw notFound('not_found');
    throw forbidden('channel_read_only');
  }
  return { conv, part };
}

/**
 * Full-DTO msg.updated re-ship of one message to the conversation's active
 * participants (API.md §2.3) — v0.4 uses it for the vibe message's growing
 * reply collage (§1.23), disappearing tombstones (§1.25) and tic-tac-toe
 * moves (§1.27). Broadcast DTO: no single viewer, `mine`/`my_*` unset.
 */
export async function publishMessageUpdated(msg: MsgRow): Promise<void> {
  const [dto] = await messageDtos([msg]);
  if (!dto) return;
  const recipients = await activeParticipantUserIds(msg.conversationId);
  await publishToUsers(recipients, {
    t: 'msg.updated',
    d: { conversation_id: msg.conversationId, message: dto },
  });
}
