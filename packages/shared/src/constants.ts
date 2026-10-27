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

// ============================ v0.4 additions =================================
// Expression pack (FEATURES #31–#38; API.md §1.19–§1.27; ADR-010). Everything
// below is SELF-HOSTED: no third-party GIF/sticker APIs — the only media is
// user-generated (avatars, uploads, doodles).

// ---- Avatar stamps (v0.4 — API.md §1.19) ----
// A stamp is a reaction row (message_reactions.kind = 'stamp') whose "emoji"
// column holds this sentinel, so the existing PK (conversation_id, seq,
// user_id, emoji) enforces the one-stamp-per-user-per-message cap for free.
export const REACTION_KINDS = ['emoji', 'stamp'] as const;
export const STAMP_REACTION_KEY = ':stamp:';
// PK-enforced, documented for clients (the second stamp POST is idempotent 204).
export const STAMPS_PER_USER_PER_MESSAGE_MAX = 1;
// The 8-distinct cap (REACTIONS_PER_USER_PER_MESSAGE_MAX) counts kind='emoji'
// rows ONLY — a stamp never eats an emoji slot.

// ---- Voice notes (v0.4 — API.md §1.20) ----
// Sniffed-MIME allowlist for kind 'audio' (ogg/opus, webm/opus, m4a/aac, mp3).
export const AUDIO_MIME_ALLOWLIST = [
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
] as const;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
// Worker-probed (ffprobe); longer sources flip the attachment to 'failed'.
export const MAX_AUDIO_DURATION_S = 300;
// Fixed-size waveform peaks array stored on the attachment and inlined in the
// DTO: duration is split into this many equal segments; each bucket is the
// segment's peak loudness normalized to 0..AUDIO_WAVEFORM_PEAK_MAX (integers).
export const AUDIO_WAVEFORM_BUCKETS = 48;
export const AUDIO_WAVEFORM_PEAK_MAX = 100;

// ---- Doodles (v0.4 — API.md §1.21) ----
// A doodle is an ordinary PNG image upload + metadata.doodle = true on the
// message (render-with-sketchy-frame flag; zero new server machinery). Client
// canvas export guidance only — the normal image pipeline enforces real limits.
export const DOODLE_CANVAS_MAX_PX = 1024;

// ---- Message effects (v0.4 — API.md §1.22) ----
// metadata.effect on a send. CONSENT RULE (binding): the client may AUTO-
// SUGGEST an effect when a trigger phrase is typed, but the user must confirm —
// an effect is NEVER auto-attached or auto-fired (PSYCHOLOGY: the user
// initiates; no app-pushed surprises). Plays ONCE per viewer per message
// (client-tracked) with a full prefers-reduced-motion fallback (static badge).
export const MESSAGE_EFFECTS = ['confetti', 'hearts', 'fireworks', 'snow'] as const;
// Case-insensitive substring triggers for the composer's suggest chip.
export const EFFECT_TRIGGERS = [
  { phrase: 'congrats', effect: 'confetti' },
  { phrase: 'congratulations', effect: 'confetti' },
  { phrase: 'happy birthday', effect: 'confetti' },
  { phrase: 'love you', effect: 'hearts' },
  { phrase: 'happy new year', effect: 'fireworks' },
  { phrase: "it's snowing", effect: 'snow' },
  { phrase: 'its snowing', effect: 'snow' },
] as const satisfies ReadonlyArray<{
  phrase: string;
  effect: (typeof MESSAGE_EFFECTS)[number];
}>;

// ---- Vibe checks (v0.4 — API.md §1.23) ----
// Rotating prompt deck (client picks, or writes a custom prompt ≤ the same
// cap). The prompt IS the message body of a type='vibe_check' message.
export const VIBE_CHECK_PROMPT_MAX_CHARS = 120;
export const VIBE_CHECK_PROMPTS = [
  'post the last photo in your camera roll',
  'doodle your current mood',
  'show us your view right now',
  'your lock screen. no cheating',
  'draw the weekend in one doodle',
  "today's outfit check",
  'what are you eating rn',
  'show your desk as it actually looks',
  'doodle your spirit animal',
  'last thing that made you laugh',
  'your sky right now',
  'draw this group as animals',
  'show the shoes you are wearing',
  'your most chaotic recent photo',
  'doodle your dream vacation',
  'what is in your hand right now',
  'the oldest photo you still love',
  'draw your week as weather',
  'show us your water bottle / mug',
  'your current tab situation (screenshot it)',
  'doodle a self-portrait in 30 seconds',
  'the last thing you cooked',
  'show something yellow near you',
  'draw where you wish you were',
] as const;
// Reply refs inlined on the vibe message DTO (reply_count carries the rest).
export const VIBE_REPLIES_PREVIEW_MAX = 12;

// ---- Chat themes / wallpapers / nicknames (v0.4 — API.md §1.24) ----
// Themes and wallpapers are PERSONAL (my view only, synced across my devices)
// — never fanned out to other participants. Fixed sets, text + CHECK as usual;
// wallpapers are CSS patterns, NO uploads in v0.4.
export const CHAT_THEMES = [
  'classic',
  'sunset',
  'ocean',
  'forest',
  'grape',
  'bubblegum',
  'mono',
  'midnight',
] as const;
export const CHAT_WALLPAPERS = [
  'dots',
  'grid',
  'waves',
  'stars',
  'scribbles',
  'blobs',
] as const;
// Per-(owner, conversation, target) nickname — also personal to the owner.
export const NICKNAME_MAX_CHARS = 32;

// ---- Disappearing messages (v0.4 — API.md §1.25) ----
// conversations.disappear_ttl_s is NULL (off) or one of these (CHECK-pinned):
// 1 hour, 24 hours, 7 days, 30 days.
export const DISAPPEAR_TTL_OPTIONS_S = [3600, 86400, 604800, 2592000] as const;
// Worker sweep cadence (queue `timers`, repeatable).
export const DISAPPEAR_SWEEP_INTERVAL_S = 60;

// ---- Scheduled messages & time capsules (v0.4 — API.md §1.26) ----
export const SCHEDULED_PENDING_MAX_PER_USER = 50;
export const SCHEDULED_MIN_LEAD_S = 60;
// Far enough out for birthday time capsules; one leap-year of horizon.
export const SCHEDULED_MAX_HORIZON_S = 366 * 24 * 3600;
export const SCHEDULED_CREATE_RATE_PER_HOUR = 30;

// ---- Mini-games: tic-tac-toe (v0.4 — API.md §1.27) ----
export const TTT_BOARD_CELLS = 9;

// ---- Daily word puzzle (v0.4 — API.md §1.27) ----
// The day's word = PUZZLE_WORDLIST[ sha256(`${yyyy-mm-dd}:${PUZZLE_SECRET}`)
// mod length ] — deterministic per UTC date, unpredictable to clients because
// the secret is server-side (env PUZZLE_SECRET). The wordlist itself is public
// (bundled here); guesses are scored SERVER-side only.
export const PUZZLE_WORD_LENGTH = 5;
export const PUZZLE_MAX_GUESSES = 6;
export const PUZZLE_GUESS_REGEX = /^[a-z]{5}$/;
// Score strings are 5 chars of g (green) / y (yellow) / x (grey); clients map
// to emoji for the shareable no-spoiler grid.
export const PUZZLE_SCORE_REGEX = /^[gyx]{5}$/;
export const PUZZLE_SCORE_EMOJI = { g: '🟩', y: '🟨', x: '⬜' } as const;
// Curated common 5-letter words. Appending is contract-safe (selection is
// modulo length, so APPEND ONLY — reordering or removal would reshuffle every
// future day's word).
export const PUZZLE_WORDLIST = [
  'about', 'apple', 'beach', 'brave', 'bread', 'brick', 'charm', 'chess',
  'cloud', 'crane', 'dance', 'dream', 'drift', 'earth', 'feast', 'flame',
  'fruit', 'ghost', 'giant', 'glide', 'grape', 'green', 'happy', 'heart',
  'house', 'juice', 'laugh', 'lemon', 'light', 'lucky', 'lunar', 'maple',
  'mango', 'money', 'month', 'moose', 'mount', 'music', 'night', 'noble',
  'ocean', 'olive', 'onion', 'paint', 'party', 'peach', 'pearl', 'piano',
  'pizza', 'plant', 'plaza', 'pride', 'queen', 'quiet', 'radio', 'raven',
  'river', 'robot', 'salsa', 'scarf', 'shine', 'smile', 'snack', 'spark',
  'spice', 'spoon', 'storm', 'story', 'sugar', 'sunny', 'sweet', 'table',
  'tiger', 'toast', 'torch', 'train', 'truck', 'tulip', 'uncle', 'vivid',
  'wagon', 'water', 'whale', 'wheat', 'world', 'youth', 'zebra', 'zesty',
] as const;
// NO leaderboard, NO rankings, NO streak counters, ever: sharing a grid into a
// chat is a named, consensual act; a ranked table and a streak are on the
// PSYCHOLOGY never-build list. GET /api/puzzle/today/friends lists DM partners
// who POSTED a result (opt-in by sharing), ordered by username — never by score.

