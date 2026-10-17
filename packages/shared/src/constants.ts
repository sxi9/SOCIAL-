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
export const LISTING_ROOM_PHOTOS_MAX = 6;
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
export const WORDMARK_WORDS = ['Bored', 'Sad', 'Excited', 'Happy', 'Lonely', 'Hyped'] as const;
export const WORDMARK_FLIP_INTERVAL_MS = 2500;
