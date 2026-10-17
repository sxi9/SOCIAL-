// Row → DTO mappers and batch loaders. DTO shapes come from @socialchat/shared
// (the contract); this file never redefines them.
import type {
  Attachment,
  Avatar,
  Conversation,
  ConversationListItem,
  ConversationPin,
  Message,
  MessageMetadata,
  Mood,
  NameStyle,
  Participant,
  Poll,
  ReactionAggregate,
  ReplyContext,
  UserLite,
  UserPrivate,
  UserPublic,
  VibeCheckAggregate,
  VibeReplyRef,
} from '@socialchat/shared';
import { REPLY_EXCERPT_MAX_CHARS, VIBE_REPLIES_PREVIEW_MAX } from '@socialchat/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { blockedSetOf, blockPairsAmong } from './blocks.js';
import { acceptedPairsBetween, connectionIdsOf } from './connections.js';
import { ghostMessageDto, loadMasks, maskUserPublic, pseudoIdFor, type GhostCtx } from './ghost.js';
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
  /** v0.8a (§1.57/§1.59): the viewer's ACCEPTED §1.28 connections —
   * 'connections' mood visibility resolves against this, literally
   * connections, never friends-of (a DM alone does not qualify). */
  connectionIds: Set<string>;
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
    connectionIds: await connectionIdsOf(viewer.id),
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

// ---------------------------------------------------------------------------
// v0.8a moods (API.md §1.57, ADR-018). The chip rides EVERY UserLite /
// UserPublic serialization, resolved PER VIEWER at serialization time:
// live (`mood_expires_at > now()` — the §1.44 live-filter pattern, so a
// lagging sweep can never show a stale chip) AND the owner's visibility
// admits the viewer (everyone / accepted-§1.28-connections / nobody) AND the
// pair is not §1.14-blocked — else null, byte-identical to no-mood. With NO
// view (broadcast hydration, cross-conversation lists) the resolution cannot
// check blocks, so it serializes null — a conservative over-filter (the
// §2.11 doctrine); per-recipient paths (publishUserUpdated, conversation
// fan-out) stamp the chip themselves and REST reads pass their ViewCtx.
// ---------------------------------------------------------------------------

type MoodCols = Pick<
  UserRow,
  'id' | 'moodEmoji' | 'moodLabel' | 'moodKind' | 'moodVisibility' | 'moodExpiresAt'
>;

/** Is the mood live right now (set + unexpired)? Expiry filters LIVE.
 * Loose `!= null` deliberately: raw-SQL partial UserRow casts (piles,
 * reactor lists) carry no mood columns and must read as "no mood". */
export function moodLive(u: Partial<MoodCols>, now = Date.now()): boolean {
  return (
    u.moodKind != null &&
    u.moodEmoji != null &&
    u.moodLabel != null &&
    u.moodExpiresAt != null &&
    u.moodExpiresAt.getTime() > now
  );
}

/** The bare chip, ignoring visibility — OWNER surfaces only (§1.57: the
 * owner always sees their own chip; others never see expires_at/swing_set). */
export function moodSelfDto(u: MoodCols): Mood | null {
  if (!moodLive(u)) return null;
  return { emoji: u.moodEmoji!, label: u.moodLabel!, kind: u.moodKind as Mood['kind'] };
}

/** The §1.57 per-viewer resolution. null is byte-identical to "no mood", so
 * a visibility setting is never confirmable from outside. */
export function moodDto(u: MoodCols, view?: ViewCtx | null): Mood | null {
  if (!moodLive(u)) return null;
  if (view && view.viewerId === u.id) return moodSelfDto(u);
  if (!view) return null; // no single viewer → conservative null (§2.11)
  if (view.blockedIds.has(u.id)) return null;
  switch (u.moodVisibility) {
    case 'everyone':
      return moodSelfDto(u);
    case 'connections':
      return view.connectionIds.has(u.id) ? moodSelfDto(u) : null;
    default:
      return null; // 'nobody' — owner-only, handled above
  }
}

/** v0.8a (§1.58): name_style is viewer-independent identity. The fallback
 * guards the few raw-SQL partial casts that predate the column. */