// ============================ v0.5a additions =================================
// Social layer (FEATURES #46–#48; API.md §1.28–§1.37; ADR-011). Connections,
// threads/replies, edit/delete, forwarding, pins, @mentions, stories, channels,
// the finite feed, and rich profiles. PSYCHOLOGY.md stays binding: finite feeds
// with a hard caught-up end, named faces never numeric scores, no seen-at
// timestamps, mentions may override mute but NEVER blocks.

// ---- Connections (v0.5a — API.md §1.28) ----
// FRIENDS-OF (the v0.5a audience primitive) = accepted connections UNION
// dm-partners. The beacons 'friends' audience and the beacon_default_audience
// setting keep their STORED enum value 'friends' but resolve to friends-of
// from v0.5a on (semantic upgrade, API.md §1.28). show_last_seen /
// group_add_policy 'dm_partners' are untouched — they name DM partners
// literally and still mean exactly that.
export const CONNECTION_REQUEST_RATE_PER_HOUR = 30;

// ---- Threads / replies (v0.5a — API.md §1.29) ----
// Server-resolved reply context snippet: first chars of the referenced
// message's body (grapheme-safe truncation client-side is cosmetic only).
export const REPLY_EXCERPT_MAX_CHARS = 80;

// ---- Edit & delete (v0.5a — API.md §1.30) ----
// PATCH window measured from created_at; outside it → 409 edit_window_closed.
export const EDIT_WINDOW_S = 86400;
// Kinds whose body the author may edit. Tombstones, 'system', 'poll',
// 'vibe_check' (replies already answered the original prompt), 'game_ttt' and
// 'puzzle_result' (server-owned state) are never editable.
export const EDITABLE_MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'audio'] as const;

// ---- Forwarding (v0.5a — API.md §1.31) ----
export const FORWARD_MAX_TARGETS = 5;
// Forwardable kinds — interactive/server-owned kinds stay where they happened.
export const FORWARDABLE_MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'audio'] as const;

// ---- Pins (v0.5a — API.md §1.32) ----
// Per conversation; the 11th pin → 409 pin_limit.
export const MAX_PINS = 10;

// ---- Mentions (v0.5a — API.md §1.33) ----
// Server-parsed @username tokens against ACTIVE PARTICIPANTS at send time;
// tokens past the cap stay plain text (never an error). A mention overrides
// muted_until for push, but NEVER a block (API.md §1.14 is structural).
export const MENTIONS_PER_MESSAGE_MAX = 20;

// ---- Stories (v0.5a — API.md §1.34) ----
export const STORY_CAPTION_MAX_CHARS = 140;
// expires_at = created_at + 24 h, fixed (no custom story TTLs).
export const STORY_TTL_S = 24 * 3600;
export const STORY_CREATE_RATE_PER_HOUR = 20;
// Worker expiry sweep cadence (queue `timers`, repeatable): expired stories
// are hard-deleted (rows + attachments; MinIO objects refcount-guarded).
export const STORY_SWEEP_INTERVAL_S = 60;

// ---- Channels (v0.5a — API.md §1.35) ----
// Participant cap for type='channel' conversations. Watermark receipts are the
// entire reason this is safe: receipts/unread stay one cursor row per member,
// O(participants) not O(messages × participants) (ARCHITECTURE §1 + ADR-002).
// Groups keep MAX_GROUP_PARTICIPANTS=256 — min-watermark tick math and
// participant-list serialization stay bounded there.
export const CHANNEL_MAX = 10000;

// ---- Feed (v0.5a — API.md §1.36) ----
export const POST_BODY_MAX_CHARS = 2000;
export const POST_MAX_ATTACHMENTS = 4;
export const POST_CREATE_RATE_PER_HOUR = 10;
export const POST_COMMENT_MAX_CHARS = 500;
// Distinct emoji one user may hold on one post; the 9th distinct POST → 409.
export const REACTIONS_PER_USER_PER_POST_MAX = 8;
// Reaction chips carry named FACES: the first N reactors as UserLite +
// has_more — NEVER a numeric total anywhere (PSYCHOLOGY design rule 3).
export const POST_REACTORS_PREVIEW_MAX = 12;
// Latest comments inlined on the Post DTO (ASC); has_more_comments carries the
// rest — no comment COUNT is ever serialized.
export const POST_COMMENTS_PREVIEW_MAX = 3;

// ---- Rich profiles (v0.5a — API.md §1.37) ----
export const INTERESTS_MAX = 10;
export const INTEREST_TAG_MAX_CHARS = 24;
export const PROFILE_ENTRIES_MAX = 12;
export const PROFILE_ENTRY_TITLE_MAX_CHARS = 80;
export const PROFILE_ENTRY_DETAIL_MAX_CHARS = 160;
// The 3-GIF strip: profile_media rows, order_idx 0..2.
export const PROFILE_MEDIA_MAX = 3;

// ============================ v0.5b additions =================================
// Local board + admin (FEATURES #39–#45, #54; API.md §1.38–§1.41; ADR-012 /
// ADR-013). One listing system, four card kinds, all area-tagged; marketplace
// trust via gated person reviews; the operator admin surface. HARD PRODUCT
// RULES: no payment processing of any kind — every price field is DISPLAY
// TEXT, money settles outside the app; the board is PULL-BASED (no WS events,
// no push — PSYCHOLOGY design rules 2 and 4); admin routes never expose
// private message content.

// ---- Listings (v0.5b — API.md §1.38, ADR-012) ----
// The four card kinds (listings.kind CHECK). Beacons join the board tab
// client-side (FEATURES #43) — they stay their own table and API.
export const LISTING_KINDS = ['gig', 'ride', 'room', 'place_review'] as const;
export const LISTING_TITLE_MAX_CHARS = 80;
export const LISTING_BODY_MAX_CHARS = 2000;
// DISPLAY TEXT ONLY ("₹2000 / month", "free", "split petrol") — never parsed,
// never summed, never charged. There is no payment machinery anywhere.
export const LISTING_PRICE_TEXT_MAX_CHARS = 40;
// Simultaneously ACTIVE listings per author; the 11th → 409 listing_limit.
export const LISTING_ACTIVE_MAX_PER_USER = 10;
export const LISTING_CREATE_RATE_PER_HOUR = 10;
// gig/room: expires_at = created_at + 30 d. ride: expires_at = departs_at.
// place_review: never expires (expires_at NULL).
export const LISTING_TTL_S = 30 * 24 * 3600;
// Worker sweep cadence (queue `timers`) — bookkeeping only: board reads also
// filter `expires_at > now()` live, so sweep precision never shows a stale card.
export const LISTING_SWEEP_INTERVAL_S = 3600;
// Per-kind details (jsonb, Zod-validated — the house metadata pattern):
export const LISTING_GIG_DIRECTIONS = ['offering', 'seeking'] as const;
export const LISTING_GIG_TAGS_MAX = 5;
export const LISTING_GIG_TAG_MAX_CHARS = 24; // the INTEREST_TAG_MAX_CHARS bound
export const LISTING_RIDE_LEG_MAX_CHARS = 80; // from_text / to_text
export const LISTING_RIDE_SEATS_MIN = 1;
export const LISTING_RIDE_SEATS_MAX = 8;
// v1.0a (#91): every listing kind takes photos now, not just rooms.
export const LISTING_PHOTOS_MAX = 6;
/** @deprecated alias — use LISTING_PHOTOS_MAX. */
export const LISTING_ROOM_PHOTOS_MAX = LISTING_PHOTOS_MAX;
export const LISTING_PLACE_NAME_MAX_CHARS = 80;
export const LISTING_RATING_MIN = 1;
export const LISTING_RATING_MAX = 5;
// `q` filter: ILIKE substring over title + details->>'place_name'.
export const LISTING_SEARCH_MAX_CHARS = 80;
// The bulletin-board terms, rendered VERBATIM on gig/ride/room detail views
// (LISTING_SAFETY_NOTE_KINDS) — FEATURES #45. Not dismissible copy to bury in
// a settings page: it rides the card where the money talk happens.
export const LISTING_SAFETY_NOTE =
  'Bored Chat is a bulletin board: it does not vet listings, hold money, or process payments. Meet in public, bring a friend for first meetings, and verify before you pay — money settles outside the app, at your own judgement.';
export const LISTING_SAFETY_NOTE_KINDS = ['gig', 'ride', 'room'] as const;

// ---- Message-the-author & gig team-up (v0.5b — API.md §1.39) ----
export const LISTING_CONTACT_RATE_PER_HOUR = 20;
// Team-up picks (people who contacted the gig); + the author = a group of ≤ 8,
// the same human-scale bound as ride seats (PSYCHOLOGY §3 favors small crews).
export const TEAM_UP_MAX_PICKS = 7;

