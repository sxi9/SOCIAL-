// The logged-out profile hero (AUDIT-PLAN §1b phase 6, 2026-10-28; API.md
// §1.13 profile_visibility, §1.67 profile pages). ONE builder feeds both
// unauthenticated surfaces — GET /api/users/:username/public (the /u/ route
// SSR) and the owner-minted `profile` share token — so they can never
// disagree about what a stranger sees. Decision 11: show the thing, hide
// the people, gate the action — avatar, name, one bio line, interests and
// the joined month when profile_visibility is 'public'; avatar + name only
// otherwise. NEVER last-seen, mood, area, counts or faces.
import { PROFILE_HERO_BIO_CHARS, type ProfileHero } from '@socialchat/shared';
import type { UserRow } from './dto.js';
import { nameStyleOf } from './dto.js';

/** Unauthenticated STATIC avatar path — the §1.67 proxy pattern keyed on the
 * username (the thing a stranger already holds), never a MinIO key. */
export function publicAvatarPath(username: string): string {
  return `/api/users/${encodeURIComponent(username)}/public-avatar?v=static`;
}

/** First line of the bio, trimmed to PROFILE_HERO_BIO_CHARS code points. */
export function bioLine(bio: string | null | undefined): string | null {
  const first = (bio ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!first) return null;
  const cps = Array.from(first);
  if (cps.length <= PROFILE_HERO_BIO_CHARS) return first;
  return `${cps.slice(0, PROFILE_HERO_BIO_CHARS).join('').trimEnd()}…`;
}

export function profileHeroFor(u: UserRow): ProfileHero {
  const full = u.profileVisibility === 'public';
  const joined = u.createdAt;
  return {
    username: u.username,
    display_name: u.displayName,
    name_style: nameStyleOf(u),
    avatar_url: u.avatarStatus === 'ready' && u.avatarStaticKey ? publicAvatarPath(u.username) : null,
    visibility: full ? 'full' : 'minimal',
    bio_line: full ? bioLine(u.bio) : null,
    interests: full ? u.interests : [],
    joined: full ? `${joined.getUTCFullYear()}-${String(joined.getUTCMonth() + 1).padStart(2, '0')}` : null,
    // The doors follow dm_policy (Wave 1.7): a stranger's message to a
    // 'connections' account parks in Requests, so Message still opens; a
    // parked DM can't be rung, so Call needs 'everyone'. 'nobody' = no doors.
    doors: {
      message: u.dmPolicy !== 'nobody',
      call: u.dmPolicy === 'everyone',
    },
  };
}