function nameStyleOf(u: { nameStyle?: string | null }): NameStyle {
  return (u.nameStyle ?? 'none') as NameStyle;
}

export function userLiteDto(u: UserRow, view?: ViewCtx | null): UserLite {
  // Deliberately NO last_seen_at and NO area (API.md §0, FEATURES #30).
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    avatar: avatarDto(u),
    mood: moodDto(u, view),
    name_style: nameStyleOf(u),
    // v0.8b (§1.68): non-null ONLY on ghost-group MASK serializations
    // (lib/ghost.ts builds those); a real identity never carries it.
    mask_emoji: null,
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
    // v0.8a (§1.57/§1.58): per-viewer mood + viewer-independent name style.
    mood: moodDto(u, view),
    name_style: nameStyleOf(u),
  };
}

export function userPrivateDto(u: UserRow): UserPrivate {
  return {
    ...userPublicDto(u),
    // The owner always sees their own last_seen_at, area — and mood chip.
    last_seen_at: isoOrNull(u.lastSeenAt),
    mood: moodSelfDto(u),
    email: u.email,
    email_verified: u.emailVerifiedAt !== null,
    avatar_motion: u.avatarMotion as UserPrivate['avatar_motion'],
    area: u.area,
    created_at: iso(u.createdAt),
    // v0.9 (§1.73): armed-or-not only — the secret itself NEVER serializes.
    totp_enabled: u.totpEnabledAt !== null,
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
    // v0.4 (§1.20): 48 worker-computed peaks, audio only; null while pending.
    waveform: (a.waveform as number[] | null) ?? null,
  };
}

