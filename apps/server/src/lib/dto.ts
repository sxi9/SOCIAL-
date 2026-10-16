// Row → DTO mappers and batch loaders. DTO shapes come from @socialchat/shared
// (the contract); this file never redefines them.
import type {
  Attachment,
  Avatar,
  Conversation,
  ConversationListItem,
  Message,
  MessageMetadata,
  Participant,
  ReactionAggregate,
  UserPrivate,
  UserPublic,
} from '@socialchat/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { mediaUrl } from './media.js';

export type UserRow = typeof schema.users.$inferSelect;
export type ConvRow = typeof schema.conversations.$inferSelect;
export type PartRow = typeof schema.conversationParticipants.$inferSelect;
export type MsgRow = typeof schema.messages.$inferSelect;
export type AttRow = typeof schema.attachments.$inferSelect;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface AvatarCols {
  avatarStatus: string;
  avatarVersion: number;
  avatarStaticKey: string | null;
  avatarAnimatedKey: string | null;
}

export function avatarDto(row: AvatarCols): Avatar {
  return {
    status: row.avatarStatus as Avatar['status'],
    version: row.avatarVersion,
    static_url: row.avatarStaticKey ? mediaUrl(row.avatarStaticKey) : null,
    animated_url: row.avatarAnimatedKey ? mediaUrl(row.avatarAnimatedKey) : null,
  };
}

export function userPublicDto(u: UserRow): UserPublic {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    bio: u.bio,
    avatar: avatarDto(u),
    last_seen_at: isoOrNull(u.lastSeenAt),
  };
}

export function userPrivateDto(u: UserRow): UserPrivate {
  return {
    ...userPublicDto(u),
    email: u.email,
    email_verified: u.emailVerifiedAt !== null,
    avatar_motion: u.avatarMotion as UserPrivate['avatar_motion'],
    created_at: iso(u.createdAt),
  };
}

export function attachmentDto(a: AttRow): Attachment {
  return {
    id: a.id,
    kind: a.kind as Attachment['kind'],
    mime: a.mime,
    size_bytes: a.sizeBytes,
    width: a.width,
    height: a.height,
    duration_ms: a.durationMs,
    blurhash: a.blurhash,
    status: a.status as Attachment['status'],
    url: mediaUrl(a.originalKey),
    thumb_url: a.thumbKey ? mediaUrl(a.thumbKey) : null,
    file_name: a.fileName,
  };
}

export function messageDto(m: MsgRow, atts: AttRow[], reactions: ReactionAggregate[] = []): Message {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    seq: m.seq,
    sender_id: m.senderId,
    type: m.type as Message['type'],
    body: m.body,
    metadata: (m.metadata ?? {}) as MessageMetadata,
    reply_to_id: m.replyToId,
    attachments: atts.map(attachmentDto),
    reactions,
    created_at: iso(m.createdAt),
    edited_at: isoOrNull(m.editedAt),
    deleted_at: isoOrNull(m.deletedAt),
  };
}

export function participantDto(p: PartRow, u: UserRow): Participant {
  return {
    user: userPublicDto(u),
    role: p.role as Participant['role'],
    joined_at: iso(p.joinedAt),
    join_seq: p.joinSeq,
    left_at: isoOrNull(p.leftAt),
    last_delivered_seq: p.lastDeliveredSeq,
    last_read_seq: p.lastReadSeq,
    muted_until: isoOrNull(p.mutedUntil),
  };
}