// ---- Person reviews / marketplace trust (v0.5b — API.md §1.40, ADR-012) ----
// Star averages here are SAFETY INFORMATION about transacting with a stranger
// — not social approval. The distinction vs PSYCHOLOGY design rule 3 (no
// scores on people) is argued in ADR-012; the guardrails are structural:
// reviews only after a real listing contact, one per (listing, reviewer),
// avg hidden under TRUST_AVG_MIN_REVIEWS, and NOTHING ever ranks or sorts
// people by rating.
export const PERSON_REVIEW_BODY_MAX_CHARS = 500;
export const PERSON_REVIEW_RATE_PER_HOUR = 10;
// avg_rating serializes null below this count (a 1-review "2.0" is noise that
// reads like a verdict); the count + recent list still show.
export const TRUST_AVG_MIN_REVIEWS = 3;
// avg_rating is rounded to this many decimals server-side.
export const TRUST_AVG_DECIMALS = 1;
// Recent reviews inlined on the profile trust panel.
export const TRUST_RECENT_REVIEWS_MAX = 5;

// ---- Admin (v0.5b — API.md §1.41, ADR-013, FEATURES #54) ----
// Promotion is CLI-ONLY: node dist/cli.js grant-admin <username> /
// revoke-admin <username>. There is no web path to adminhood — shell access to
// the box is the root of trust (ADR-013).
// IP retention: a nightly GC job (queue `gc`) nulls users.registration_ip and
// sessions.ip older than this window. Documented in the instance privacy note.
export const IP_RETENTION_DAYS = 90;
// Server log ring: pino warn+error entries + EVERY admin action, LPUSHed to a
// capped Redis list (LPUSH + LTRIM) — operational telemetry, not product data.
export const LOG_RING_MAX = 1000;
export const ADMIN_LOG_LEVELS = ['warn', 'error', 'admin'] as const;
// GET /api/admin/users serializes last_seen as a COARSE bucket, not a
// timestamp — the operator needs liveness, not a surveillance feed.
export const LAST_SEEN_BUCKETS = ['today', 'this_week', 'this_month', 'older', 'never'] as const;
// Metrics time series length (registrations/day, DAU proxy, messages/day).
export const ADMIN_METRICS_WINDOW_DAYS = 30;
// Optional note on suspend/ban/unsuspend/unban/report-close; ring-logged.
export const ADMIN_NOTE_MAX_CHARS = 500;

// ============================ v0.6 additions =================================
// Calls + discovery (FEATURES #49–#53; API.md §1.42–§1.46 + §2.12; ADR-014 /
// ADR-015; PSYCHOLOGY finding #10). HARD RULES carried here: signaling is
// EPHEMERAL (rides the existing WS gateway, relayed per recipient, never
// persisted — only the calls row is durable, via REST); group calls are MESH
// WebRTC capped at CALL_MESH_MAX (the LiveKit SFU seam is documented in
// ADR-014, not built); a single wave notifies NOBODY (no rejection surface);
// roulette DMs that are not kept are HARD-DELETED.

// ---- Calls (v0.6 — API.md §1.42 + §2.12, ADR-014) ----
export const CALL_KINDS = ['audio', 'video'] as const;
export const CALL_STATUSES = [
  'ringing',
  'ongoing',
  'completed',
  'missed',
  'rejected',
  'failed',
] as const;
// Mesh fan-out cap: n-1 peer connections per participant. 8 is the ceiling a
// mid-range phone encodes video for; past it the answer is an SFU (ADR-014
// documents the LiveKit upgrade seam), never a bigger mesh.
export const CALL_MESH_MAX = 8;
// A 'ringing' call with no join flips to 'missed' after this (worker delayed
// job, queue `timers`): missed-call system message + push (§2.9 guards).
export const CALL_RING_TIMEOUT_S = 45;
// Zod bounds on relayed signaling payloads (the gateway refuses bigger frames
// before relaying — SDP offers with many candidates stay well under this).
export const CALL_SDP_MAX_CHARS = 64 * 1024;
export const CALL_ICE_CANDIDATE_MAX_CHARS = 2048;

// ---- TURN credentials (v0.6 — API.md §1.42, ADR-014) ----
// coturn static-auth-secret (TURN REST API memo) format: username is
// "<unix expiry>:<user_id>", credential is base64(HMAC-SHA1(TURN_SECRET,
// username)) — minted by the api, verified by coturn, no shared DB.
export const TURN_CRED_TTL_S = 3600;
// Relay port range coturn publishes (the ONE exception to only-caddy-
// publishes — UDP media cannot ride an HTTP proxy; ADR-014). Keep in sync
// with docker-compose.yml and the firewall.
export const TURN_PORT = 3478;
export const TURN_RELAY_PORT_MIN = 49160;
export const TURN_RELAY_PORT_MAX = 49200;

// ---- Watch together (v0.6 — API.md §1.43 + §2.12) ----
// Ephemeral ONLY: one active session per conversation in Redis
// (`watch:{conversation_id}`), no table. The key's TTL is refreshed by every
// host sync; the host client sends a keepalive sync at least every
// WATCH_KEEPALIVE_S even while paused, so a vanished host ends the session
// within the TTL and late joiners catch state from the next relayed sync.
export const WATCH_SESSION_TTL_S = 60;
export const WATCH_KEEPALIVE_S = 15;
// Gateway drops host sync frames arriving faster than this (flood guard).
export const WATCH_SYNC_MIN_INTERVAL_MS = 250;
// YouTube video ids are exactly 11 chars of this alphabet. The id is parsed
// SERVER-side from the URL the host pastes (shared parser in urls.ts — one
// canonical implementation, like extractFirstUrl).
export const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

// ---- Bored Together: discovery opt-ins (v0.6 — API.md §1.44, ADR-015) ----
export const DISCOVERY_SCOPES = ['area', 'public'] as const;
// An opt-in lives exactly this long (expires_at = now() + 60 min); re-opting
// extends. Being discoverable is a MOMENT, not a setting (ADR-015).
export const DISCOVERY_OPTIN_TTL_S = 3600;
export const DISCOVERY_NOTE_MAX_CHARS = 80;
// Cards returned per read (newest opt-in first; no cursor — the pool is
// whoever is bored RIGHT NOW, not a backlog to page through).
export const DISCOVERY_CARDS_MAX = 50;
export const DISCOVERY_WAVE_RATE_PER_HOUR = 30;
// Rotating icebreaker for match DMs (discovery AND roulette), picked by
// hash(conversation id) % length — the BEACON_ICEBREAKERS pattern.
export const DISCOVERY_ICEBREAKERS = [
  'You were both bored at the same time. That is basically fate.',
  'Two strangers, one shared enemy: boredom. Go.',
  'This chat exists because you both said "why not". Keep that energy.',
  'Rule one: no small talk about the weather. Rule two: there are no other rules.',
  'You waved, they waved. The hard part is over.',
  'Boredom brought you here. Curiosity keeps it going.',
] as const;

// ---- Expectation feedback & encouragement (v0.6 — API.md §1.45, ADR-015,
// PSYCHOLOGY finding #10) ----
// PRIVATE one-tap after a discovery/roulette DM ends or persists. Never shown
// to the other person, never on a profile — only the anonymous instance-wide
// aggregate ("N% said better than expected"), and that only PRE-opt-in to
// hesitant users.
export const EXPECTATION_CONTEXTS = ['roulette', 'discovery'] as const;
export const EXPECTATION_VERDICTS = ['better', 'same', 'worse'] as const;
// The aggregate serializes null below this sample size (a 2-sample "100%"
// is noise that reads like a promise).
export const ENCOURAGEMENT_MIN_SAMPLES = 10;

// ---- Bored Roulette (v0.6 — API.md §1.45, ADR-015) ----
// Queue entries live in Redis (`roulette:queue`); joining requires an ACTIVE
// discovery opt-in. An entry lapses after this long un-paired (re-join is one
// tap; a stale queue must never match someone who wandered off).
export const ROULETTE_QUEUE_TTL_S = 300;
// Worker pairing cadence (queue `discovery`, repeatable).
export const ROULETTE_PAIR_INTERVAL_S = 10;
// The provisional DM window: conversations.expires_at = matched_at + 5 min.
// Both parties POST keep within it → permanent; else the sweep HARD-DELETES
// the conversation and its messages (no archive of awkward dead ends).
export const ROULETTE_WINDOW_S = 300;
export const ROULETTE_SWEEP_INTERVAL_S = 30;

// ---- Rescue me (v0.6 — API.md §1.46) ----
export const RESCUE_MAX_TARGETS = 3;
export const RESCUE_NOTE_MAX_CHARS = 80;
// Per user per UTC day (Redis fixed window). A rescue is an SOS, not a
// broadcast channel — the cap keeps it meaning something.
export const RESCUE_MAX_PER_DAY = 3;
// Default message body when the rescuer sends no note (also the push copy —
// "<display_name> needs a rescue call 📞").
export const RESCUE_DEFAULT_BODY = 'needs a rescue call 📞';

