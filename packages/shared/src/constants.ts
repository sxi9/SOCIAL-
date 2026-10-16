// Shared invariants — ONE place (ARCHITECTURE §1). Imported by web, api, worker.

// Keeps O(participants) fan-out and receipt math safe until Phase-2 channels.
export const MAX_GROUP_PARTICIPANTS = 256;

export const TYPING_TTL_S = 6;
export const PRESENCE_TTL_S = 60;
export const OFFLINE_GRACE_S = 15;
export const RECEIPT_COALESCE_MS = 1000;
export const PUSH_DEBOUNCE_S = 5;
export const WS_PING_S = 25;
export const WS_IDLE_CLOSE_S = 60;

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;

// ---- Media size limits (ARCHITECTURE §5), enforced while streaming ----
export const MAX_AVATAR_SOURCE_BYTES = 15 * 1024 * 1024;
// Only the first 10 s of an animated avatar source are used.
export const MAX_AVATAR_SOURCE_DURATION_S = 10;
export const AVATAR_SIZE_PX = 512;
// Animated WebP output budget; worker steps down once (q55, 384px) if exceeded.
export const AVATAR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const THUMB_SIZE_PX = 512;

// Per-kind allowlists checked against SNIFFED magic-byte MIME (client claim advisory).
export const IMAGE_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
] as const;
export const VIDEO_MIME_ALLOWLIST = ['video/mp4', 'video/webm'] as const;
export const AVATAR_SOURCE_MIME_ALLOWLIST = [
  'image/gif',
  'image/webp',
  'image/apng',
  'image/png',
  'image/jpeg',
  'video/mp4',
] as const;

// ---- M8 rate-limit sweep (per user; blueprint names the sweep, values are
// the boring choice) ----
export const UPLOAD_RATE_PER_HOUR = 60;
export const CONVERSATION_CREATE_RATE_PER_HOUR = 20;

// ---- Link unfurl limits (ARCHITECTURE §6) ----
export const UNFURL_RATE_PER_HOUR = 30;
export const UNFURL_MAX_REDIRECTS = 3;
export const UNFURL_BUDGET_MS = 5000;
export const UNFURL_MAX_HTML_BYTES = 1024 * 1024;
export const UNFURL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UNFURL_IMAGE_WIDTH_PX = 600;
export const PREVIEW_OK_TTL_S = 7 * 24 * 3600;
// Negative cache for failed unfurls — stops retry storms.
export const PREVIEW_FAILED_TTL_S = 3600;

// ---- Logged-out share stash (ARCHITECTURE §6) ----
export const SHARE_STASH_MAX_BYTES = 30 * 1024 * 1024;
export const SHARE_STASH_MAX_PER_IP = 3;
export const SHARE_STASH_TTL_S = 30 * 60;

// ---- GC windows (ARCHITECTURE §5) ----
export const ORPHAN_ATTACHMENT_TTL_H = 24;
export const SHARE_IMPORT_TTL_DAYS = 7;

// ---- Auth & input validation (API.md §1.1) ----
export const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;
export const PASSWORD_MIN_LENGTH = 8;

// ---- Invite links (v0.2 — API.md §1.11, ARCHITECTURE §9, ADR-007) ----
// Default lifetime of a minted invite (invites.expires_at = now() + 7 days).
export const INVITE_TTL_S = 7 * 24 * 3600;
// Default invites.max_uses per minted link.
export const INVITE_MAX_USES = 50;
// A user may hold at most this many simultaneously OPEN (status 'valid')
// invites; minting past the cap → 409 invite_limit (API.md §1.11).
export const INVITE_OPEN_MAX = 20;
// Token entropy: 32 random bytes base64url = 43 url-safe chars (same generator
// as session tokens; stored PLAINTEXT with a unique index — see ADR-007).
export const INVITE_TOKEN_BYTES = 32;
// Accepted token shape (base64url alphabet). Lax upper bound so the shape can
// evolve without breaking old clients; the DB unique index is the arbiter.
export const INVITE_TOKEN_REGEX = /^[A-Za-z0-9_-]{32,128}$/;
// Mint rate, per user (M8 sweep style).
export const INVITE_CREATE_RATE_PER_HOUR = 30;
// UNAUTHENTICATED endpoints, per IP (Redis fixed-window, like login/register).
export const INVITE_PUBLIC_RATE_PER_HOUR_PER_IP = 60;
export const INVITE_AVATAR_RATE_PER_HOUR_PER_IP = 120;
// Cache-Control: private, max-age for GET /api/invites/:token/avatar — short
// because the underlying avatar can change version while the token is live.
export const INVITE_AVATAR_CACHE_TTL_S = 300;

