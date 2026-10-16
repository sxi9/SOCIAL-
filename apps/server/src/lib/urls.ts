import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src']);

/**
 * Normalize a URL for the unfurl cache (ARCHITECTURE §6): lowercase host,
 * strip fragment + known tracking params. Throws on unparseable input.
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  const toDelete: string[] = [];
  u.searchParams.forEach((_v, k) => {
    if (k.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(k.toLowerCase())) toDelete.push(k);
  });
  for (const k of toDelete) u.searchParams.delete(k);
  return u.toString();
}

export function urlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}

/** First http(s) URL in a message body, or null. */
export function extractFirstUrl(body: string): string | null {
  const match = body.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!match) return null;
  try {
    return new URL(match[0]).toString();
  } catch {
    return null;
  }
}