// ============================ v0.7 additions =================================
// Interactivity pack (FEATURES #60–#71; API.md §1.47–§1.54; ADR-016).
// PSYCHOLOGY.md stays binding everywhere here: the discover lane is FINITE
// with a hard all_caught_up end and NO ranking; poll-option counts are a VOTE
// TALLY on choices, never approval attached to a person (the distinction is
// argued in ADR-016); comment reactions render as capped FACES lists, never
// totals; joiner notifications go to people who COMMITTED to a plan — never
// to anyone who cannot join (design rule 2); locations are user-initiated
// snapshots, never live tracking; no third-party map tiles or API keys.

// ---- Beacon editing & custom vibes (v0.7 — API.md §1.47) ----
// The full beacons.vibe VALUE set = the BEACON_VIBES preset chips + 'custom'
// (which requires custom_vibe_emoji + custom_vibe_label on the row). Keep in
// sync with BEACON_VIBES above and the beacons_vibe_check DB CHECK.
export const BEACON_VIBE_VALUES = [
  'food',
  'chai',
  'walk',
  'game',
  'movie',
  'study',
  'sport',
  'chill',
  'custom',
] as const;
export const BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS = 24; // one word-ish, the tag bound
// Zod counts UTF-16 units, like REACTION_EMOJI_MAX_LEN (astral emoji fit).
export const BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN = 16;
// Client-side recents for the custom-vibe picker (localStorage, per device —
// never synced, never serialized; FEATURES #61 "recents remembered").
export const BEACON_CUSTOM_VIBE_RECENTS_MAX = 6;
// PATCH /api/beacons/:id budget (fixed window, per user).
export const BEACON_EDIT_RATE_PER_HOUR = 30;
// The editable field set — the `changed` array on the edited beacon.updated
// frame only ever names these (API.md §1.47).
export const BEACON_EDITABLE_FIELDS = [
  'vibe',
  'custom_vibe_emoji',
  'custom_vibe_label',
  'note',
  'starts_at',
  'expires_at',
  'spark_threshold',
  'location',
] as const;
// Starting-soon worker ping: joiners (+ the creator of a sparked plan) get one
// push when starts_at is this close. Claimed once per beacon via the guarded
// UPDATE on starting_soon_pinged_at (the repinged_at pattern). §2.9 guards
// apply — a user with the app open has the countdown card already.
export const BEACON_STARTING_SOON_LEAD_S = 30 * 60;

// ---- Listing editing (v0.7 — API.md §1.48) ----
// PATCH /api/listings/:id budget (fixed window, per user) — the beacon-edit
// bound re-applied to the board.
export const LISTING_EDIT_RATE_PER_HOUR = 30;

// ---- Feed lanes & public posts (v0.7 — API.md §1.49) ----
export const FEED_LANES = ['friends', 'discover'] as const;
export const POST_AUDIENCES = ['friends_of', 'public'] as const;

// ---- Interactive posts (v0.7 — API.md §1.50, ADR-016) ----
export const POST_KINDS = ['text', 'poll', 'game', 'join_card'] as const;
// Post polls are snappier than chat polls (POLL_QUESTION_MAX_CHARS=200):
// a feed card is a glance, not a thread. Options reuse the §1.17 bounds
// (POLL_OPTIONS_MIN/MAX, POLL_OPTION_MAX_CHARS).
export const POST_POLL_QUESTION_MAX_CHARS = 120;
// What a join_card may point at (posts.ref jsonb {type, id}).
export const POST_REF_TYPES = ['beacon', 'listing'] as const;
// Joiner faces inlined on a join_card's live beacon summary (the pile
// preview; the full pile lives on GET /api/beacons/:id).
export const JOIN_CARD_SUMMARY_JOINERS_MAX = 4;

// ---- Comment upgrades (v0.7 — API.md §1.51) ----
// Distinct emoji one user may hold on one comment; the 9th distinct → 409.
// Stamps ride the ':stamp:' sentinel (STAMP_REACTION_KEY) with kind='stamp'
// and never eat an emoji slot — the §1.19 machinery, re-applied.
export const REACTIONS_PER_USER_PER_COMMENT_MAX = 8;
// Reactor FACES inlined per (emoji, kind) chip on a comment; has_more carries
// the rest. NEVER a numeric total (PSYCHOLOGY design rule 3).
export const COMMENT_REACTORS_PREVIEW_MAX = 6;
// Audit P0 (PSYCHOLOGY rule 3): message emoji chips ship FACES too — the
// first N reactors by first-reaction order; has_more carries the rest. There
// is deliberately no count on the wire (the PostReactionAggregate rule).
export const MESSAGE_REACTORS_PREVIEW_MAX = 6;

// ---- Locations (v0.7 — API.md §1.52) ----
// {label ≤ 80, lat?, lng?} — lat/lng are OPTIONAL, both-or-neither, and only
// ever a user-initiated one-tap SNAPSHOT (no live GPS, no tracking, nothing
// ambient — the FEATURES #30 line holds). Rendering is a LINK (geo:/OSM/
// Google URL built client-side) — no tile embeds, no map API keys ever
// (self-hosted ethos, CLAUDE.md golden rule 7).
export const LOCATION_LABEL_MAX_CHARS = 80;
export const LOCATION_LAT_MIN = -90;
export const LOCATION_LAT_MAX = 90;
export const LOCATION_LNG_MIN = -180;
export const LOCATION_LNG_MAX = 180;
// The on-my-way quick action is an ORDINARY text reply (reply_to_seq = the
// location message's seq) with this exact body — zero new server machinery;
// the location bubble derives its headcount faces from these replies.
export const ON_MY_WAY_BODY = 'On my way 🏃';

// ---- Invite OG banner (v0.7 — API.md §1.53) ----
// GET /api/invites/:token/og-banner.png — sharp-composed server-side (brand
// gradient + inviter avatar circle or the mascot-blob fallback + SVG text
// overlay; display_name is XML-ESCAPED before it enters the SVG). Valid-
// token-gated and rate-limited exactly like the §1.11 avatar proxy; cache
// keyed on the inviter's avatar_version.
export const OG_BANNER_WIDTH_PX = 1200;
export const OG_BANNER_HEIGHT_PX = 630;
export const OG_BANNER_AVATAR_PX = 320;
export const INVITE_OG_RATE_PER_HOUR_PER_IP = 120; // the avatar-proxy budget

// ---- Scheduled-send feedback (v0.7 — API.md §1.54, web-only) ----
// Toast lifetime for the "Scheduled for <time>" confirmation. The pending
// count on the composer clock badge is the user's OWN utility state (their
// queued sends) — not a social counter; PSYCHOLOGY rule 3 is untouched.
export const SCHEDULED_TOAST_MS = 4000;

// ---- Flipping wordmark (v0.7 — API.md §1.54, web-only) ----
// The auth headline "[Bored] Chat" cycles these on a fixed-width slot with a
// vertical roll; pauses while the tab is hidden; settles on 'Bored';
// prefers-reduced-motion renders static 'Bored'. The mascot reacts per word.
// v1.1 Royal login: the four MOODS — word, tagline, mascot face and
// background layer all flip together on one clock (design drop 2026-10-17).
export const WORDMARK_WORDS = ['Bored', 'Happy', 'Sad', 'Drunk'] as const;
export const WORDMARK_FLIP_INTERVAL_MS = 2600;

// =========================== v0.7.1 additions ================================
// Call reliability (FEATURES #87–#90b; API.md §1.55–§1.56 + §2.9 + §2.12;
// ADR-017). HARD RULES carried here: the ring push is RETRACTABLE (a silent
// `call.ring.stop` push closes it by tag the instant the call is handled
// anywhere) and runs the §2.9 guards unchanged — muted_until suppresses it,
// blocks are structural, and it only ever announces a call the recipient can
// actually join (PSYCHOLOGY rule 2); connection-state frames and ICE restarts
// are EPHEMERAL signaling on the existing gateway (never persisted); the
// self-test and TURN-honesty surfaces tell the truth about this instance's
// relay instead of letting calls fail silently.

// ---- Incoming-call ring push (v0.7.1 — API.md §2.9, FEATURES #88) ----
// Push payload discriminator. Legacy payloads (message snippet, missed call)
// carry NO kind field; v0.7.1 kinds are explicit so the service worker can
// route without guessing.
export const PUSH_KIND_CALL_RING = 'call.ring' as const;
export const PUSH_KIND_CALL_RING_STOP = 'call.ring.stop' as const;
// Notification tag = CALL_RING_PUSH_TAG_PREFIX + call_id. Tag-scoped per
// CALL (not conversation) so the ring never collapses into message pushes
// and the stop push can close exactly the ring it targets.
export const CALL_RING_PUSH_TAG_PREFIX = 'call:';
// notification action ids (service-worker action routing, §2.9).
export const PUSH_ACTION_ANSWER = 'answer' as const;
export const PUSH_ACTION_DECLINE = 'decline' as const;
// Web-push TTL header on the ring push: a ring that cannot be delivered
// within the ring window must NEVER be delivered late (a stale "incoming
// call" hours after the fact is a lie). The stop push uses the same TTL.
export const CALL_RING_PUSH_TTL_S = CALL_RING_TIMEOUT_S;

