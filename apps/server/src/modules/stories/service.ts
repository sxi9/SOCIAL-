// Stories (v0.5a — API.md §1.34, FEATURES #46, ADR-011). 24 h ephemera for the
// FRIENDS-OF audience, riding the §1.6 upload pipeline. story_views stores NO
// timestamp column at all (structural no-seen-at: the DB cannot leak what it
// does not store); view lists are author-only faces ordered by username.
// Expiry HARD-deletes (worker queue `timers`): story + view rows, the
// attachment row and its MinIO objects — refcount-guarded (§1.31: recap
// shares re-reference the same content-hashed objects).
import { asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Story, StoryOverlay, StoryOverlayPayload } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { attachmentDto, userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { blockedSetOf } from '../../lib/blocks.js';
import { friendsOfIds } from '../../lib/friends.js';
import { publishToUsers } from '../../ws/events.js';

export type StoryRow = typeof schema.stories.$inferSelect;
export type OverlayRow = typeof schema.storyOverlays.$inferSelect;

export function storyDto(
  row: StoryRow,
  author: UserRow,
  att: AttRow,
  viewed: boolean,
  overlays: StoryOverlay[] = [],
): Story {
  return {
    id: row.id,
    author: userLiteDto(author),
    attachment: attachmentDto(att),
    caption: row.caption,
    audience: 'friends_of',
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    viewed,
    // v0.8b (§1.66): the canvas invitation + the viewer's overlay slice.
    canvas_mode: row.canvasMode as Story['canvas_mode'],
    overlays,
  };
}

// ---------------------------------------------------------------------------
// v0.8b canvas overlays (API.md §1.66, FEATURES #79a, ADR-020). Attributed
// VECTOR layers, never burned into the image; 'removed' rows serialize to
// NOBODY (the tombstone exists for reports); 'pending' serializes only to
// its author and the story author; blocked pairs are invisible both ways.
// ---------------------------------------------------------------------------

export function overlayDto(row: OverlayRow, author: UserRow): StoryOverlay {
  return {
    id: row.id,
    story_id: row.storyId,
    author: userLiteDto(author),
    kind: row.kind as StoryOverlay['kind'],
    payload: row.payload as StoryOverlayPayload,
    status: row.status as StoryOverlay['status'],
    created_at: row.createdAt.toISOString(),
  };
}

/** live+pending overlay rows (with author users) for a story set, paint
 * order (created_at ASC). Removed tombstones never load here. */
export async function loadOverlayRowsFor(
  storyIds: string[],
): Promise<Map<string, { o: OverlayRow; u: UserRow }[]>> {
  const map = new Map<string, { o: OverlayRow; u: UserRow }[]>();
  if (storyIds.length === 0) return map;
  const rows = await db
    .select({ o: schema.storyOverlays, u: schema.users })
    .from(schema.storyOverlays)
    .innerJoin(schema.users, eq(schema.storyOverlays.authorId, schema.users.id))
    .where(
      sql`${inArray(schema.storyOverlays.storyId, storyIds)}
          AND ${schema.storyOverlays.status} IN ('live','pending')
          AND ${schema.users.bannedAt} IS NULL AND ${schema.users.deactivatedAt} IS NULL`,
    )
    .orderBy(asc(schema.storyOverlays.createdAt));
  for (const row of rows) {
    const list = map.get(row.o.storyId) ?? [];
    list.push(row);
    map.set(row.o.storyId, list);
  }
  return map;
}

/** The §1.66 per-viewer slice: live overlays (minus §1.14-blocked authors)
 * plus pending ones ONLY for their author and the story author. */
export function overlaysForViewer(
  rows: { o: OverlayRow; u: UserRow }[],
  viewerId: string,
  storyAuthorId: string,
  blockedIds: Set<string>,
): StoryOverlay[] {
  const out: StoryOverlay[] = [];
  for (const { o, u } of rows) {
    if (u.id !== viewerId && blockedIds.has(u.id)) continue;
    if (o.status === 'pending' && viewerId !== o.authorId && viewerId !== storyAuthorId) continue;
    out.push(overlayDto(o, u));
  }
  return out;
}

/**
 * story.updated (§2.3): full-story replace to the story's AUDIENCE sockets
 * (friends-of minus blocks + the author), viewer-stamped. A pending-only
 * change fans only to the overlay author + the story author. NO push, ever —
 * stories stay ambient (§1.34).
 */
export async function fanStoryUpdated(
  row: StoryRow,
  opts: { pendingOnlyAuthorId?: string } = {},
): Promise<void> {
  const [author] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, row.authorId))
    .limit(1);
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, row.attachmentId))
    .limit(1);
  if (!author || !att) return;

  const recipients = opts.pendingOnlyAuthorId
    ? [...new Set([opts.pendingOnlyAuthorId, row.authorId])]
    : [row.authorId, ...(await friendsOfIds(row.authorId))];
  const overlayRows = (await loadOverlayRowsFor([row.id])).get(row.id) ?? [];
  const viewedBy = await viewedSetOfStory(row.id);
  for (const viewerId of recipients) {
    // §1.9: the AUTHOR's own block set applies to their own canvas too.
    const blocked = await blockedSetOf(viewerId);
    const overlays = overlaysForViewer(overlayRows, viewerId, row.authorId, blocked);
    await publishToUsers([viewerId], {
      t: 'story.updated',
      d: {
        story: storyDto(
          row,
          author,
          att,
          viewerId === row.authorId ? true : viewedBy.has(viewerId),
          overlays,
        ),
      },
    });
  }
}

