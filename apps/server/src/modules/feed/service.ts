// Feed (v0.5a — API.md §1.36; v0.7 — §1.49/§1.50/§1.51, ADR-016). Posts by my
// friends-of set + me (friends lane) or audience='public' instance-wide
// (discover lane), newest first, FINITE: the terminal page answers
// all_caught_up and next_cursor null. FACES, NEVER COUNTERS: reactions carry
// the first POST_REACTORS_PREVIEW_MAX reactors as UserLite + has_more — no
// numeric total exists in any payload; comments inline the latest 3 (ASC) +
// has_more_comments — no comment count either. The ONE sanctioned tally is
// post.poll.counts — a vote tally on OPTIONS, a decision tool, never approval
// attached to a person (ADR-016 argues the PSYCHOLOGY rule-3 distinction).
// Blocked pairs are invisible in both directions on every surface (posts,
// reactor faces, comments, claimed-by faces, join_card summaries).
import { eq, inArray, sql } from 'drizzle-orm';
import {
  COMMENT_REACTORS_PREVIEW_MAX,
  JOIN_CARD_SUMMARY_JOINERS_MAX,
  POST_COMMENTS_PREVIEW_MAX,
  POST_REACTORS_PREVIEW_MAX,
  type BeaconVibe,
  type CommentReactionAggregate,
  type JoinCardSummary,
  type Location,
  type Post,
  type PostComment,
  type PostGame,
  type PostPoll,
  type PostReactionAggregate,
  type PostRef,
  type ReactionKind,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { attachmentDto, userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';
import { isBeaconVisibleTo, loadBeacon } from '../beacons/service.js';
import {
  derivedListingStatus,
  hasListingContact,
  isListingLive,
  loadListingWithAuthor,
} from '../listings/service.js';

export type PostRow = typeof schema.posts.$inferSelect;
export type CommentRow = typeof schema.postComments.$inferSelect;

// The comment-preview window: fetched DESC per post, blocked authors filtered,
// then the newest POST_COMMENTS_PREVIEW_MAX serialized ASC. A window larger
// than the preview keeps has_more honest even when a few blocked comments sit
// at the tail.
const COMMENT_WINDOW = 20;

// ---------------------------------------------------------------------------
// Comment DTOs (v0.7 §1.51: + attachment + reactions-as-faces)
// ---------------------------------------------------------------------------

export interface CommentWithAuthor {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  attachmentId: string | null;
  createdAt: Date;
  author: UserRow;
}

/**
 * Batch comment serialization: inlines the §1.6 attachment DTO and the §1.51
 * reaction chips — one chip per (emoji, kind), reactors capped at
 * COMMENT_REACTORS_PREVIEW_MAX in first-reaction order, has_more for the rest.
 * NEVER a numeric total (PSYCHOLOGY rule 3). Blocked faces never serialize.
 */
export async function commentDtosFor(
  rows: CommentWithAuthor[],
  viewerId: string,
  blocked?: Set<string>,
): Promise<PostComment[]> {
  if (rows.length === 0) return [];
  const blockedIds = blocked ?? (await blockedSetOf(viewerId));
  const commentIds = rows.map((r) => r.id);
  const idList = sql.join(commentIds.map((id) => sql`${id}::uuid`), sql`, `);

  // Attachments (≤ one per comment).
  const attIds = rows.flatMap((r) => (r.attachmentId ? [r.attachmentId] : []));
  const attById = new Map<string, AttRow>();
  if (attIds.length > 0) {
    const attRows = await db
      .select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.id, [...new Set(attIds)]));
    for (const a of attRows) attById.set(a.id, a);
  }

  // Reactions as FACES (the §1.51 twin of the post aggregation below).
  const reactionRows = (await db.execute(sql`
    SELECT cr.comment_id, cr.emoji, cr.kind, cr.user_id, row_to_json(u.*) AS reactor
    FROM comment_reactions cr
    JOIN users u ON u.id = cr.user_id
    WHERE cr.comment_id IN (${idList})
    ORDER BY cr.created_at ASC
  `)) as unknown as {
    comment_id: string;
    emoji: string;
    kind: ReactionKind;
    user_id: string;
    reactor: Record<string, unknown>;
  }[];
  const chipsByComment = new Map<string, Map<string, CommentReactionAggregate>>();
  for (const r of reactionRows) {
    const chips = chipsByComment.get(r.comment_id) ?? new Map<string, CommentReactionAggregate>();
    chipsByComment.set(r.comment_id, chips);
    const key = `${r.kind}:${r.emoji}`;
    const chip =
      chips.get(key) ??
      ({ emoji: r.emoji, kind: r.kind, reactors: [], has_more: false, mine: false } as CommentReactionAggregate);
    chips.set(key, chip);
    if (r.user_id === viewerId) chip.mine = true;
    if (blockedIds.has(r.user_id)) continue; // blocked faces never serialize
    if (chip.reactors.length < COMMENT_REACTORS_PREVIEW_MAX) {
      chip.reactors.push(userLiteDto(rawUser(r.reactor)));
    } else {
      chip.has_more = true;
    }
  }

  return rows.map((r) => {
    const att = r.attachmentId ? attById.get(r.attachmentId) : undefined;
    const chips = [...(chipsByComment.get(r.id)?.values() ?? [])]
      // A chip whose every reactor is blocked w.r.t. the viewer disappears
      // entirely (no faces → nothing to show; counts don't exist).
      .filter((c) => c.reactors.length > 0 || c.mine);
    return {
      id: r.id,
      post_id: r.postId,
      author: userLiteDto(r.author),
      body: r.body,
      attachment: att ? attachmentDto(att) : null,
      reactions: chips,
      created_at: r.createdAt.toISOString(),
    } satisfies PostComment;
  });
}