// ---- Connection-state reporting + ICE restart (v0.7.1 — API.md §2.12) ----
// The per-peer RTC connection states a client reports via the relayed
// `call.state` frame and renders in the call UI. These are UI-truth states
// derived from RTCPeerConnection.iceConnectionState — not the raw enum.
export const CALL_CONN_STATES = ['connecting', 'connected', 'reconnecting', 'failed'] as const;
// 'disconnected' must persist this long before the impolite peer (lower user
// id, the §2.12 perfect-negotiation rule) triggers restartIce() — transient
// blips self-heal and must not thrash renegotiation.
export const CALL_ICE_DISCONNECT_GRACE_MS = 3000;
// Automatic ICE restarts per peer pair before giving up; backoff between
// attempts. After the last attempt the pair is 'failed' and the UI says WHY
// (verdict copy keyed on the §1.55 self-test knowledge, never "call failed").
export const CALL_ICE_RESTART_MAX_ATTEMPTS = 3;
export const CALL_ICE_RESTART_BACKOFF_MS = [2000, 4000, 8000] as const;

// ---- Call self-test + TURN honesty (v0.7.1 — API.md §1.55, FEATURES #89/#90) ----
// GET /api/call-selftest mints SHORT-lived probe credentials (same coturn
// static-auth-secret format; username "<unix expiry>:selftest:<user_id>" so
// relay logs distinguish probes from calls). Participant-free but authed +
// rate-limited: the relay still cannot be farmed anonymously.
export const CALL_SELFTEST_CRED_TTL_S = 300;
export const CALL_SELFTEST_RATE_PER_HOUR = 30;
// Client-side ICE gather budget per probe pass (relay-only pass + default
// pass). A gather that produces no relay candidate within this window is the
// "relay unreachable" verdict.
export const CALL_SELFTEST_GATHER_TIMEOUT_MS = 8000;

// ---- Shared toasts (v0.7.1 — API.md §1.56, FEATURES #90a, web-only) ----
// ONE shared component (components/Toast.tsx), rendered through Portal,
// bottom-anchored above the tab bar, auto-dismiss, reduced-motion safe
// (fade only, no slide). Per-call duration override allowed (the v0.7
// SCHEDULED_TOAST_MS=4000 scheduled-send toast now rides this component).
export const TOAST_DEFAULT_MS = 3500;
// Oldest toast drops when a new one would exceed this (never a stack of
// nags; confirmations are glanceable, not a log). v0.9: SINGLE-slot — the
// newest confirmation replaces the previous one; a two-high stack covered
// sheet content (the shown-once recovery codes) at phone widths.
export const TOAST_MAX_VISIBLE = 1;

// ---- Notifications-on assurance (v0.7.1 — API.md §1.56, FEATURES #90b) ----
// localStorage key for the one-time post-login push explainer. DEVICE-local
// by design: push permission is a per-browser fact, so the prompt state
// lives beside it — never synced, never re-nagged after a decline.
export const PUSH_EXPLAINER_SEEN_KEY = 'bc.push-explainer-seen';

// ============================ v0.8a additions =================================
// Identity & moods slice of v0.8 (FEATURES #72–#76, #79, #80; API.md
// §1.57–§1.61; ADR-018). HARD RULES carried here: moods NEVER appear in any
// activity/history surface and leave NO trace after expiry (PSYCHOLOGY: no
// seen-at archaeology, no guilt); a mood change never generates push — the
// drunk banner is a passive in-chat surface, never a blast; activity items
// never leak past the underlying object's audience (viewer must be able to
// see the thing itself); every motion effect in this release (mood bubbles,
// animated names, GIF/video backgrounds, the tour) dies completely under
// prefers-reduced-motion; no public numeric counters anywhere, as always.

// ---- Moods (v0.8a — API.md §1.57, FEATURES #72, ADR-018) ----
export const MOOD_KINDS = ['preset', 'custom', 'swing', 'drunk'] as const;
// Who may see my mood chip. Resolved SERVER-side at serialization (§1.13
// machinery): 'connections' = my ACCEPTED connections (§1.28 — literally
// connections, NOT friends-of; a DM alone does not qualify); blocks hide the
// mood both directions regardless. 'nobody' leaves it owner-only.
export const MOOD_VISIBILITIES = ['everyone', 'connections', 'nobody'] as const;
// The preset chips. label is the stable key (mood-reactive effects and the
// swing picker key on it); emoji is the default glyph. Appending is
// contract-safe; renaming/removing is not (stored rows reference labels).
export const MOOD_PRESETS = [
  { emoji: '😴', label: 'bored' },
  { emoji: '🎉', label: 'hyped' },
  { emoji: '💤', label: 'lazy' },
  { emoji: '🌧️', label: 'sad' },
  { emoji: '😊', label: 'happy' },
  { emoji: '☕', label: 'cozy' },
  { emoji: '😾', label: 'grumpy' },
  { emoji: '🍜', label: 'hungry' },
] as const;
// Custom mood bounds. Zod counts UTF-16 units for the emoji, like
// REACTION_EMOJI_MAX_LEN (astral emoji fit); the label is one word-ish.
export const MOOD_EMOJI_MAX_LEN = 16;
export const MOOD_LABEL_MAX_CHARS = 24;
// Every mood auto-expires: users.mood_expires_at = now() + MOOD_TTL_S on
// every set ("always-current, never stale"). Reads filter
// mood_expires_at > now() LIVE (the discovery-optin pattern), so sweep
// precision never shows a stale chip; the sweep only clears columns + fans
// the user.updated goodbye.
export const MOOD_TTL_S = 4 * 3600;
export const MOOD_SWEEP_INTERVAL_S = 60;
export const MOOD_SET_RATE_PER_HOUR = 30;
// 🎢 Swing mode: the chip cycles through a chosen set. The worker rotates
// each swinging user every MOOD_SWING_INTERVAL_S ± uniform jitter (random,
// per rotation) and fans out user.updated; clients morph-animate the chip.
export const MOOD_SWING_SET_MIN = 2;
export const MOOD_SWING_SET_MAX = 6;
export const MOOD_SWING_INTERVAL_S = 30 * 60;
export const MOOD_SWING_JITTER_S = 10 * 60;

// ---- 🍻 Drunk mode (v0.8a — API.md §1.57, FEATURES #73, ADR-018) ----
// A mood kind with guardrails. The chip itself is pinned:
export const MOOD_DRUNK_EMOJI = '🍻';
export const MOOD_DRUNK_LABEL = 'drunk';
// Drunk visibility DEFAULTS to 'connections' even when the user's other
// moods were public — overridable per set, but the default is the guardrail.
export const MOOD_DRUNK_DEFAULT_VISIBILITY = 'connections' as const;
// Send-undo: while drunk mode is active, every send gets an undo window.
// DELETE …/messages/:seq?undo=1 within this window of created_at (plus the
// skew slack, server-side) VANISHES the message: tombstone row (seq survives,
// golden rule 2) with metadata {"undone": true} — clients render NOTHING, not
// a "message deleted" stub. Works on every own message type, editable or not.
export const MOOD_DRUNK_UNDO_WINDOW_S = 10;
export const MOOD_DRUNK_UNDO_SLACK_S = 2;
// v1.0a (#96): the drunk-mode undo generalized — EVERY send gets a short
// transparent undo pill. Drunk keeps its longer window; the slack constant is
// shared. Same ?undo=1 path, same vanish semantics ({"undone": true}).
export const UNDO_SEND_WINDOW_S = 5;
// Cold-contact confirm (CLIENT-side): before sending into a DM whose
// conversation.last_message_at is older than this (or into a brand-new DM),
// and before any public post/listing/beacon, the composer asks "you sure?".
// The >1-month fact needs no new endpoint — Conversation.last_message_at IS
// the DTO flag (§1.57 spells the rule out).
export const COLD_CONTACT_THRESHOLD_S = 30 * 24 * 3600;
// "Check on them 💙" preset DM body (the banner's caring one-tap; the other
// button starts an ordinary §1.42 call). A PASSIVE banner — never a push.
export const DRUNK_CHECK_IN_BODY = 'hey, checking in 💙 all good tonight?';