export function messageDto(
  m: MsgRow,
  atts: AttRow[],
  reactions: ReactionAggregate[] = [],
  poll: Poll | null = null,
  stamps: UserLite[] = [],
  vibe: VibeCheckAggregate | null = null,
  replyContext: ReplyContext | null = null,
): Message {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    seq: m.seq,
    sender_id: m.senderId,
    type: m.type as Message['type'],
    body: m.body,
    metadata: (m.metadata ?? {}) as MessageMetadata,
    // v0.5a (§1.29): reply_to_id is RETIRED — always null; seq is the identity.
    reply_to_id: null,
    reply_to_seq: m.replyToSeq,
    // Server-resolved at serialization time: edits/tombstones of the target
    // are always current, clients never join locally (§1.29).
    reply_context: replyContext,
    attachments: atts.map(attachmentDto),
    reactions,
    poll,
    // v0.4 (§1.19): stamp reactors in first-stamp order — faces, not a count.
    stamps,
    // v0.4 (§1.23): reply aggregate, iff type === 'vibe_check'.
    vibe,
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
export function participantDto(
  p: PartRow,
  u: UserRow,
  view?: ViewCtx | null,
  ghost?: GhostCtx | null,
): Participant {
  // v0.8b (§1.68): 👻 ghost groups suppress the identity side channels for
  // EVERYONE (admins included): others' last_read_seq serializes as the §1.13
  // receipts-off shape (0) and last_seen_at as null; non-admin members get
  // the MASK UserPublic in place of the real identity (own row stays real).
  if (ghost) {
    const self = u.id === ghost.viewerId;
    const user =
      self || ghost.viewerIsAdmin
        ? { ...userPublicDto(u, view), last_seen_at: self ? isoOrNull(u.lastSeenAt) : null, mood: null }
        : maskUserPublic(ghost, u.id);
    return {
      user,
      role: p.role as Participant['role'],
      joined_at: iso(p.joinedAt),
      join_seq: p.joinSeq,
      left_at: isoOrNull(p.leftAt),
      last_delivered_seq: self ? p.lastDeliveredSeq : 0,
      last_read_seq: self ? p.lastReadSeq : 0,
      muted_until: self ? isoOrNull(p.mutedUntil) : null,
    };
  }
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

// v0.6 (migration 0007, API.md §1.44/§1.45): the conversations.metadata
// jsonb rider — shape authority is the shared contract; this is the server's
// reading of it.
export interface ConvMetadata {
  origin?: 'discovery' | 'roulette';
  roulette?: { kept_by?: string[] };
}

export function convMetadata(c: ConvRow): ConvMetadata {
  return (c.metadata ?? {}) as ConvMetadata;
}

export function conversationDto(
  c: ConvRow,
  parts: { p: PartRow; u: UserRow }[],
  view?: ViewCtx | null,
  pins: ConversationPin[] = [],
  ghost?: GhostCtx | null,
): Conversation {
  const meta = convMetadata(c);
  // v0.8b (§1.68): a 👻 ghost conversation is ALWAYS serialized through a
  // GhostCtx — a caller that failed to load masks still never leaks real
  // identities (fallback masks + empty map, the conservative over-filter).
  const g: GhostCtx | null =
    c.visibility === 'ghost'
      ? (ghost ?? {
          convId: c.id,
          masks: new Map(),
          viewerId: view?.viewerId ?? null,
          viewerIsAdmin: false,
        })
      : null;
  // v0.5a (§1.35): a channel's Conversation DTO carries ONLY the viewer's own
  // row + the owner + admins — never the member body, never a member COUNT
  // (PSYCHOLOGY rule 3). The full list is the paged §1.35 read.
  const serialized =
    c.type === 'channel'
      ? parts.filter(({ p, u }) => p.role !== 'member' || u.id === view?.viewerId)
      : parts;
  return {
    id: c.id,
    type: c.type as Conversation['type'],
    title: c.title,
    avatar: avatarDto(c),
    created_by: c.createdBy,
    last_seq: c.lastSeq,
    last_message_at: isoOrNull(c.lastMessageAt),
    participants: serialized.map(({ p, u }) => participantDto(p, u, view, g)),
    // v0.5a (§1.32): pinned messages, created_at ASC — a stable board.
    // §1.68: in ghost groups pinned_by is an identity — pseudo-id for masks.
    pins: g
      ? pins.map((pin) => ({
          ...pin,
          pinned_by:
            pin.pinned_by && pin.pinned_by !== g.viewerId && !g.viewerIsAdmin
              ? pseudoIdFor(c.id, pin.pinned_by)
              : pin.pinned_by,
        }))
      : pins,
    // v0.4 (§1.25): conversation-wide disappearing TTL (null = off).
    disappear_ttl_s: c.disappearTtlS,
    // v0.6 (§1.44/§1.45): how this DM came to exist; null for ordinary ones.
    origin: meta.origin ?? null,
    // v0.6 (§1.45): the roulette rider, non-null ONLY while provisional.
    // `kept` is the VIEWER's own keep — the other party's keep state is never
    // serialized (no pressure surface); broadcast frames without a single
    // viewer serialize kept:false and clients reconcile on the next
    // viewer-scoped fetch (the reactions `mine` pattern).
    roulette:
      c.expiresAt && meta.origin === 'roulette'
        ? {
            expires_at: iso(c.expiresAt),
            kept: view ? (meta.roulette?.kept_by ?? []).includes(view.viewerId) : false,
          }
        : null,
    // v0.8b (§1.68): group visibility mode + description + the public floor.
    // public_since_seq non-null iff visibility='public' (DB CHECK); its
    // presence IS the member banner flag.
    visibility: c.visibility as Conversation['visibility'],
    description: c.description,
    public_since_seq: c.publicSinceSeq,
    // v0.8b (§1.68): MY mask — the explicit own-mask read. The viewer's own
    // participant row serializes REAL (a client must find itself), so this is
    // the one field that tells a ghost-group member the pseudonym+emoji the
    // other members see them as (the banner and the mask editor read it).
    my_mask: (() => {
      if (!g || !g.viewerId) return null;
      const mine = g.masks.get(g.viewerId);
      return mine ? { name: mine.name, emoji: mine.emoji } : null;
    })(),
    created_at: iso(c.createdAt),
  };
}

/** v0.8b (§1.68): the GhostCtx for one viewer of one conversation — null for
 * everything that is not a 👻 ghost group. */
export async function ghostCtxFor(
  c: Pick<ConvRow, 'id' | 'visibility'>,
  viewerId: string | null | undefined,
  viewerRole?: string | null,
): Promise<GhostCtx | null> {
  if (c.visibility !== 'ghost') return null;
  let isAdmin = viewerRole === 'admin';
  if (viewerRole === undefined && viewerId) {
    const rows = (await db.execute(sql`
      SELECT 1 AS one FROM conversation_participants
      WHERE conversation_id = ${c.id} AND user_id = ${viewerId}
        AND left_at IS NULL AND role = 'admin'
      LIMIT 1
    `)) as unknown as { one: number }[];
    isAdmin = rows.length > 0;
  }
  return {
    convId: c.id,
    masks: await loadMasks(c.id),
    viewerId: viewerId ?? null,
    viewerIsAdmin: isAdmin,
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
  // v0.4 (§1.19): aggregates are EMOJI chips only — stamp rows ride
  // Message.stamps as faces (loadStampsFor), never a counted chip.
  const rows = (await db.execute(sql`
    SELECT conversation_id, seq, emoji, count(*)::int AS count, ${mineExpr} AS mine
    FROM message_reactions
    WHERE (conversation_id, seq) IN (${tuples}) AND kind = 'emoji'
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

// v0.4 (API.md §1.19): batch stamp loaders — the stampers as UserLite[] in
// first-stamp order, keyed by the message identity. Faces, not counters
// (PSYCHOLOGY rule 3); blocked pairs keep working in shared groups (§1.14),
// so no per-viewer filtering here.
export async function loadStampsFor(
  keys: { conversationId: string; seq: number }[],
): Promise<Map<string, UserLite[]>> {
  const map = new Map<string, UserLite[]>();
  if (keys.length === 0) return map;
  const tuples = sql.join(
    keys.map((k) => sql`(${k.conversationId}::uuid, ${k.seq}::bigint)`),
    sql`, `,
  );
  const rows = await db
    .select({ r: schema.messageReactions, u: schema.users })
    .from(schema.messageReactions)
    .innerJoin(schema.users, eq(schema.messageReactions.userId, schema.users.id))
    .where(
      sql`(${schema.messageReactions.conversationId}, ${schema.messageReactions.seq}) IN (${tuples})
          AND ${schema.messageReactions.kind} = 'stamp'`,
    )
    .orderBy(asc(schema.messageReactions.createdAt));
  for (const { r, u } of rows) {
    const key = `${r.conversationId}:${r.seq}`;
    const list = map.get(key) ?? [];
    list.push(userLiteDto(u));
    map.set(key, list);
  }
  return map;
}

// v0.4 (API.md §1.23): batch vibe aggregates for 'vibe_check' messages.
// Replies are non-deleted messages in the same conversation carrying
// metadata.vibe_reply_seq = the vibe message's seq. replies = first
// VIBE_REPLIES_PREVIEW_MAX by seq; reply_count carries the rest; my_reply_seq
// is viewer-specific (null without a viewer — broadcast frames reconcile from
// the next viewer-scoped fetch, like reactions `mine`).
export async function loadVibesFor(
  vibeRows: MsgRow[],
  viewerId?: string,
): Promise<Map<string, VibeCheckAggregate>> {
  const map = new Map<string, VibeCheckAggregate>();
  const parents = vibeRows.filter((r) => r.deletedAt === null && r.body !== null);
  if (parents.length === 0) return map;
  const tuples = sql.join(
    parents.map((k) => sql`(${k.conversationId}::uuid, ${k.seq}::bigint)`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT
      r.conversation_id,
      (r.metadata->>'vibe_reply_seq')::bigint AS parent_seq,
      r.seq,
      (r.metadata ? 'doodle') AS is_doodle,
      (r.metadata ? 'stamp') AS is_stamp,
      a.thumb_key,
      u.id AS user_id, u.username, u.display_name, u.name_style,
      u.avatar_status, u.avatar_version, u.avatar_static_key, u.avatar_animated_key
    FROM messages r
    JOIN users u ON u.id = r.sender_id
    LEFT JOIN LATERAL (
      SELECT thumb_key FROM attachments
      WHERE message_id = r.id ORDER BY created_at ASC LIMIT 1
    ) a ON true
    WHERE r.deleted_at IS NULL
      AND r.metadata ? 'vibe_reply_seq'
      AND (r.conversation_id, (r.metadata->>'vibe_reply_seq')::bigint) IN (${tuples})
    ORDER BY r.seq ASC
  `)) as unknown as {
    conversation_id: string;
    parent_seq: string | number;
    seq: string | number;
    is_doodle: boolean;
    is_stamp: boolean;
    thumb_key: string | null;
    user_id: string;
    username: string;
    display_name: string;
    name_style: string;
    avatar_status: string;
    avatar_version: number;
    avatar_static_key: string | null;
    avatar_animated_key: string | null;
  }[];

  const byParent = new Map<string, { refs: VibeReplyRef[]; count: number; mine: number | null }>();
  for (const r of rows) {
    const key = `${r.conversation_id}:${Number(r.parent_seq)}`;
    const agg = byParent.get(key) ?? { refs: [], count: 0, mine: null };
    agg.count += 1;
    // kind derived: stamp > doodle > image (§1.23).
    const kind = r.is_stamp ? 'stamp' : r.is_doodle ? 'doodle' : 'image';
    if (agg.refs.length < VIBE_REPLIES_PREVIEW_MAX) {
      agg.refs.push({
        seq: Number(r.seq),
        user: {
          id: r.user_id,
          username: r.username,
          display_name: r.display_name,
          avatar: avatarDto({
            avatarStatus: r.avatar_status,
            avatarVersion: Number(r.avatar_version),
            avatarStaticKey: r.avatar_static_key,
            avatarAnimatedKey: r.avatar_animated_key,
          }),
          // Broadcast-shaped ref: mood is per-viewer and reconciles from
          // viewer-scoped reads (§1.57 conservative null); style is identity.
          mood: null,
          name_style: (r.name_style ?? 'none') as NameStyle,
          mask_emoji: null,
        },
        kind,
        // Stamps tile with user.avatar — thumb_url is null by construction.
        thumb_url: kind === 'stamp' ? null : r.thumb_key ? mediaUrl(r.thumb_key) : null,
      });
    }
    if (viewerId && r.user_id === viewerId) agg.mine = Number(r.seq);
    byParent.set(key, agg);
  }

  for (const p of parents) {
    const key = `${p.conversationId}:${p.seq}`;
    const agg = byParent.get(key);
    map.set(key, {
      prompt: p.body!,
      reply_count: agg?.count ?? 0,
      replies: agg?.refs ?? [],
      my_reply_seq: agg?.mine ?? null,
    });
  }
  return map;
}

// v0.5a (API.md §1.29): batch reply-context resolution for messages carrying
// reply_to_seq. Resolved at SERIALIZATION time against the referenced
// message's CURRENT row, so edits and tombstones are always reflected.
// excerpt = first REPLY_EXCERPT_MAX_CHARS of the current body; null for
// body-less kinds and tombstones. author null = system message / deleted
// account (the reply bubble renders a neutral label).
export async function loadReplyContextsFor(rows: MsgRow[]): Promise<Map<string, ReplyContext>> {
  const map = new Map<string, ReplyContext>();
  const withReply = rows.filter((r) => r.replyToSeq !== null);
  if (withReply.length === 0) return map;
  const keys = [
    ...new Set(withReply.map((r) => `${r.conversationId}:${r.replyToSeq}`)),
  ].map((k) => {
    const idx = k.lastIndexOf(':');
    return { conversationId: k.slice(0, idx), seq: Number(k.slice(idx + 1)) };
  });
  const tuples = sql.join(
    keys.map((k) => sql`(${k.conversationId}::uuid, ${k.seq}::bigint)`),
    sql`, `,
  );
  const targets = (await db.execute(sql`
    SELECT m.conversation_id, m.seq, m.type, m.body, m.deleted_at,
           u.id AS user_id, u.username, u.display_name, u.name_style,
           u.avatar_status, u.avatar_version, u.avatar_static_key, u.avatar_animated_key
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE (m.conversation_id, m.seq) IN (${tuples})
  `)) as unknown as {
    conversation_id: string;
    seq: string | number;
    type: string;
    body: string | null;
    deleted_at: string | Date | null;
    user_id: string | null;
    username: string | null;
    display_name: string | null;
    name_style: string | null;
    avatar_status: string | null;
    avatar_version: number | null;
    avatar_static_key: string | null;
    avatar_animated_key: string | null;
  }[];
  for (const t of targets) {
    const deleted = t.deleted_at !== null;
    map.set(`${t.conversation_id}:${Number(t.seq)}`, {
      seq: Number(t.seq),
      author: t.user_id
        ? {
            id: t.user_id,
            username: t.username!,
            display_name: t.display_name!,
            avatar: avatarDto({
              avatarStatus: t.avatar_status!,
              avatarVersion: Number(t.avatar_version),
              avatarStaticKey: t.avatar_static_key,
              avatarAnimatedKey: t.avatar_animated_key,
            }),
            mood: null, // §1.57 conservative null (no single viewer here)
            name_style: (t.name_style ?? 'none') as NameStyle,
            mask_emoji: null,
          }
        : null,
      type: t.type as ReplyContext['type'],
      excerpt: deleted || !t.body ? null : t.body.slice(0, REPLY_EXCERPT_MAX_CHARS),
      deleted,
    });
  }
  return map;
}

// v0.5a (API.md §1.32): batch pin loader — created_at ASC (a stable board,
// not a feed), ≤ MAX_PINS per conversation by construction.
export async function loadPinsFor(convIds: string[]): Promise<Map<string, ConversationPin[]>> {
  const map = new Map<string, ConversationPin[]>();
  if (convIds.length === 0) return map;
  const rows = await db
    .select()
    .from(schema.conversationPins)
    .where(inArray(schema.conversationPins.conversationId, convIds))
    .orderBy(asc(schema.conversationPins.createdAt), asc(schema.conversationPins.seq));
  for (const r of rows) {
    const list = map.get(r.conversationId) ?? [];
    list.push({ seq: r.seq, pinned_by: r.pinnedBy, created_at: r.createdAt.toISOString() });
    map.set(r.conversationId, list);
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
  const keys = rows.map((r) => ({ conversationId: r.conversationId, seq: r.seq }));
  const reactions = await loadReactionsFor(keys, viewerId);
  const stamps = await loadStampsFor(keys);
  const pollRows = rows.filter((r) => r.type === 'poll');
  const polls = await loadPollsFor(
    pollRows.map((r) => ({ conversationId: r.conversationId, seq: r.seq })),
    viewerId,
  );
  const vibes = await loadVibesFor(
    rows.filter((r) => r.type === 'vibe_check'),
    viewerId,
  );
  const replyContexts = await loadReplyContextsFor(rows);
  return rows.map((r) =>
    messageDto(
      r,
      atts.get(r.id) ?? [],
      reactions.get(`${r.conversationId}:${r.seq}`) ?? [],
      polls.get(`${r.conversationId}:${r.seq}`) ?? null,
      stamps.get(`${r.conversationId}:${r.seq}`) ?? [],
      r.type === 'vibe_check' ? (vibes.get(`${r.conversationId}:${r.seq}`) ?? null) : null,
      r.replyToSeq !== null
        ? (replyContexts.get(`${r.conversationId}:${r.replyToSeq}`) ?? null)
        : null,
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
  const pins = await loadPinsFor([convId]);
  const mine = (parts.get(convId) ?? []).find(({ u }) => u.id === view?.viewerId);
  const ghost = await ghostCtxFor(c, view?.viewerId, mine ? mine.p.role : null);
  return conversationDto(c, parts.get(convId) ?? [], view, pins.get(convId) ?? [], ghost);
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
  const pinsMap = await loadPinsFor([convId]);
  const pins = pinsMap.get(convId) ?? [];
  const participantIds = parts.map(({ u }) => u.id);
  const userById = new Map(parts.map(({ u }) => [u.id, u]));
  // A recipient may no longer be a participant (the just-removed member's own
  // conv.updated): load the missing user rows for their read_receipts.
  const missing = uniqueRecipients.filter((id) => !userById.has(id));
  if (missing.length > 0) {
    const rows = await db.select().from(schema.users).where(inArray(schema.users.id, missing));
    for (const u of rows) userById.set(u.id, u);
  }
  // v0.8b (§1.68): 👻 ghost conversations fan PER RECIPIENT — each non-admin
  // member's serialization differs (own row real, everyone else masked), so
  // the signature grouping below never applies. Ghost groups are direct-
  // invite-only and small; per-recipient envelopes are fine.
  if (c.visibility === 'ghost') {
    const masks = await loadMasks(convId);
    const roleById = new Map(parts.map(({ p, u }) => [u.id, p.role]));
    for (const r of uniqueRecipients) {
      const ctx: ViewCtx = {
        viewerId: r,
        viewerReadReceipts: userById.get(r)?.readReceipts ?? true,
        dmPartnerIds: new Set(),
        blockedIds: new Set(),
        connectionIds: new Set(),
      };
      const ghost: GhostCtx = {
        convId,
        masks,
        viewerId: r,
        viewerIsAdmin: roleById.get(r) === 'admin',
      };
      await publishToUsers([r], {
        t,
        d: { conversation: conversationDto(c, parts, ctx, pins, ghost) },
      });
    }
    return;
  }

  const pairs = await blockPairsAmong([...new Set([...participantIds, ...uniqueRecipients])]);
  // v0.8a (§1.57): participants with a LIVE 'connections'-visibility mood
  // need one accepted-connection lookup, batched like the dm_partners one —
  // the per-recipient mood stamp below resolves against it.
  const moodConnOwners = parts
    .filter(({ u }) => moodLive(u) && u.moodVisibility === 'connections')
    .map(({ u }) => u.id);
  const connPairs = await acceptedPairsBetween(moodConnOwners, uniqueRecipients);
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
    const connectionIds = new Set(moodConnOwners.filter((o) => connPairs.has(`${o}:${r}`)));
    let sig = '';
    for (const { u } of parts) {
      const readVisible = u.id === r || (u.readReceipts && rr);
      const lastSeenVisible =
        u.id === r ||
        (!blockedIds.has(u.id) &&
          (u.showLastSeen === 'everyone' ||
            (u.showLastSeen === 'dm_partners' && dmPartnerIds.has(u.id))));
      // v0.8a (§1.57): the mood bit is part of the serialization signature —
      // recipients with a different view of any participant's chip must not
      // share an envelope.
      const moodVisible =
        moodLive(u) &&
        (u.id === r ||
          (!blockedIds.has(u.id) &&
            (u.moodVisibility === 'everyone' ||
              (u.moodVisibility === 'connections' && connectionIds.has(u.id)))));
      sig += (readVisible ? 'r' : '.') + (lastSeenVisible ? 'l' : '.') + (moodVisible ? 'm' : '.');
    }
    // v0.5a (§1.35): a channel DTO embeds the VIEWER'S OWN row (plus owner +
    // admins), so each plain member's serialization is unique — key the group
    // by recipient. Owner/admins still share one envelope among themselves.
    if (c.type === 'channel') {
      const mine = parts.find(({ u }) => u.id === r);
      if (mine && mine.p.role === 'member') sig += `#${r}`;
    }
    const g = groups.get(sig);
    if (g) g.userIds.push(r);
    else {
      groups.set(sig, {
        ctx: { viewerId: r, viewerReadReceipts: rr, dmPartnerIds, blockedIds, connectionIds },
        userIds: [r],
      });
    }
  }
  for (const { ctx, userIds } of groups.values()) {
    await publishToUsers(userIds, { t, d: { conversation: conversationDto(c, parts, ctx, pins) } });
  }
}

/**
 * user.updated fan-out: blocked co-members keep receiving profile/avatar
 * updates (shared groups keep functioning, §1.14) but never the owner's
 * last_seen_at — it is clamped to null on their copy of the frame — and
 * never the owner's mood (v0.8a §1.57: blocks hide the chip both directions).
 * The mood is stamped PER RECIPIENT here (the §2.11 gateway-edge resolution):
 * owner always, 'everyone' to non-blocked recipients, 'connections' only to
 * accepted §1.28 connections, 'nobody' to the owner alone — a hidden chip is
 * null, byte-identical to no mood.
 */
export async function publishUserUpdated(row: UserRow, recipients: string[]): Promise<void> {
  if (recipients.length === 0) return;
  const blocked = await blockedSetOf(row.id);
  const dto = userPublicDto(row); // conservative broadcast view ('everyone' only; mood null)
  const chip = moodSelfDto(row); // live chip, visibility applied per recipient below
  const connections =
    chip && row.moodVisibility === 'connections' ? await connectionIdsOf(row.id) : null;

  // Up to four distinct serializations: (blocked?) × (mood visible?).
  const groups = new Map<string, { userIds: string[]; isBlocked: boolean; mood: Mood | null }>();
  for (const id of recipients) {
    const isBlocked = id !== row.id && blocked.has(id);
    const mood =
      chip && !isBlocked
        ? id === row.id
          ? chip
          : row.moodVisibility === 'everyone'
            ? chip
            : row.moodVisibility === 'connections' && connections?.has(id)
              ? chip
              : null
        : null;
    const key = `${isBlocked ? 'b' : '.'}|${mood ? 'm' : '.'}`;
    const g = groups.get(key);
    if (g) g.userIds.push(id);
    else groups.set(key, { userIds: [id], isBlocked, mood });
  }
  for (const { userIds, isBlocked, mood } of groups.values()) {
    await publishToUsers(userIds, {
      t: 'user.updated',
      d: { user: { ...dto, mood, ...(isBlocked ? { last_seen_at: null } : {}) } },
    });
  }
}

/** Load `userId`'s fresh row and fan user.updated to the standard recipient
 * set (own sockets + everyone sharing a conversation), per-recipient clamped. */
export async function broadcastUserUpdatedOf(userId: string): Promise<void> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!row) return;
  const peers = await coParticipantUserIds(userId);
  await publishUserUpdated(row, peers);
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

/** Distinct users sharing at least one active NON-GHOST conversation with
 * `userId` (self included). v0.8b (§1.68): a peer reachable ONLY through a
 * 👻 ghost group never receives this user's user.updated frames — "user X
 * changed their avatar" arriving at a masked co-member is an identity side
 * channel (a one-conversation member could link frame to mask). */
export async function coParticipantUserIds(userId: string): Promise<string[]> {
  const cp = schema.conversationParticipants;
  const rows = await db.execute(sql`
    SELECT DISTINCT other.user_id AS user_id
    FROM ${cp} AS mine
    JOIN ${cp} AS other ON other.conversation_id = mine.conversation_id
    JOIN conversations gc ON gc.id = mine.conversation_id AND gc.visibility <> 'ghost'
    WHERE mine.user_id = ${userId} AND mine.left_at IS NULL AND other.left_at IS NULL
  `);
  const ids = (rows as unknown as { user_id: string }[]).map((r) => r.user_id);
  if (!ids.includes(userId)) ids.push(userId);
  return ids;
}

export function rawToMsgRow(r: Record<string, unknown>): MsgRow {
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
    replyToSeq: r.reply_to_seq === null || r.reply_to_seq === undefined ? null : Number(r.reply_to_seq),
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
  const pinsByConv = await loadPinsFor(convIds);

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
    // v0.8b (§1.68): 👻 ghost conversations serialize masked for non-admin
    // viewers — participants AND the last-message preview.
    const ghost = await ghostCtxFor(c, userId, mine.role);
    let lastMessage = lastByConv.get(c.id) ?? null;
    if (ghost && !ghost.viewerIsAdmin && lastMessage) {
      lastMessage = ghostMessageDto(lastMessage, ghost);
    }
    items.push({
      ...conversationDto(c, partsByConv.get(c.id) ?? [], ctx, pinsByConv.get(c.id) ?? [], ghost),
      unread_count: Math.max(0, c.lastSeq - mine.lastReadSeq),
      last_message: lastMessage,
    });
  }
  items.sort((a, b) => {
    const ta = a.last_message_at ?? a.created_at;
    const tb = b.last_message_at ?? b.created_at;
    return tb.localeCompare(ta);
  });
  return items;
}
