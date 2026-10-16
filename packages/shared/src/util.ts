/**
 * Split a list into consecutive chunks of at most `size` items. Used by the
 * web client to keep presence.sub/presence.unsub frames within
 * PRESENCE_SUB_MAX ids per frame (API.md §2.4) — an oversized frame fails
 * server-side validation, costs a protocol strike and drops the whole
 * subscription.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