// ---- Mood-reactive messages (v0.8a — API.md §1.58, FEATURES #74, web-only) ----
// Pure CLIENT rendering driven by the sender's mood already visible in the
// DTOs — the server ships no effect field and stores no trace. label → bubble
// effect, for kinds preset/swing/drunk ONLY (custom labels never trigger an
// effect, even if they collide with these keys).
export const MOOD_BUBBLE_EFFECTS = ['wobble', 'rain', 'bounce'] as const;
export const MOOD_MESSAGE_EFFECTS = {
  drunk: 'wobble', // tipsy wobble-in, settle slightly crooked, straighten on tap
  sad: 'rain', // soft rain overlay in the chat scroll + text falls into place
  hyped: 'bounce', // bounce-in
} as const satisfies Record<string, (typeof MOOD_BUBBLE_EFFECTS)[number]>;
// Max crooked settle for the drunk wobble (legibility always wins).
export const MOOD_WOBBLE_MAX_DEG = 2;

// ---- Animated names (v0.8a — API.md §1.58, FEATURES #75) ----
// users.name_style, CHECK-pinned. Pure CSS text effects on profile, chat
// headers and group sender names; reduced-motion viewers get a static tint;
// 'surprise' rotates daily and DETERMINISTICALLY on the client —
// NAME_STYLE_SURPRISE_POOL[hash(user_id + UTC date) % 3] — so every viewer
// agrees without server state.
export const NAME_STYLES = ['none', 'glow', 'shimmer', 'rainbow', 'surprise'] as const;
export const NAME_STYLE_SURPRISE_POOL = ['glow', 'shimmer', 'rainbow'] as const;

// ---- Activity strip + privacy (v0.8a — API.md §1.59, FEATURES #76) ----
// activities rows, written by the OWNING module's transaction through the one
// helper (lib/activity.ts recordActivity). Moods are NEVER recorded here —
// no mood kind exists, by contract.
export const ACTIVITY_KINDS = [
  'beacon_lit',
  'beacon_sparked',
  'post_created',
  'listing_posted',
  'puzzle_played',
  'game_won',
] as const;
// Per-kind privacy settings are grouped (the Settings → Privacy → Activity
// toggles): kind → which users.activity_* column governs it.
export const ACTIVITY_SETTING_GROUPS = ['beacons', 'posts', 'listings', 'games'] as const;
export const ACTIVITY_KIND_GROUP = {
  beacon_lit: 'beacons',
  beacon_sparked: 'beacons',
  post_created: 'posts',
  listing_posted: 'listings',
  puzzle_played: 'games',
  game_won: 'games',
} as const satisfies Record<
  (typeof ACTIVITY_KINDS)[number],
  (typeof ACTIVITY_SETTING_GROUPS)[number]
>;
// 'private' = owner only. Default 'connections' — the calm default: activity
// is for people you know, not a public broadcast, until the owner says so.
export const ACTIVITY_VISIBILITIES = ['public', 'connections', 'private'] as const;
export const ACTIVITY_DEFAULT_VISIBILITY = 'connections' as const;
// Strip length served per profile read (viewer-resolved; invisible items are
// silently dropped, never placeholders — no "3 hidden items" counters).
export const ACTIVITY_STRIP_MAX = 20;
// Retention: the nightly gc sweep hard-deletes rows older than this. The
// strip is "recent activity", not an archive.
export const ACTIVITY_RETENTION_DAYS = 30;

// ---- GIF/video chat backgrounds (v0.8a — API.md §1.60, FEATURES #79) ----
// PERSONAL, like every §1.24 pref: my view only, prefs.updated to my own
// sockets only, nobody else ever learns my background exists. OWN uploads
// only (uploader_id = me, ownership-checked at PATCH), through the existing
// §1.6 pipeline — kind image (incl. GIF, ≤ MAX_IMAGE_BYTES) or video with
// the tighter caps below.
export const CHAT_BG_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
export const CHAT_BG_VIDEO_MAX_DURATION_S = 30;
// Render contract (§1.60): scrim over the media so bubbles stay legible.
export const CHAT_BG_OVERLAY_OPACITY = 0.45;

// ---- Discoverability (v0.8a — API.md §1.61, FEATURES #80, client-heavy) ----
// First-run spotlight tour: shown ONCE after first login on a device,
// skippable at every step, never repeats (TOUR_SEEN_KEY is localStorage,
// device-local like PUSH_EXPLAINER_SEEN_KEY — the tour is a per-device
// orientation, not synced state). Reduced-motion: no spotlight animation,
// plain dismissible cards.
export const TOUR_SEEN_KEY = 'bc.tour-seen';
export const TOUR_STEPS = [
  {
    id: 'chats',
    title: 'Chats',
    body: 'Message friends, make groups, send voice notes, doodles and polls.',
    anchor: 'tab-chats',
  },
  {
    id: 'plans',
    title: 'Bored? Light a beacon',
    body: 'Tell your people you are free — when enough join, it becomes a real plan.',
    anchor: 'tab-plans',
  },
  {
    id: 'local',
    title: 'Local board',
    body: 'Gigs, rides, rooms and place reviews from people around you.',
    anchor: 'tab-local',
  },
  {
    id: 'you',
    title: 'Make it yours',
    body: 'Feed, stories, moods, themes and your profile live here.',
    anchor: 'tab-profile',
  },
] as const;
// "✨ Things you can do" — the typed feature directory (searchable client-
// side; Try-it = deep link). STATIC registry in the contract so web and any
// future client render the same directory; `since` is the release that
// shipped it (drives the "new" badge against the §1.61 release markers).
export const FEATURE_DIRECTORY = [
  { id: 'beacons', title: 'Beacons', one_liner: 'Tell friends you are bored; spark a real plan.', href: '/plans', since: 'v0.3' },
  { id: 'rituals', title: 'Rituals', one_liner: 'Turn a good hangout into a weekly thing.', href: '/plans', since: 'v0.3' },
  { id: 'polls', title: 'Polls', one_liner: 'Settle where/when/what in any chat.', href: '/', since: 'v0.3' },
  { id: 'voice_notes', title: 'Voice notes', one_liner: 'Hold to talk, with waveforms.', href: '/', since: 'v0.4' },
  { id: 'doodles', title: 'Doodles', one_liner: 'Draw something instead of typing it.', href: '/', since: 'v0.4' },
  { id: 'vibe_checks', title: 'Vibe checks', one_liner: 'One prompt, everyone answers with a photo.', href: '/', since: 'v0.4' },
  { id: 'themes', title: 'Chat themes', one_liner: 'Restyle any chat — only you see it.', href: '/', since: 'v0.4' },
  { id: 'disappearing', title: 'Disappearing messages', one_liner: 'Chats that clean up after themselves.', href: '/', since: 'v0.4' },
  { id: 'scheduled', title: 'Scheduled sends & time capsules', one_liner: 'Write now, deliver later.', href: '/', since: 'v0.4' },
  { id: 'games', title: 'Tic-tac-toe & daily puzzle', one_liner: 'Tiny games inside your chats.', href: '/puzzle', since: 'v0.4' },
  { id: 'connections', title: 'Connections', one_liner: 'Your people, requests and suggestions.', href: '/connections', since: 'v0.5' },
  { id: 'stories', title: 'Stories', one_liner: '24-hour moments for your people.', href: '/feed', since: 'v0.5' },
  { id: 'feed', title: 'Feed', one_liner: 'Posts from your people, with a real end.', href: '/feed', since: 'v0.5' },
  { id: 'local_board', title: 'Local board', one_liner: 'Gigs, rides, rooms, place reviews nearby.', href: '/local', since: 'v0.5' },
  { id: 'calls', title: 'Calls', one_liner: 'Audio and video, up to 8 people.', href: '/', since: 'v0.6' },
  { id: 'watch_together', title: 'Watch together', one_liner: 'Synced videos in any chat.', href: '/', since: 'v0.6' },
  { id: 'discovery', title: 'Bored Together', one_liner: 'Find people who are bored right now.', href: '/local', since: 'v0.6' },
  { id: 'people', title: 'Find people', one_liner: 'People you may know, with filters.', href: '/people', since: 'v1.0' },
  { id: 'gallery', title: 'My gallery', one_liner: 'Your media + auto-saved stories, private.', href: '/gallery', since: 'v1.0' },
  { id: 'rescue', title: 'Rescue me', one_liner: 'One tap asks a friend to call you out of anywhere.', href: '/', since: 'v0.6' },
  { id: 'locations', title: 'Location drops', one_liner: '"Join me here" pins with map links.', href: '/', since: 'v0.7' },
  { id: 'moods', title: 'Moods', one_liner: 'Set a chip that says how you are — it fades on its own.', href: '/settings', since: 'v0.8' },
  { id: 'animated_names', title: 'Animated names', one_liner: 'Glow, shimmer or rainbow your display name.', href: '/settings', since: 'v0.8' },
  { id: 'chat_backgrounds', title: 'Chat backgrounds', one_liner: 'Your own GIF or clip behind any chat — only you see it.', href: '/', since: 'v0.8' },
  { id: 'activity_strip', title: 'Profile activity', one_liner: 'Your recent plans, posts and wins — you choose who sees each kind.', href: '/settings', since: 'v0.8' },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  one_liner: string;
  href: string;
  since: string;
}>;
// Release markers for "new since your last visit": the list of shipped
// releases lives in instance_settings key 'release_notes' (seeded/appended by
// migrations — the instance knows what IT runs, not what the repo HEAD says);
// the per-user cursor is users.last_seen_release. Register stamps the newest
// version so day-one users never get a card storm.
export const RELEASE_VERSION_MAX_CHARS = 20;
export const RELEASE_NOTE_ITEM_MAX_CHARS = 200;
export const RELEASE_NOTE_ITEMS_MAX = 12;