async function viewedSetOfStory(storyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ viewerId: schema.storyViews.viewerId })
    .from(schema.storyViews)
    .where(eq(schema.storyViews.storyId, storyId));
  return new Set(rows.map((r) => r.viewerId));
}

/** story.new — to the author's friends-of audience ONLY (minus blocks, which
 * friendsOfIds already applies), `viewed` stamped false per recipient. NO
 * push, ever (ambient, user-pulled — PSYCHOLOGY §6). */
export async function fanStoryNew(row: StoryRow, author: UserRow, att: AttRow): Promise<void> {
  const audience = [...(await friendsOfIds(author.id))];
  if (audience.length === 0) return;
  await publishToUsers(audience, {
    t: 'story.new',
    d: { story: storyDto(row, author, att, false) },
  });
}

/** Hard-delete one story: views AND overlays cascade with the row; the
 * attachment row goes too, its objects refcount-guarded. The story's §1.67
 * share token (author-minted) dies with it. Shared by DELETE /:id + sweep.
 * v1.0a (#94): the SWEEP passes saveToGallery — the author's media moves to
 * their private gallery (gallery_saves row keeps the attachment alive; the
 * GC anti-joins it) instead of being destroyed. An explicit author DELETE
 * stays a full delete: deleting a story is a choice to destroy it. */
export async function hardDeleteStory(row: StoryRow, saveToGallery = false): Promise<void> {
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, row.attachmentId))
    .limit(1);
  // §1.67: the page and every gated media URL die with the story (reads also
  // re-check expiry live, so this is belt + suspenders).
  await db.execute(sql`
    UPDATE share_tokens SET revoked_at = now()
    WHERE object_type = 'story' AND object_id = ${row.id} AND revoked_at IS NULL
  `);
  if (saveToGallery && att && att.status === 'ready') {
    await db.execute(sql`
      INSERT INTO gallery_saves (user_id, attachment_id, source)
      VALUES (${row.authorId}, ${att.id}, 'story')
      ON CONFLICT DO NOTHING
    `);
    await db.delete(schema.stories).where(eq(schema.stories.id, row.id)); // views + overlays cascade
    return; // the attachment lives on, owner-private (#94)
  }
  await db.delete(schema.stories).where(eq(schema.stories.id, row.id)); // views + overlays cascade
  if (att) {
    await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
    await deleteAttachmentObjects(att); // refcount-guarded (§1.31)
  }
}

/** Worker sweep (queue `timers`, every STORY_SWEEP_INTERVAL_S): expired
 * stories drop silently — no fan-out, no "story expired" event (§1.34). */
export async function runStorySweep(): Promise<void> {
  const expired = await db
    .select()
    .from(schema.stories)
    .where(lte(schema.stories.expiresAt, new Date()))
    .orderBy(asc(schema.stories.expiresAt))
    .limit(500);
  for (const row of expired) {
    await hardDeleteStory(row, true); // v1.0a #94: expiry saves to the gallery
  }
}

/** Batch (story → viewed-by-viewer) lookups for the tray read. */
export async function viewedSetOf(viewerId: string, storyIds: string[]): Promise<Set<string>> {
  if (storyIds.length === 0) return new Set();
  const rows = await db
    .select({ storyId: schema.storyViews.storyId })
    .from(schema.storyViews)
    .where(
      sql`${schema.storyViews.viewerId} = ${viewerId} AND ${inArray(schema.storyViews.storyId, storyIds)}`,
    );
  return new Set(rows.map((r) => r.storyId));
}
