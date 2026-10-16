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
  Poll,
  ReactionAggregate,
  UserLite,
  UserPrivate,
  UserPublic,
} from '@socialchat/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { blockedSetOf, blockPairsAmong } from './blocks.js';
import { mediaUrl } from './media.js';
import { publishToUsers } from '../ws/events.js';

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

// ---------------------------------------------------------------------------
// Viewer context (v0.3 — API.md §1.13/§1.14, ADR-009). Serialization-time
// privacy filtering: nothing stored is ever rewritten by a settings toggle.
// ---------------------------------------------------------------------------

export interface ViewCtx {
  viewerId: string;
  /** Reciprocal read receipts: the viewer's own setting (API.md §1.13). */
  viewerReadReceipts: boolean;
  /** Users sharing an active DM with the viewer ('dm_partners' last-seen). */
  dmPartnerIds: Set<string>;
  /** Users blocked w.r.t. the viewer, either direction (API.md §1.14). */
  blockedIds: Set<string>;
}

/** Users sharing an active DM conversation with `userId` (self excluded). */
export async function dmPartnerIdsOf(userId: string): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM conversation_participants mine
    JOIN conversation_participants other ON other.conversation_id = mine.conversation_id
    JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
    WHERE mine.user_id = ${userId} AND mine.left_at IS NULL
      AND other.left_at IS NULL AND other.user_id <> ${userId}
  `)) as unknown as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

export async function viewCtxFor(viewer: UserRow): Promise<ViewCtx> {
  return {
    viewerId: viewer.id,
    viewerReadReceipts: viewer.readReceipts,
    dmPartnerIds: await dmPartnerIdsOf(viewer.id),
    blockedIds: await blockedSetOf(viewer.id),
  };
}

export async function viewCtxForId(viewerId: string): Promise<ViewCtx | null> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, viewerId)).limit(1);
  if (!row) return null;
  return viewCtxFor(row);
}

/**
 * show_last_seen gate (API.md §1.13): may `view` see `owner`'s last_seen_at?
 * Blocked pairs never qualify (§1.14). With no view (broadcast frames, where
 * no single recipient is known) only 'everyone' owners expose it — a
 * conservative over-filter; REST responses are the per-viewer truth.
 */
function lastSeenVisible(owner: UserRow, view?: ViewCtx | null): boolean {
  if (view && owner.id === view.viewerId) return true;
  if (view?.blockedIds.has(owner.id)) return false;
  switch (owner.showLastSeen) {
    case 'everyone':
      return true;
    case 'dm_partners':
      return view ? view.dmPartnerIds.has(owner.id) : false;
    default:
      return false;
  }
}

export function userLiteDto(u: UserRow): UserLite {
  // Deliberately NO last_seen_at and NO area (API.md §0, FEATURES #30).
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    avatar: avatarDto(u),
  };
}

export function userPublicDto(u: UserRow, view?: ViewCtx | null): UserPublic {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    bio: u.bio,
    avatar: avatarDto(u),
    last_seen_at: lastSeenVisible(u, view) ? isoOrNull(u.lastSeenAt) : null,
    // v0.3 plan karma: profile facts, never ranked (PSYCHOLOGY rule 3).
    beacons_created: u.beaconsCreated,
    beacons_sparked: u.beaconsSparked,
  };
}

export function userPrivateDto(u: UserRow): UserPrivate {
  return {
    ...userPublicDto(u),
    // The owner always sees their own last_seen_at and area.
    last_seen_at: isoOrNull(u.lastSeenAt),
    email: u.email,
    email_verified: u.emailVerifiedAt !== null,
    avatar_motion: u.avatarMotion as UserPrivate['avatar_motion'],
    area: u.area,
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

export function messageDto(
  m: MsgRow,
  atts: AttRow[],
  reactions: ReactionAggregate[] = [],
  poll: Poll | null = null,
): Message {
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
    poll,
    created_at: iso(m.createdAt),
    edited_at: isoOrNull(m.editedAt),
    deleted_at: isoOrNull(m.deletedAt),
  };
}

/**
 * Reciprocal read receipts (API.md §1.13a): Participant.last_read_seq is the
 * true value only when P = V or BOTH P and V have read_receipts on — else 0.
 * last_delivered_seq is never filtered. Every REST response and every conv.*
 * broadcast now serializes with a per-viewer ctx (publishConversationToUsers
 * groups recipients by identical clamping); the no-view fallback (P's own
 * setting alone decides) remains only as a conservative default for callers
 * that genuinely have no single recipient.
 */
export function participantDto(p: PartRow, u: UserRow, view?: ViewCtx | null): Participant {
  const readVisible = view
    ? u.id === view.viewerId || (u.readReceipts && view.viewerReadReceipts)
    : u.readReceipts;
  return {
    user: userPublicDto(u, view),
    role: p.role as Participant['role'],
    joined_at: iso(p.joinedAt),
    join_seq: p.joinSeq,
    left_at: isoOrNull(p.leftAt),
    last_delivered_seq: p.lastDeliveredSeq,
    last_read_seq: readVisible ? p.lastReadSeq : 0,
    muted_until: isoOrNull(p.mutedUntil),
  };
}

export function conversationDto(
  c: ConvRow,
  parts: { p: PartRow; u: UserRow }[],
  view?: ViewCtx | null,
): Conversation {
  return {
    id: c.id,
    type: c.type as Conversation['type'],
    title: c.title,
    avatar: avatarDto(c),
    created_by: c.createdBy,
    last_seq: c.lastSeq,
    last_message_at: isoOrNull(c.lastMessageAt),
    participants: parts.map(({ p, u }) => participantDto(p, u, view)),
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

// v0.3 (API.md §1.17): batch poll DTOs for 'poll' messages, keyed by the
// message identity (conversation_id, seq). counts aligns with options;
// my_vote is viewer-specific (null without a viewer — broadcast frames
// reconcile from the next viewer-scoped fetch, like reactions `mine`).
export type PollRow = typeof schema.polls.$inferSelect;

export function pollDto(
  row: PollRow,
  votes: Map<number, number>,
  myVote: number | null,
): Poll {
  const options = row.options as string[];
  const counts = options.map((_, i) => votes.get(i) ?? 0);
  return {
    id: row.id,
    conversation_id: row.conversationId,
    seq: row.seq,
    question: row.question,
    options,
    closes_at: isoOrNull(row.closesAt),
    counts,
    total_votes: counts.reduce((a, b) => a + b, 0),
    my_vote: myVote,
  };
}

export async function loadPollsFor(
  keys: { conversationId: string; seq: number }[],
  viewerId?: string,
): Promise<Map<string, Poll>> {
  const map = new Map<string, Poll>();
  if (keys.length === 0) return map;
  const tuples = sql.join(
    keys.map((k) => sql`(${k.conversationId}::uuid, ${k.seq}::bigint)`),
    sql`, `,
  );
  const rows = await db
    .select()
    .from(schema.polls)
    .where(sql`(${schema.polls.conversationId}, ${schema.polls.seq}) IN (${tuples})`);
  if (rows.length === 0) return map;
  const pollIds = rows.map((r) => r.id);
  const idList = sql.join(pollIds.map((id) => sql`${id}::uuid`), sql`, `);
  const voteRows = (await db.execute(sql`
    SELECT poll_id, option_idx, count(*)::int AS n
    FROM poll_votes WHERE poll_id IN (${idList})
    GROUP BY poll_id, option_idx
  `)) as unknown as { poll_id: string; option_idx: number; n: number }[];
  const votesByPoll = new Map<string, Map<number, number>>();
  for (const v of voteRows) {
    const m = votesByPoll.get(v.poll_id) ?? new Map<number, number>();
    m.set(Number(v.option_idx), Number(v.n));
    votesByPoll.set(v.poll_id, m);
  }
  const myByPoll = new Map<string, number>();
  if (viewerId) {
    const mine = (await db.execute(sql`
      SELECT poll_id, option_idx FROM poll_votes
      WHERE poll_id IN (${idList}) AND user_id = ${viewerId}
    `)) as unknown as { poll_id: string; option_idx: number }[];
    for (const v of mine) myByPoll.set(v.poll_id, Number(v.option_idx));
  }
  for (const row of rows) {
    map.set(
      `${row.conversationId}:${row.seq}`,
      pollDto(row, votesByPoll.get(row.id) ?? new Map(), myByPoll.get(row.id) ?? null),
    );
  }
  return map;
}

/**
 * `viewerId` personalizes `reactions[].mine` and `poll.my_vote`. REST
 * responses (history, sync, send/replay) MUST pass the requesting user.
 * Broadcast DTOs (msg.new fan-out of a brand-new message — which cannot have
 * reactions yet — and worker msg.updated hydration) have no single viewer and
 * leave it unset (`mine` false, `my_vote` null); clients reconcile from
 * reaction.updated / poll.updated frames (`user_id === me`) and from the next
 * viewer-scoped fetch (API.md §1.12/§1.17).
 */
export async function messageDtos(rows: MsgRow[], viewerId?: string): Promise<Message[]> {
  const atts = await loadAttachmentsFor(rows.map((r) => r.id));
  const reactions = await loadReactionsFor(
    rows.map((r) => ({ conversationId: r.conversationId, seq: r.seq })),
    viewerId,
  );
  const pollRows = rows.filter((r) => r.type === 'poll');
  const polls = await loadPollsFor(
    pollRows.map((r) => ({ conversationId: r.conversationId, seq: r.seq })),
    viewerId,
  );
  return rows.map((r) =>
    messageDto(
      r,
      atts.get(r.id) ?? [],
      reactions.get(`${r.conversationId}:${r.seq}`) ?? [],
      polls.get(`${r.conversationId}:${r.seq}`) ?? null,
    ),
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

export async function loadConversationDto(
  convId: string,
  view?: ViewCtx | null,
): Promise<Conversation | null> {
  const [c] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!c) return null;
  const parts = await loadActiveParticipantsWithUsers([convId]);
  return conversationDto(c, parts.get(convId) ?? [], view);
}

/**
 * conv.new / conv.updated fan-out with per-recipient §1.13/§1.14 clamping
 * (the broadcast twin of a viewer-scoped REST read). The old no-view
 * broadcast leaked reciprocity (a receipts-off recipient got receipts-on
 * participants' true last_read_seq) and served 'everyone' last_seen_at to
 * blocked co-members. The per-recipient `users` envelope makes exact
 * clamping feasible; recipients whose serialization is identical share one
 * envelope, so the common case (no blocks, receipts on) still costs a
 * handful of publishes, not one per member.
 */
export async function publishConversationToUsers(
  convId: string,
  recipients: string[],
  t: 'conv.new' | 'conv.updated',
): Promise<void> {
  const uniqueRecipients = [...new Set(recipients)];
  if (uniqueRecipients.length === 0) return;
  const [c] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, convId))
    .limit(1);
  if (!c) return;
  const partsMap = await loadActiveParticipantsWithUsers([convId]);
  const parts = partsMap.get(convId) ?? [];
  const participantIds = parts.map(({ u }) => u.id);
  const userById = new Map(parts.map(({ u }) => [u.id, u]));
  // A recipient may no longer be a participant (the just-removed member's own
  // conv.updated): load the missing user rows for their read_receipts.
  const missing = uniqueRecipients.filter((id) => !userById.has(id));
  if (missing.length > 0) {
    const rows = await db.select().from(schema.users).where(inArray(schema.users.id, missing));
    for (const u of rows) userById.set(u.id, u);
  }
  const pairs = await blockPairsAmong([...new Set([...participantIds, ...uniqueRecipients])]);
  // 'dm_partners' last-seen owners need one shared-DM lookup, batched.
  const dmOwners = parts
    .filter(({ u }) => u.showLastSeen === 'dm_partners' && u.lastSeenAt !== null)
    .map(({ u }) => u.id);
  const dmPairs = new Set<string>(); // `${owner}:${viewer}`
  if (dmOwners.length > 0) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT p1.user_id AS owner, p2.user_id AS viewer
      FROM conversation_participants p1
      JOIN conversation_participants p2 ON p2.conversation_id = p1.conversation_id
      JOIN conversations dc ON dc.id = p1.conversation_id AND dc.type = 'dm'
      WHERE p1.left_at IS NULL AND p2.left_at IS NULL
        AND p1.user_id <> p2.user_id
        AND p1.user_id IN (${sql.join(dmOwners.map((id) => sql`${id}::uuid`), sql`, `)})
        AND p2.user_id IN (${sql.join(uniqueRecipients.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { owner: string; viewer: string }[];
    for (const r of rows) dmPairs.add(`${r.owner}:${r.viewer}`);
  }

  // Group recipients whose clamped serialization is bit-identical: the DTO
  // varies only in last_read_seq visibility and last_seen_at visibility per
  // participant, so those bits ARE the signature.
  const groups = new Map<string, { ctx: ViewCtx; userIds: string[] }>();
  for (const r of uniqueRecipients) {
    const rr = userById.get(r)?.readReceipts ?? true;
    const blockedIds = new Set(participantIds.filter((pid) => pairs.has(`${r}:${pid}`)));
    const dmPartnerIds = new Set(dmOwners.filter((o) => dmPairs.has(`${o}:${r}`)));
    let sig = '';
    for (const { u } of parts) {
      const readVisible = u.id === r || (u.readReceipts && rr);
      const lastSeenVisible =
        u.id === r ||
        (!blockedIds.has(u.id) &&
          (u.showLastSeen === 'everyone' ||
            (u.showLastSeen === 'dm_partners' && dmPartnerIds.has(u.id))));
      sig += (readVisible ? 'r' : '.') + (lastSeenVisible ? 'l' : '.');
    }
    const g = groups.get(sig);
    if (g) g.userIds.push(r);
    else {
      groups.set(sig, {
        ctx: { viewerId: r, viewerReadReceipts: rr, dmPartnerIds, blockedIds },
        userIds: [r],
      });
    }
  }
  for (const { ctx, userIds } of groups.values()) {
    await publishToUsers(userIds, { t, d: { conversation: conversationDto(c, parts, ctx) } });
  }
}

/**
 * user.updated fan-out: blocked co-members keep receiving profile/avatar
 * updates (shared groups keep functioning, §1.14) but never the owner's
 * last_seen_at — it is clamped to null on their copy of the frame.
 */
export async function publishUserUpdated(row: UserRow, recipients: string[]): Promise<void> {
  if (recipients.length === 0) return;
  const blocked = await blockedSetOf(row.id);
  const dto = userPublicDto(row); // conservative broadcast view ('everyone' only)
  const clear = recipients.filter((id) => id === row.id || !blocked.has(id));
  const clamped = recipients.filter((id) => id !== row.id && blocked.has(id));
  if (clear.length > 0) {
    await publishToUsers(clear, { t: 'user.updated', d: { user: dto } });
  }
  if (clamped.length > 0) {
    await publishToUsers(clamped, {
      t: 'user.updated',
      d: { user: { ...dto, last_seen_at: null } },
    });
  }
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
  view?: ViewCtx | null,
): Promise<ConversationListItem[]> {
  if (convIds.length === 0) return [];
  // Viewer-scoped privacy filtering (§1.13): compute the context once.
  const ctx = view ?? (await viewCtxForId(userId));

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
      ...conversationDto(c, partsByConv.get(c.id) ?? [], ctx),
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