export function conversationDto(c: ConvRow, parts: { p: PartRow; u: UserRow }[]): Conversation {
  return {
    id: c.id,
    type: c.type as Conversation['type'],
    title: c.title,
    avatar: avatarDto(c),
    created_by: c.createdBy,
    last_seq: c.lastSeq,
    last_message_at: isoOrNull(c.lastMessageAt),
    participants: parts.map(({ p, u }) => participantDto(p, u)),
    created_at: iso(c.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function loadAttachmentsFor(messageIds: string[]): Promise<Map<string, AttRow[]>> {
  const map = new Map<string, AttRow[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.messageId, messageIds))
    .orderBy(asc(schema.attachments.createdAt));
  for (const row of rows) {
    if (!row.messageId) continue;
    const list = map.get(row.messageId) ?? [];
    list.push(row);
    map.set(row.messageId, list);
  }
  return map;
}

// v0.2 (API.md §1.12): batch reaction aggregates — one chip per emoji, count,
// `mine` from the viewer's perspective, ordered by first reaction
// (min created_at) so chips never reshuffle as counts change.
export async function loadReactionsFor(
  keys: { conversationId: string; seq: number }[],
  viewerId?: string,
): Promise<Map<string, ReactionAggregate[]>> {
  const map = new Map<string, ReactionAggregate[]>();
  if (keys.length === 0) return map;
  const tuples = sql.join(
    keys.map((k) => sql`(${k.conversationId}::uuid, ${k.seq}::bigint)`),
    sql`, `,
  );
  const mineExpr = viewerId ? sql`bool_or(user_id = ${viewerId}::uuid)` : sql`false`;
  const rows = (await db.execute(sql`
    SELECT conversation_id, seq, emoji, count(*)::int AS count, ${mineExpr} AS mine
    FROM message_reactions
    WHERE (conversation_id, seq) IN (${tuples})
    GROUP BY conversation_id, seq, emoji
    ORDER BY min(created_at) ASC, emoji ASC
  `)) as unknown as {
    conversation_id: string;
    seq: string | number;
    emoji: string;
    count: number;
    mine: boolean;
  }[];
  for (const r of rows) {
    const key = `${r.conversation_id}:${Number(r.seq)}`;
    const list = map.get(key) ?? [];
    list.push({ emoji: r.emoji, count: Number(r.count), mine: Boolean(r.mine) });
    map.set(key, list);
  }
  return map;
}

/**
 * `viewerId` personalizes `reactions[].mine`. REST responses (history, sync,
 * send/replay) MUST pass the requesting user. Broadcast DTOs (msg.new fan-out
 * of a brand-new message — which cannot have reactions yet — and worker
 * msg.updated hydration) have no single viewer and leave it unset (`mine`
 * false); clients reconcile `mine` from reaction.updated frames (`user_id ===
 * me`) and from the next viewer-scoped fetch (API.md §1.12).
 */
export async function messageDtos(rows: MsgRow[], viewerId?: string): Promise<Message[]> {
  const atts = await loadAttachmentsFor(rows.map((r) => r.id));
  const reactions = await loadReactionsFor(
    rows.map((r) => ({ conversationId: r.conversationId, seq: r.seq })),
    viewerId,
  );
  return rows.map((r) =>
    messageDto(r, atts.get(r.id) ?? [], reactions.get(`${r.conversationId}:${r.seq}`) ?? []),
  );
}

export async function loadMessageDtoById(id: string, viewerId?: string): Promise<Message | null> {
  const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1);
  if (!row) return null;
  const [dto] = await messageDtos([row], viewerId);
  return dto ?? null;
}

async function loadActiveParticipantsWithUsers(
  convIds: string[],
): Promise<Map<string, { p: PartRow; u: UserRow }[]>> {
  const map = new Map<string, { p: PartRow; u: UserRow }[]>();
  if (convIds.length === 0) return map;
  const rows = await db
    .select({ p: schema.conversationParticipants, u: schema.users })
    .from(schema.conversationParticipants)
    .innerJoin(schema.users, eq(schema.conversationParticipants.userId, schema.users.id))
    .where(
      and(
        inArray(schema.conversationParticipants.conversationId, convIds),
        isNull(schema.conversationParticipants.leftAt),
      ),
    )
    .orderBy(asc(schema.conversationParticipants.joinedAt));
  for (const row of rows) {
    const list = map.get(row.p.conversationId) ?? [];
    list.push(row);
    map.set(row.p.conversationId, list);
  }
  return map;
}

export async function loadConversationDto(convId: string): Promise<Conversation | null> {
  const [c] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!c) return null;
  const parts = await loadActiveParticipantsWithUsers([convId]);
  return conversationDto(c, parts.get(convId) ?? []);
}

export async function activeParticipantUserIds(convId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.conversationParticipants.userId })
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, convId),
        isNull(schema.conversationParticipants.leftAt),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Distinct users sharing at least one active conversation with `userId` (self included). */
export async function coParticipantUserIds(userId: string): Promise<string[]> {
  const cp = schema.conversationParticipants;
  const rows = await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM ${cp} AS mine
    JOIN ${cp} AS other ON other.conversation_id = mine.conversation_id
    WHERE mine.user_id = ${userId} AND mine.left_at IS NULL AND other.left_at IS NULL
  `);
  const ids = (rows as unknown as { user_id: string }[]).map((r) => r.user_id);
  if (!ids.includes(userId)) ids.push(userId);
  return ids;
}

function rawToMsgRow(r: Record<string, unknown>): MsgRow {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    seq: Number(r.seq),
    senderId: (r.sender_id as string | null) ?? null,
    clientMsgId: (r.client_msg_id as string | null) ?? null,
    type: r.type as string,
    body: (r.body as string | null) ?? null,
    metadata: r.metadata,
    replyToId: (r.reply_to_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string | Date),
    editedAt: r.edited_at ? new Date(r.edited_at as string | Date) : null,
    deletedAt: r.deleted_at ? new Date(r.deleted_at as string | Date) : null,
  };
}

/**
 * ConversationListItem[] for a set of conversations, from `userId`'s viewpoint:
 * unread_count = last_seq - my last_read_seq, last_message respects my
 * join_seq visibility floor.
 */
export async function loadListItems(
  userId: string,
  convIds: string[],
): Promise<ConversationListItem[]> {
  if (convIds.length === 0) return [];

  const convs = await db
    .select()
    .from(schema.conversations)
    .where(inArray(schema.conversations.id, convIds));

  const myParts = await db
    .select()
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.userId, userId),
        inArray(schema.conversationParticipants.conversationId, convIds),
      ),
    );
  const myPartByConv = new Map(myParts.map((p) => [p.conversationId, p]));

  const partsByConv = await loadActiveParticipantsWithUsers(convIds);

  const cp = schema.conversationParticipants;
  const lastRows = await db.execute(sql`
    SELECT m.*
    FROM ${cp} p
    JOIN LATERAL (
      SELECT * FROM messages m
      WHERE m.conversation_id = p.conversation_id AND m.seq > p.join_seq
      ORDER BY m.seq DESC
      LIMIT 1
    ) m ON true
    WHERE p.user_id = ${userId}
      AND p.conversation_id IN (${sql.join(convIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const lastMsgRows = (lastRows as unknown as Record<string, unknown>[]).map(rawToMsgRow);
  const lastDtos = await messageDtos(lastMsgRows, userId);
  const lastByConv = new Map(lastDtos.map((m) => [m.conversation_id, m]));

  const items: ConversationListItem[] = [];
  for (const c of convs) {
    const mine = myPartByConv.get(c.id);
    if (!mine) continue;
    items.push({
      ...conversationDto(c, partsByConv.get(c.id) ?? []),
      unread_count: Math.max(0, c.lastSeq - mine.lastReadSeq),
      last_message: lastByConv.get(c.id) ?? null,
    });
  }
  items.sort((a, b) => {
    const ta = a.last_message_at ?? a.created_at;
    const tb = b.last_message_at ?? b.created_at;
    return tb.localeCompare(ta);
  });
  return items;
}