// ============================ v0.8b additions =================================
// Community pack — the rest of v0.8 (FEATURES #77, #78/#78a/#78b, #79a, #79c,
// #79d, #81; API.md §1.62–§1.69; ADR-019 / ADR-020). HARD RULES carried here:
// the anonymous game hides the sender from the RECIPIENT only, never from the
// server — reports and ghost-group reports always attach real identity; blocks
// and opt-outs are enforced invisibly (byte-identical refusals); a single wave
// stays invisible — the nudge names nobody and fires only when the pool is big
// enough to keep it that way; canvas overlays are attributed vector layers,
// never burned into the image, and being drawable is always the author's
// invitation (default OFF); share pages exist for PUBLIC things only,
// friends-only content never gets a URL, and all share media rides token-gated
// endpoints (the §1.11 invite-avatar pattern — no open media routes); public
// groups expose only post-switch messages, ghost groups are unlisted
// everywhere; admin still never reads private messages — the report-context
// viewer exists only where the REPORTER consented at report time.

// ---- Anonymous reveal game (v0.8b — API.md §1.62, FEATURES #77, ADR-019) ----
// Recipient opt-in: who may open an anonymous thread to me. Resolved at send
// like every §1.13 setting; 'connections' = accepted §1.28 connections
// (literally connections, NOT friends-of — the §1.57 mood rule).
export const ANON_OPTIN_VALUES = ['nobody', 'connections', 'everyone'] as const;
export const ANON_OPTIN_DEFAULT = 'connections' as const;

// ---- Share-everything plumbing (migration 0014 — AUDIT-PLAN §1b, decision 11) ----
// Who may open a DM / start a call with me (Wave 1.7). 'connections' =
// accepted §1.28 connections literally. Stored now; ENFORCED at DM/call
// creation in the profile-share phase (404-shaped like blocks, a stranger's
// message lands in Requests). Match/roulette DMs are exempt by design.
export const DM_POLICIES = ['everyone', 'connections', 'nobody'] as const;
export const DM_POLICY_DEFAULT = 'connections' as const;
// How much of my profile a logged-out share link may show: 'public' = the
// full teaser (avatar, name, one bio line, interests, joined-month — never
// counts); 'connections' | 'private' reduce it to avatar + name. Same value
// set as the activity_* toggles.
export const PROFILE_VISIBILITIES = ['public', 'connections', 'private'] as const;
export const PROFILE_VISIBILITY_DEFAULT = 'public' as const;
// A share token's preview mode (decision 11): public objects are always
// fully viewable (no switch); a NON-public object shared by token shows a
// TEASER unless the sharer chose Full at mint time. Stored on the token; the
// server decides what to render.
export const SHARE_PREVIEWS = ['teaser', 'full'] as const;
export const SHARE_PREVIEW_DEFAULT = 'full' as const;
// Text only at first — no attachments, no media, by design (ADR-019).
export const ANON_BODY_MAX_CHARS = 500;
export const ANON_RIDDLE_MAX_CHARS = 200;
// Timer reveal presets (1 h / 6 h / 24 h) — reveal_at = now() + preset; the
// client derives the progressive un-blur factor as
// clamp((reveal_at - now) / reveal_timer_s, 0, 1); the SERVER renders the
// blurred avatar (the gated §1.62 proxy) so the real image never ships early.
export const ANON_TIMER_PRESETS_S = [3600, 21600, 86400] as const;
// Gaussian blur sigma (px at the 512 avatar size) at factor 1; sigma scales
// linearly down to 0 at full reveal.
export const ANON_BLUR_SIGMA_MAX = 24;
// Cache-Control: private, max-age for the blurred-avatar proxy — SHORT: the
// blur factor is time-derived and must keep moving.
export const ANON_AVATAR_CACHE_TTL_S = 60;
// Messages into anon threads (either party), per user.
export const ANON_SEND_RATE_PER_HOUR = 20;
// Brand-new threads (distinct recipients), per user per UTC day — the spam
// bound that also blunts delete-and-retry games.
export const ANON_NEW_THREAD_RATE_PER_DAY = 5;
// Worker sweep cadence (queue `timers`): timer reveals are also resolved LIVE
// at read (reveal_at <= now() serializes as revealed) — the house pattern;
// the sweep only stamps revealed_at + fans the anon.updated goodbye-blur.
export const ANON_SWEEP_INTERVAL_S = 60;
// Push copy — NEVER any identity in either direction's payload.
export const ANON_PUSH_BODY_RECIPIENT = 'Someone sent you an anonymous message 🎭';
export const ANON_PUSH_BODY_SENDER = 'Your anonymous thread got a reply 🎭';

// ---- Wave nudges (v0.8b — API.md §1.63, FEATURES #78a) ----
// A nudge fires ONLY when the recipient's currently-visible card pool (the
// §1.44 mutual-reachability set, minus blocks/friends-of) holds at least this
// many people — below it, "someone waved" would be guessable and the
// no-rejection rule would quietly die (ADR-019).
export const NUDGE_MIN_POOL = 4;
// One nudge per opt-in hour, claimed via the guarded wave_nudged_at UPDATE —
// multiple waves batch into that single anonymous line.
export const NUDGE_PUSH_BODY = 'Someone in the pool waved at you 👀';

// ---- Suggestions & find-your-people (v0.8b — API.md §1.64, FEATURES #78) ----
export const SUGGESTIONS_MAX = 20;
// Mutual-connection FACES inlined per suggestion card; mutual_count carries
// the rest (the §1.36 pattern — the count here is relationship evidence about
// MY network, not public approval; ADR-019 records the distinction).
export const SUGGESTION_MUTUALS_PREVIEW_MAX = 3;
// NEVER suggestion/user cards on the login page — unauthenticated member
// enumeration is forbidden (the standing decision, SPECS v0.8).

// ---- Discovery filters & vibes (v0.8b — API.md §1.65, FEATURES #78b) ----
// Optional what-for chip on a discovery opt-in. Same vocabulary as the beacon
// chips (familiar glyphs), its own tuple so the two can diverge. Filters only
// ever NARROW on data people chose to share — no age/gender fields exist.
export const DISCOVERY_VIBES = [
  'food',
  'chai',
  'walk',
  'game',
  'movie',
  'study',
  'sport',
  'chill',
] as const;
// Shared profile-interest tags inlined on a card ("you both like X") — the
// overlap of two PUBLIC §1.37 interest lists, capped.
export const DISCOVERY_SHARED_INTERESTS_MAX = 3;

// ---- Canvas stories (v0.8b — API.md §1.66, FEATURES #79a, ADR-020) ----
// Per-story author mode. DEFAULT OFF — being drawable is always the author's
// invitation; 'approve' holds viewer overlays as 'pending' until the author
// approves each one.
export const STORY_CANVAS_MODES = ['off', 'open', 'approve'] as const;
export const STORY_OVERLAY_KINDS = ['stroke', 'emoji', 'text'] as const;
// 'removed' is a tombstone (reports must outlive moderation); removed rows
// never serialize to anyone and never count toward the cap.
export const STORY_OVERLAY_STATUSES = ['live', 'pending', 'removed'] as const;
// Live+pending overlays per (story, contributor); the 6th → 409 overlay_limit.
export const OVERLAYS_PER_USER = 5;
// Vector payload bounds (coordinates are normalized 0..1 of the story frame;
// stroke width is px at a 512 reference edge — clients scale).
export const OVERLAY_STROKE_POINTS_MIN = 2;
export const OVERLAY_STROKE_POINTS_MAX = 256;
export const OVERLAY_STROKE_WIDTH_MIN = 1;
export const OVERLAY_STROKE_WIDTH_MAX = 24;
export const OVERLAY_TEXT_MAX_CHARS = 80;
export const OVERLAY_EMOJI_SCALE_MIN = 0.5;
export const OVERLAY_EMOJI_SCALE_MAX = 3;
export const OVERLAY_RATE_PER_HOUR = 60;