/** Single-comment convenience (the create-route 201 response). */
export async function commentDtoFor(
  row: CommentRow,
  author: UserRow,
  viewerId: string,
): Promise<PostComment> {
  const [dto] = await commentDtosFor(
    [
      {
        id: row.id,
        postId: row.postId,
        authorId: row.authorId,
        body: row.body,
        attachmentId: row.attachmentId,
        createdAt: row.createdAt,
        author,
      },
    ],
    viewerId,
  );
  return dto!;
}

// ---------------------------------------------------------------------------
// §1.50 join_card live summaries — resolved per viewer at serialization time
// (the §1.29 reply_context pattern). The summary never carries more than the
// ref's own DTO would show that viewer; invisible = null ("no longer
// available" card) — blocks, bans and deletion included.
// ---------------------------------------------------------------------------

async function resolveRefSummary(
  ref: PostRef,
  viewer: { id: string; area: string | null },
  blocked: Set<string>,
): Promise<JoinCardSummary | null> {
  if (ref.type === 'beacon') {
    const row = await loadBeacon(ref.id);
    if (!row) return null;
    if (!(await isBeaconVisibleTo(row, viewer))) return null;
    const joins = (await db.execute(sql`
      SELECT j.user_id, row_to_json(u.*) AS u
      FROM beacon_joins j JOIN users u ON u.id = j.user_id
      WHERE j.beacon_id = ${row.id}
      ORDER BY j.created_at ASC
    `)) as unknown as { user_id: string; u: Record<string, unknown> }[];
    const isCreator = row.creatorId === viewer.id;
    const isJoiner = joins.some((j) => j.user_id === viewer.id);
    const joinerFaces = joins
      .filter((j) => !blocked.has(j.user_id))
      .slice(0, JOIN_CARD_SUMMARY_JOINERS_MAX)
      .map((j) => userLiteDto(rawUser(j.u)));
    // Live truth for a card that outlives its beacon: an 'open' row past
    // expires_at (sweep lag) reads 'expired'.
    const status =
      row.status === 'open' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status;
    return {
      type: 'beacon',
      id: row.id,
      vibe: row.vibe as BeaconVibe,
      custom_vibe_emoji: row.customVibeEmoji,
      custom_vibe_label: row.customVibeLabel,
      note: row.note,
      status,
      starts_at: row.startsAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      joiners: joinerFaces,
      needs: Math.max(0, row.sparkThreshold - joins.length),
      my_state: isCreator ? 'creator' : isJoiner ? 'joined' : 'none',
      location: (row.location as Location | null) ?? null,
    } as JoinCardSummary;
  }
  // listing
  const row = await loadListingWithAuthor(ref.id);
  if (!row) return null;
  const { l, u } = row;
  if (l.authorId !== viewer.id) {
    if (u.bannedAt !== null) return null;
    if (await isBlockedPair(viewer.id, l.authorId)) return null;
    if (!(await hasListingContact(l.id, viewer.id))) {
      const areaOk =
        l.isPublic || (viewer.area !== null && l.area.toLowerCase() === viewer.area.toLowerCase());
      if (!isListingLive(l) || !areaOk) return null;
    }
  }
  return {
    type: 'listing',
    id: l.id,
    kind: l.kind as 'gig' | 'ride' | 'room' | 'place_review',
    title: l.title,
    price_text: l.priceText,
    status: derivedListingStatus(l),
    area: l.area,
    my_contacted: l.authorId !== viewer.id && (await hasListingContact(l.id, viewer.id)),
    location: (l.location as Location | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Post DTOs
// ---------------------------------------------------------------------------

export async function postDtos(rows: PostRow[], viewerId: string): Promise<Post[]> {
  if (rows.length === 0) return [];
  const postIds = rows.map((r) => r.id);
  const idList = sql.join(postIds.map((id) => sql`${id}::uuid`), sql`, `);
  const blocked = await blockedSetOf(viewerId);

  // Authors.
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const authors = await db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.id, authorIds));
  const authorById = new Map(authors.map((u) => [u.id, u]));

  // Attachments, ordered by the author's posts.attachment_ids array.
  const attRows = await db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.postId, postIds));
  const attById = new Map(attRows.map((a) => [a.id, a]));

  // Reactions as FACES: all rows in created_at order; chips keep first-
  // reaction order per emoji; reactors filter blocked, cap at the preview max.
  const reactionRows = (await db.execute(sql`
    SELECT pr.post_id, pr.emoji, pr.user_id, row_to_json(u.*) AS reactor
    FROM post_reactions pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.post_id IN (${idList})
    ORDER BY pr.created_at ASC
  `)) as unknown as {
    post_id: string;
    emoji: string;
    user_id: string;
    reactor: Record<string, unknown>;
  }[];
  const reactionsByPost = new Map<string, Map<string, PostReactionAggregate & { extra: number }>>();
  for (const r of reactionRows) {
    const chips = reactionsByPost.get(r.post_id) ?? new Map();
    reactionsByPost.set(r.post_id, chips);
    const chip =
      chips.get(r.emoji) ??
      ({ emoji: r.emoji, reactors: [], has_more: false, mine: false, extra: 0 } as PostReactionAggregate & {
        extra: number;
      });
    chips.set(r.emoji, chip);
    if (r.user_id === viewerId) chip.mine = true;
    if (blocked.has(r.user_id)) continue; // blocked faces never serialize
    if (chip.reactors.length < POST_REACTORS_PREVIEW_MAX) {
      chip.reactors.push(userLiteDto(rawUser(r.reactor)));
    } else {
      chip.extra += 1;
      chip.has_more = true;
    }
  }

  // Comment previews: newest COMMENT_WINDOW per post via LATERAL, blocked
  // authors filtered, newest POST_COMMENTS_PREVIEW_MAX kept, serialized ASC.
  const commentRows = (await db.execute(sql`
    SELECT c.id, c.post_id, c.author_id, c.body, c.attachment_id, c.created_at,
           row_to_json(u.*) AS author
    FROM posts p
    JOIN LATERAL (
      SELECT * FROM post_comments
      WHERE post_id = p.id
      ORDER BY created_at DESC, id DESC
      LIMIT ${COMMENT_WINDOW}
    ) c ON true
    JOIN users u ON u.id = c.author_id
    WHERE p.id IN (${idList})
    ORDER BY c.created_at DESC
  `)) as unknown as {
    id: string;
    post_id: string;
    author_id: string;
    body: string;
    attachment_id: string | null;
    created_at: string | Date;
    author: Record<string, unknown>;
  }[];
  const commentsByPost = new Map<string, { visible: CommentWithAuthor[]; windowSize: number }>();
  for (const c of commentRows) {
    const g = commentsByPost.get(c.post_id) ?? { visible: [], windowSize: 0 };
    commentsByPost.set(c.post_id, g);
    g.windowSize += 1;
    if (blocked.has(c.author_id)) continue;
    g.visible.push({
      id: c.id,
      postId: c.post_id,
      authorId: c.author_id,
      body: c.body,
      attachmentId: c.attachment_id,
      createdAt: new Date(c.created_at),
      author: rawUser(c.author),
    });
  }
  // One batched DTO pass over every previewed comment (attachments + chips).
  const previewRows = [...commentsByPost.values()].flatMap((g) =>
    g.visible.slice(0, POST_COMMENTS_PREVIEW_MAX),
  );
  const previewDtoList = await commentDtosFor(previewRows, viewerId, blocked);
  const previewDtoById = new Map(previewDtoList.map((c) => [c.id, c]));

  // §1.50 polls: counts + total + my_vote, batched over the page's poll posts.
  const pollPostIds = rows.filter((r) => r.kind === 'poll').map((r) => r.id);
  const pollByPost = new Map<string, PostPoll>();
  if (pollPostIds.length > 0) {
    const pollList = sql.join(pollPostIds.map((id) => sql`${id}::uuid`), sql`, `);
    const pollRows = (await db.execute(sql`
      SELECT post_id, question, options FROM post_polls WHERE post_id IN (${pollList})
    `)) as unknown as { post_id: string; question: string; options: string[] }[];
    const voteRows = (await db.execute(sql`
      SELECT post_id, user_id, option_idx FROM post_poll_votes WHERE post_id IN (${pollList})
    `)) as unknown as { post_id: string; user_id: string; option_idx: number }[];
    const votesByPost = new Map<string, { user_id: string; option_idx: number }[]>();
    for (const v of voteRows) {
      const list = votesByPost.get(v.post_id) ?? [];
      list.push(v);
      votesByPost.set(v.post_id, list);
    }
    for (const p of pollRows) {
      const options = (p.options ?? []) as string[];
      const counts = new Array<number>(options.length).fill(0);
      let myVote: number | null = null;
      const votes = votesByPost.get(p.post_id) ?? [];
      for (const v of votes) {
        const idx = Number(v.option_idx);
        if (idx >= 0 && idx < counts.length) counts[idx]! += 1;
        if (v.user_id === viewerId) myVote = idx;
      }
      pollByPost.set(p.post_id, {
        question: p.question,
        options,
        counts,
        total_votes: votes.length,
        my_vote: myVote,
      });
    }
  }

  // §1.50 game claims: claimed_by faces, blocked faces nulled (state stays).
  const claimerIds = [
    ...new Set(rows.flatMap((r) => (r.gameClaimedBy ? [r.gameClaimedBy] : []))),
  ];
  const claimerById = new Map<string, UserRow>();
  if (claimerIds.length > 0) {
    const claimers = await db
      .select()
      .from(schema.users)
      .where(inArray(schema.users.id, claimerIds));
    for (const u of claimers) claimerById.set(u.id, u);
  }

  // §1.50 join_card refs: resolved per viewer; the viewer's area feeds the
  // listing same-area rule (beacon 'area' refs cannot exist — refused at
  // create by the audience-intersection table).
  const hasRefs = rows.some((r) => r.kind === 'join_card' && r.ref !== null);
  let viewerArea: string | null = null;
  if (hasRefs) {
    const [me] = await db
      .select({ area: schema.users.area })
      .from(schema.users)
      .where(eq(schema.users.id, viewerId))
      .limit(1);
    viewerArea = me?.area ?? null;
  }
  const refSummaryByPost = new Map<string, JoinCardSummary | null>();
  for (const row of rows) {
    if (row.kind !== 'join_card' || row.ref === null) continue;
    refSummaryByPost.set(
      row.id,
      await resolveRefSummary(row.ref as PostRef, { id: viewerId, area: viewerArea }, blocked),
    );
  }

  return rows.flatMap((row) => {
    const author = authorById.get(row.authorId);
    if (!author) return [];
    const orderedAtts = ((row.attachmentIds ?? []) as string[])
      .map((id) => attById.get(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    const chips = [...(reactionsByPost.get(row.id)?.values() ?? [])]
      // A chip whose every reactor is blocked w.r.t. the viewer disappears
      // entirely (no faces → nothing to show; counts don't exist).
      .filter((c) => c.reactors.length > 0 || c.mine)
      .map(({ extra: _extra, ...chip }) => chip);
    const cg = commentsByPost.get(row.id) ?? { visible: [], windowSize: 0 };
    const preview = cg.visible
      .slice(0, POST_COMMENTS_PREVIEW_MAX)
      .map((c) => previewDtoById.get(c.id))
      .filter((c): c is PostComment => c !== undefined)
      .reverse(); // ASC
    const hasMore =
      cg.visible.length > POST_COMMENTS_PREVIEW_MAX || cg.windowSize >= COMMENT_WINDOW;

    let game: PostGame | null = null;
    if (row.kind === 'game') {
      const claimer =
        row.gameClaimedBy && !blocked.has(row.gameClaimedBy)
          ? claimerById.get(row.gameClaimedBy)
          : undefined;
      game = {
        state: row.gameClaimedBy ? 'claimed' : 'open',
        claimed_by: claimer ? userLiteDto(claimer) : null,
      };
    }

    return [
      {
        id: row.id,
        author: userLiteDto(author),
        kind: row.kind as Post['kind'],
        audience: row.audience as Post['audience'],
        body: row.body,
        attachments: orderedAtts.map(attachmentDto),
        reactions: chips,
        comments: preview,
        has_more_comments: hasMore,
        poll: pollByPost.get(row.id) ?? null,
        game,
        ref: row.kind === 'join_card' ? ((row.ref as PostRef | null) ?? null) : null,
        ref_summary: refSummaryByPost.get(row.id) ?? null,
        location: (row.location as Location | null) ?? null,
        created_at: row.createdAt.toISOString(),
      } satisfies Post,
    ];
  });
}

function rawUser(o: Record<string, unknown>): UserRow {
  return {
    id: o.id as string,
    username: o.username as string,
    displayName: o.display_name as string,
    avatarStatus: o.avatar_status as string,
    avatarVersion: Number(o.avatar_version),
    avatarStaticKey: (o.avatar_static_key as string | null) ?? null,
    avatarAnimatedKey: (o.avatar_animated_key as string | null) ?? null,
    // v0.8a (§1.58): name_style is viewer-independent identity and rides
    // every author/reactor UserLite. Mood columns are deliberately NOT
    // mapped: feed serialization is broadcast-shaped here, and §1.57's
    // conservative rule serializes mood null without a per-viewer ctx.
    nameStyle: ((o.name_style as string | undefined) ?? 'none'),
  } as UserRow;
}

export async function loadPost(id: string): Promise<PostRow | null> {
  const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
  return row ?? null;
}

/** The §1.50 fresh poll aggregate (the voter's own 200 body). */
export async function pollDtoFor(postId: string, viewerId: string): Promise<PostPoll | null> {
  const [poll] = (await db.execute(sql`
    SELECT question, options FROM post_polls WHERE post_id = ${postId} LIMIT 1
  `)) as unknown as { question: string; options: string[] }[];
  if (!poll) return null;
  const options = (poll.options ?? []) as string[];
  const voteRows = (await db.execute(sql`
    SELECT user_id, option_idx FROM post_poll_votes WHERE post_id = ${postId}
  `)) as unknown as { user_id: string; option_idx: number }[];
  const counts = new Array<number>(options.length).fill(0);
  let myVote: number | null = null;
  for (const v of voteRows) {
    const idx = Number(v.option_idx);
    if (idx >= 0 && idx < counts.length) counts[idx]! += 1;
    if (v.user_id === viewerId) myVote = idx;
  }
  return {
    question: poll.question,
    options,
    counts,
    total_votes: voteRows.length,
    my_vote: myVote,
  };
}
