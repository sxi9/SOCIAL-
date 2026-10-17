// Stories (v0.5a — API.md §1.34, FEATURES #46, ADR-011). 24 h ephemera for the
// FRIENDS-OF audience, riding the §1.6 upload pipeline. story_views stores NO
// timestamp column at all (structural no-seen-at: the DB cannot leak what it
// does not store); view lists are author-only faces ordered by username.
// Expiry HARD-deletes (worker queue `timers`): story + view rows, the
// attachment row and its MinIO objects — refcount-guarded (§1.31: recap
// shares re-reference the same content-hashed objects).
import { asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Story } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { attachmentDto, userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { friendsOfIds } from '../../lib/friends.js';
import { publishToUsers } from '../../ws/events.js';

export type StoryRow = typeof schema.stories.$inferSelect;

export function storyDto(row: StoryRow, author: UserRow, att: AttRow, viewed: boolean): Story {
  return {
    id: row.id,
    author: userLiteDto(author),
    attachment: attachmentDto(att),
    caption: row.caption,
    audience: 'friends_of',
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    viewed,
  };
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

/** Hard-delete one story: views cascade with the row; the attachment row goes
 * too, its objects refcount-guarded. Shared by DELETE /:id and the sweep. */
export async function hardDeleteStory(row: StoryRow): Promise<void> {
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, row.attachmentId))
    .limit(1);
  await db.delete(schema.stories).where(eq(schema.stories.id, row.id)); // views cascade
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
    await hardDeleteStory(row);
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
