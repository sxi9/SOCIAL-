import { UNFURL_RATE_PER_HOUR, type LinkPreview } from '@socialchat/shared';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { mediaUrl } from '../../lib/media.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { normalizeUrl, urlHash } from '../../lib/urls.js';
import { enqueueUnfurl } from '../../queues.js';
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

// ---------------------------------------------------------------------------
// THE unfurl budget chokepoint (ARCHITECTURE §6 / ROADMAP M7): every outbound
// unfurl fetch — previews POST, message-send URL extraction, share-import
// creation and claim — is enqueued through here and charged against the
// per-user 30/hour budget. Nothing else may call enqueueUnfurl.
// ---------------------------------------------------------------------------

export type UnfurlRequestOutcome =
  | { outcome: 'enqueued' }
  /** Nothing to fetch (cache hit / failed / another requester owns the in-flight fetch). */
  | { outcome: 'skipped' }
  | { outcome: 'rate_limited'; retryAfterS: number };

export async function requestUnfurl(opts: {
  userId: string;
  lookup: PreviewLookup;
  /** Set on the message-send path: the worker snapshots the card into this
   * message and hydrates recipients via msg.updated. */
  message?: { id: string; conversation_id: string };
}): Promise<UnfurlRequestOutcome> {
  const { userId, lookup, message } = opts;
  if (lookup.state !== 'miss' && lookup.state !== 'pending') return { outcome: 'skipped' };
  // An in-flight fetch owned by another requester already answers a plain
  // preview request (waiters get preview.ready) — only a message-bound
  // request must enqueue its own job, since the in-flight one carries no
  // message ref to hydrate.
  if (lookup.state === 'pending' && !message) return { outcome: 'skipped' };

  // Budget BEFORE markPending: a row marked pending with no job behind it
  // would be stuck pending forever. (The tiny race — budget consumed, then
  // the markPending insert lost to a concurrent requester — over-charges one
  // unit; harmless.)
  const rate = await fixedWindow(`unfurl:${userId}`, UNFURL_RATE_PER_HOUR, 3600);
  if (!rate.allowed) return { outcome: 'rate_limited', retryAfterS: rate.retryAfterS };

  let ownsFetch = true;
  if (lookup.state === 'miss') {
    ownsFetch = await markPending(lookup.hash, lookup.normalized);
  }
  if (!ownsFetch && !message) return { outcome: 'skipped' };

  await enqueueUnfurl({
    url: lookup.normalized,
    url_hash: lookup.hash,
    requested_by: userId,
    ...(message ? { message } : {}),
  });
  return { outcome: 'enqueued' };
}