// ---- Reactions (v0.2 — API.md §1.12 + §2.3, ADR-007 companion feature) ----
// Zod enforces UTF-16 units (client-binding); the DB CHECK enforces the same
// bound in codepoints — Zod is the stricter of the two for astral emoji.
export const REACTION_EMOJI_MAX_LEN = 16;
// Distinct emoji one user may hold on one message; the 9th distinct POST → 409.
export const REACTIONS_PER_USER_PER_MESSAGE_MAX = 8;

// ---- Protocol caps (API.md) ----
export const PRESENCE_SUB_MAX = 100;
export const USER_SEARCH_LIMIT = 20;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_BODY_CHARS = 8192;

// ============================ v0.3 additions =================================

// ---- Beacons (v0.3 — API.md §1.15, ARCHITECTURE §10, ADR-008) ----
// The fixed vibe chip set (beacons.vibe CHECK). Adding a chip is a one-line
// migration + this tuple; free text goes in the note.
export const BEACON_VIBES = [
  'food',
  'chai',
  'walk',
  'game',
  'movie',
  'study',
  'sport',
  'chill',
] as const;
export const BEACON_NOTE_MAX_CHARS = 140;
// Joiners (creator excluded) needed to spark. Default 2 → groups of 3+,
// matching the 3-5 sweet spot (PSYCHOLOGY §3).
export const BEACON_SPARK_THRESHOLD_MIN = 2;
export const BEACON_SPARK_THRESHOLD_MAX = 10;
export const BEACON_SPARK_THRESHOLD_DEFAULT = 2;
// starts_at may be at most this far in the past (clock-skew slack).
export const BEACON_STARTS_AT_SLACK_S = 300;
// expires_at bounds: at least 30 min joinable, at most a week out ("weekend").
export const BEACON_MIN_WINDOW_S = 30 * 60;
export const BEACON_MAX_HORIZON_S = 7 * 24 * 3600;
// Simultaneously OPEN beacons per creator; the 4th → 409 beacon_limit.
export const BEACON_OPEN_MAX = 3;
export const BEACON_CREATE_RATE_PER_HOUR = 10;
// Avatar pile size in the Beacon DTO (joiner_count carries the rest).
export const BEACON_JOINERS_PREVIEW_MAX = 12;
// Named micro-roles per plan (PSYCHOLOGY §4); the 13th → 409 role_limit.
export const BEACON_ROLES_MAX = 12;
export const BEACON_ROLE_LABEL_MAX_CHARS = 40;
// Afterglow recap: posted this long after a SPARKED beacon's expires_at.
export const BEACON_AFTERGLOW_DELAY_S = 2 * 3600;
export const BEACON_AFTERGLOW_PHOTOS_MAX = 6;
// Kudos accepted from spark until expires_at + this window.
export const BEACON_KUDOS_WINDOW_S = 7 * 24 * 3600;
// Rotating playful openers for the spark system message; picked by
// hash(beacon id) % length so reruns rotate.
export const BEACON_ICEBREAKERS = [
  'It is officially a plan. No take-backs.',
  'The council has assembled. First order of business: where?',
  'Boredom: defeated. Logistics: pending.',
  'Everyone said yes. This is legally binding now.',
  'Great news — you are all equally bored. Make it count.',
  'Plan sparked. Someone bring the good energy.',
] as const;
export const BEACON_VENUE_POLL_QUESTION = 'Where are we doing this?';
export const BEACON_VENUE_POLL_OPTIONS = [
  'The usual spot',
  'Somewhere new',
  'Creator picks',
  'Surprise me',
] as const;

// ---- Rituals (v0.3 — API.md §1.15, ADR-008) ----
// Weekly only for now (beacons.ritual_rrule CHECK pins this exact value).
export const RITUAL_RRULE_WEEKLY = 'FREQ=WEEKLY';
export const RITUAL_INTERVAL_S = 7 * 24 * 3600;
// Consecutive unsparked runs before the chain silently stops re-creating
// (auto-pause, ZERO guilt copy — PSYCHOLOGY never-build list).
export const RITUAL_AUTO_PAUSE_SKIPS = 2;

// ---- Kudos (v0.3 — API.md §1.15) ----
export const KUDOS_KINDS = ['glad_you_came', 'glad_you_posted'] as const;

// ---- Polls (v0.3 — API.md §1.17) ----
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 6;
export const POLL_QUESTION_MAX_CHARS = 200;
export const POLL_OPTION_MAX_CHARS = 80;

// ---- Privacy & area (v0.3 — API.md §1.13, ADR-009) ----
// Self-declared coarse profile area (users.area, citext). Private: it is in
// UserPrivate only, NEVER in UserPublic/UserLite (FEATURES #30).
export const AREA_MAX_CHARS = 64;

// ---- Reports (v0.3 — API.md §1.14) ----
export const REPORT_REASON_MAX_CHARS = 500;
export const REPORT_RATE_PER_HOUR = 10;