// ---- Public share pages (v0.8b — API.md §1.67, FEATURES #79c, ADR-020) ----
// What a share token may point at. post/beacon/listing tokens exist only for
// PUBLIC-audience objects; story tokens are author-minted only; group tokens
// exist for visibility public|invite_only (§1.68). Friends-only content NEVER
// gets a token.
export const SHARE_OBJECT_TYPES = ['post', 'beacon', 'listing', 'story', 'group'] as const;
// Token entropy + accepted shape — the §1.11 invite-token machinery verbatim
// (revocable capability stored plaintext with a unique index, ADR-007).
export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{32,128}$/;
// UNAUTHENTICATED budgets, per IP (Redis fixed window, the invite-public
// pattern). The report budget is deliberately HARD — it is writable.
export const SHARE_PUBLIC_RATE_PER_HOUR_PER_IP = 120;
export const SHARE_MEDIA_RATE_PER_HOUR_PER_IP = 240;
export const SHARE_REPORT_RATE_PER_DAY_PER_IP = 5;
// Cache-Control: private, max-age for token-gated share media (short — the
// token can be revoked while a CDN-less browser cache lives).
export const SHARE_MEDIA_CACHE_TTL_S = 300;
// Messages rendered on a PUBLIC group's live share page (newest page; older
// pages via cursor, floor always public_since_seq — history never
// retro-exposed).
export const SHARE_GROUP_PAGE_MESSAGES_MAX = 50;

// ---- Group visibility modes (v0.8b — API.md §1.68, FEATURES #79d, ADR-020) ----
// Groups only (DMs and channels stay 'private', DB CHECK). PUBLIC exposes
// ONLY messages with seq > public_since_seq (stamped at the admin-confirmed
// switch); GHOST is unlisted everywhere and one-way (never switchable off —
// members spoke under masks).
export const GROUP_VISIBILITIES = ['private', 'invite_only', 'public', 'ghost'] as const;
export const GROUP_DESCRIPTION_MAX_CHARS = 300;
// POST /api/conversations/:id/join budget (fixed window, per user) — covers
// both public joins and invite-only join requests.
export const GROUP_JOIN_RATE_PER_HOUR = 20;
// Ghost masks: chosen pseudonym + emoji avatar, unique per group. Members are
// anonymous to EACH OTHER, never to the server; group admins see real
// identities for abuse handling and reports always attach them (the #77
// precedent).
export const MASK_NAME_MAX_CHARS = 32;
export const MASK_EMOJI_MAX_LEN = 16;
// Auto-assign pools (random name+emoji at join / at the switch; the member
// can re-pick). Appending is contract-safe.
export const GHOST_MASK_NAMES = [
  'raccoon', 'heron', 'walnut', 'comet', 'bramble', 'tundra', 'pepper',
  'marble', 'juniper', 'ember', 'puffin', 'lantern', 'clover', 'drift',
  'maple', 'onyx', 'poppy', 'quartz', 'sorrel', 'wisp',
] as const;
export const GHOST_MASK_EMOJI = [
  '🦝', '🦜', '🐢', '🦊', '🐙', '🦔', '🐸', '🦉', '🐌', '🦩',
  '🐰', '🦥', '🐧', '🦀', '🐝', '🦭', '🐨', '🦎', '🐿️', '🦡',
] as const;

// ---- Admin: content, support, report context, update (v0.8b — API.md §1.69,
// FEATURES #81, ADR-020) ----
export const ADMIN_CONTENT_TYPES = ['post', 'beacon', 'listing'] as const;
// Takedown reason — REQUIRED (min 1): the author-facing notice carries it.
export const TAKEDOWN_REASON_MAX_CHARS = 500;
// Support inbox (Settings → Help & feedback): 🐞 bug / ❓ question / 💡 idea /
// ⚠️ safety.
export const SUPPORT_CATEGORIES = ['bug', 'question', 'idea', 'safety'] as const;
export const SUPPORT_TICKET_STATUSES = ['open', 'answered', 'closed'] as const;
export const SUPPORT_BODY_MAX_CHARS = 2000;
export const SUPPORT_TICKET_RATE_PER_DAY = 10;
// The per-user support conversation (lazily created on the first delivery):
// type 'group', this exact title, metadata.support = true, the user as sole
// member, messages from the operator side sender_id NULL + metadata.support
// rider — rendered as the Support brand, never as a named admin.
export const SUPPORT_CONVERSATION_TITLE = 'Bored Chat Support';
// Report-context viewer: the reported message ± this many messages by seq
// (N = 10 surrounding), served ONLY when the reporter consented at report
// time (include_context). Every view is ring-logged.
export const REPORT_CONTEXT_RADIUS = 5;
// The EXACT consent copy rendered beside the include-context checkbox in the
// report sheet (binding UX contract — the §1.54/§1.56 precedent). Unchecked
// by default; the report sends fine without it.
export const REPORT_CONTEXT_CONSENT_COPY =
  'Also share the 10 messages around this one with the moderators, so they can see the context. Only this slice is shared, and only because you chose to.';
// Update banner: the api compares its baked build commit (GIT_COMMIT build
// arg) against the instance repo remote's HEAD via the git HTTPS smart
// protocol (info/refs — first-party protocol, no API, no key), on a worker
// cadence, cached in Redis. Unreachable remote → update_available null
// (honesty, never a guess). The update itself always runs on the HOST
// (./bored update) — the container never gets docker.sock.
export const UPDATE_CHECK_INTERVAL_S = 6 * 3600;
export const UPDATE_CHECK_TIMEOUT_MS = 5000;

// ---- Auth pack (v0.9 — API.md §1.70–§1.74, FEATURES #82–#86, ADR-021) ----

// Passkeys (§1.70). The WebAuthn JSON shapes themselves are owned by the
// W3C spec via @simplewebauthn (pinned in ADR-021) — the contract pins only
// our own fields and knobs around them.
export const PASSKEYS_MAX = 10;
export const PASSKEY_NICKNAME_MAX_CHARS = 32;
export const PASSKEY_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;
// Registration AND login challenges live in Redis under this TTL — never rows.
export const WEBAUTHN_CHALLENGE_TTL_S = 300;
export const PASSKEY_LOGIN_RATE_PER_MIN = 10; // per IP, options + verify each

// QR / cross-device login (§1.71). The QR encodes <origin>/link/<code>; the
// human fallback is a LOGIN_LINK_DISPLAY_CODE_LEN-char code from the
// ambiguity-free alphabet below (no 0/O/1/I/L), typed into the phone's
// approve page. The full code (LOGIN_LINK_CODE_BYTES random bytes, base64url)
// is the laptop's poll/redeem capability; the display code can only approve.
export const LOGIN_LINK_TTL_S = 120;
export const LOGIN_LINK_POLL_INTERVAL_MS = 2000;
export const LOGIN_LINK_CODE_BYTES = 32; // base64url → 43 chars
export const LOGIN_LINK_CODE_REGEX = /^[A-Za-z0-9_-]{43}$/;
export const LOGIN_LINK_DISPLAY_CODE_LEN = 6;
export const LOGIN_LINK_DISPLAY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LOGIN_LINK_CREATE_RATE_PER_HOUR = 30; // per IP (the logged-out laptop)
export const LOGIN_LINK_APPROVE_RATE_PER_MIN = 5; // per user (the phone) — lookup + approve each

// Recovery codes (§1.72). Shown ONCE (register / regenerate responses),
// stored sha256 of the normalized form (lowercased, '-'/' ' stripped). The
// display form groups RECOVERY_CODE_LEN chars as xxxxx-xxxxx. Inputs are
// accepted LOOSELY (≤ 64 chars at the schema, normalized route-side — the
// §1.1 invite_token doctrine: a mangled paste fails verification, never
// validation).
export const RECOVERY_CODES_COUNT = 6;
export const RECOVERY_CODE_LEN = 10;
export const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_LOGIN_RATE_PER_HOUR = 5; // per IP — scorched-earth path, keep it slow
export const RESET_TOKEN_TTL_S = 15 * 60; // Redis one-shot, minted by a consumed recovery code

// TOTP (§1.73) — RFC 6238 by hand (HMAC-SHA1 via node:crypto; ADR-021), no
// dependency. Verification accepts ±TOTP_DRIFT_STEPS steps and burns the
// matched step in Redis so one code never authenticates twice.
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_S = 30;
export const TOTP_DRIFT_STEPS = 1;
export const TOTP_SECRET_BYTES = 20; // 160-bit, the RFC 4226 recommendation; base32 manual key
export const TOTP_CODE_REGEX = /^\d{6}$/;
export const TOTP_SETUP_TTL_S = 600; // pending (unconfirmed) secret, Redis
export const TOTP_TOKEN_TTL_S = 300; // half-login token between password/passkey ok and code ok
export const TOTP_VERIFY_RATE_PER_MIN = 5; // per totp_token AND per IP
export const TOTP_ISSUER = 'Bored Chat'; // otpauth:// issuer label

// Admin Authentication settings (§1.74). Toggles persist TODAY and every
// email-dependent flow flags off them at runtime, but they stay inert until
// a mailer ships (none in v0.9 — golden rule 10; ADR-021 documents the
// honesty: the UI disables them with a "needs SMTP support" note while the
// CONFIG itself is fully storable).
export const AUTH_FEATURE_TOGGLES = [
  'email_verification',
  'email_otp',
  'magic_links',
  'password_reset',
] as const;
export const SMTP_FIELD_MAX_CHARS = 255; // host/username/from/password each
