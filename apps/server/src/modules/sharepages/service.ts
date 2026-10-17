// Public share pages — token machinery & live object resolution (v0.8b —
// API.md §1.67, FEATURES #79c, ADR-020). The ADR-007 invite-token doctrine:
// 32 random bytes base64url stored PLAINTEXT with a unique index — a
// revocable CAPABILITY. ONE open token per object (partial unique); tokens
// exist ONLY for PUBLIC things and every public read RE-CHECKS the object's
// publicness LIVE — narrowing an audience kills the page mid-flight even
// before any revoke lands. 404 share_not_found is byte-identical for every
// cause (unknown, revoked, deleted, no-longer-public, expired story, banned
// author): no enumeration, no oracle.
import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  SHARE_GROUP_PAGE_MESSAGES_MAX,
  SHARE_TOKEN_BYTES,
  type ShareAuthorChip,
  type ShareLink,
  type ShareMedia,
  type ShareMessage,
  type SharePage,
  type StoryOverlayPayload,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import type { AttRow, UserRow } from '../../lib/dto.js';
import type { SqlExecutor } from '../../lib/activity.js';

export type ShareTokenRow = typeof schema.shareTokens.$inferSelect;
export type ShareObjectType = ShareTokenRow['objectType'] extends string
  ? 'post' | 'beacon' | 'listing' | 'story' | 'group'
  : never;

const stt = schema.shareTokens;

export function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function shareUrlPath(type: string, token: string): string {
  // App-origin PATH — PUBLIC_ORIGIN prefixes it everywhere absolute (§1.53).
  return type === 'story' ? `/s/${token}` : `/p/${token}`;
}

export function shareLinkDto(row: ShareTokenRow): ShareLink {
  return {
    token: row.token,
    url: shareUrlPath(row.objectType, row.token),
    object: { type: row.objectType as ShareLink['object']['type'], id: row.objectId },
    created_at: row.createdAt.toISOString(),
  };
}

/** Mint-or-return the object's ONE open token (§1.67). */
export async function mintOrReturnToken(
  type: string,
  objectId: string,
  createdBy: string,
): Promise<ShareTokenRow> {
  const [open] = await db
    .select()
    .from(stt)
    .where(and(eq(stt.objectType, type), eq(stt.objectId, objectId), isNull(stt.revokedAt)))
    .limit(1);
  if (open) return open;
  try {
    const [row] = await db
      .insert(stt)
      .values({ id: newId(), objectType: type, objectId, token: newShareToken(), createdBy })
      .returning();
    return row!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const [raced] = await db
        .select()
        .from(stt)
        .where(and(eq(stt.objectType, type), eq(stt.objectId, objectId), isNull(stt.revokedAt)))
        .limit(1);
      if (raced) return raced;
    }
    throw err;
  }
}

/** Route-side revocation — runs inside the owning mutation's transaction
 * where one is open (delete post / cancel beacon / visibility switch). */
