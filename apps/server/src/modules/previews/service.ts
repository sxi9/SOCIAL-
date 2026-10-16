import type { LinkPreview } from '@socialchat/shared';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { mediaUrl } from '../../lib/media.js';
import { normalizeUrl, urlHash } from '../../lib/urls.js';
import { redis } from '../../redis.js';

export type LinkPreviewRow = typeof schema.linkPreviews.$inferSelect;

export function previewDto(row: LinkPreviewRow): LinkPreview {
  return {
    url: row.url,
    site_name: row.siteName,
    title: row.title,
    description: row.description,
    // Always OUR origin — og:image is re-encoded into MinIO, never hotlinked.
    image_url: row.imageKey ? mediaUrl(row.imageKey) : null,
  };
}

// Every requester who was answered 'pending' is recorded here so the worker's
// preview.ready reaches all of them (API.md §1.7/§2.3), not only the first
// requester (whose id rides the job itself).
const WAITERS_TTL_S = 600;
const waitersKey = (hash: string) => `preview_waiters:${hash}`;

export async function addPreviewWaiter(hash: string, userId: string): Promise<void> {
  await redis.sadd(waitersKey(hash), userId);
  await redis.expire(waitersKey(hash), WAITERS_TTL_S);
}

export async function takePreviewWaiters(hash: string): Promise<string[]> {
  const key = waitersKey(hash);
  const members = await redis.smembers(key);
  if (members.length > 0) await redis.del(key);
  return members;
}

export interface PreviewLookup {
  normalized: string;
  hash: string;
  row: LinkPreviewRow | null;
  /** Effective state with expiry applied: expired ok/failed rows read as 'miss'. */
  state: 'ok' | 'failed' | 'pending' | 'miss';
}

export async function lookupPreview(rawUrl: string): Promise<PreviewLookup> {
  const normalized = normalizeUrl(rawUrl);
  const hash = urlHash(normalized);
  const [row] = await db
    .select()
    .from(schema.linkPreviews)
    .where(eq(schema.linkPreviews.urlHash, hash))
    .limit(1);
  if (!row) return { normalized, hash, row: null, state: 'miss' };
  if (row.status === 'pending') return { normalized, hash, row, state: 'pending' };
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  if (expired) return { normalized, hash, row, state: 'miss' };
  return { normalized, hash, row, state: row.status === 'ok' ? 'ok' : 'failed' };
}

/**
 * Insert a pending cache row (or reset an expired one to pending). Returns
 * true when the caller should enqueue an unfurl job.
 */
export async function markPending(hash: string, normalized: string): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(schema.linkPreviews)
    .where(eq(schema.linkPreviews.urlHash, hash))
    .limit(1);
  if (!existing) {
    try {
      await db.insert(schema.linkPreviews).values({ urlHash: hash, url: normalized, status: 'pending' });
      return true;
    } catch {
      return false; // insert race: someone else owns the fetch
    }
  }
  if (existing.status === 'pending') return false;
  const expired = existing.expiresAt !== null && existing.expiresAt.getTime() <= Date.now();
  if (!expired) return false;
  await db
    .update(schema.linkPreviews)
    .set({ status: 'pending', url: normalized })
    .where(eq(schema.linkPreviews.urlHash, hash));
  return true;
}
