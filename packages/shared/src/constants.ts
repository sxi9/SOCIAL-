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

// ---- Protocol caps (API.md) ----
export const PRESENCE_SUB_MAX = 100;
export const USER_SEARCH_LIMIT = 20;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_MESSAGE_BODY_CHARS = 8192;