export async function revokeShareTokensFor(
  executor: SqlExecutor,
  type: string,
  objectId: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE share_tokens SET revoked_at = now()
    WHERE object_type = ${type} AND object_id = ${objectId} AND revoked_at IS NULL
  `);
}

export async function loadOpenTokenByToken(token: string): Promise<ShareTokenRow | null> {
  const [row] = await db
    .select()
    .from(stt)
    .where(and(eq(stt.token, token), isNull(stt.revokedAt)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Page assembly. Author chips carry NO ids and NO UserLite — username,
// display_name, the token-gated avatar path, name_style. All media URLs are
// the token-gated proxy paths, never /api/media/:key.
// ---------------------------------------------------------------------------

export function authorChip(u: UserRow, token: string): ShareAuthorChip {
  return {
    username: u.username,
    display_name: u.displayName,
    avatar_url:
      u.avatarStatus === 'ready' && u.avatarStaticKey
        ? `/api/share/${token}/avatar/${u.id}?v=static`
        : null,
    name_style: (u.nameStyle ?? 'none') as ShareAuthorChip['name_style'],
  };
}

export function shareMediaDto(a: AttRow, token: string): ShareMedia {
  return {
    attachment_id: a.id,
    kind: a.kind as ShareMedia['kind'],
    url: `/api/share/${token}/media/${a.id}`,
    thumb_url: a.thumbKey ? `/api/share/${token}/media/${a.id}?variant=thumb` : null,
    width: a.width,
    height: a.height,
    blurhash: a.blurhash,
  };
}

function locationLabel(loc: unknown): string | null {
  if (loc && typeof loc === 'object' && typeof (loc as { label?: unknown }).label === 'string') {
    return (loc as { label: string }).label;
  }
  return null;
}

async function loadUser(id: string): Promise<UserRow | null> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u ?? null;
}

/** Live beacon status (expiry resolves live, the §1.15 pattern). */
function liveBeaconStatus(row: { status: string; expiresAt: Date }): string {
  if (row.status === 'open' && row.expiresAt.getTime() <= Date.now()) return 'expired';
  return row.status;
}

function liveListingStatus(row: { status: string; expiresAt: Date | null }): string {
  if (row.status === 'active' && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return 'expired';
  }
  return row.status;
}

/**
 * Resolve one token to its live SharePage, or null (the route answers the
 * byte-identical 404 share_not_found). `groupCursor` pages a public group's
 * read-only tail (older messages, floored at public_since_seq ALWAYS).
 */
export async function resolveSharePage(
  t: ShareTokenRow,
  groupCursor?: number,
): Promise<SharePage | null> {
  const token = t.token;
  switch (t.objectType) {
    case 'post': {
      const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, t.objectId)).limit(1);
      if (!post || post.audience !== 'public') return null;
      const author = await loadUser(post.authorId);
      if (!author || author.bannedAt !== null) return null;
      const atts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.postId, post.id));
      const order = (post.attachmentIds as string[]) ?? [];
      const sorted = [...atts].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      let poll: { question: string; options: string[]; counts: number[] } | null = null;
      if (post.kind === 'poll') {
        const [p] = await db
          .select()
          .from(schema.postPolls)
          .where(eq(schema.postPolls.postId, post.id))
          .limit(1);
        if (p) {
          const options = p.options as string[];
          const votes = (await db.execute(sql`
            SELECT option_idx, count(*)::int AS n FROM post_poll_votes
            WHERE post_id = ${post.id} GROUP BY option_idx
          `)) as unknown as { option_idx: number; n: number }[];
          const byIdx = new Map(votes.map((v) => [Number(v.option_idx), Number(v.n)]));
          poll = {
            question: p.question,
            options,
            counts: options.map((_, i) => byIdx.get(i) ?? 0),
          };
        }
      }
      return {
        type: 'post',
        author: authorChip(author, token),
        kind: post.kind as 'text' | 'poll' | 'game' | 'join_card',
        body: post.body,
        media: sorted.map((a) => shareMediaDto(a, token)),
        poll,
        location_label: locationLabel(post.location),
        created_at: post.createdAt.toISOString(),
      };
    }
    case 'beacon': {
      const [b] = await db
        .select()
        .from(schema.beacons)
        .where(eq(schema.beacons.id, t.objectId))
        .limit(1);
      if (!b || b.audience !== 'public') return null;
      const creator = await loadUser(b.creatorId);
      if (!creator || creator.bannedAt !== null) return null;
      const [joins] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM beacon_joins WHERE beacon_id = ${b.id}
      `)) as unknown as { n: number }[];
      // `needs` is the §1.15 utility number — NO joiner faces or identities
      // to logged-out strangers, ever.
      const needs = Math.max(0, b.sparkThreshold - Number(joins?.n ?? 0));
      return {
        type: 'beacon',
        creator: authorChip(creator, token),
        vibe: b.vibe as 'food' | 'chai' | 'walk' | 'game' | 'movie' | 'study' | 'sport' | 'chill' | 'custom',
        custom_vibe_emoji: b.customVibeEmoji,
        custom_vibe_label: b.customVibeLabel,
        note: b.note,
        status: liveBeaconStatus(b) as 'open' | 'sparked' | 'expired' | 'cancelled',
        starts_at: b.startsAt.toISOString(),
        expires_at: b.expiresAt.toISOString(),
        needs,
        location_label: locationLabel(b.location),
        created_at: b.createdAt.toISOString(),
      };
    }
    case 'listing': {
      const [l] = await db
        .select()
        .from(schema.listings)
        .where(eq(schema.listings.id, t.objectId))
        .limit(1);
      if (!l || !l.isPublic) return null;
      const author = await loadUser(l.authorId);
      if (!author || author.bannedAt !== null) return null;
      const atts = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.listingId, l.id))
        .orderBy(asc(schema.attachments.createdAt));
      return {
        type: 'listing',
        author: authorChip(author, token),
        kind: l.kind as 'gig' | 'ride' | 'room' | 'place_review',
        title: l.title,
        body: l.body,
        price_text: l.priceText,
        area: l.area,
        status: liveListingStatus(l) as 'active' | 'closed' | 'expired',
        media: atts.map((a) => shareMediaDto(a, token)),
        location_label: locationLabel(l.location),
        created_at: l.createdAt.toISOString(),
      };
    }
    case 'story': {
      const [s] = await db
        .select()
        .from(schema.stories)
        .where(eq(schema.stories.id, t.objectId))
        .limit(1);
      // The page dies with the story — expiry resolves LIVE.
      if (!s || s.expiresAt.getTime() <= Date.now()) return null;
      const author = await loadUser(s.authorId);
      if (!author || author.bannedAt !== null) return null;
      const [att] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, s.attachmentId))
        .limit(1);
      if (!att) return null;
      // Canvas overlays render read-only with contributor USERNAME chips
      // (public attribution is the §1.66 contract); live ones only.
      const overlays = (await db.execute(sql`
        SELECT so.kind, so.payload, u.username
        FROM story_overlays so
        JOIN users u ON u.id = so.author_id
        WHERE so.story_id = ${s.id} AND so.status = 'live'
        ORDER BY so.created_at ASC
      `)) as unknown as { kind: string; payload: unknown; username: string }[];
      return {
        type: 'story',
        author: authorChip(author, token),
        caption: s.caption,
        media: shareMediaDto(att, token),
        overlays: overlays.map((o) => ({
          kind: o.kind as 'stroke' | 'emoji' | 'text',
          payload: o.payload as StoryOverlayPayload,
          author_username: o.username,
        })),
        expires_at: s.expiresAt.toISOString(),
        created_at: s.createdAt.toISOString(),
      };
    }
    case 'group': {
      const [c] = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, t.objectId))
        .limit(1);
      if (!c || c.type !== 'group') return null;
      const [members] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM conversation_participants
        WHERE conversation_id = ${c.id} AND left_at IS NULL
      `)) as unknown as { n: number }[];
      const memberCount = Math.max(1, Number(members?.n ?? 1));
      const avatarUrl =
        c.avatarStatus === 'ready' && c.avatarStaticKey
          ? `/api/share/${token}/avatar/${c.id}?v=static`
          : null;
      if (c.visibility === 'invite_only') {
        // The CARD only — never messages (§1.68).
        return {
          type: 'group_card',
          title: c.title ?? '',
          description: c.description,
          avatar_url: avatarUrl,
          member_count: memberCount,
          created_at: c.createdAt.toISOString(),
        };
      }
      if (c.visibility !== 'public' || c.publicSinceSeq === null) return null;
      const floor = c.publicSinceSeq;
      // The read-only live tail: ONLY seq > public_since_seq, system noise,
      // tombstones and undone messages never render. Newest page by default;
      // older pages by cursor — floored at the switch seq ALWAYS.
      const ceiling = groupCursor !== undefined ? Math.min(groupCursor, Number.MAX_SAFE_INTEGER) : null;
      const msgRows = (await db.execute(sql`
        SELECT m.*, u.id AS su_id, u.username AS su_username, u.display_name AS su_display_name,
               u.name_style AS su_name_style, u.avatar_status AS su_avatar_status,
               u.avatar_static_key AS su_avatar_static_key
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${c.id}
          AND m.seq > ${floor}::bigint
          ${ceiling !== null ? sql`AND m.seq < ${ceiling}::bigint` : sql``}
          AND m.deleted_at IS NULL
          AND m.type <> 'system'
        ORDER BY m.seq DESC
        LIMIT ${SHARE_GROUP_PAGE_MESSAGES_MAX + 1}
      `)) as unknown as Record<string, unknown>[];
      const hasMore = msgRows.length > SHARE_GROUP_PAGE_MESSAGES_MAX;
      const page = msgRows.slice(0, SHARE_GROUP_PAGE_MESSAGES_MAX);
      const msgIds = page.map((r) => r.id as string);
      const attRows =
        msgIds.length > 0
          ? await db
              .select()
              .from(schema.attachments)
              .where(
                sql`${schema.attachments.messageId} IN (${sql.join(msgIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
              )
              .orderBy(asc(schema.attachments.createdAt))
          : [];
      const attsByMsg = new Map<string, AttRow[]>();
      for (const a of attRows) {
        if (!a.messageId) continue;
        const list = attsByMsg.get(a.messageId) ?? [];
        list.push(a);
        attsByMsg.set(a.messageId, list);
      }
      const messages: ShareMessage[] = page
        .map((r) => {
          const senderId = r.su_id as string | null;
          return {
            seq: Number(r.seq),
            sender: senderId
              ? {
                  username: r.su_username as string,
                  display_name: r.su_display_name as string,
                  avatar_url:
                    r.su_avatar_status === 'ready' && r.su_avatar_static_key
                      ? `/api/share/${token}/avatar/${senderId}?v=static`
                      : null,
                  name_style: ((r.su_name_style as string) ?? 'none') as ShareAuthorChip['name_style'],
                }
              : null,
            type: r.type as ShareMessage['type'],
            body: (r.body as string | null) ?? null,
            media: (attsByMsg.get(r.id as string) ?? []).map((a) => shareMediaDto(a, token)),
            created_at: new Date(r.created_at as string | Date).toISOString(),
          };
        })
        .reverse(); // seq ASC on the wire
      const oldest = messages[0]?.seq ?? null;
      return {
        type: 'group_live',
        title: c.title ?? '',
        description: c.description,
        avatar_url: avatarUrl,
        member_count: memberCount,
        messages,
        next_cursor: hasMore && oldest !== null ? String(oldest) : null,
        created_at: c.createdAt.toISOString(),
      };
    }
    default:
      return null;
  }
}

/** Nightly GC bookkeeping (§1.67): prune tokens whose object is gone or
 * whose story expired — reads already 404 live. */
export async function pruneDeadShareTokens(): Promise<void> {
  await db.execute(sql`
    DELETE FROM share_tokens st
    WHERE (st.object_type = 'post' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = st.object_id))
       OR (st.object_type = 'beacon' AND NOT EXISTS (SELECT 1 FROM beacons b WHERE b.id = st.object_id))
       OR (st.object_type = 'listing' AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.id = st.object_id))
       OR (st.object_type = 'story' AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.id = st.object_id))
       OR (st.object_type = 'group' AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = st.object_id))
  `);
}
