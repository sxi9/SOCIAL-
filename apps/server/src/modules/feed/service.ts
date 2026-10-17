// Feed (v0.5a — API.md §1.36, FEATURES #46, ADR-011). Posts by my friends-of
// set + me, newest first, FINITE: the terminal page answers all_caught_up and
// next_cursor null. FACES, NEVER COUNTERS: reactions carry the first
// POST_REACTORS_PREVIEW_MAX reactors as UserLite + has_more — no numeric
// total exists in any payload; comments inline the latest 3 (ASC) +
// has_more_comments — no comment count either. Blocked pairs are invisible in
// both directions on every surface (posts, reactor faces, comments).
import { eq, inArray, sql } from 'drizzle-orm';
import {
  POST_COMMENTS_PREVIEW_MAX,
  POST_REACTORS_PREVIEW_MAX,
  type Post,
  type PostComment,
  type PostReactionAggregate,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { attachmentDto, userLiteDto, type UserRow } from '../../lib/dto.js';

export type PostRow = typeof schema.posts.$inferSelect;
export type CommentRow = typeof schema.postComments.$inferSelect;

// The comment-preview window: fetched DESC per post, blocked authors filtered,
// then the newest POST_COMMENTS_PREVIEW_MAX serialized ASC. A window larger
// than the preview keeps has_more honest even when a few blocked comments sit
// at the tail.
const COMMENT_WINDOW = 20;

export function commentDto(row: CommentRow, author: UserRow): PostComment {
  return {
    id: row.id,
    post_id: row.postId,
    author: userLiteDto(author),
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
}

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
    SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, row_to_json(u.*) AS author
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
    created_at: string | Date;
    author: Record<string, unknown>;
  }[];
  const commentsByPost = new Map<string, { visible: PostComment[]; windowSize: number }>();
  for (const c of commentRows) {
    const g = commentsByPost.get(c.post_id) ?? { visible: [], windowSize: 0 };
    commentsByPost.set(c.post_id, g);
    g.windowSize += 1;
    if (blocked.has(c.author_id)) continue;
    g.visible.push({
      id: c.id,
      post_id: c.post_id,
      author: userLiteDto(rawUser(c.author)),
      body: c.body,
      created_at: new Date(c.created_at).toISOString(),
    });
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
    const preview = cg.visible.slice(0, POST_COMMENTS_PREVIEW_MAX).reverse(); // ASC
    const hasMore =
      cg.visible.length > POST_COMMENTS_PREVIEW_MAX || cg.windowSize >= COMMENT_WINDOW;
    return [
      {
        id: row.id,
        author: userLiteDto(author),
        body: row.body,
        attachments: orderedAtts.map(attachmentDto),
        reactions: chips,
        comments: preview,
        has_more_comments: hasMore,
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
  } as UserRow;
}

export async function loadPost(id: string): Promise<PostRow | null> {
  const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
  return row ?? null;
}
