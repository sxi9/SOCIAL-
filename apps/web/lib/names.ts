// Animated names (v0.8a — API.md §1.58, FEATURES #75). 'surprise' resolves
// CLIENT-side and DETERMINISTICALLY — NAME_STYLE_SURPRISE_POOL[hash(user_id +
// UTC date) % pool] — so it rotates daily and every viewer sees the same
// style with zero server state. The hash is FNV-1a: stable across sessions,
// devices and clients (no Math.random, no locale).
import { NAME_STYLE_SURPRISE_POOL, type NameStyle } from '@socialchat/shared';

export type ResolvedNameStyle = Exclude<NameStyle, 'surprise'>;

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Today's UTC date, YYYY-MM-DD — the daily rotation key (§1.58). */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function resolveNameStyle(style: NameStyle, userId: string): ResolvedNameStyle {
  if (style !== 'surprise') return style;
  return NAME_STYLE_SURPRISE_POOL[fnv1a(userId + utcDate()) % NAME_STYLE_SURPRISE_POOL.length];
}
