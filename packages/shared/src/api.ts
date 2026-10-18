// REST contract (docs/API.md) — Zod schemas + inferred types for every DTO.
// Field names follow docs/API.md exactly. This file IS the contract.
import { z } from 'zod';
import {
  AREA_MAX_CHARS,
  AUDIO_WAVEFORM_BUCKETS,
  AUDIO_WAVEFORM_PEAK_MAX,
  BEACON_NOTE_MAX_CHARS,
  EDITABLE_MESSAGE_TYPES,
  FORWARD_MAX_TARGETS,
  INTEREST_TAG_MAX_CHARS,
  INTERESTS_MAX,
  ADMIN_LOG_LEVELS,
  ADMIN_NOTE_MAX_CHARS,
  LAST_SEEN_BUCKETS,
  LISTING_BODY_MAX_CHARS,
  LISTING_GIG_DIRECTIONS,
  LISTING_GIG_TAG_MAX_CHARS,
  LISTING_GIG_TAGS_MAX,
  LISTING_KINDS,
  LISTING_PLACE_NAME_MAX_CHARS,
  LISTING_PRICE_TEXT_MAX_CHARS,
  LISTING_RATING_MAX,
  LISTING_RATING_MIN,
  LISTING_RIDE_LEG_MAX_CHARS,
  LISTING_RIDE_SEATS_MAX,
  LISTING_RIDE_SEATS_MIN,
  LISTING_PHOTOS_MAX,
  LISTING_SEARCH_MAX_CHARS,
  LISTING_TITLE_MAX_CHARS,
  PERSON_REVIEW_BODY_MAX_CHARS,
  TEAM_UP_MAX_PICKS,
  TRUST_RECENT_REVIEWS_MAX,
  POST_BODY_MAX_CHARS,
  POST_COMMENT_MAX_CHARS,
  POST_MAX_ATTACHMENTS,
  PROFILE_ENTRIES_MAX,
  PROFILE_ENTRY_DETAIL_MAX_CHARS,
  PROFILE_ENTRY_TITLE_MAX_CHARS,
  PROFILE_MEDIA_MAX,
  REPLY_EXCERPT_MAX_CHARS,
  STORY_CAPTION_MAX_CHARS,
  BEACON_ROLE_LABEL_MAX_CHARS,
  BEACON_SPARK_THRESHOLD_MAX,
  BEACON_SPARK_THRESHOLD_MIN,
  CHAT_THEMES,
  CHAT_WALLPAPERS,
  DISAPPEAR_TTL_OPTIONS_S,
  INVITE_TOKEN_REGEX,
  KUDOS_KINDS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  MESSAGE_EFFECTS,
  NICKNAME_MAX_CHARS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PASSWORD_MIN_LENGTH,
  POLL_OPTION_MAX_CHARS,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX_CHARS,
  PUZZLE_GUESS_REGEX,
  PUZZLE_MAX_GUESSES,
  PUZZLE_SCORE_REGEX,
  REACTION_EMOJI_MAX_LEN,
  REACTION_KINDS,
  REPORT_REASON_MAX_CHARS,
  TTT_BOARD_CELLS,
  USERNAME_REGEX,
  VIBE_CHECK_PROMPT_MAX_CHARS,
  // ---- v0.6 (API.md §1.42–§1.46; ADR-014/ADR-015) ----
  CALL_KINDS,
  CALL_STATUSES,
  DISCOVERY_NOTE_MAX_CHARS,
  DISCOVERY_SCOPES,
  EXPECTATION_CONTEXTS,
  EXPECTATION_VERDICTS,
  RESCUE_MAX_TARGETS,
  RESCUE_NOTE_MAX_CHARS,
  // ---- v0.7 (API.md §1.47–§1.54; ADR-016) ----
  BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN,
  BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS,
  BEACON_VIBE_VALUES,
  FEED_LANES,
  LOCATION_LABEL_MAX_CHARS,
  LOCATION_LAT_MAX,
  LOCATION_LAT_MIN,
  LOCATION_LNG_MAX,
  LOCATION_LNG_MIN,
  POST_AUDIENCES,
  POST_KINDS,
  POST_POLL_QUESTION_MAX_CHARS,
  POST_REF_TYPES,
  // ---- v0.7.1 (API.md §1.55–§1.56 + §2.9 + §2.12; ADR-017) ----
  CALL_CONN_STATES,
  CALL_RING_PUSH_TAG_PREFIX,
  // ---- v0.8a (API.md §1.57–§1.61; ADR-018) ----
  ACTIVITY_KINDS,
  ACTIVITY_VISIBILITIES,
  MOOD_EMOJI_MAX_LEN,
  MOOD_KINDS,
  MOOD_LABEL_MAX_CHARS,
  MOOD_SWING_SET_MAX,
  MOOD_SWING_SET_MIN,
  MOOD_VISIBILITIES,
  NAME_STYLES,
  RELEASE_NOTE_ITEM_MAX_CHARS,
  RELEASE_NOTE_ITEMS_MAX,
  RELEASE_VERSION_MAX_CHARS,
  // ---- v0.8b (API.md §1.62–§1.69, ADR-019 / ADR-020) ----
  ANON_BODY_MAX_CHARS,
  ANON_OPTIN_VALUES,
  ANON_RIDDLE_MAX_CHARS,
  ANON_TIMER_PRESETS_S,
  ADMIN_CONTENT_TYPES,
  DISCOVERY_SHARED_INTERESTS_MAX,
  DISCOVERY_VIBES,
  GROUP_DESCRIPTION_MAX_CHARS,
  GROUP_VISIBILITIES,
  MASK_EMOJI_MAX_LEN,
  MASK_NAME_MAX_CHARS,
  OVERLAY_EMOJI_SCALE_MAX,
  OVERLAY_EMOJI_SCALE_MIN,
  OVERLAY_STROKE_POINTS_MAX,
  OVERLAY_STROKE_POINTS_MIN,
  OVERLAY_STROKE_WIDTH_MAX,
  OVERLAY_STROKE_WIDTH_MIN,
  OVERLAY_TEXT_MAX_CHARS,
  REPORT_CONTEXT_RADIUS,
  SHARE_GROUP_PAGE_MESSAGES_MAX,
  SHARE_OBJECT_TYPES,
  STORY_CANVAS_MODES,
  STORY_OVERLAY_KINDS,
  STORY_OVERLAY_STATUSES,
  SUGGESTION_MUTUALS_PREVIEW_MAX,
  SUPPORT_BODY_MAX_CHARS,
  SUPPORT_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
  TAKEDOWN_REASON_MAX_CHARS,
  // ---- v0.9 auth pack (API.md §1.70–§1.74, ADR-021) ----
  AUTH_FEATURE_TOGGLES,
  LOGIN_LINK_DISPLAY_CODE_LEN,
  PASSKEY_DEVICE_TYPES,
  PASSKEY_NICKNAME_MAX_CHARS,
  SMTP_FIELD_MAX_CHARS,
  TOTP_CODE_REGEX,
} from './constants.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UuidSchema = z.string().uuid();
// ISO-8601 UTC strings; offsets tolerated on parse.
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
// Per-conversation gapless counter. Message seq > 0; watermarks start at 0.
export const SeqSchema = z.number().int().nonnegative();

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Core DTOs (API.md §0)
// ---------------------------------------------------------------------------

export const AvatarStatusSchema = z.enum(['none', 'processing', 'ready', 'failed']);
export type AvatarStatus = z.infer<typeof AvatarStatusSchema>;

export const AvatarSchema = z.object({
  status: AvatarStatusSchema,
  version: z.number().int().nonnegative(),
  static_url: z.string().nullable(),
  animated_url: z.string().nullable(),
});
export type Avatar = z.infer<typeof AvatarSchema>;

export const AvatarMotionSchema = z.enum(['auto', 'reduced', 'off']);
export type AvatarMotion = z.infer<typeof AvatarMotionSchema>;

// ---- v0.8a moods & animated names (API.md §1.57–§1.58, ADR-018) ----

export const MoodKindSchema = z.enum(MOOD_KINDS);
export type MoodKind = z.infer<typeof MoodKindSchema>;

export const MoodVisibilitySchema = z.enum(MOOD_VISIBILITIES);
export type MoodVisibility = z.infer<typeof MoodVisibilitySchema>;

// What OTHERS see of a mood, when the §1.57 visibility + blocks allow it:
// the current chip only. No expires_at (a countdown on someone's feelings is
// a seen-at timestamp in disguise), no swing_set (the set is the owner's);
// for kind='swing' this is the CURRENT entry — kind lets clients morph.
export const MoodSchema = z.object({
  emoji: z.string().min(1).max(MOOD_EMOJI_MAX_LEN),
  label: z.string().min(1).max(MOOD_LABEL_MAX_CHARS),
  kind: MoodKindSchema,
});
export type Mood = z.infer<typeof MoodSchema>;

// users.name_style (API.md §1.58): pure CSS text effect on the display name.
export const NameStyleSchema = z.enum(NAME_STYLES);
export type NameStyle = z.infer<typeof NameStyleSchema>;

// v0.3 (API.md §0): the minimal embeddable identity — beacon joiner piles,
// seen-by lists, blocked lists, role assignees. Deliberately carries NO
// last_seen_at and NO area (privacy surfaces never ride list DTOs).
export const UserLiteSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  display_name: z.string(),
  avatar: AvatarSchema,
  // v0.8a (§1.57): the mood chip, resolved PER-VIEWER at serialization time
  // (visibility everyone/connections/nobody + §1.14 blocks; expired = null —
  // reads filter mood_expires_at > now() live). default(null) keeps pre-v0.8
  // payloads (IndexedDB rows, old fixtures) parsing clean.
  mood: MoodSchema.nullable().default(null),
  // v0.8a (§1.58): animated-name style — viewer-independent, rides every
  // identity the name renders from (headers, sender names, piles).
  name_style: NameStyleSchema.default('none'),
  // v0.8b (§1.68): non-null ONLY inside 👻 ghost-group serializations to
  // non-admin members — the identity is a MASK: id is the per-(group, member)
  // pseudo-id, username is '', display_name is the mask name, avatar is the
  // empty shell, and this field carries the emoji the client renders as the
  // avatar glyph. Real identities never ride a masked frame (mood/name_style
  // serialize null/'none' with it — both are identity tells). default(null)
  // keeps every pre-v0.8b payload parsing clean.
  mask_emoji: z.string().max(MASK_EMOJI_MAX_LEN).nullable().default(null),
});
export type UserLite = z.infer<typeof UserLiteSchema>;

export const UserPublicSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  display_name: z.string(),
  bio: z.string(),
  avatar: AvatarSchema,
  // null when the owner's show_last_seen setting (or a block) hides it from
  // the viewer — serialization-time filtering, v0.3 §1.13 (ADR-009).
  last_seen_at: IsoDateTimeSchema.nullable(),
  // v0.3 plan karma (API.md §1.15): lifetime counters rendered as plain profile
  // facts ("12 plans, 8 sparked") — named people, never ranked, never compared
  // (PSYCHOLOGY design rule 3: no leaderboards). default(0) keeps pre-v0.3
  // payloads parsing clean.
  beacons_created: z.number().int().nonnegative().default(0),
  beacons_sparked: z.number().int().nonnegative().default(0),
  // v0.8a (§1.57/§1.58): same per-viewer mood resolution and name style as
  // UserLite — profile pages and user.updated frames carry them too.
  mood: MoodSchema.nullable().default(null),
  name_style: NameStyleSchema.default('none'),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const UserPrivateSchema = UserPublicSchema.extend({
  email: z.string(),
  email_verified: z.boolean(),
  avatar_motion: AvatarMotionSchema,
  // v0.3: self-declared coarse area ("neighborhood/city" free text, citext in
  // the DB). PRIVATE — owner-only; it is never serialized into UserPublic or
  // UserLite and never shown to others (FEATURES #30). It only gates 'area'
  // beacon visibility via case-insensitive equality.
  area: z.string().nullable().default(null),
  created_at: IsoDateTimeSchema,
  // v0.9 (§1.73): is TOTP 2FA armed on this account. The secret itself NEVER
  // serializes anywhere. default(false) keeps pre-v0.9 payloads parsing clean.
  totp_enabled: z.boolean().default(false),
});
export type UserPrivate = z.infer<typeof UserPrivateSchema>;

// v0.4 adds 'audio' (API.md §1.20 voice notes).
export const AttachmentKindSchema = z.enum(['image', 'video', 'file', 'audio']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

export const AttachmentSchema = z.object({
  id: UuidSchema,
  kind: AttachmentKindSchema,
  mime: z.string(),
  size_bytes: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  blurhash: z.string().nullable(),
  status: AttachmentStatusSchema,
  url: z.string(),
  thumb_url: z.string().nullable(),
  file_name: z.string().nullable(),
  // v0.4 (§1.20): kind 'audio' only — AUDIO_WAVEFORM_BUCKETS integer peaks
  // (0..AUDIO_WAVEFORM_PEAK_MAX), worker-computed (ffmpeg astats per segment)
  // and inlined here so bubbles render the waveform with zero extra fetches.
  // null while status is 'pending' and for every non-audio kind. default(null)
  // keeps pre-v0.4 payloads parsing clean.
  waveform: z
    .array(z.number().int().min(0).max(AUDIO_WAVEFORM_PEAK_MAX))
    .length(AUDIO_WAVEFORM_BUCKETS)
    .nullable()
    .default(null),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// image_url is OUR origin (/api/media/:key), never hotlinked.
export const LinkPreviewSchema = z.object({
  url: z.string(),
  site_name: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
});
export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

// v0.3 adds 'poll' (API.md §1.17): a poll is a message that rides the seq log.
// v0.4 adds 'audio' (§1.20 voice notes), 'vibe_check' (§1.23), 'game_ttt'
// (§1.27 tic-tac-toe — state lives in metadata.game), 'puzzle_result' (§1.27
// — the no-spoiler emoji grid share, metadata.puzzle).
// v0.7 adds 'location' (§1.52): a "📍 join me here" drop — the place rides
// metadata.location (+ optional metadata.join_me), body is an optional note.
export const MessageTypeSchema = z.enum([
  'text',
  'image',
  'video',
  'file',
  'system',
  'poll',
  'audio',
  'vibe_check',
  'game_ttt',
  'puzzle_result',
  'location',
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

// ---------------------------------------------------------------------------
// Polls (v0.3 — API.md §1.17). A poll IS a message (type 'poll'); the poll row
// is keyed by the message identity (conversation_id, seq). counts/total_votes
// are aggregates; my_vote is the viewer's option index (null = not voted).
// NO per-voter lists and NO vote timestamps in the DTO.
// ---------------------------------------------------------------------------

export const PollSchema = z.object({
  id: UuidSchema,
  conversation_id: UuidSchema,
  seq: z.number().int().positive(), // the message the poll rides on
  question: z.string().min(1).max(POLL_QUESTION_MAX_CHARS),
  options: z
    .array(z.string().min(1).max(POLL_OPTION_MAX_CHARS))
    .min(POLL_OPTIONS_MIN)
    .max(POLL_OPTIONS_MAX),
  closes_at: IsoDateTimeSchema.nullable(),
  counts: z.array(z.number().int().nonnegative()), // same length as options
  total_votes: z.number().int().nonnegative(),
  my_vote: z.number().int().nonnegative().nullable(), // option index, viewer-specific
});
export type Poll = z.infer<typeof PollSchema>;

export const SystemEventMetadataSchema = z.object({
  event: z.string(),
  actor_id: UuidSchema.optional(),
  target_id: UuidSchema.optional(),
  // v0.4 (§1.25): on event 'disappear_changed' — the new TTL (null = turned off).
  ttl_s: z.number().int().positive().nullable().optional(),
});
export type SystemEventMetadata = z.infer<typeof SystemEventMetadataSchema>;

// v0.3 beacons (API.md §1.15): the vibe chips. v0.7 (§1.47) widens the VALUE
// set with 'custom' (BEACON_VIBE_VALUES = BEACON_VIBES + 'custom'); a custom
// vibe carries custom_vibe_emoji + custom_vibe_label on the beacon DTO.
export const BeaconVibeSchema = z.enum(BEACON_VIBE_VALUES);
export type BeaconVibe = z.infer<typeof BeaconVibeSchema>;

// v0.3 afterglow recap (API.md §1.15): rides the recap SYSTEM message the
// worker posts in the plan conversation 2 h after a sparked beacon expires.
// run_it_back is the source beacon id — POST /api/beacons/:id/run-it-back
// re-creates the beacon one-tap (the id is the token; membership of the spark
// group is the authorization, no extra secret).
export const AfterglowMetadataSchema = z.object({
  beacon_id: UuidSchema,
  vibe: BeaconVibeSchema,
  participant_ids: z.array(UuidSchema),
  // Image attachments posted in the plan conversation during the hangout
  // window (spark → expires_at + 2 h), capped at BEACON_AFTERGLOW_PHOTOS_MAX.
  photo_attachment_ids: z.array(UuidSchema),
  run_it_back: UuidSchema,
});
export type AfterglowMetadata = z.infer<typeof AfterglowMetadataSchema>;

// ---------------------------------------------------------------------------
// v0.4 metadata riders (ADR-010). All are plain jsonb fields on messages —
// durable sends stay REST, fan-out stays msg.new/msg.updated.
// ---------------------------------------------------------------------------

// §1.22 message effects. CONSENT RULE (binding): clients may auto-SUGGEST on a
// trigger phrase (EFFECT_TRIGGERS) but the sender must confirm — never
// auto-attached. Plays once per viewer per message (client-tracked); full
// prefers-reduced-motion fallback (static badge, zero animation).
export const MessageEffectSchema = z.enum(MESSAGE_EFFECTS);
export type MessageEffect = z.infer<typeof MessageEffectSchema>;

// §1.27 tic-tac-toe state, the whole truth on the game message (metadata.game).
// board is 9 cells row-major; players maps symbol → user id; turn/winner are
// symbols ('draw' for a full board without a line). Moves are SERVER-validated
// (POST /api/games/:messageId/move) and fanned out as msg.updated full-DTO
// replacements — clients never compute game state locally.
export const TttSymbolSchema = z.enum(['x', 'o']);
export type TttSymbol = z.infer<typeof TttSymbolSchema>;

export const GameTttStateSchema = z.object({
  board: z.array(TttSymbolSchema.nullable()).length(TTT_BOARD_CELLS),
  players: z.object({ x: UuidSchema, o: UuidSchema }),
  turn: TttSymbolSchema,
  winner: z.union([TttSymbolSchema, z.literal('draw')]).nullable(),
});
export type GameTttState = z.infer<typeof GameTttStateSchema>;

// §1.27 daily puzzle share (metadata.puzzle on type='puzzle_result'). The grid
// is score rows ('g'/'y'/'x' per letter) — NO letters, NO word: spoiler-free by
// construction. The server builds this from the sender's own stored attempt
// (forged grids are impossible); clients render rows via PUZZLE_SCORE_EMOJI.
export const PuzzleResultMetadataSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // UTC puzzle day
  attempts_used: z.number().int().min(1).max(PUZZLE_MAX_GUESSES),
  solved: z.boolean(),
  grid: z.array(z.string().regex(PUZZLE_SCORE_REGEX)).min(1).max(PUZZLE_MAX_GUESSES),
});
export type PuzzleResultMetadata = z.infer<typeof PuzzleResultMetadataSchema>;

// v0.5a (§1.31): forwarding attribution — a SNAPSHOT of the original author's
// identity at forward time (survives renames/deletion; deliberately not an FK
// and not a UserLite — no avatar hotlink into conversations the original
// author never joined). The forwarder is the message's sender_id: forwarding
// never spoofs authorship.
export const ForwardedFromSchema = z.object({
  username: z.string(),
  display_name: z.string(),
});
export type ForwardedFrom = z.infer<typeof ForwardedFromSchema>;

// v0.5b (§1.38): the four local-board card kinds. Defined up here (ahead of
// the §1.38 block) because the listing_ref metadata rider below needs it.
export const ListingKindSchema = z.enum(LISTING_KINDS);
export type ListingKind = z.infer<typeof ListingKindSchema>;

// v0.5b (§1.39): rides the 'listing_contact' context system message in the DM
// and the 'team_up' kickoff system message in the project group. A SNAPSHOT of
// the listing's identity at contact/team-up time (the forwarded_from pattern):
// not an FK — the message must keep rendering after the listing is closed,
// expired or deleted.
export const ListingRefSchema = z.object({
  listing_id: UuidSchema,
  kind: ListingKindSchema,
  title: z.string().min(1).max(LISTING_TITLE_MAX_CHARS),
});
export type ListingRef = z.infer<typeof ListingRefSchema>;

// v0.5b listing status — moved up in v0.7 (ahead of its §1.38 block) because
// the §1.50 join_card live summary needs it (the ListingKindSchema precedent).
export const ListingStatusSchema = z.enum(['active', 'closed', 'expired']);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

// v0.7 locations (§1.52): the ONE location shape, everywhere a location can
// appear — posts, beacons, listings, and metadata.location on 'location'
// messages. label is required (a location always has a human name); lat/lng
// are OPTIONAL, both-or-neither, and only ever a user-initiated one-tap
// SNAPSHOT — no live GPS, no tracking, nothing ambient (the FEATURES #30
// line). Clients render map LINKS (geo:/OSM/Google URLs) — never tile embeds,
// never a map API key (CLAUDE.md golden rule 7).
export const LocationSchema = z
  .object({
    label: z.string().min(1).max(LOCATION_LABEL_MAX_CHARS),
    lat: z.number().min(LOCATION_LAT_MIN).max(LOCATION_LAT_MAX).optional(),
    lng: z.number().min(LOCATION_LNG_MIN).max(LOCATION_LNG_MAX).optional(),
  })
  .refine((l) => (l.lat === undefined) === (l.lng === undefined), {
    message: 'lat and lng come together or not at all',
  });
export type Location = z.infer<typeof LocationSchema>;

// v0.6 calls (§1.42): defined up here (ahead of the §1.42 block) because the
// call_ref metadata rider below needs them.
export const CallKindSchema = z.enum(CALL_KINDS);
export type CallKind = z.infer<typeof CallKindSchema>;

export const CallStatusSchema = z.enum(CALL_STATUSES);
export type CallStatus = z.infer<typeof CallStatusSchema>;

// v0.6 (§1.42): SERVER-written snapshot on the missed-call system message
// (event 'call_missed') — the forwarded_from pattern: the message keeps
// rendering whatever later happens to the calls row. duration_s is reserved
// for a future call-log message on 'completed'; it is null on missed calls.
export const CallRefSchema = z.object({
  call_id: UuidSchema,
  kind: CallKindSchema,
  status: CallStatusSchema,
  duration_s: z.number().int().nonnegative().nullable(),
});
export type CallRef = z.infer<typeof CallRefSchema>;

export const MessageMetadataSchema = z.object({
  link_preview: LinkPreviewSchema.optional(),
  system: SystemEventMetadataSchema.optional(),
  afterglow: AfterglowMetadataSchema.optional(), // v0.3; on the recap system message
  // ---- v0.4 (§1.21–§1.27) ----
  // §1.21: this image message is a canvas doodle — render with the sketchy
  // frame. Valid only on type='image' (route-enforced); no other machinery.
  doodle: z.literal(true).optional(),
  // §1.22: confirmed-by-sender send effect (DB CHECK pins the set).
  effect: MessageEffectSchema.optional(),
  // §1.23: this message answers the vibe check at that seq (same conversation).
  vibe_reply_seq: z.number().int().positive().optional(),
  // §1.23: an avatar-stamp vibe reply (no body, no attachment — the tile is the
  // sender's avatar). Valid only together with vibe_reply_seq (route-enforced).
  stamp: z.literal(true).optional(),
  // §1.26: delivered time capsule — sealed-envelope reveal on first view
  // (client-tracked, reduced-motion fallback opens instantly).
  capsule: z.literal(true).optional(),
  // §1.27: tic-tac-toe state; present iff type='game_ttt'.
  game: GameTttStateSchema.optional(),
  // §1.27: puzzle share; present iff type='puzzle_result'. Server-populated.
  puzzle: PuzzleResultMetadataSchema.optional(),
  // ---- v0.5a (§1.31, §1.33) ----
  // §1.33: SERVER-written at send time from @username tokens matched against
  // active participants (client-sent values are ignored). Caps at
  // MENTIONS_PER_MESSAGE_MAX; drives the mute-override push rule — which NEVER
  // crosses a blocked pair (§1.14 stays structural).
  mentions: z.array(UuidSchema).optional(),
  // §1.31: present on forwarded messages; preserved verbatim when a forward is
  // forwarded again (attribution sticks to the original author).
  forwarded_from: ForwardedFromSchema.optional(),
  // ---- v0.5b (§1.39) ----
  // SERVER-written listing snapshot on the 'listing_contact' DM context message
  // and the 'team_up' group kickoff message (client-sent values are ignored).
  listing_ref: ListingRefSchema.optional(),
  // ---- v0.6 (§1.42, §1.46) ----
  // §1.42: SERVER-written call snapshot on the missed-call system message
  // (client-sent values are ignored).
  call_ref: CallRefSchema.optional(),
  // §1.46: this message is a rescue SOS — render the rescue card with the
  // one-tap "call <name>" action. SERVER-written by POST /api/rescue only.
  rescue: z.literal(true).optional(),
  // ---- v0.7 (§1.52) ----
  // The place a type='location' message drops (required on that type,
  // 400 location_required otherwise; invalid on every other type).
  location: LocationSchema.optional(),
  // "📍 Join me here": renders the join-me variant with the ON_MY_WAY_BODY
  // quick reply. Valid only on type='location' (route-enforced).
  join_me: z.literal(true).optional(),
  // ---- v0.8a (§1.57) ----
  // Drunk-mode send-undo: SERVER-written on the tombstone when the author
  // undoes within MOOD_DRUNK_UNDO_WINDOW_S. An undone message renders as
  // NOTHING — the bubble vanishes entirely, unlike an ordinary §1.30
  // tombstone's "message deleted" stub. The seq survives (golden rule 2).
  undone: z.literal(true).optional(),
  // ---- v0.8b (§1.69) ----
  // SERVER-written on operator messages in the per-user Support conversation
  // (admin ticket replies and takedown notices; sender_id is NULL). Clients
  // render the "Bored Chat Support" brand identity — never a named admin, and
  // never the system-event chrome. ticket_id links back to the user's ticket.
  support: z.object({ ticket_id: UuidSchema.nullable() }).optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

// v0.2 reactions (API.md §1.12). Zod's max() counts UTF-16 units — stricter
// than the DB CHECK's codepoint count for astral emoji, so Zod is binding.
export const ReactionEmojiSchema = z.string().min(1).max(REACTION_EMOJI_MAX_LEN);
export type ReactionEmoji = z.infer<typeof ReactionEmojiSchema>;

// v0.4 (§1.19): 'stamp' = react with your own animated avatar. A stamp is a
// message_reactions row with kind='stamp' and the STAMP_REACTION_KEY sentinel
// in the emoji column — the existing PK enforces one stamp per user per message.
export const ReactionKindSchema = z.enum(REACTION_KINDS);
export type ReactionKind = z.infer<typeof ReactionKindSchema>;

// One aggregate chip per emoji on a message, from the viewer's perspective.
// Server orders by first-reaction time (min created_at per emoji) so chips
// never reshuffle as counts change. EMOJI reactions only — stamp reactions
// ride Message.stamps (the renderer needs faces, not a count).
export const ReactionAggregateSchema = z.object({
  emoji: ReactionEmojiSchema,
  count: z.number().int().positive(),
  mine: z.boolean(),
});
export type ReactionAggregate = z.infer<typeof ReactionAggregateSchema>;

// ---------------------------------------------------------------------------
// Vibe checks (v0.4 — API.md §1.23). The vibe message (type 'vibe_check',
// body = the prompt) aggregates REPLY REFS so the client renders the collage
// strip under the prompt with zero extra fetches. Replies are ordinary
// messages in the same conversation carrying metadata.vibe_reply_seq.
// ---------------------------------------------------------------------------

export const VibeReplyKindSchema = z.enum(['image', 'doodle', 'stamp']);
export type VibeReplyKind = z.infer<typeof VibeReplyKindSchema>;

// kind is derived server-side: 'stamp' when metadata.stamp, 'doodle' when
// metadata.doodle, else 'image'. thumb_url is the reply's first attachment
// thumb (null for stamps — the tile is user.avatar, version-busted as usual).
export const VibeReplyRefSchema = z.object({
  seq: z.number().int().positive(),
  user: UserLiteSchema,
  kind: VibeReplyKindSchema,
  thumb_url: z.string().nullable(),
});
export type VibeReplyRef = z.infer<typeof VibeReplyRefSchema>;

// replies = first VIBE_REPLIES_PREVIEW_MAX by seq (reply_count carries the
// rest); my_reply_seq lets the composer flip to "you answered" cross-device.
export const VibeCheckAggregateSchema = z.object({
  prompt: z.string().min(1).max(VIBE_CHECK_PROMPT_MAX_CHARS),
  reply_count: z.number().int().nonnegative(),
  replies: z.array(VibeReplyRefSchema),
  my_reply_seq: z.number().int().positive().nullable(),
});
export type VibeCheckAggregate = z.infer<typeof VibeCheckAggregateSchema>;

// ---------------------------------------------------------------------------
// Threads / replies (v0.5a — API.md §1.29). A reply names an EARLIER message
// in the SAME conversation by seq (the message identity everything else uses —
// reactions, polls, reports). The context snippet is resolved SERVER-side at
// serialization time so the reply bubble renders with zero extra fetches and
// always reflects the referenced message's current state (edits, tombstones).
// ---------------------------------------------------------------------------

export const ReplyContextSchema = z.object({
  seq: z.number().int().positive(),
  author: UserLiteSchema.nullable(), // null = system message or deleted account
  type: MessageTypeSchema,
  // First REPLY_EXCERPT_MAX_CHARS of the referenced message's CURRENT body;
  // null for body-less kinds (the "Photo" / "Voice note" label is client copy)
  // and for tombstones.
  excerpt: z.string().max(REPLY_EXCERPT_MAX_CHARS).nullable(),
  // true = referenced message has been tombstoned since (render "message
  // deleted"; the reply itself stays).
  deleted: z.boolean(),
});
export type ReplyContext = z.infer<typeof ReplyContextSchema>;

export const MessageSchema = z.object({
  id: UuidSchema,
  conversation_id: UuidSchema,
  seq: z.number().int().positive(),
  sender_id: UuidSchema.nullable(), // null = system
  type: MessageTypeSchema,
  body: z.string().nullable(),
  metadata: MessageMetadataSchema,
  reply_to_id: UuidSchema.nullable(),
  // v0.5a (§1.29): seq of the replied-to message in the SAME conversation
  // (reply_to_id predates the seq-keyed identity and is retired — always null
  // from v0.5a on). default(null) keeps pre-v0.5a payloads parsing clean.
  reply_to_seq: z.number().int().positive().nullable().default(null),
  // v0.5a (§1.29): server-resolved snippet; non-null iff reply_to_seq is set.
  reply_context: ReplyContextSchema.nullable().default(null),
  attachments: z.array(AttachmentSchema),
  // v0.2: aggregated reactions. default([]) keeps pre-v0.2 payloads (IndexedDB
  // rows, old fixtures) parsing clean; the server always emits the array.
  reactions: z.array(ReactionAggregateSchema).default([]),
  // v0.3 (§1.17): populated iff type === 'poll'; viewer-specific (my_vote).
  // default(null) keeps pre-v0.3 payloads parsing clean.
  poll: PollSchema.nullable().default(null),
  // v0.4 (§1.19): stamp reactors in first-stamp order — the renderer shows the
  // reactor avatars themselves (version-busted via avatar.version), so this is
  // faces, not a counter. default([]) keeps pre-v0.4 payloads parsing clean.
  stamps: z.array(UserLiteSchema).default([]),
  // v0.4 (§1.23): populated iff type === 'vibe_check'; viewer-specific
  // (my_reply_seq). default(null) keeps pre-v0.4 payloads parsing clean.
  vibe: VibeCheckAggregateSchema.nullable().default(null),
  created_at: IsoDateTimeSchema,
  edited_at: IsoDateTimeSchema.nullable(),
  deleted_at: IsoDateTimeSchema.nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

// v0.5a adds 'owner' (API.md §1.35): the channel creator. Exactly one per
// channel; never appears in DMs/groups (their creator stays 'admin').
export const ParticipantRoleSchema = z.enum(['member', 'admin', 'owner']);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

export const ParticipantSchema = z.object({
  user: UserPublicSchema,
  role: ParticipantRoleSchema,
  joined_at: IsoDateTimeSchema,
  join_seq: SeqSchema,
  left_at: IsoDateTimeSchema.nullable(),
  last_delivered_seq: SeqSchema,
  last_read_seq: SeqSchema,
  muted_until: IsoDateTimeSchema.nullable(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

// v0.5a adds 'channel' (API.md §1.35): broadcast conversations — owner/admins
// send, everyone reads + reacts; cap CHANNEL_MAX (watermark receipts make it
// safe, ARCHITECTURE §1); joined via the existing invite system.
export const ConversationTypeSchema = z.enum(['dm', 'group', 'channel']);
export type ConversationType = z.infer<typeof ConversationTypeSchema>;

// v0.5a pins (API.md §1.32): one row per pinned message, newest-pinned last
// (created_at ASC — a stable board, not a feed). pinned_by is null when the
// pinner's account is gone.
export const ConversationPinSchema = z.object({
  seq: z.number().int().positive(),
  pinned_by: UuidSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type ConversationPin = z.infer<typeof ConversationPinSchema>;

export const ConversationSchema = z.object({
  id: UuidSchema,
  type: ConversationTypeSchema,
  title: z.string().nullable(),
  avatar: AvatarSchema,
  created_by: UuidSchema.nullable(),
  last_seq: SeqSchema,
  last_message_at: IsoDateTimeSchema.nullable(),
  // v0.5a (§1.35): for type='channel' this carries ONLY the viewer's own row
  // plus the owner and admins — never 10k rows, and never a member COUNT
  // (PSYCHOLOGY design rule 3: no follower counts). DMs/groups are unchanged.
  participants: z.array(ParticipantSchema),
  // v0.5a (§1.32): pinned messages, ≤ MAX_PINS, created_at ASC. default([])
  // keeps pre-v0.5a payloads parsing clean.
  pins: z.array(ConversationPinSchema).default([]),
  // v0.4 (§1.25): disappearing-messages TTL — null = off; otherwise one of
  // DISAPPEAR_TTL_OPTIONS_S (DB CHECK pins the set). Conversation-wide state
  // (NOT personal like themes): everyone sees the same TTL. default(null)
  // keeps pre-v0.4 payloads parsing clean.
  disappear_ttl_s: z.number().int().positive().nullable().default(null),
  // v0.6 (§1.44/§1.45): how this DM came to exist — 'discovery' (mutual wave)
  // or 'roulette'; null for every ordinary conversation. Drives the client's
  // one-time PRIVATE expectation-feedback prompt (§1.45; PSYCHOLOGY finding
  // #10). default(null) keeps pre-v0.6 payloads parsing clean.
  origin: z.enum(['discovery', 'roulette']).nullable().default(null),
  // v0.6 (§1.45): non-null ONLY while a roulette DM is provisional. kept is
  // the VIEWER's own keep state — whether the other party kept is never
  // serialized (no pressure surface; it resolves when both have kept or the
  // window lapses). default(null) keeps pre-v0.6 payloads parsing clean.
  roulette: z
    .object({
      expires_at: IsoDateTimeSchema,
      kept: z.boolean(),
    })
    .nullable()
    .default(null),
  // ---- v0.8b (§1.68, ADR-020). Defaults keep pre-v0.8b payloads clean. ----
  // Group visibility mode (groups only — DMs/channels are always 'private',
  // DB CHECK). 'public' and 'invite_only' power the §1.67 share pages;
  // 'ghost' is unlisted everywhere and serializes member MASKS to non-admins.
  visibility: z.enum(GROUP_VISIBILITIES).default('private'),
  // Group description — rendered on the group card and its share page.
  description: z.string().max(GROUP_DESCRIPTION_MAX_CHARS).default(''),
  // Non-null iff visibility='public': conversations.last_seq at the
  // admin-confirmed switch. ONLY messages with seq > this ever render
  // publicly (history is never retro-exposed), and its presence IS the
  // persistent member banner flag ("new messages here are publicly
  // readable") — clients render the banner from it, nothing extra ships.
  public_since_seq: SeqSchema.nullable().default(null),
  // v0.8b (§1.68): MY current mask in a 👻 ghost group — the explicit
  // own-mask read. The viewer's OWN participant row serializes with their
  // real identity (a client must find itself for bubble alignment/"my role"),
  // so this field is the ONE place a member learns the pseudonym+emoji the
  // others see them as (incl. after a 409 mask_taken left an auto-mask on).
  // null outside ghost groups. default(null) keeps pre-v0.8b payloads clean.
  my_mask: z
    .object({
      name: z.string().max(MASK_NAME_MAX_CHARS),
      emoji: z.string().max(MASK_EMOJI_MAX_LEN),
    })
    .nullable()
    .default(null),
  created_at: IsoDateTimeSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationListItemSchema = ConversationSchema.extend({
  unread_count: z.number().int().nonnegative(), // last_seq - my last_read_seq
  last_message: MessageSchema.nullable(),
});
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;

// ---------------------------------------------------------------------------
// §1.1 Auth
// ---------------------------------------------------------------------------

export const RegisterRequestSchema = z.object({
  username: z.string().regex(USERNAME_REGEX),
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
  display_name: z.string().min(1).max(100),
  // v0.2 (§1.11): registering through /join/<token> auto-accepts the invite —
  // DM with the inviter is created (or deduped), or the scoped group joined.
  // Deliberately LOOSE (max-length only, NOT INVITE_TOKEN_REGEX): per §1.1
  // registration NEVER fails because of a bad invite, so a malformed token
  // (e.g. a link truncated by an SMS/mail client) must degrade to
  // `invite: null` in the handler — not 400 at schema validation.
  invite_token: z.string().max(256).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  user: UserPrivateSchema,
  // v0.2: the conversation created/joined via invite_token, else null.
  // Registration NEVER fails because of a bad/expired invite — the account is
  // created and invite is null (default(null) keeps the pre-v0.2 handler and
  // old fixtures valid).
  invite: z.object({ conversation_id: UuidSchema }).nullable().default(null),
  // v0.9 (§1.72): the SIX one-time recovery codes, display form
  // (xxxxx-xxxxx), shown to the user ONCE here — the server keeps only
  // sha256 rows. default([]) keeps pre-v0.9 fixtures parsing clean.
  recovery_codes: z.array(z.string()).default([]),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const LoginRequestSchema = z.object({
  username_or_email: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({ user: UserPrivateSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// v0.9 (§1.73): a TOTP-armed account does NOT get a session from a correct
// password (or passkey) alone — the 200 carries this half-login challenge
// instead (totp_token = one-shot Redis ref, TOTP_TOKEN_TTL_S). Finish at
// POST /api/auth/totp with the 6-digit code. LoginOutcome is the §1.1 /
// §1.70 login response: exactly one of the two shapes.
export const TotpChallengeSchema = z.object({
  totp_required: z.literal(true),
  totp_token: z.string(),
});
export type TotpChallenge = z.infer<typeof TotpChallengeSchema>;

export const LoginOutcomeSchema = z.union([LoginResponseSchema, TotpChallengeSchema]);
export type LoginOutcome = z.infer<typeof LoginOutcomeSchema>;

export const SessionInfoSchema = z.object({
  id: UuidSchema,
  user_agent: z.string().nullable(),
  ip: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  last_seen_at: IsoDateTimeSchema,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionsResponseSchema = z.object({ sessions: z.array(SessionInfoSchema) });
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.2 Users & profiles
// ---------------------------------------------------------------------------

export const MeResponseSchema = z.object({ user: UserPrivateSchema });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const UpdateMeRequestSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  bio: z.string().max(1000).optional(),
  avatar_motion: AvatarMotionSchema.optional(),
  // v0.3 (§1.13): self-declared coarse area; null clears it (and with it all
  // 'area' beacon visibility, both directions). Never shown to other users.
  area: z.string().min(1).max(AREA_MAX_CHARS).nullable().optional(),
  // v0.8a (§1.58): animated-name style. Identity, not privacy — it rides
  // PATCH /users/me like display_name and fans out the same user.updated.
  name_style: NameStyleSchema.optional(),
});
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

export const UpdateMeResponseSchema = z.object({ user: UserPrivateSchema });
export type UpdateMeResponse = z.infer<typeof UpdateMeResponseSchema>;

// 202 on upload (status 'processing'); 200 on delete (status 'none').
export const AvatarResponseSchema = z.object({ avatar: AvatarSchema });
export type AvatarResponse = z.infer<typeof AvatarResponseSchema>;

export const UserResponseSchema = z.object({ user: UserPublicSchema });
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const UserSearchQuerySchema = z.object({ q: z.string().min(1) });
export type UserSearchQuery = z.infer<typeof UserSearchQuerySchema>;

export const UserSearchResponseSchema = z.object({ users: z.array(UserPublicSchema) });
export type UserSearchResponse = z.infer<typeof UserSearchResponseSchema>;

// ---------------------------------------------------------------------------
// §1.3 Sync (the reconnect anchor)
// ---------------------------------------------------------------------------

export const SyncResponseSchema = z.object({
  server_time: IsoDateTimeSchema,
  me: UserPrivateSchema,
  conversations: z.array(ConversationListItemSchema),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// ---------------------------------------------------------------------------
// §1.4 Conversations
// ---------------------------------------------------------------------------

export const CreateConversationRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dm'),
    user_id: UuidSchema,
  }),
  z.object({
    type: z.literal('group'),
    title: z.string().min(1).max(100),
    // No Zod max here: the 256 cap (user_ids + creator) is enforced by the
    // route so an over-cap create yields the documented machine code
    // `400 group_too_large`, not a generic validation error (API.md §1.4).
    // Request body size limits bound the array in practice.
    user_ids: z.array(UuidSchema).min(1),
  }),
  // v0.5a (§1.35): a channel starts empty — members arrive through invites
  // (§1.11 with a channel conversation_id). Creator becomes 'owner'.
  z.object({
    type: z.literal('channel'),
    title: z.string().min(1).max(100),
  }),
]);
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const ConversationResponseSchema = z.object({ conversation: ConversationSchema });
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const ListConversationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListConversationsResponseSchema = z.object({
  conversations: z.array(ConversationListItemSchema),
  next_cursor: z.string().nullable(),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

export const UpdateConversationRequestSchema = z.object({
  title: z.string().min(1).max(100),
});
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequestSchema>;

// No Zod max: the route checks "existing + added ≤ 256" and answers an
// over-cap request with the documented `400 group_too_large` (API.md §1.4).
export const AddParticipantsRequestSchema = z.object({
  user_ids: z.array(UuidSchema).min(1),
});
export type AddParticipantsRequest = z.infer<typeof AddParticipantsRequestSchema>;

// ---------------------------------------------------------------------------
// §1.5 Messages
// ---------------------------------------------------------------------------

// Exactly one of after_seq (ascending catch-up) or before_seq (descending scroll).
export const ListMessagesQuerySchema = z
  .object({
    after_seq: z.coerce.number().int().nonnegative().optional(),
    before_seq: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  })
  .refine((q) => (q.after_seq === undefined) !== (q.before_seq === undefined), {
    message: 'exactly one of after_seq or before_seq is required',
  });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const ListMessagesResponseSchema = z.object({ messages: z.array(MessageSchema) });
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

// v0.4 widens the client-sendable types: 'audio' (§1.20, needs exactly one
// audio attachment), 'vibe_check' (§1.23, body = the prompt ≤
// VIBE_CHECK_PROMPT_MAX_CHARS), 'puzzle_result' (§1.27, server populates
// metadata.puzzle from MY stored attempt — a client-sent puzzle payload is
// ignored). 'system', 'poll' and 'game_ttt' are never client-sent here (polls
// and challenges have dedicated routes). The v0.4 metadata riders are
// cross-validated by the route: doodle ⇒ type 'image'; stamp ⇒ vibe_reply_seq
// set, no body/attachments; vibe_reply_seq ⇒ targets a visible 'vibe_check'
// message; effect allowed on any client-sent type.
// v0.7 (§1.52) adds 'location': metadata.location required (400
// location_required), optional metadata.join_me: true — both riders invalid on
// every other type (400 bad_metadata).
export const SendMessageRequestSchema = z.object({
  client_msg_id: UuidSchema, // idempotency key; replay returns 200 with the original row
  type: z.enum(['text', 'image', 'video', 'file', 'audio', 'vibe_check', 'puzzle_result', 'location']),
  body: z.string().max(MAX_MESSAGE_BODY_CHARS).optional(),
  // v0.5a (§1.29): reply — the seq of a visible message in the SAME
  // conversation (route-enforced: within my floor, exists; tombstoned targets
  // ARE repliable — the context renders "message deleted").
  reply_to_seq: z.number().int().positive().optional(),
  attachment_ids: z.array(UuidSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  metadata: z
    .object({
      link_preview: LinkPreviewSchema.optional(),
      // ---- v0.4 ----
      doodle: z.literal(true).optional(),
      effect: MessageEffectSchema.optional(),
      vibe_reply_seq: z.number().int().positive().optional(),
      stamp: z.literal(true).optional(),
      // ---- v0.7 (§1.52) ----
      location: LocationSchema.optional(),
      join_me: z.literal(true).optional(),
    })
    .optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({ message: MessageSchema });
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

// ---------------------------------------------------------------------------
// §1.6 Uploads & media
// ---------------------------------------------------------------------------

// POST /api/uploads is streaming multipart (field `file`); optional text field:
export const UploadFieldsSchema = z.object({
  share_import_id: UuidSchema.optional(),
});
export type UploadFields = z.infer<typeof UploadFieldsSchema>;

export const UploadResponseSchema = z.object({ attachment: AttachmentSchema });
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const AttachmentResponseSchema = z.object({ attachment: AttachmentSchema });
export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>;

// ---------------------------------------------------------------------------
// §1.7 Link previews
// ---------------------------------------------------------------------------

export const PreviewStatusSchema = z.enum(['pending', 'ok', 'failed']);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

export const CreatePreviewRequestSchema = z.object({ url: z.string().url() });
export type CreatePreviewRequest = z.infer<typeof CreatePreviewRequestSchema>;

export const CreatePreviewResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), url_hash: z.string(), preview: LinkPreviewSchema }),
  z.object({ status: z.literal('pending'), url_hash: z.string() }),
  z.object({ status: z.literal('failed'), url_hash: z.string() }),
]);
export type CreatePreviewResponse = z.infer<typeof CreatePreviewResponseSchema>;

export const GetPreviewResponseSchema = z.object({
  status: PreviewStatusSchema,
  preview: LinkPreviewSchema.optional(),
});
export type GetPreviewResponse = z.infer<typeof GetPreviewResponseSchema>;

// ---------------------------------------------------------------------------
// §1.8 Share target
// ---------------------------------------------------------------------------

export const ShareImportStatusSchema = z.enum(['open', 'consumed', 'expired']);
export type ShareImportStatus = z.infer<typeof ShareImportStatusSchema>;

export const ShareImportSchema = z.object({
  id: UuidSchema,
  title: z.string().nullable(),
  text_body: z.string().nullable(),
  url: z.string().nullable(),
  status: ShareImportStatusSchema,
  attachments: z.array(AttachmentSchema),
  preview: z
    .object({ status: PreviewStatusSchema, preview: LinkPreviewSchema.optional() })
    .nullable(),
  created_at: IsoDateTimeSchema,
});
export type ShareImport = z.infer<typeof ShareImportSchema>;

export const ShareImportResponseSchema = z.object({ import: ShareImportSchema });
export type ShareImportResponse = z.infer<typeof ShareImportResponseSchema>;

// Text fields of the multipart POST /api/share-imports (files ride as `media[]`).
export const ShareImportFieldsSchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
});
export type ShareImportFields = z.infer<typeof ShareImportFieldsSchema>;

export const ShareStashResponseSchema = z.object({ stash_id: UuidSchema });
export type ShareStashResponse = z.infer<typeof ShareStashResponseSchema>;

export const ClaimShareImportRequestSchema = z.object({ stash_id: UuidSchema });
export type ClaimShareImportRequest = z.infer<typeof ClaimShareImportRequestSchema>;

// ---------------------------------------------------------------------------
// §1.9 Web push
// ---------------------------------------------------------------------------

export const VapidResponseSchema = z.object({ public_key: z.string() });
export type VapidResponse = z.infer<typeof VapidResponseSchema>;

export const PushSubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export const PushSubscribeResponseSchema = z.object({ id: UuidSchema });
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponseSchema>;

export const PushUnsubscribeRequestSchema = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

// ---------------------------------------------------------------------------
// §1.10 Ops
// ---------------------------------------------------------------------------

export const HealthzResponseSchema = z.object({ ok: z.literal(true) });
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

// ---------------------------------------------------------------------------
// §1.11 Invites (v0.2 — ADR-007)
// ---------------------------------------------------------------------------

// Derived, never stored. Precedence when several apply:
// revoked > expired > exhausted > valid.
export const InviteStatusSchema = z.enum(['valid', 'expired', 'exhausted', 'revoked']);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;

// 'dm' = conversation_id is null (accepting creates/dedupes a DM with the
// inviter); 'group' = scoped to that group conversation. v0.5a adds 'channel'
// (§1.35): scoped to a channel — joining is the existing §1.11 accept flow
// verbatim (owner/admin mints; cap check is CHANNEL_MAX → 400 channel_full).
// InvitePublic.group_title is non-null for BOTH group and channel kinds (the
// field name is kept stable for old clients).
export const InviteKindSchema = z.enum(['dm', 'group', 'channel']);
export type InviteKind = z.infer<typeof InviteKindSchema>;

export const InviteTokenSchema = z.string().regex(INVITE_TOKEN_REGEX);
export type InviteToken = z.infer<typeof InviteTokenSchema>;

// Who is inviting you — rendered on the UNAUTHENTICATED /join/<token> page.
// avatar URLs point at the token-gated proxy GET /api/invites/:token/avatar
// (?v=static|animated&ver=<avatar.version>), NEVER at /api/media/:key (which is
// auth-checked). Both are null unless status === 'valid' AND the inviter's
// avatar is 'ready' — revoking an invite instantly kills its avatar proxy.
export const InviteInviterSchema = z.object({
  username: z.string(),
  display_name: z.string(),
  avatar: AvatarSchema,
});
export type InviteInviter = z.infer<typeof InviteInviterSchema>;

export const InvitePublicSchema = z.object({
  status: InviteStatusSchema,
  kind: InviteKindSchema,
  group_title: z.string().nullable(), // non-null iff kind === 'group'
  inviter: InviteInviterSchema,
  expires_at: IsoDateTimeSchema,
});
export type InvitePublic = z.infer<typeof InvitePublicSchema>;

export const InvitePublicResponseSchema = z.object({ invite: InvitePublicSchema });
export type InvitePublicResponse = z.infer<typeof InvitePublicResponseSchema>;

// The minter's own view (POST /api/invites, GET /api/invites).
export const InvitePrivateSchema = z.object({
  id: UuidSchema,
  token: InviteTokenSchema,
  // App-origin PATH (`/join/<token>`), not an absolute URL: the API does not
  // know the public origin; web prefixes window.location.origin when copying.
  url: z.string(),
  kind: InviteKindSchema,
  conversation_id: UuidSchema.nullable(), // null = DM-with-inviter invite
  status: InviteStatusSchema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  max_uses: z.number().int().positive(),
  use_count: z.number().int().nonnegative(),
  revoked_at: IsoDateTimeSchema.nullable(),
});
export type InvitePrivate = z.infer<typeof InvitePrivateSchema>;

export const CreateInviteRequestSchema = z.object({
  // Omitted ⇒ DM-with-inviter invite. Present ⇒ group invite (minter must be
  // an ADMIN of that group; DMs cannot be invite-scoped → 400 invite_bad_scope).
  conversation_id: UuidSchema.optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

export const CreateInviteResponseSchema = z.object({ invite: InvitePrivateSchema });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const ListInvitesResponseSchema = z.object({ invites: z.array(InvitePrivateSchema) });
export type ListInvitesResponse = z.infer<typeof ListInvitesResponseSchema>;

// GET /api/invites/:token/avatar?v=static|animated (default static — OG
// unfurlers get the universally supported JPEG unless asked otherwise).
// An extra `ver` cache-buster query param is accepted and ignored server-side.
export const InviteAvatarQuerySchema = z.object({
  v: z.enum(['static', 'animated']).default('static'),
});
export type InviteAvatarQuery = z.infer<typeof InviteAvatarQuerySchema>;

// POST /api/invites/:token/accept (already-logged-in path).
export const AcceptInviteResponseSchema = z.object({ conversation_id: UuidSchema });
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

// ---------------------------------------------------------------------------
// §1.12 Reactions (v0.2)
// ---------------------------------------------------------------------------
// ReactionEmojiSchema / ReactionAggregateSchema live with the core DTOs above
// (MessageSchema embeds the aggregate). Fan-out event: ws.ts reaction.updated.

// v0.4 (§1.19) adds `kind`. default('emoji') keeps every pre-v0.4 client
// payload ({emoji}) valid byte-for-byte. kind='stamp' takes no emoji (the
// server stores the STAMP_REACTION_KEY sentinel); kind='emoji' requires one.
export const AddReactionRequestSchema = z
  .object({
    kind: ReactionKindSchema.default('emoji'),
    emoji: ReactionEmojiSchema.optional(),
  })
  .refine((r) => (r.kind === 'emoji') === (r.emoji !== undefined), {
    message: "emoji is required for kind 'emoji' and forbidden for kind 'stamp'",
  });
export type AddReactionRequest = z.infer<typeof AddReactionRequestSchema>;

// ---------------------------------------------------------------------------
// §1.13 Privacy settings (v0.3 — ADR-009)
// ---------------------------------------------------------------------------
// Stored as columns on users (one row read on the presence/typing/receipt hot
// paths — the same pattern as avatar_motion). Every setting is enforced
// SERVER-SIDE at the points documented in API.md §1.13; clients only mirror.

export const ShowLastSeenSchema = z.enum(['everyone', 'dm_partners', 'nobody']);
export type ShowLastSeen = z.infer<typeof ShowLastSeenSchema>;

export const GroupAddPolicySchema = z.enum(['everyone', 'dm_partners', 'nobody']);
export type GroupAddPolicy = z.infer<typeof GroupAddPolicySchema>;

export const BeaconAudienceSchema = z.enum(['friends', 'area', 'public']);
export type BeaconAudience = z.infer<typeof BeaconAudienceSchema>;

export const UserSettingsSchema = z.object({
  // RECIPROCAL (API.md §1.13): off hides YOUR read state from everyone AND
  // hides everyone's read state (seen ticks, seen-by lists) from you.
  // Delivered state is unaffected either way.
  read_receipts: z.boolean(),
  show_last_seen: ShowLastSeenSchema,
  show_typing: z.boolean(),
  // true: minting new invites AND accepting your existing ones both 403.
  invites_paused: z.boolean(),
  beacon_default_audience: BeaconAudienceSchema,
  group_add_policy: GroupAddPolicySchema,
  // ---- v0.8a (§1.58/§1.59). Defaults keep pre-v0.8 payloads parsing clean. ----
  // PER-VIEWER mood-effects toggle: whether MY client performs other people's
  // mood-reactive bubble effects (§1.58). Stored server-side purely for
  // cross-device sync — rendering is entirely client-side.
  mood_effects: z.boolean().default(true),
  // Per-kind activity-strip visibility (§1.59): which viewers may see each
  // GROUP of my activity items (ACTIVITY_KIND_GROUP maps kinds to these).
  // 'private' = owner only. The underlying object's audience ALWAYS also
  // binds — these toggles can only narrow further, never widen.
  activity_beacons: z.enum(ACTIVITY_VISIBILITIES).default('connections'),
  activity_posts: z.enum(ACTIVITY_VISIBILITIES).default('connections'),
  activity_listings: z.enum(ACTIVITY_VISIBILITIES).default('connections'),
  activity_games: z.enum(ACTIVITY_VISIBILITIES).default('connections'),
  // ---- v0.8b (§1.62/§1.63). Defaults keep pre-v0.8b payloads parsing clean. ----
  // Who may open an anonymous thread to me (§1.62). Enforced INVISIBLY at
  // send: 'nobody', an unmet 'connections', and a §1.14 block all answer the
  // same 404 anon_unavailable — the setting is never confirmable from outside.
  anon_messages: z.enum(ANON_OPTIN_VALUES).default('connections'),
  // Anonymous wave-nudge toggle (§1.63): may the worker send me the batched
  // "someone in the pool waved" line during a live opt-in. Never any identity
  // either way; off kills the push AND the in-app frame.
  wave_nudges: z.boolean().default(true),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const UpdateSettingsRequestSchema = UserSettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

export const SettingsResponseSchema = z.object({ settings: UserSettingsSchema });
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.14 Blocks & reports (v0.3 — ADR-009)
// ---------------------------------------------------------------------------

export const BlockedListResponseSchema = z.object({ users: z.array(UserLiteSchema) });
export type BlockedListResponse = z.infer<typeof BlockedListResponseSchema>;

// v0.8b (§1.62/§1.66/§1.67) adds 'anon_message', 'story_overlay' and the
// non-user 'share_page' kind (stored with reporter_id NULL — migration 0010).
export const ReportKindSchema = z.enum([
  'user',
  'message',
  'beacon',
  'anon_message',
  'story_overlay',
  'share_page',
]);
export type ReportKind = z.infer<typeof ReportKindSchema>;

// Message identity is (conversation_id, seq) — the messages PK, same as
// reactions. Targets are stored WITHOUT FKs (reports are an audit log that
// must survive target deletion; see migration 0003).
export const CreateReportRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    user_id: UuidSchema,
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
  }),
  z.object({
    kind: z.literal('message'),
    conversation_id: UuidSchema,
    seq: z.number().int().positive(),
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
    // v0.8b (§1.69, FEATURES #81): the reporter's EXPLICIT consent to also
    // disclose the REPORT_CONTEXT_RADIUS messages either side of this one to
    // the admin context viewer. Default false; the report sheet renders
    // REPORT_CONTEXT_CONSENT_COPY beside the checkbox, unchecked (binding UX
    // contract). Without it the context viewer answers 404 for this report.
    include_context: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('beacon'),
    beacon_id: UuidSchema,
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
  }),
  // v0.8b (§1.62): reporting an anonymous message ATTACHES the reported
  // message author's real identity SERVER-side (FEATURES #77) — anonymity is
  // to the recipient, never to the server. The reporter must be a party of
  // the thread; the message must be the other party's.
  z.object({
    kind: z.literal('anon_message'),
    thread_id: UuidSchema,
    message_id: UuidSchema,
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
  }),
  // v0.8b (§1.66): reporting a canvas overlay attaches the overlay author
  // server-side. The story must be visible to the reporter (audience rules);
  // removed overlays stay reportable while the story lives (the tombstone).
  z.object({
    kind: z.literal('story_overlay'),
    story_id: UuidSchema,
    overlay_id: UuidSchema,
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
  }),
]);
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

// v0.8b (§1.67): the NON-USER report from a public share page — its own
// unauthenticated endpoint (POST /api/share/:token/report), hard rate-limited
// per IP, reason REQUIRED (an anonymous empty report is noise). Stored as an
// ordinary reports row with reporter_id NULL + the resolved share target.
export const SharePageReportRequestSchema = z.object({
  reason: z.string().min(1).max(REPORT_REASON_MAX_CHARS),
});
export type SharePageReportRequest = z.infer<typeof SharePageReportRequestSchema>;

export const CreateReportResponseSchema = z.object({ id: UuidSchema });
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;

// ---------------------------------------------------------------------------
// §1.15 Beacons (v0.3 — ADR-008)
// ---------------------------------------------------------------------------

export const BeaconStatusSchema = z.enum(['open', 'sparked', 'expired', 'cancelled']);
export type BeaconStatus = z.infer<typeof BeaconStatusSchema>;

export const BeaconMyStateSchema = z.enum(['creator', 'joined', 'none']);
export type BeaconMyState = z.infer<typeof BeaconMyStateSchema>;

// Ritual chain state carried on each run (null when not a ritual). count
// counts UP (sparked runs in the chain — "12 chai nights"); skips counts
// consecutive unsparked runs; the worker stops re-creating at
// RITUAL_AUTO_PAUSE_SKIPS with zero guilt copy (PSYCHOLOGY never-build list).
export const BeaconRitualSchema = z.object({
  rrule: z.string(), // 'FREQ=WEEKLY' only for now (RITUAL_RRULE_WEEKLY)
  count: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(),
});
export type BeaconRitual = z.infer<typeof BeaconRitualSchema>;

// Viewer-specific DTO (my_state, my conversation_id visibility). Faces, not
// counters: joiners is the avatar pile (first BEACON_JOINERS_PREVIEW_MAX by
// join order), needs = max(0, spark_threshold - joiner_count) powers the
// "needs 2 more" chip. conversation_id is non-null ONLY for the creator and
// joiners of a sparked beacon — spark details never leak to the rest of the
// audience (FoMO-safe, PSYCHOLOGY design rule 2).
export const BeaconSchema = z.object({
  id: UuidSchema,
  creator: UserLiteSchema,
  vibe: BeaconVibeSchema,
  // v0.7 (§1.47): non-null iff vibe='custom' — the creator's own chip
  // (emoji + a word). defaults keep pre-v0.7 payloads parsing clean.
  custom_vibe_emoji: z.string().max(BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN).nullable().default(null),
  custom_vibe_label: z.string().max(BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS).nullable().default(null),
  note: z.string().max(BEACON_NOTE_MAX_CHARS),
  audience: BeaconAudienceSchema,
  // Creator-area SNAPSHOT for audience 'area' beacons, else null. Only ever
  // serialized to viewers whose own area matches, so it exposes nothing new.
  area: z.string().nullable(),
  starts_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  spark_threshold: z.number().int().min(BEACON_SPARK_THRESHOLD_MIN).max(BEACON_SPARK_THRESHOLD_MAX),
  status: BeaconStatusSchema,
  joiner_count: z.number().int().nonnegative(),
  needs: z.number().int().nonnegative(),
  joiners: z.array(UserLiteSchema),
  my_state: BeaconMyStateSchema,
  conversation_id: UuidSchema.nullable(),
  ritual: BeaconRitualSchema.nullable(),
  // v0.7 (§1.52): optional place chip ("chai spot behind campus"), the ONE
  // Location shape. Editable while open (§1.47).
  location: LocationSchema.nullable().default(null),
  // v0.7 (§1.47): set on every effective creator edit — the card renders the
  // "edited" marker from it (the §1.30 edited_at pattern; no edit history).
  edited_at: IsoDateTimeSchema.nullable().default(null),
  created_at: IsoDateTimeSchema,
});
export type Beacon = z.infer<typeof BeaconSchema>;

// starts_at/expires_at are CLIENT-computed from the now/tonight/weekend preset
// chips (the server is timezone-blind; API.md §1.15 documents the preset
// mapping) and server-validated against the BEACON_* window bounds.
// audience omitted ⇒ the creator's beacon_default_audience setting.
// v0.7 (§1.47): vibe 'custom' requires BOTH custom fields; any other vibe
// forbids them (route-enforced → 400 bad_custom_vibe).
export const CreateBeaconRequestSchema = z.object({
  vibe: BeaconVibeSchema,
  custom_vibe_emoji: z.string().min(1).max(BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN).optional(),
  custom_vibe_label: z.string().min(1).max(BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS).optional(),
  note: z.string().max(BEACON_NOTE_MAX_CHARS).default(''),
  audience: BeaconAudienceSchema.optional(),
  spark_threshold: z
    .number()
    .int()
    .min(BEACON_SPARK_THRESHOLD_MIN)
    .max(BEACON_SPARK_THRESHOLD_MAX)
    .optional(),
  starts_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  location: LocationSchema.nullable().optional(), // v0.7 (§1.52)
});
export type CreateBeaconRequest = z.infer<typeof CreateBeaconRequestSchema>;

// v0.7 (§1.47): PATCH /api/beacons/:id — creator only, status 'open' only.
// Omitted = unchanged; location takes explicit null to clear. audience and
// the window SHAPE rules are the §1.15 ones re-applied; a new spark_threshold
// must also be ≥ the current joiner count (threshold == count sparks the
// beacon inside the edit transaction — the §1.15 spark path, row-locked).
export const PatchBeaconRequestSchema = z.object({
  vibe: BeaconVibeSchema.optional(),
  custom_vibe_emoji: z.string().min(1).max(BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN).optional(),
  custom_vibe_label: z.string().min(1).max(BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS).optional(),
  note: z.string().max(BEACON_NOTE_MAX_CHARS).optional(),
  starts_at: IsoDateTimeSchema.optional(),
  expires_at: IsoDateTimeSchema.optional(),
  spark_threshold: z
    .number()
    .int()
    .min(BEACON_SPARK_THRESHOLD_MIN)
    .max(BEACON_SPARK_THRESHOLD_MAX)
    .optional(),
  location: LocationSchema.nullable().optional(),
});
export type PatchBeaconRequest = z.infer<typeof PatchBeaconRequestSchema>;

export const BeaconResponseSchema = z.object({ beacon: BeaconSchema });
export type BeaconResponse = z.infer<typeof BeaconResponseSchema>;

export const ListBeaconsResponseSchema = z.object({ beacons: z.array(BeaconSchema) });
export type ListBeaconsResponse = z.infer<typeof ListBeaconsResponseSchema>;

// v0.7 (§1.47): GET /api/beacons/:id/joins — the "Who's in" sheet. The FULL
// joiner list in join order (the DTO pile is capped at
// BEACON_JOINERS_PREVIEW_MAX); audience-gated like the beacon itself and
// filtered of users blocked w.r.t. the viewer. Faces only — join timestamps
// are never serialized (the §1.18 no-timestamps rule).
export const BeaconJoinsResponseSchema = z.object({
  joiners: z.array(UserLiteSchema),
});
export type BeaconJoinsResponse = z.infer<typeof BeaconJoinsResponseSchema>;

// Boredom radar: AGGREGATE count only — no names, no faces, no list
// (FEATURES #26 "aggregate counts only").
export const RadarResponseSchema = z.object({
  active_visible_count: z.number().int().nonnegative(),
});
export type RadarResponse = z.infer<typeof RadarResponseSchema>;

export const KudosKindSchema = z.enum(KUDOS_KINDS);
export type KudosKind = z.infer<typeof KudosKindSchema>;

// 'glad_you_posted' must target the creator; 'glad_you_came' a fellow member
// of the spark group. Delivered PRIVATELY to the recipient only — never any
// public count anywhere (PSYCHOLOGY §9 + design rule 3).
export const SendKudosRequestSchema = z.object({
  to_user_id: UuidSchema,
  kind: KudosKindSchema,
});
export type SendKudosRequest = z.infer<typeof SendKudosRequestSchema>;

// ---------------------------------------------------------------------------
// §1.16 Plan roles (v0.3 — ADR-008; PSYCHOLOGY §4 named micro-roles)
// ---------------------------------------------------------------------------

export const BeaconRoleSchema = z.object({
  id: UuidSchema,
  beacon_id: UuidSchema,
  label: z.string().min(1).max(BEACON_ROLE_LABEL_MAX_CHARS),
  assignee: UserLiteSchema.nullable(),
  done: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type BeaconRole = z.infer<typeof BeaconRoleSchema>;

export const CreateRoleRequestSchema = z.object({
  label: z.string().min(1).max(BEACON_ROLE_LABEL_MAX_CHARS),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

export const RoleResponseSchema = z.object({ role: BeaconRoleSchema });
export type RoleResponse = z.infer<typeof RoleResponseSchema>;

// ---------------------------------------------------------------------------
// §1.17 Polls (v0.3). PollSchema lives with the core DTOs (MessageSchema
// embeds it). Fan-out event: ws.ts poll.updated.
// ---------------------------------------------------------------------------

export const CreatePollRequestSchema = z.object({
  client_msg_id: UuidSchema, // same idempotency contract as §1.5 sends
  question: z.string().min(1).max(POLL_QUESTION_MAX_CHARS),
  options: z
    .array(z.string().min(1).max(POLL_OPTION_MAX_CHARS))
    .min(POLL_OPTIONS_MIN)
    .max(POLL_OPTIONS_MAX),
  closes_at: IsoDateTimeSchema.optional(),
});
export type CreatePollRequest = z.infer<typeof CreatePollRequestSchema>;

// 201 (200 on idempotent replay); message.type === 'poll', message.poll set.
export const CreatePollResponseSchema = z.object({ message: MessageSchema });
export type CreatePollResponse = z.infer<typeof CreatePollResponseSchema>;

// option_idx bounds beyond >= 0 (i.e. < options.length) are route-enforced so
// an out-of-range vote yields the documented 400 bad_option.
export const VotePollRequestSchema = z.object({
  option_idx: z.number().int().nonnegative(),
});
export type VotePollRequest = z.infer<typeof VotePollRequestSchema>;

export const PollResponseSchema = z.object({ poll: PollSchema });
export type PollResponse = z.infer<typeof PollResponseSchema>;

// ---------------------------------------------------------------------------
// §1.18 Seen-by receipts (v0.3 — ADR-009)
// ---------------------------------------------------------------------------
// Computed from the §2.5 watermarks — NO timestamps anywhere in the response
// (PSYCHOLOGY never-build list: "seen X minutes ago" converts a receipt into
// a deadline). seen = last_read_seq >= seq; delivered = last_delivered_seq >=
// seq and not already in seen. Users with read_receipts OFF never appear in
// seen (they cap at delivered). Ordered by username — never by recency.

export const MessageReceiptsResponseSchema = z.object({
  seen: z.array(UserLiteSchema),
  delivered: z.array(UserLiteSchema),
});
export type MessageReceiptsResponse = z.infer<typeof MessageReceiptsResponseSchema>;

// ===========================================================================
// v0.4 — Expression pack (API.md §1.19–§1.27, ADR-010)
// ===========================================================================

// ---------------------------------------------------------------------------
// §1.24 Chat themes, wallpapers, nicknames — ALL PERSONAL (my view only).
// Stored per (conversation, user); synced across MY devices via the
// prefs.updated WS event (own sockets only); never serialized to anyone else.
// ---------------------------------------------------------------------------

export const ChatThemeSchema = z.enum(CHAT_THEMES);
export type ChatTheme = z.infer<typeof ChatThemeSchema>;

export const ChatWallpaperSchema = z.enum(CHAT_WALLPAPERS);
export type ChatWallpaper = z.infer<typeof ChatWallpaperSchema>;

// nicknames maps target user id → my nickname for them in this conversation
// (member_nicknames rows). null theme/wallpaper = app default.
export const ConversationPrefsSchema = z.object({
  conversation_id: UuidSchema,
  theme: ChatThemeSchema.nullable(),
  wallpaper: ChatWallpaperSchema.nullable(),
  nicknames: z.record(UuidSchema, z.string().min(1).max(NICKNAME_MAX_CHARS)),
  // v0.8a (§1.60): my GIF/video chat background — the OWNER's own upload,
  // resolved to a full Attachment (poster thumb included, for the reduced-
  // motion fallback). PERSONAL like theme/wallpaper: my view only, never
  // serialized to anyone else. null = the §1.24 wallpaper/theme (or default).
  // default(null) keeps pre-v0.8 payloads parsing clean.
  background: AttachmentSchema.nullable().default(null),
  // v1.0a (#95): the background the WHOLE conversation sees (DM: either side
  // sets; group: admins) — conversation-level state served through the prefs
  // read because that is where clients already resolve backgrounds. My own
  // `background` above still overrides it locally. default(null) keeps old
  // payloads parsing clean.
  shared_background: AttachmentSchema.nullable().default(null),
  // #95b: theme + wallpaper the WHOLE conversation sees (same setter rules as
  // shared_background). My own theme/wallpaper above still win for my view.
  shared_theme: ChatThemeSchema.nullable().default(null),
  shared_wallpaper: ChatWallpaperSchema.nullable().default(null),
});
export type ConversationPrefs = z.infer<typeof ConversationPrefsSchema>;

export const PrefsResponseSchema = z.object({ prefs: ConversationPrefsSchema });
export type PrefsResponse = z.infer<typeof PrefsResponseSchema>;

// PATCH semantics: omitted field = unchanged; explicit null = reset to default
// (theme/wallpaper) or remove (a nickname map value). Targets of nickname keys
// must be participants (past or present) of the conversation.
export const UpdatePrefsRequestSchema = z.object({
  theme: ChatThemeSchema.nullable().optional(),
  wallpaper: ChatWallpaperSchema.nullable().optional(),
  nicknames: z
    .record(UuidSchema, z.string().min(1).max(NICKNAME_MAX_CHARS).nullable())
    .optional(),
  // v0.8a (§1.60): set (an attachment id) or clear (null) my background for
  // this chat. Must be MY OWN upload (uploader_id = me), kind image|video,
  // status 'ready', within the §1.60 caps → else 400 bad_background.
  background_attachment_id: UuidSchema.nullable().optional(),
});
export type UpdatePrefsRequest = z.infer<typeof UpdatePrefsRequestSchema>;

// ---------------------------------------------------------------------------
// §1.25 Disappearing messages — conversation-wide TTL (NOT personal).
// ---------------------------------------------------------------------------

// The allowed TTLs, pinned (DISAPPEAR_TTL_OPTIONS_S: 1h, 24h, 7d, 30d).
export const DisappearTtlSchema = z.union([
  z.literal(DISAPPEAR_TTL_OPTIONS_S[0]),
  z.literal(DISAPPEAR_TTL_OPTIONS_S[1]),
  z.literal(DISAPPEAR_TTL_OPTIONS_S[2]),
  z.literal(DISAPPEAR_TTL_OPTIONS_S[3]),
]);
export type DisappearTtl = z.infer<typeof DisappearTtlSchema>;

export const UpdateDisappearRequestSchema = z.object({
  ttl_s: DisappearTtlSchema.nullable(), // null = turn off
});
export type UpdateDisappearRequest = z.infer<typeof UpdateDisappearRequestSchema>;

// ---------------------------------------------------------------------------
// §1.26 Scheduled messages & time capsules.
// ---------------------------------------------------------------------------

export const ScheduledStatusSchema = z.enum(['pending', 'sent', 'cancelled']);
export type ScheduledStatus = z.infer<typeof ScheduledStatusSchema>;

// The author's own view (list-mine). The payload mirrors a §1.5 send; capsule
// marks a time capsule (sealed-envelope rendering, pre- and post-delivery).
// sent_seq is the delivered message's seq (jump-to after delivery).
export const ScheduledMessageSchema = z.object({
  id: UuidSchema,
  conversation_id: UuidSchema,
  type: z.enum(['text', 'image', 'video', 'file', 'audio']),
  body: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
  metadata: z.object({
    effect: MessageEffectSchema.optional(),
    capsule: z.literal(true).optional(),
  }),
  deliver_at: IsoDateTimeSchema,
  status: ScheduledStatusSchema,
  created_at: IsoDateTimeSchema,
  sent_at: IsoDateTimeSchema.nullable(),
  sent_seq: z.number().int().positive().nullable(),
});
export type ScheduledMessage = z.infer<typeof ScheduledMessageSchema>;

export const CreateScheduledRequestSchema = z.object({
  client_msg_id: UuidSchema, // idempotency: replay returns the existing row, 200
  type: z.enum(['text', 'image', 'video', 'file', 'audio']),
  body: z.string().max(MAX_MESSAGE_BODY_CHARS).optional(),
  attachment_ids: z.array(UuidSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  metadata: z
    .object({
      effect: MessageEffectSchema.optional(),
      capsule: z.literal(true).optional(),
    })
    .optional(),
  // Route-enforced window: now + SCHEDULED_MIN_LEAD_S ≤ deliver_at ≤ now +
  // SCHEDULED_MAX_HORIZON_S (400 deliver_at_out_of_range).
  deliver_at: IsoDateTimeSchema,
});
export type CreateScheduledRequest = z.infer<typeof CreateScheduledRequestSchema>;

export const ScheduledResponseSchema = z.object({ scheduled: ScheduledMessageSchema });
export type ScheduledResponse = z.infer<typeof ScheduledResponseSchema>;

export const ListScheduledResponseSchema = z.object({
  scheduled: z.array(ScheduledMessageSchema),
});
export type ListScheduledResponse = z.infer<typeof ListScheduledResponseSchema>;

// ---------------------------------------------------------------------------
// §1.27 Mini-games: tic-tac-toe + daily word puzzle.
// ---------------------------------------------------------------------------

// POST /api/conversations/:id/games/ttt — challenge. In a DM the opponent is
// the other party (opponent_id must be omitted); in a group it is required.
export const CreateTttRequestSchema = z.object({
  client_msg_id: UuidSchema,
  opponent_id: UuidSchema.optional(),
});
export type CreateTttRequest = z.infer<typeof CreateTttRequestSchema>;

// POST /api/games/:messageId/move — cell is the row-major board index.
export const TttMoveRequestSchema = z.object({
  cell: z.number().int().min(0).max(TTT_BOARD_CELLS - 1),
});
export type TttMoveRequest = z.infer<typeof TttMoveRequestSchema>;

// Both answer with the full game message (metadata.game is the whole state).
export const GameMessageResponseSchema = z.object({ message: MessageSchema });
export type GameMessageResponse = z.infer<typeof GameMessageResponseSchema>;

// One scored attempt: the guessed word stays PRIVATE to its guesser (it only
// ever appears in the guesser's own responses, never in any shared payload).
export const PuzzleAttemptSchema = z.object({
  guess: z.string().regex(PUZZLE_GUESS_REGEX),
  score: z.string().regex(PUZZLE_SCORE_REGEX),
});
export type PuzzleAttempt = z.infer<typeof PuzzleAttemptSchema>;

// GET /api/puzzle/today — never contains the word.
export const PuzzleTodayResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // UTC day = puzzle identity
  attempts: z.array(PuzzleAttemptSchema).max(PUZZLE_MAX_GUESSES),
  solved: z.boolean(),
  remaining: z.number().int().min(0).max(PUZZLE_MAX_GUESSES),
});
export type PuzzleTodayResponse = z.infer<typeof PuzzleTodayResponseSchema>;

export const PuzzleGuessRequestSchema = z.object({
  guess: z.string().regex(PUZZLE_GUESS_REGEX),
});
export type PuzzleGuessRequest = z.infer<typeof PuzzleGuessRequestSchema>;

// Same shape as today (the new truth after the guess); correct echoes whether
// THIS guess won, so the client can celebrate without diffing.
export const PuzzleGuessResponseSchema = PuzzleTodayResponseSchema.extend({
  correct: z.boolean(),
});
export type PuzzleGuessResponse = z.infer<typeof PuzzleGuessResponseSchema>;

// GET /api/puzzle/today/friends — DM partners who OPTED IN by posting a
// puzzle_result for today into a conversation I participate in. Ordered by
// username, NEVER by score or speed: a shared grid is fine, a ranked table is
// on the PSYCHOLOGY never-build list. No streaks anywhere.
export const PuzzleFriendEntrySchema = z.object({
  user: UserLiteSchema,
  result: PuzzleResultMetadataSchema,
});
export type PuzzleFriendEntry = z.infer<typeof PuzzleFriendEntrySchema>;

export const PuzzleFriendsResponseSchema = z.object({
  friends: z.array(PuzzleFriendEntrySchema),
});
export type PuzzleFriendsResponse = z.infer<typeof PuzzleFriendsResponseSchema>;

// ===========================================================================
// v0.5a — Social layer (API.md §1.28–§1.37, ADR-011)
// ===========================================================================

// ---------------------------------------------------------------------------
// §1.28 Connections. The unordered pair is unique; status is 'pending' until
// the addressee accepts. FRIENDS-OF (the audience primitive) = accepted
// connections UNION dm-partners, always minus §1.14 blocks. Declines DELETE
// the row and are SILENT to the requester (no rejection ping — liking gap,
// PSYCHOLOGY §9); removal is silent to the removed party the same way.
// ---------------------------------------------------------------------------

export const ConnectionStatusSchema = z.enum(['pending', 'accepted']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

// Viewer-specific: `user` is the OTHER party; direction says who asked whom.
export const ConnectionSchema = z.object({
  id: UuidSchema,
  user: UserLiteSchema,
  direction: z.enum(['incoming', 'outgoing']),
  status: ConnectionStatusSchema,
  created_at: IsoDateTimeSchema,
  responded_at: IsoDateTimeSchema.nullable(), // non-null iff status 'accepted'
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionResponseSchema = z.object({ connection: ConnectionSchema });
export type ConnectionResponse = z.infer<typeof ConnectionResponseSchema>;

export const ListConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema), // accepted, ordered by username
  incoming: z.array(ConnectionSchema), // pending requests TO me, created_at ASC
  outgoing: z.array(ConnectionSchema), // my pending requests, created_at ASC
});
export type ListConnectionsResponse = z.infer<typeof ListConnectionsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.30 Edit & delete. PATCH is author-only, EDITABLE_MESSAGE_TYPES, within
// EDIT_WINDOW_S; DELETE tombstones (§1.25 semantics — body nulled, metadata
// emptied, attachments deleted, seq survives forever). Both fan out
// msg.updated; the edited badge is edited_at != null on the DTO.
// ---------------------------------------------------------------------------

export const EditableMessageTypeSchema = z.enum(EDITABLE_MESSAGE_TYPES);
export type EditableMessageType = z.infer<typeof EditableMessageTypeSchema>;

export const EditMessageRequestSchema = z.object({
  body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
});
export type EditMessageRequest = z.infer<typeof EditMessageRequestSchema>;

export const EditMessageResponseSchema = z.object({ message: MessageSchema });
export type EditMessageResponse = z.infer<typeof EditMessageResponseSchema>;

// ---------------------------------------------------------------------------
// §1.31 Forwarding. All-or-nothing across ≤ FORWARD_MAX_TARGETS targets; the
// shared client_msg_id makes retries idempotent per target (the existing
// per-conversation idempotency index). Attachments are RE-REFERENCED (new
// rows, same content-hash objects), never re-uploaded.
// ---------------------------------------------------------------------------

export const ForwardMessageRequestSchema = z.object({
  client_msg_id: UuidSchema, // reused across targets; per-target idempotency
  target_conversation_ids: z.array(UuidSchema).min(1).max(FORWARD_MAX_TARGETS),
});
export type ForwardMessageRequest = z.infer<typeof ForwardMessageRequestSchema>;

// Created messages in target order (replayed targets return existing rows).
export const ForwardMessageResponseSchema = z.object({
  messages: z.array(MessageSchema),
});
export type ForwardMessageResponse = z.infer<typeof ForwardMessageResponseSchema>;

// ---------------------------------------------------------------------------
// §1.32 Pins. ConversationPinSchema lives with the core DTOs (Conversation
// embeds the list). Pin/unpin fan out conv.updated.
// ---------------------------------------------------------------------------

export const PinMessageRequestSchema = z.object({
  seq: z.number().int().positive(),
});
export type PinMessageRequest = z.infer<typeof PinMessageRequestSchema>;

// ---------------------------------------------------------------------------
// §1.34 Stories. 24 h, audience FRIENDS-OF only (enum value 'friends_of' is
// CHECK-pinned — one value today, stable for later options). Views are a PK
// row (story_id, viewer_id) with NO timestamp column at all: the DB cannot
// leak what it does not store (PSYCHOLOGY never-build list). View lists are
// author-private faces ordered by username.
// ---------------------------------------------------------------------------

export const StoryAudienceSchema = z.enum(['friends_of']);
export type StoryAudience = z.infer<typeof StoryAudienceSchema>;

// ---- v0.8b canvas stories (§1.66, FEATURES #79a, ADR-020) ----

// Per-story author mode: 'off' (just viewing — the DEFAULT; being drawable is
// always the author's invitation), 'open' (viewer overlays go live at once),
// 'approve' (viewer overlays hold as 'pending' until the author approves).
export const StoryCanvasModeSchema = z.enum(STORY_CANVAS_MODES);
export type StoryCanvasMode = z.infer<typeof StoryCanvasModeSchema>;

// VECTOR overlay payloads — stored as data, NEVER burned into the image, so
// removal is total and attribution survives. Coordinates are normalized 0..1
// of the story frame (x right, y down); stroke width is px at a 512 reference
// edge. Shape authority is HERE (the house jsonb pattern — the DB pins only
// jsonb_typeof).
export const StoryOverlayPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stroke'), // the v0.4 doodle brush, as points
    points: z
      .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
      .min(OVERLAY_STROKE_POINTS_MIN)
      .max(OVERLAY_STROKE_POINTS_MAX),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(OVERLAY_STROKE_WIDTH_MIN).max(OVERLAY_STROKE_WIDTH_MAX),
  }),
  z.object({
    kind: z.literal('emoji'), // draggable stamp
    emoji: z.string().min(1).max(REACTION_EMOJI_MAX_LEN),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    scale: z.number().min(OVERLAY_EMOJI_SCALE_MIN).max(OVERLAY_EMOJI_SCALE_MAX).default(1),
  }),
  z.object({
    kind: z.literal('text'), // short text bubble
    text: z.string().min(1).max(OVERLAY_TEXT_MAX_CHARS),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
]);
export type StoryOverlayPayload = z.infer<typeof StoryOverlayPayloadSchema>;

// One attributed layer. Every overlay wears its contributor's username chip
// and is tappable → "drawn by @x" → profile (binding render contract, §1.66).
// status 'pending' serializes ONLY to the overlay author and the story author
// (everyone else's DTO simply omits it); 'removed' serializes to NOBODY —
// the tombstone exists for reports alone.
export const StoryOverlaySchema = z.object({
  id: UuidSchema,
  story_id: UuidSchema,
  author: UserLiteSchema,
  kind: z.enum(STORY_OVERLAY_KINDS),
  payload: StoryOverlayPayloadSchema,
  status: z.enum(STORY_OVERLAY_STATUSES),
  created_at: IsoDateTimeSchema,
});
export type StoryOverlay = z.infer<typeof StoryOverlaySchema>;

// viewed is viewer-specific. NO view counts anywhere on the DTO.
export const StorySchema = z.object({
  id: UuidSchema,
  author: UserLiteSchema,
  attachment: AttachmentSchema,
  caption: z.string().max(STORY_CAPTION_MAX_CHARS),
  audience: StoryAudienceSchema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  viewed: z.boolean(),
  // ---- v0.8b (§1.66). Defaults keep pre-v0.8b payloads parsing clean. ----
  canvas_mode: StoryCanvasModeSchema.default('off'),
  // Live overlays (plus the viewer's own / the author's pending ones),
  // created_at ASC — layers paint in arrival order. The contributor strip
  // ("🎨 maya, arjun +3") derives client-side from these FACES; no contributor
  // count is ever serialized on its own (PSYCHOLOGY rule 3).
  overlays: z.array(StoryOverlaySchema).default([]),
});
export type Story = z.infer<typeof StorySchema>;

export const CreateStoryRequestSchema = z.object({
  attachment_id: UuidSchema, // mine, kind image|video, unbound
  caption: z.string().max(STORY_CAPTION_MAX_CHARS).default(''),
  // v0.8b (§1.66): the canvas invitation — DEFAULT OFF, always the author's
  // choice. Switchable later via PATCH /api/stories/:id.
  canvas_mode: StoryCanvasModeSchema.default('off'),
});
export type CreateStoryRequest = z.infer<typeof CreateStoryRequestSchema>;

// §1.34 afterglow integration: share a recap photo to my story. The seq names
// the afterglow recap system message; attachment_id must be one of its
// metadata.afterglow.photo_attachment_ids. The server re-references the
// object (new attachment row) — recap photos never leave the plan group
// except through a participant's own deliberate share (PSYCHOLOGY rule 2).
export const CreateRecapStoryRequestSchema = z.object({
  conversation_id: UuidSchema,
  seq: z.number().int().positive(),
  attachment_id: UuidSchema,
  caption: z.string().max(STORY_CAPTION_MAX_CHARS).default(''),
});
export type CreateRecapStoryRequest = z.infer<typeof CreateRecapStoryRequestSchema>;

export const StoryResponseSchema = z.object({ story: StorySchema });
export type StoryResponse = z.infer<typeof StoryResponseSchema>;

// Grouped by author: authors with ANY unviewed story first, then all-viewed
// authors; each bucket ordered by username (no recency ranking — a finite
// tray, not a feed). Within an author: created_at ASC (watch in order). My
// own stories ride a separate `mine` list.
export const StoryAuthorGroupSchema = z.object({
  author: UserLiteSchema,
  stories: z.array(StorySchema),
});
export type StoryAuthorGroup = z.infer<typeof StoryAuthorGroupSchema>;

export const ListStoriesResponseSchema = z.object({
  mine: z.array(StorySchema),
  groups: z.array(StoryAuthorGroupSchema),
});
export type ListStoriesResponse = z.infer<typeof ListStoriesResponseSchema>;

// Author-private view list: faces/names ordered by username — NO timestamps,
// NO counts beyond the list itself (§1.18 seen-by pattern, FEATURES #27).
export const StoryViewsResponseSchema = z.object({
  viewers: z.array(UserLiteSchema),
});
export type StoryViewsResponse = z.infer<typeof StoryViewsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.36 Feed. Posts by my FRIENDS-OF set + me, newest first, cursor-paginated,
// FINITE: the terminal page answers all_caught_up=true and next_cursor=null —
// a hard end, no wraparound, no recommendations, first-party only
// (PSYCHOLOGY design rule 5). No share/repost mechanic exists.
// ---------------------------------------------------------------------------

// ---- v0.7 lanes & interactive posts (§1.49/§1.50, ADR-016) ----

export const PostKindSchema = z.enum(POST_KINDS);
export type PostKind = z.infer<typeof PostKindSchema>;

// 'public' posts feed the discover lane (§1.49) — visible to every
// non-blocked, non-banned user; 'friends_of' stays the v0.5a audience.
export const PostAudienceSchema = z.enum(POST_AUDIENCES);
export type PostAudience = z.infer<typeof PostAudienceSchema>;

export const FeedLaneSchema = z.enum(FEED_LANES);
export type FeedLane = z.infer<typeof FeedLaneSchema>;

// §1.50 poll posts. counts ARE serialized here — a vote tally on OPTIONS is a
// decision tool, not approval attached to a person (ADR-016 argues the
// distinction vs PSYCHOLOGY rule 3; the §1.17 chat-poll precedent). No voter
// lists, no vote timestamps, ever. my_vote is viewer-specific.
export const PostPollSchema = z.object({
  question: z.string().min(1).max(POST_POLL_QUESTION_MAX_CHARS),
  options: z
    .array(z.string().min(1).max(POLL_OPTION_MAX_CHARS))
    .min(POLL_OPTIONS_MIN)
    .max(POLL_OPTIONS_MAX),
  counts: z.array(z.number().int().nonnegative()), // same length as options
  total_votes: z.number().int().nonnegative(),
  my_vote: z.number().int().nonnegative().nullable(),
});
export type PostPoll = z.infer<typeof PostPollSchema>;

// §1.50 game posts: an OPEN tic-tac-toe challenge — first claimer gets the
// game (advisory-locked claim). players = post.author (x, moves first) vs
// claimed_by (o); the game itself is an ordinary §1.27 game_ttt message in
// the pair's DM — only its players see the board, the post shows the claim.
export const PostGameSchema = z.object({
  state: z.enum(['open', 'claimed']),
  claimed_by: UserLiteSchema.nullable(),
});
export type PostGame = z.infer<typeof PostGameSchema>;

// §1.50 join_card ref: what the card points at. Stored verbatim (posts.ref
// jsonb); the LIVE state rides ref_summary, resolved per viewer at
// serialization time (the reply_context pattern).
export const PostRefSchema = z.object({
  type: z.enum(POST_REF_TYPES),
  id: UuidSchema,
});
export type PostRef = z.infer<typeof PostRefSchema>;

// §1.50 join_card live summaries — SERVER-resolved per viewer on every read,
// so the card always shows current truth (sparked/expired/closed states
// included) and never widens the ref's audience: a viewer the ref is not
// visible to (audience, blocks, ban) gets ref_summary: null and the client
// renders the "no longer available" card. joiners carries at most
// JOIN_CARD_SUMMARY_JOINERS_MAX faces (the pile preview).
export const JoinCardBeaconSummarySchema = z.object({
  type: z.literal('beacon'),
  id: UuidSchema,
  vibe: BeaconVibeSchema,
  custom_vibe_emoji: z.string().nullable(),
  custom_vibe_label: z.string().nullable(),
  note: z.string(),
  status: BeaconStatusSchema,
  starts_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  joiners: z.array(UserLiteSchema),
  needs: z.number().int().nonnegative(),
  my_state: BeaconMyStateSchema,
  location: LocationSchema.nullable(),
});
export type JoinCardBeaconSummary = z.infer<typeof JoinCardBeaconSummarySchema>;

export const JoinCardListingSummarySchema = z.object({
  type: z.literal('listing'),
  id: UuidSchema,
  kind: ListingKindSchema,
  title: z.string(),
  price_text: z.string().nullable(),
  status: ListingStatusSchema,
  area: z.string(),
  my_contacted: z.boolean(),
  location: LocationSchema.nullable(),
});
export type JoinCardListingSummary = z.infer<typeof JoinCardListingSummarySchema>;

export const JoinCardSummarySchema = z.discriminatedUnion('type', [
  JoinCardBeaconSummarySchema,
  JoinCardListingSummarySchema,
]);
export type JoinCardSummary = z.infer<typeof JoinCardSummarySchema>;

// §1.51 comment reactions: one chip per (emoji, kind) — capped FACES, never a
// numeric total (the PostReactionAggregate rule). Stamps are kind='stamp'
// with the STAMP_REACTION_KEY sentinel as emoji (the §1.19 machinery);
// reactors = first COMMENT_REACTORS_PREVIEW_MAX by first-reaction order.
export const CommentReactionAggregateSchema = z.object({
  emoji: ReactionEmojiSchema,
  kind: ReactionKindSchema,
  reactors: z.array(UserLiteSchema),
  has_more: z.boolean(),
  mine: z.boolean(),
});
export type CommentReactionAggregate = z.infer<typeof CommentReactionAggregateSchema>;

// Named faces, never a numeric total: reactors = first
// POST_REACTORS_PREVIEW_MAX by first-reaction order; has_more carries the
// rest. There is deliberately NO count field (PSYCHOLOGY design rule 3).
export const PostReactionAggregateSchema = z.object({
  emoji: ReactionEmojiSchema,
  reactors: z.array(UserLiteSchema),
  has_more: z.boolean(),
  mine: z.boolean(),
});
export type PostReactionAggregate = z.infer<typeof PostReactionAggregateSchema>;

// v0.7 (§1.51): body loses its min — an image/GIF-only comment is legal (at
// least one of body/attachment, route-enforced at create). attachment rides
// the EXISTING §1.6 pipeline (kind image; a GIF is just an image upload).
export const PostCommentSchema = z.object({
  id: UuidSchema,
  post_id: UuidSchema,
  author: UserLiteSchema,
  body: z.string().max(POST_COMMENT_MAX_CHARS),
  attachment: AttachmentSchema.nullable().default(null), // v0.7 (§1.51)
  reactions: z.array(CommentReactionAggregateSchema).default([]), // v0.7 (§1.51)
  created_at: IsoDateTimeSchema,
});
export type PostComment = z.infer<typeof PostCommentSchema>;

// comments = the latest POST_COMMENTS_PREVIEW_MAX in created_at ASC;
// has_more_comments carries the rest (no comment COUNT is ever serialized).
// v0.7 (§1.49/§1.50): kind + audience + the per-kind riders (poll/game/
// ref+ref_summary) and the §1.52 location chip. Every default keeps pre-v0.7
// payloads parsing clean; poll/game/ref are non-null iff kind matches.
export const PostSchema = z.object({
  id: UuidSchema,
  author: UserLiteSchema,
  kind: PostKindSchema.default('text'),
  audience: PostAudienceSchema.default('friends_of'),
  body: z.string().max(POST_BODY_MAX_CHARS),
  attachments: z.array(AttachmentSchema).max(POST_MAX_ATTACHMENTS),
  reactions: z.array(PostReactionAggregateSchema),
  comments: z.array(PostCommentSchema),
  has_more_comments: z.boolean(),
  poll: PostPollSchema.nullable().default(null), // iff kind='poll'; my_vote viewer-specific
  game: PostGameSchema.nullable().default(null), // iff kind='game'
  ref: PostRefSchema.nullable().default(null), // iff kind='join_card'
  ref_summary: JoinCardSummarySchema.nullable().default(null), // viewer-resolved; null = gone/hidden
  location: LocationSchema.nullable().default(null), // §1.52
  created_at: IsoDateTimeSchema,
});
export type Post = z.infer<typeof PostSchema>;

// Per-kind shape rules are route-enforced (400 bad_post_shape): 'text' needs
// at least one of body/attachment_ids (400 empty_post, the v0.5a rule);
// 'poll' requires poll and forbids attachments; 'game' forbids poll/ref/
// attachments (body = the trash-talk caption); 'join_card' requires ref and
// forbids attachments. audience must nest inside the ref's audience for
// join_cards (§1.50 audience-intersection rule, 400 ref_audience_mismatch).
export const CreatePostRequestSchema = z.object({
  kind: PostKindSchema.default('text'),
  audience: PostAudienceSchema.default('friends_of'),
  body: z.string().max(POST_BODY_MAX_CHARS).default(''),
  attachment_ids: z.array(UuidSchema).max(POST_MAX_ATTACHMENTS).default([]),
  poll: z
    .object({
      question: z.string().min(1).max(POST_POLL_QUESTION_MAX_CHARS),
      options: z
        .array(z.string().min(1).max(POLL_OPTION_MAX_CHARS))
        .min(POLL_OPTIONS_MIN)
        .max(POLL_OPTIONS_MAX),
    })
    .optional(),
  ref: PostRefSchema.optional(),
  location: LocationSchema.nullable().optional(),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const PostResponseSchema = z.object({ post: PostSchema });
export type PostResponse = z.infer<typeof PostResponseSchema>;

// v0.7 (§1.49): lane picks the feed — 'friends' (the v0.5a feed: my
// friends-of set + me, every audience) or 'discover' (audience='public'
// posts instance-wide, minus blocks and banned authors). Both are FINITE
// (all_caught_up), both created_at DESC, no ranking in either.
export const FeedQuerySchema = z.object({
  lane: FeedLaneSchema.default('friends'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

// all_caught_up=true ⇔ next_cursor=null: the hard "you're all caught up" end.
export const FeedResponseSchema = z.object({
  posts: z.array(PostSchema),
  next_cursor: z.string().nullable(),
  all_caught_up: z.boolean(),
});
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

export const AddPostReactionRequestSchema = z.object({
  emoji: ReactionEmojiSchema,
});
export type AddPostReactionRequest = z.infer<typeof AddPostReactionRequestSchema>;

// v0.7 (§1.51): at least one of body / attachment_id (route-enforced →
// 400 empty_comment). The attachment must be mine, kind 'image', unbound.
export const CreateCommentRequestSchema = z.object({
  body: z.string().max(POST_COMMENT_MAX_CHARS).default(''),
  attachment_id: UuidSchema.optional(),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;

export const CommentResponseSchema = z.object({ comment: PostCommentSchema });
export type CommentResponse = z.infer<typeof CommentResponseSchema>;

// ---- v0.7 interactive-post actions (§1.50) ----

// POST /api/posts/:id/poll/vote — UPSERT on (post, me): revoting replaces
// (the §1.17 semantics). DELETE unvotes. Both answer the fresh aggregate.
export const PostPollVoteRequestSchema = z.object({
  option_idx: z.number().int().nonnegative(),
});
export type PostPollVoteRequest = z.infer<typeof PostPollVoteRequestSchema>;

export const PostPollResponseSchema = z.object({ poll: PostPollSchema });
export type PostPollResponse = z.infer<typeof PostPollResponseSchema>;

// POST /api/posts/:id/claim-game — the FIRST claimer (advisory-locked +
// guarded UPDATE) gets the game: a DM with the author (dm_key create-or-
// dedupe) carrying an ordinary §1.27 game_ttt message. conversation_id +
// game_seq land the claimer straight on the board.
export const ClaimGameResponseSchema = z.object({
  post: PostSchema,
  conversation_id: UuidSchema,
  game_seq: z.number().int().positive(),
});
export type ClaimGameResponse = z.infer<typeof ClaimGameResponseSchema>;

// ---- v0.7 comment reactions (§1.51) — the §1.19 request shape verbatim ----

export const AddCommentReactionRequestSchema = z
  .object({
    kind: ReactionKindSchema.default('emoji'),
    emoji: ReactionEmojiSchema.optional(),
  })
  .refine((r) => (r.kind === 'emoji') === (r.emoji !== undefined), {
    message: "emoji is required for kind 'emoji' and forbidden for kind 'stamp'",
  });
export type AddCommentReactionRequest = z.infer<typeof AddCommentReactionRequestSchema>;

export const ListCommentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type ListCommentsQuery = z.infer<typeof ListCommentsQuerySchema>;

export const ListCommentsResponseSchema = z.object({
  comments: z.array(PostCommentSchema), // created_at ASC
  next_cursor: z.string().nullable(),
});
export type ListCommentsResponse = z.infer<typeof ListCommentsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.37 Rich profiles. Profile data rides GET /api/users/:username (and the
// owner's PATCH /api/users/me/profile) — NOT UserPublic, which is embedded in
// every participant list and must stay lean. Blocked viewers keep getting the
// §1.14 404 for the whole profile page.
// ---------------------------------------------------------------------------

export const ProfileEntryKindSchema = z.enum(['work', 'skill']);
export type ProfileEntryKind = z.infer<typeof ProfileEntryKindSchema>;

export const ProfileEntrySchema = z.object({
  id: UuidSchema,
  kind: ProfileEntryKindSchema,
  title: z.string().min(1).max(PROFILE_ENTRY_TITLE_MAX_CHARS),
  detail: z.string().max(PROFILE_ENTRY_DETAIL_MAX_CHARS),
});
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;

// media = the 3-GIF strip: ≤ PROFILE_MEDIA_MAX image attachments in order_idx
// order (animated rendering honors §5 motion hygiene like every avatar).
export const ProfileSchema = z.object({
  interests: z.array(z.string().min(1).max(INTEREST_TAG_MAX_CHARS)).max(INTERESTS_MAX),
  entries: z.array(ProfileEntrySchema).max(PROFILE_ENTRIES_MAX), // order_idx ASC
  media: z.array(AttachmentSchema).max(PROFILE_MEDIA_MAX),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileResponseSchema = z.object({ profile: ProfileSchema });
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

// ---------------------------------------------------------------------------
// v0.5b (§1.40) — marketplace trust, defined here because the profile response
// below embeds it. A person review exists only after a real §1.39 listing
// contact between the two parties; star averages are SAFETY INFORMATION about
// transacting with a stranger, not social approval (the distinction vs
// PSYCHOLOGY design rule 3 is argued in ADR-012). Nothing anywhere ranks or
// sorts people by rating.
// ---------------------------------------------------------------------------

// One review, as the subject's profile shows it. listing_kind is a SNAPSHOT
// (the review survives deletion of the listing that brokered it); the full
// listing is deliberately not resolved — the review is about the person.
export const PersonReviewSchema = z.object({
  id: UuidSchema,
  reviewer: UserLiteSchema,
  rating: z.number().int().min(LISTING_RATING_MIN).max(LISTING_RATING_MAX),
  body: z.string().max(PERSON_REVIEW_BODY_MAX_CHARS),
  listing_kind: ListingKindSchema,
  created_at: IsoDateTimeSchema,
});
export type PersonReview = z.infer<typeof PersonReviewSchema>;

// avg_rating: rounded to TRUST_AVG_DECIMALS, and null while review_count <
// TRUST_AVG_MIN_REVIEWS (a one-review average reads like a verdict). recent =
// newest TRUST_RECENT_REVIEWS_MAX, minus reviewers blocked w.r.t. the viewer
// (count/avg stay computed over all reviews — §1.14 filters serialization).
export const TrustSchema = z.object({
  review_count: z.number().int().nonnegative(),
  avg_rating: z.number().min(LISTING_RATING_MIN).max(LISTING_RATING_MAX).nullable(),
  recent: z.array(PersonReviewSchema).max(TRUST_RECENT_REVIEWS_MAX),
});
export type Trust = z.infer<typeof TrustSchema>;

// GET /api/users/:username (v0.5a shape — additive: `profile` joins `user`;
// v0.5b adds `trust`, defaulted so pre-v0.5b payloads parse clean).
export const UserProfileResponseSchema = z.object({
  user: UserPublicSchema,
  profile: ProfileSchema,
  trust: TrustSchema.default({ review_count: 0, avg_rating: null, recent: [] }),
});
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

// Full-replace per present field; omitted fields are untouched. Entry order =
// array order; media order = array order (order_idx 0..2).
export const UpdateProfileRequestSchema = z.object({
  interests: z
    .array(z.string().min(1).max(INTEREST_TAG_MAX_CHARS))
    .max(INTERESTS_MAX)
    .optional(),
  entries: z
    .array(
      z.object({
        kind: ProfileEntryKindSchema,
        title: z.string().min(1).max(PROFILE_ENTRY_TITLE_MAX_CHARS),
        detail: z.string().max(PROFILE_ENTRY_DETAIL_MAX_CHARS).default(''),
      }),
    )
    .max(PROFILE_ENTRIES_MAX)
    .optional(),
  media_attachment_ids: z.array(UuidSchema).max(PROFILE_MEDIA_MAX).optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// ---------------------------------------------------------------------------
// §1.35 Channels — membership paging & role management. The Conversation DTO
// for channels carries only owner + admins + the viewer's own row, so the
// member list is a dedicated paged read (owner/admin only in channels; any
// active participant in groups). `q` powers mention autocomplete (§1.33).
// ---------------------------------------------------------------------------

export const ListParticipantsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  q: z.string().min(1).optional(), // username/display_name prefix filter
});
export type ListParticipantsQuery = z.infer<typeof ListParticipantsQuerySchema>;

export const ListParticipantsResponseSchema = z.object({
  participants: z.array(ParticipantSchema), // ordered by username
  next_cursor: z.string().nullable(),
});
export type ListParticipantsResponse = z.infer<typeof ListParticipantsResponseSchema>;

// Channels: owner only. Groups: any admin. 'owner' is never assignable.
export const UpdateParticipantRoleRequestSchema = z.object({
  role: z.enum(['member', 'admin']),
});
export type UpdateParticipantRoleRequest = z.infer<typeof UpdateParticipantRoleRequestSchema>;

// ===========================================================================
// v0.5b — Local board + admin (API.md §1.38–§1.41, ADR-012/ADR-013)
// ===========================================================================

// ---------------------------------------------------------------------------
// §1.38 Listings. ONE table, four card kinds; per-kind payloads live in a
// jsonb `details` column validated by the discriminated schemas below (the
// house metadata pattern — Zod is the shape authority, the DB pins only
// jsonb_typeof). The board is PULL-BASED: no WS events, no push, ever —
// a listing is an offer, not an interruption (PSYCHOLOGY design rules 2/4).
// All price fields are DISPLAY TEXT: no payment machinery exists (FEATURES
// #45); gig/ride/room detail views render LISTING_SAFETY_NOTE verbatim.
// ---------------------------------------------------------------------------

// ListingStatusSchema moved up beside ListingKindSchema in v0.7 (the §1.50
// join_card summary needs it ahead of the feed block).

export const GigDirectionSchema = z.enum(LISTING_GIG_DIRECTIONS);
export type GigDirection = z.infer<typeof GigDirectionSchema>;

// kind='gig' — "work together / hire me" (FEATURES #39). direction: offering
// = portfolio/hire-me; seeking = I need people/a gig.
export const GigDetailsSchema = z.object({
  direction: GigDirectionSchema,
  // v1.0a (#91): photos on every kind — mine, kind image, unbound at create;
  // bound via attachments.listing_id (the post_id GC-shield pattern).
  attachment_ids: z.array(UuidSchema).max(LISTING_PHOTOS_MAX).default([]),
  tags: z
    .array(z.string().min(1).max(LISTING_GIG_TAG_MAX_CHARS))
    .max(LISTING_GIG_TAGS_MAX)
    .default([]),
});
export type GigDetails = z.infer<typeof GigDetailsSchema>;

// kind='ride' (FEATURES #40). departs_at doubles as the listing's expires_at.
export const RideDetailsSchema = z.object({
  // v1.0a (#91): photos on every kind — mine, kind image, unbound at create;
  // bound via attachments.listing_id (the post_id GC-shield pattern).
  attachment_ids: z.array(UuidSchema).max(LISTING_PHOTOS_MAX).default([]),
  from_text: z.string().min(1).max(LISTING_RIDE_LEG_MAX_CHARS),
  to_text: z.string().min(1).max(LISTING_RIDE_LEG_MAX_CHARS),
  departs_at: IsoDateTimeSchema,
  seats: z.number().int().min(LISTING_RIDE_SEATS_MIN).max(LISTING_RIDE_SEATS_MAX),
});
export type RideDetails = z.infer<typeof RideDetailsSchema>;

// kind='room' (FEATURES #41). attachment_ids ride the EXISTING §1.6 upload
// pipeline (kind 'image', mine, unbound at create; bound via
// attachments.listing_id — the post_id GC-shield pattern). The DTO resolves
// them into Listing.photos; available_from is a plain date (timezone-blind,
// like the §1.15 window chips).
export const RoomDetailsSchema = z.object({
  monthly_price_text: z.string().max(LISTING_PRICE_TEXT_MAX_CHARS).nullable().default(null),
  available_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  attachment_ids: z.array(UuidSchema).max(LISTING_PHOTOS_MAX).default([]),
});
export type RoomDetails = z.infer<typeof RoomDetailsSchema>;

// kind='place_review' (FEATURES #42). rating here is about a PLACE, not a
// person — PSYCHOLOGY rule 3 is about scoring people; venues are fair game.
// These never expire and later feed beacon venue suggestions.
export const PlaceReviewDetailsSchema = z.object({
  // v1.0a (#91): photos on every kind — mine, kind image, unbound at create;
  // bound via attachments.listing_id (the post_id GC-shield pattern).
  attachment_ids: z.array(UuidSchema).max(LISTING_PHOTOS_MAX).default([]),
  place_name: z.string().min(1).max(LISTING_PLACE_NAME_MAX_CHARS),
  rating: z.number().int().min(LISTING_RATING_MIN).max(LISTING_RATING_MAX),
});
export type PlaceReviewDetails = z.infer<typeof PlaceReviewDetailsSchema>;

// Shared DTO fields (spread into each kind branch below).
const ListingDtoBase = {
  id: UuidSchema,
  author: UserLiteSchema,
  title: z.string().min(1).max(LISTING_TITLE_MAX_CHARS),
  body: z.string().max(LISTING_BODY_MAX_CHARS),
  // DISPLAY TEXT ONLY — never parsed, never charged (FEATURES #45).
  price_text: z.string().max(LISTING_PRICE_TEXT_MAX_CHARS).nullable(),
  // The author's area snapshot at mint (citext equality, the beacons.area
  // pattern). Always serialized: a card names where it applies.
  area: z.string(),
  // false = visible to same-area users only; true = board-wide.
  is_public: z.boolean(),
  status: ListingStatusSchema,
  // §1.38 photos, resolved server-side from details.attachment_ids
  // (v1.0a #91: every kind; [] when none).
  photos: z.array(AttachmentSchema).default([]),
  // Viewer-specific: I already contacted this listing (the "Message me"
  // button flips to "Open chat"). Always false for the author.
  my_contacted: z.boolean().default(false),
  // §1.39 team-up: the project group. Non-null ONLY for the author and the
  // picked members (everyone else always sees null — the beacon
  // conversation_id pattern).
  conversation_id: UuidSchema.nullable().default(null),
  // v0.7 (§1.52): optional place chip, the ONE Location shape.
  location: LocationSchema.nullable().default(null),
  // v0.7 (§1.48): set on every effective author edit — the card renders the
  // "edited" marker from it (the §1.30 pattern; no edit history).
  edited_at: IsoDateTimeSchema.nullable().default(null),
  created_at: IsoDateTimeSchema,
  // gig/room: created_at + LISTING_TTL_S; ride: details.departs_at;
  // place_review: null (never expires).
  expires_at: IsoDateTimeSchema.nullable(),
};

export const ListingSchema = z.discriminatedUnion('kind', [
  z.object({ ...ListingDtoBase, kind: z.literal('gig'), details: GigDetailsSchema }),
  z.object({ ...ListingDtoBase, kind: z.literal('ride'), details: RideDetailsSchema }),
  z.object({ ...ListingDtoBase, kind: z.literal('room'), details: RoomDetailsSchema }),
  z.object({
    ...ListingDtoBase,
    kind: z.literal('place_review'),
    details: PlaceReviewDetailsSchema,
  }),
]);
export type Listing = z.infer<typeof ListingSchema>;

// Create fields shared by every kind. `area` defaults to my users.area; a
// request with neither → 400 area_required (the §1.15 beacon rule).
const CreateListingBase = {
  title: z.string().min(1).max(LISTING_TITLE_MAX_CHARS),
  body: z.string().max(LISTING_BODY_MAX_CHARS).default(''),
  price_text: z.string().min(1).max(LISTING_PRICE_TEXT_MAX_CHARS).nullable().optional(),
  area: z.string().min(1).max(AREA_MAX_CHARS).optional(),
  is_public: z.boolean().default(false),
  location: LocationSchema.nullable().optional(), // v0.7 (§1.52)
};

export const CreateListingRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...CreateListingBase, kind: z.literal('gig'), details: GigDetailsSchema }),
  z.object({ ...CreateListingBase, kind: z.literal('ride'), details: RideDetailsSchema }),
  z.object({ ...CreateListingBase, kind: z.literal('room'), details: RoomDetailsSchema }),
  z.object({
    ...CreateListingBase,
    kind: z.literal('place_review'),
    details: PlaceReviewDetailsSchema,
  }),
]);
export type CreateListingRequest = z.infer<typeof CreateListingRequestSchema>;

// v0.7 (§1.48): PATCH /api/listings/:id — author only, status 'active' only.
// kind is ECHOED to pick the validation branch and must match the row (it is
// immutable — 400 kind_immutable). Every present field full-replaces; details
// (when present) is the COMPLETE per-kind payload, revalidated exactly like
// create (ride departs_at re-copied to expires_at; room attachment_ids re-
// bound/unbound). area and expiry rules never change on edit. Omitted =
// unchanged; location takes explicit null to clear.
const UpdateListingBase = {
  title: z.string().min(1).max(LISTING_TITLE_MAX_CHARS).optional(),
  body: z.string().max(LISTING_BODY_MAX_CHARS).optional(),
  price_text: z.string().min(1).max(LISTING_PRICE_TEXT_MAX_CHARS).nullable().optional(),
  is_public: z.boolean().optional(),
  location: LocationSchema.nullable().optional(),
};

export const UpdateListingRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...UpdateListingBase, kind: z.literal('gig'), details: GigDetailsSchema.optional() }),
  z.object({
    ...UpdateListingBase,
    kind: z.literal('ride'),
    details: RideDetailsSchema.optional(),
  }),
  z.object({
    ...UpdateListingBase,
    kind: z.literal('room'),
    details: RoomDetailsSchema.optional(),
  }),
  z.object({
    ...UpdateListingBase,
    kind: z.literal('place_review'),
    details: PlaceReviewDetailsSchema.optional(),
  }),
]);
export type UpdateListingRequest = z.infer<typeof UpdateListingRequestSchema>;

export const ListingResponseSchema = z.object({ listing: ListingSchema });
export type ListingResponse = z.infer<typeof ListingResponseSchema>;

// GET /api/listings — the board read. `area` defaults to MY area (visibility:
// same-area OR is_public, minus §1.14 blocks both ways — route-enforced);
// `q` is an ILIKE substring over title + details->>'place_name'.
export const ListListingsQuerySchema = z.object({
  kind: ListingKindSchema.optional(),
  area: z.string().min(1).max(AREA_MAX_CHARS).optional(),
  q: z.string().min(1).max(LISTING_SEARCH_MAX_CHARS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type ListListingsQuery = z.infer<typeof ListListingsQuerySchema>;

export const ListListingsResponseSchema = z.object({
  listings: z.array(ListingSchema), // created_at DESC, keyset cursor
  next_cursor: z.string().nullable(),
});
export type ListListingsResponse = z.infer<typeof ListListingsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.39 Message-the-author & gig team-up.
// ---------------------------------------------------------------------------

// POST /api/listings/:id/contact — no body. Creates/dedupes the DM (the §1.4
// dm_key path verbatim) and drops ONE 'listing_contact' system message with
// metadata.listing_ref; records the (listing, me) contact row that gates
// §1.40 reviews and feeds the team-up pick pool. Idempotent per listing.
export const ContactListingResponseSchema = z.object({
  conversation_id: UuidSchema,
});
export type ContactListingResponse = z.infer<typeof ContactListingResponseSchema>;

// Author-only pick pool for team-up: everyone who contacted, username order.
export const ListingContactsResponseSchema = z.object({
  contacts: z.array(UserLiteSchema),
});
export type ListingContactsResponse = z.infer<typeof ListingContactsResponseSchema>;

// POST /api/listings/:id/team-up — author only, gigs only. user_ids must all
// have contacted the listing; + the author = a group of ≤ TEAM_UP_MAX_PICKS+1.
export const TeamUpRequestSchema = z.object({
  user_ids: z.array(UuidSchema).min(1).max(TEAM_UP_MAX_PICKS),
});
export type TeamUpRequest = z.infer<typeof TeamUpRequestSchema>;

// ---------------------------------------------------------------------------
// §1.40 Person reviews (PersonReviewSchema/TrustSchema live beside the §1.37
// profile DTOs above — the profile response embeds them).
// ---------------------------------------------------------------------------

// POST /api/listings/:id/reviews. subject_id is REQUIRED when the reviewer is
// the listing's author (which contacter is being reviewed) and must be
// omitted/equal to the author otherwise (route-enforced → 400 bad_subject).
export const CreatePersonReviewRequestSchema = z.object({
  subject_id: UuidSchema.optional(),
  rating: z.number().int().min(LISTING_RATING_MIN).max(LISTING_RATING_MAX),
  body: z.string().max(PERSON_REVIEW_BODY_MAX_CHARS).default(''),
});
export type CreatePersonReviewRequest = z.infer<typeof CreatePersonReviewRequestSchema>;

export const PersonReviewResponseSchema = z.object({ review: PersonReviewSchema });
export type PersonReviewResponse = z.infer<typeof PersonReviewResponseSchema>;

export const ListPersonReviewsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type ListPersonReviewsQuery = z.infer<typeof ListPersonReviewsQuerySchema>;

export const ListPersonReviewsResponseSchema = z.object({
  reviews: z.array(PersonReviewSchema), // created_at DESC
  next_cursor: z.string().nullable(),
});
export type ListPersonReviewsResponse = z.infer<typeof ListPersonReviewsResponseSchema>;

// ---------------------------------------------------------------------------
// §1.41 Admin (operator-only; ADR-013). Every schema here serializes METADATA
// ONLY — no private message bodies exist in any admin payload, by contract.
// ---------------------------------------------------------------------------

export const LastSeenBucketSchema = z.enum(LAST_SEEN_BUCKETS);
export type LastSeenBucket = z.infer<typeof LastSeenBucketSchema>;

export const AdminUserRowSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  display_name: z.string(),
  created_at: IsoDateTimeSchema,
  // Coarse liveness, never a timestamp (LAST_SEEN_BUCKETS).
  last_seen_bucket: LastSeenBucketSchema,
  // null once the §1.41 retention GC has aged it out (IP_RETENTION_DAYS).
  registration_ip: z.string().nullable(),
  // The most recently seen session's metadata; null = no live sessions.
  last_session: z
    .object({
      ip: z.string().nullable(),
      user_agent: z.string().nullable(),
      last_seen_at: IsoDateTimeSchema,
    })
    .nullable(),
  session_count: z.number().int().nonnegative(),
  // Sum of attachments.size_bytes uploaded by this user.
  storage_bytes: z.number().int().nonnegative(),
  is_admin: z.boolean(),
  suspended: z.boolean(),
  banned: z.boolean(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

export const AdminUsersQuerySchema = z.object({
  q: z.string().min(1).optional(), // username/display_name prefix ILIKE
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

export const AdminUsersResponseSchema = z.object({
  users: z.array(AdminUserRowSchema), // created_at DESC
  next_cursor: z.string().nullable(),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

// Body for suspend/unsuspend/ban/unban: an optional operator note, ring-logged.
export const AdminActionRequestSchema = z.object({
  note: z.string().max(ADMIN_NOTE_MAX_CHARS).default(''),
});
export type AdminActionRequest = z.infer<typeof AdminActionRequestSchema>;

// §1.41 report queue row. Target previews are METADATA ONLY: a reported
// message serializes who/where/when/what-kind — NEVER its body (the
// reporter's own `reason` text is where quoted content lives, and it is the
// reporter's submission, not a counterparty's private words).
export const AdminReportSchema = z.object({
  id: UuidSchema,
  kind: ReportKindSchema, // v0.8b widens to the full §1.14 kind set
  // null = account deleted since — or, v0.8b (§1.67), a NON-USER share-page
  // report (kind 'share_page' stores reporter_id NULL by design).
  reporter: UserLiteSchema.nullable(),
  reason: z.string(),
  status: z.enum(['open', 'closed']),
  created_at: IsoDateTimeSchema,
  closed_at: IsoDateTimeSchema.nullable(),
  closed_by: UserLiteSchema.nullable().default(null),
  close_note: z.string().default(''),
  // Exactly one target preview is non-null, matching `kind` (unless the
  // target has been deleted since — reports outlive their targets).
  target_user: UserLiteSchema.nullable().default(null),
  target_message: z
    .object({
      conversation_id: UuidSchema,
      seq: z.number().int().positive(),
      sender: UserLiteSchema.nullable(),
      type: MessageTypeSchema,
      created_at: IsoDateTimeSchema,
      deleted: z.boolean(), // tombstoned since the report
      // v0.8b (§1.69): the reporter consented at report time to the context
      // viewer — GET /api/admin/reports/:id/context exists for this report.
      context_available: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  target_beacon: z
    .object({
      id: UuidSchema,
      vibe: BeaconVibeSchema,
      status: z.enum(['open', 'sparked', 'expired', 'cancelled']),
      creator: UserLiteSchema.nullable(),
    })
    .nullable()
    .default(null),
  // ---- v0.8b target previews (§1.62/§1.66/§1.67). Defaults keep pre-v0.8b
  // payloads parsing clean. Identity attachment is the point: anon_message
  // and story_overlay previews carry the REAL author (the reported party),
  // and ghost-group message reports resolve sender unmasked here — the admin
  // surface answers to the server, where nobody was ever anonymous. ----
  target_anon_message: z
    .object({
      thread_id: UuidSchema,
      message_id: UuidSchema,
      author: UserLiteSchema.nullable(), // the ATTACHED identity; null = deleted
      body: z.string(), // the reporter-disclosed anon message text (≤500)
      created_at: IsoDateTimeSchema,
    })
    .nullable()
    .default(null),
  target_overlay: z
    .object({
      story_id: UuidSchema,
      overlay_id: UuidSchema,
      author: UserLiteSchema.nullable(), // the ATTACHED identity; null = deleted
      kind: z.enum(STORY_OVERLAY_KINDS),
      payload: StoryOverlayPayloadSchema.nullable(), // null = story expired since
      status: z.enum(STORY_OVERLAY_STATUSES),
    })
    .nullable()
    .default(null),
  target_share_page: z
    .object({
      object_type: z.enum(SHARE_OBJECT_TYPES),
      object_id: UuidSchema,
      author: UserLiteSchema.nullable(), // object author/owner; null = gone
      gone: z.boolean(), // the object or its token no longer resolves
    })
    .nullable()
    .default(null),
});
export type AdminReport = z.infer<typeof AdminReportSchema>;

export const AdminReportsQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(), // omitted = both
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type AdminReportsQuery = z.infer<typeof AdminReportsQuerySchema>;

export const AdminReportsResponseSchema = z.object({
  reports: z.array(AdminReportSchema), // open first, then created_at DESC
  next_cursor: z.string().nullable(),
});
export type AdminReportsResponse = z.infer<typeof AdminReportsResponseSchema>;

export const CloseReportRequestSchema = z.object({
  note: z.string().max(ADMIN_NOTE_MAX_CHARS).default(''),
});
export type CloseReportRequest = z.infer<typeof CloseReportRequestSchema>;

export const AdminReportResponseSchema = z.object({ report: AdminReportSchema });
export type AdminReportResponse = z.infer<typeof AdminReportResponseSchema>;

// §1.41 metrics. Day series cover ADMIN_METRICS_WINDOW_DAYS; DAU is a PROXY
// (distinct users whose sessions were seen that day — sliding sessions make
// this approximate, documented as such).
export const DayCountSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().nonnegative(),
});
export type DayCount = z.infer<typeof DayCountSchema>;

export const AdminMetricsSchema = z.object({
  registrations_per_day: z.array(DayCountSchema),
  active_users_per_day: z.array(DayCountSchema), // DAU proxy
  messages_per_day: z.array(DayCountSchema),
  users_total: z.number().int().nonnegative(),
  open_beacons: z.number().int().nonnegative(),
  active_listings: z.number().int().nonnegative(),
  open_reports: z.number().int().nonnegative(),
  storage_total_bytes: z.number().int().nonnegative(),
});
export type AdminMetrics = z.infer<typeof AdminMetricsSchema>;

export const AdminMetricsResponseSchema = z.object({ metrics: AdminMetricsSchema });
export type AdminMetricsResponse = z.infer<typeof AdminMetricsResponseSchema>;

// §1.41 log ring entries (capped Redis list, LOG_RING_MAX). level 'admin' =
// an admin action (always logged); 'warn'/'error' = pino entries from
// api/worker. `data` is the structured remainder of the log line.
export const AdminLogEntrySchema = z.object({
  ts: IsoDateTimeSchema,
  level: z.enum(ADMIN_LOG_LEVELS),
  msg: z.string(),
  actor: z.object({ id: UuidSchema, username: z.string() }).nullable().default(null),
  data: z.record(z.unknown()).optional(),
});
export type AdminLogEntry = z.infer<typeof AdminLogEntrySchema>;

// Ring paging is by offset into the capped list (newest first) — a ring has
// no stable cursors; next_offset null = you have read the whole ring.
export const AdminLogsQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type AdminLogsQuery = z.infer<typeof AdminLogsQuerySchema>;

export const AdminLogsResponseSchema = z.object({
  entries: z.array(AdminLogEntrySchema),
  next_offset: z.number().int().nonnegative().nullable(),
});
export type AdminLogsResponse = z.infer<typeof AdminLogsResponseSchema>;

// v0.8a (§1.61): one shipped release, as the "new since your last visit"
// cards render it. The list lives in instance_settings key 'release_notes',
// seeded/appended by migrations — the instance describes what IT runs.
export const ReleaseNoteSchema = z.object({
  version: z.string().min(1).max(RELEASE_VERSION_MAX_CHARS),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().min(1).max(80),
  items: z
    .array(z.string().min(1).max(RELEASE_NOTE_ITEM_MAX_CHARS))
    .min(1)
    .max(RELEASE_NOTE_ITEMS_MAX),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

// v0.9 (§1.74, ADR-021): the OTP-ready Authentication settings. The SMTP
// password is NOT here — it is write-only (PATCH field smtp.password), stored
// AES-256-GCM-encrypted under its own instance_settings key (or supplied via
// the SMTP_PASSWORD env, which takes precedence), and serializes back ONLY as
// password_set. mailer_available is SERVER-computed honesty: false until a
// mailer ships (none in v0.9 — golden rule 10), and the admin UI disables the
// feature toggles and Test send behind "needs SMTP support in a future
// update" while the config itself stores fine.
export const SmtpSettingsSchema = z.object({
  host: z.string().max(SMTP_FIELD_MAX_CHARS).nullable(),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(), // implicit TLS (465-style) vs STARTTLS
  username: z.string().max(SMTP_FIELD_MAX_CHARS).nullable(),
  from: z.string().max(SMTP_FIELD_MAX_CHARS).nullable(),
  password_set: z.boolean(), // read-side flag; the password itself NEVER serializes
});
export type SmtpSettings = z.infer<typeof SmtpSettingsSchema>;

// AUTH_FEATURE_TOGGLES, spelled out — persisted today, INERT until
// mailer_available (keys match the constant; a drift is a type error at the
// satisfies below).
export const AuthFeatureTogglesSchema = z.object({
  email_verification: z.boolean(),
  email_otp: z.boolean(),
  magic_links: z.boolean(),
  password_reset: z.boolean(),
} satisfies Record<(typeof AUTH_FEATURE_TOGGLES)[number], z.ZodBoolean>);
export type AuthFeatureToggles = z.infer<typeof AuthFeatureTogglesSchema>;

export const AuthSettingsSchema = z.object({
  smtp: SmtpSettingsSchema,
  features: AuthFeatureTogglesSchema,
  mailer_available: z.boolean(),
});
export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

const AUTH_SETTINGS_DEFAULT: AuthSettings = {
  smtp: { host: null, port: 587, secure: true, username: null, from: null, password_set: false },
  features: {
    email_verification: false,
    email_otp: false,
    magic_links: false,
    password_reset: false,
  },
  mailer_available: false,
};

// §1.41 instance settings (instance_settings key/value jsonb).
// invites_enabled=false is enforced at invite MINT (403 invites_disabled) and
// ACCEPT (403 invites_disabled, no use_count claim); register-with-token
// degrades to invite: null per §1.1.
// v0.8a (§1.61) adds release_notes (newest first; default [] keeps pre-v0.8
// payloads parsing clean) — migrations seed it, admin PATCH may curate it.
// v0.9 (§1.74) adds auth (default keeps pre-v0.9 payloads parsing clean).
export const InstanceSettingsSchema = z.object({
  invites_enabled: z.boolean(),
  release_notes: z.array(ReleaseNoteSchema).default([]),
  auth: AuthSettingsSchema.default(AUTH_SETTINGS_DEFAULT),
});
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

// v0.9 (§1.74): the auth PATCH shape — deep-partial, plus the write-only
// smtp.password (set a string to store it encrypted, null to clear it; it
// never reads back). mailer_available is server-computed and not patchable.
export const AuthSettingsPatchSchema = z.object({
  smtp: z
    .object({
      host: z.string().max(SMTP_FIELD_MAX_CHARS).nullable().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      username: z.string().max(SMTP_FIELD_MAX_CHARS).nullable().optional(),
      from: z.string().max(SMTP_FIELD_MAX_CHARS).nullable().optional(),
      password: z.string().min(1).max(SMTP_FIELD_MAX_CHARS).nullable().optional(),
    })
    .optional(),
  features: AuthFeatureTogglesSchema.partial().optional(),
});
export type AuthSettingsPatch = z.infer<typeof AuthSettingsPatchSchema>;

export const UpdateInstanceSettingsRequestSchema = z.object({
  invites_enabled: z.boolean().optional(),
  release_notes: z.array(ReleaseNoteSchema).optional(),
  auth: AuthSettingsPatchSchema.optional(),
});
export type UpdateInstanceSettingsRequest = z.infer<typeof UpdateInstanceSettingsRequestSchema>;

export const InstanceSettingsResponseSchema = z.object({
  settings: InstanceSettingsSchema,
});
export type InstanceSettingsResponse = z.infer<typeof InstanceSettingsResponseSchema>;

// §1.41 per-user data export — the user's OWN rows only, secrets stripped
// (password_hash, session token_hash, push keys) and NO private message
// bodies (ADR-013: a member's messages contain their counterparties' words;
// bulk operator access to them is exactly what this surface must not be).
// Row payloads are the DB rows as JSON — deliberately loose here: the DB
// schema is the authority, and the export must not silently drop columns a
// stricter DTO forgot to name.
export const AdminUserExportSchema = z.object({
  exported_at: IsoDateTimeSchema,
  user: z.record(z.unknown()), // users row (profile + settings columns)
  sessions: z.array(z.record(z.unknown())), // metadata only, no token_hash
  listings: z.array(z.record(z.unknown())),
  posts: z.array(z.record(z.unknown())),
  reviews_received: z.array(z.record(z.unknown())),
});
export type AdminUserExport = z.infer<typeof AdminUserExportSchema>;

// ---------------------------------------------------------------------------
// Calls (v0.6 — API.md §1.42 + §2.12, ADR-014, FEATURES #49–#50)
// ---------------------------------------------------------------------------

// The durable call row (the call LOG — who called whom, when, how it ended).
// Everything live about a call is EPHEMERAL: the in-call member set lives in
// Redis, signaling rides the WS gateway and is never persisted (§2.12).
// participant_ids = the CURRENT live mesh members (from Redis; [] once the
// call is terminal) — ids only, clients resolve faces from the participants
// they already hold. Hard cap CALL_MESH_MAX (ADR-014).
export const CallSchema = z.object({
  id: UuidSchema,
  conversation_id: UuidSchema,
  initiator_id: UuidSchema.nullable(), // null = account deleted since
  kind: CallKindSchema,
  is_group: z.boolean(),
  status: CallStatusSchema,
  participant_ids: z.array(UuidSchema),
  started_at: IsoDateTimeSchema,
  answered_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
});
export type Call = z.infer<typeof CallSchema>;

// coturn static-auth-secret credentials (the TURN REST API memo format):
// username = "<unix expiry>:<user_id>", credential = base64(HMAC-SHA1(
// TURN_SECRET, username)). Time-limited (TURN_CRED_TTL_S = 1 h); long calls
// refresh via GET /api/turn-credentials before expiry. uris carry the stun:
// and turn: (udp + tcp) URIs for RTCPeerConnection.iceServers.
export const TurnCredentialsSchema = z.object({
  username: z.string(),
  credential: z.string(),
  uris: z.array(z.string()),
  expires_at: IsoDateTimeSchema,
});
export type TurnCredentials = z.infer<typeof TurnCredentialsSchema>;

export const CreateCallRequestSchema = z.object({
  kind: CallKindSchema,
});
export type CreateCallRequest = z.infer<typeof CreateCallRequestSchema>;

// turn is null only when the instance has no TURN_SECRET configured (local
// dev without coturn — host candidates still connect same-network peers).
export const CallResponseSchema = z.object({
  call: CallSchema,
  turn: TurnCredentialsSchema.nullable(),
});
export type CallResponse = z.infer<typeof CallResponseSchema>;

export const EndCallRequestSchema = z.object({
  // 'failed' marks a call whose media never (re)connected — client-reported,
  // only honored on transitions where it is coherent (§1.42).
  reason: z.enum(['completed', 'failed']).default('completed'),
});
export type EndCallRequest = z.infer<typeof EndCallRequestSchema>;

export const TurnCredentialsQuerySchema = z.object({
  call_id: UuidSchema,
});
export type TurnCredentialsQuery = z.infer<typeof TurnCredentialsQuerySchema>;

export const TurnCredentialsResponseSchema = z.object({
  turn: TurnCredentialsSchema,
});
export type TurnCredentialsResponse = z.infer<typeof TurnCredentialsResponseSchema>;

// ---------------------------------------------------------------------------
// Bored Together — discovery (v0.6 — API.md §1.44, ADR-015, FEATURES #52)
// ---------------------------------------------------------------------------

export const DiscoveryScopeSchema = z.enum(DISCOVERY_SCOPES);
export type DiscoveryScope = z.infer<typeof DiscoveryScopeSchema>;

// v0.8b (§1.65): the optional what-for chip on an opt-in ("looking to: walk/
// food/game…"). Opt-in data the owner chose to share — filters only narrow.
export const DiscoveryVibeSchema = z.enum(DISCOVERY_VIBES);
export type DiscoveryVibe = z.infer<typeof DiscoveryVibeSchema>;

// My own opt-in state (owner-only — nobody else ever sees this DTO).
export const DiscoveryOptinSchema = z.object({
  scope: DiscoveryScopeSchema,
  note: z.string().max(DISCOVERY_NOTE_MAX_CHARS),
  // v0.8b (§1.65): default(null) keeps pre-v0.8b payloads parsing clean.
  vibe: DiscoveryVibeSchema.nullable().default(null),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});
export type DiscoveryOptin = z.infer<typeof DiscoveryOptinSchema>;

export const DiscoveryOptinRequestSchema = z.object({
  scope: DiscoveryScopeSchema,
  note: z.string().max(DISCOVERY_NOTE_MAX_CHARS).default(''),
  // v0.8b (§1.65): optional; null/omitted = no chip. Re-PUT re-scopes it.
  vibe: DiscoveryVibeSchema.nullable().default(null),
});
export type DiscoveryOptinRequest = z.infer<typeof DiscoveryOptinRequestSchema>;

export const DiscoveryOptinResponseSchema = z.object({
  optin: DiscoveryOptinSchema.nullable(),
});
export type DiscoveryOptinResponse = z.infer<typeof DiscoveryOptinResponseSchema>;

// A stranger's card. UserLite ONLY (no last_seen, no area text — the area
// MATCH is computed server-side and never printed; FEATURES #30). waved is
// viewer-specific: I already waved at them (renders the "waved" chip — their
// card never shows who waved at THEM; a single wave notifies nobody, §1.44).
export const DiscoveryCardSchema = z.object({
  user: UserLiteSchema,
  scope: DiscoveryScopeSchema,
  note: z.string().max(DISCOVERY_NOTE_MAX_CHARS),
  expires_at: IsoDateTimeSchema,
  waved: z.boolean(),
  // ---- v0.8b (§1.65). Defaults keep pre-v0.8b payloads parsing clean. ----
  // The card owner's what-for chip (their own opt-in choice).
  vibe: DiscoveryVibeSchema.nullable().default(null),
  // Viewer-specific: the overlap of the two PUBLIC §1.37 interest lists
  // ("you both like X"), first DISCOVERY_SHARED_INTERESTS_MAX by the owner's
  // tag order. Already-public data, intersected — nothing new is revealed.
  shared_interests: z
    .array(z.string())
    .max(DISCOVERY_SHARED_INTERESTS_MAX)
    .default([]),
});
export type DiscoveryCard = z.infer<typeof DiscoveryCardSchema>;

// v0.8b (§1.65): GET /api/discovery/cards filters — each only ever NARROWS
// the §1.44 mutual-reachability pool. vibe = cards wearing that chip;
// interests = cards sharing ≥1 public interest tag with me; area = cards
// whose owner's area matches mine (citext), whatever their scope.
export const DiscoveryCardsQuerySchema = z.object({
  vibe: DiscoveryVibeSchema.optional(),
  interests: z.coerce.boolean().optional(),
  area: z.coerce.boolean().optional(),
});
export type DiscoveryCardsQuery = z.infer<typeof DiscoveryCardsQuerySchema>;

export const DiscoveryCardsResponseSchema = z.object({
  cards: z.array(DiscoveryCardSchema),
});
export type DiscoveryCardsResponse = z.infer<typeof DiscoveryCardsResponseSchema>;

export const WaveRequestSchema = z.object({
  user_id: UuidSchema,
});
export type WaveRequest = z.infer<typeof WaveRequestSchema>;

// matched=false → the wave is parked silently (NOBODY is notified — no
// FoMO, no rejection surface; ADR-015). matched=true → the mutual-wave DM.
export const WaveResponseSchema = z.object({
  matched: z.boolean(),
  conversation_id: UuidSchema.nullable(),
});
export type WaveResponse = z.infer<typeof WaveResponseSchema>;

// ---------------------------------------------------------------------------
// Expectation feedback & encouragement (v0.6 — API.md §1.45, ADR-015,
// PSYCHOLOGY finding #10: people underestimate how pleasant strangers are)
// ---------------------------------------------------------------------------

export const ExpectationContextSchema = z.enum(EXPECTATION_CONTEXTS);
export type ExpectationContext = z.infer<typeof ExpectationContextSchema>;

export const ExpectationVerdictSchema = z.enum(EXPECTATION_VERDICTS);
export type ExpectationVerdict = z.infer<typeof ExpectationVerdictSchema>;

// conversation_id is a dedupe key, not an FK — expired roulette DMs are
// hard-deleted, and the one-tap often lands right after that deletion.
export const ExpectationFeedbackRequestSchema = z.object({
  context: ExpectationContextSchema,
  conversation_id: UuidSchema,
  verdict: ExpectationVerdictSchema,
});
export type ExpectationFeedbackRequest = z.infer<typeof ExpectationFeedbackRequestSchema>;

// The anonymous instance-wide aggregate, shown ONLY pre-opt-in (client rule,
// §1.45). better_percent is null under ENCOURAGEMENT_MIN_SAMPLES.
export const EncouragementResponseSchema = z.object({
  sample_size: z.number().int().nonnegative(),
  better_percent: z.number().int().min(0).max(100).nullable(),
});
export type EncouragementResponse = z.infer<typeof EncouragementResponseSchema>;

// ---------------------------------------------------------------------------
// Bored Roulette (v0.6 — API.md §1.45, ADR-015, FEATURES #52)
// ---------------------------------------------------------------------------

export const RouletteJoinResponseSchema = z.object({
  status: z.literal('queued'),
});
export type RouletteJoinResponse = z.infer<typeof RouletteJoinResponseSchema>;

export const RouletteKeepRequestSchema = z.object({
  conversation_id: UuidSchema,
});
export type RouletteKeepRequest = z.infer<typeof RouletteKeepRequestSchema>;

// permanent=true the moment BOTH parties have kept (the DTO's roulette rider
// goes null); until then the viewer only ever learns their own keep state.
export const RouletteKeepResponseSchema = z.object({
  conversation: ConversationSchema,
  permanent: z.boolean(),
});
export type RouletteKeepResponse = z.infer<typeof RouletteKeepResponseSchema>;

// ---------------------------------------------------------------------------
// Rescue me (v0.6 — API.md §1.46, FEATURES #53)
// ---------------------------------------------------------------------------

export const RescueRequestSchema = z.object({
  user_ids: z.array(UuidSchema).min(1).max(RESCUE_MAX_TARGETS),
  note: z.string().max(RESCUE_NOTE_MAX_CHARS).default(''),
});
export type RescueRequest = z.infer<typeof RescueRequestSchema>;

export const RescueResponseSchema = z.object({
  // One entry per target: the DM the rescue message landed in.
  rescues: z.array(
    z.object({
      user_id: UuidSchema,
      conversation_id: UuidSchema,
    }),
  ),
});
export type RescueResponse = z.infer<typeof RescueResponseSchema>;

// ---------------------------------------------------------------------------
// Call reliability (v0.7.1 — API.md §1.55 + §2.9 + §2.12, ADR-017,
// FEATURES #87–#90b)
// ---------------------------------------------------------------------------

// Per-peer RTC connection state as the client REPORTS it (relayed `call.state`
// frame, §2.12) and renders it. Derived client-side from
// RTCPeerConnection.iceConnectionState; 'reconnecting' covers the automatic
// ICE-restart window, 'failed' is terminal for that peer pair.
export const CallConnStateSchema = z.enum(CALL_CONN_STATES);
export type CallConnState = z.infer<typeof CallConnStateSchema>;

// §2.9 push payloads. The pre-v0.7.1 payloads (message snippet, missed call)
// carry NO `kind` — the service worker treats a kind-less payload as a plain
// notification, exactly as before. v0.7.1 payloads are discriminated so the
// worker routes without guessing.

// Incoming-call ring push — sent at call create to every callee the §2.9
// guards allow, ONLY when that user has no live socket (a live socket already
// rings via `call.invite`). tag = `call:<call_id>` (CALL_RING_PUSH_TAG_PREFIX)
// so the stop push can close exactly this ring. Shown with Answer/Decline
// actions (PUSH_ACTION_ANSWER / PUSH_ACTION_DECLINE) where the platform
// supports notification actions; a plain tap deep-links to data.url.
export const CallRingPushPayloadSchema = z.object({
  kind: z.literal('call.ring'),
  title: z.string(), // caller display name, or the group title
  body: z.string(), // "Incoming audio call" | "Incoming video call"
  tag: z.string().startsWith(CALL_RING_PUSH_TAG_PREFIX),
  data: z.object({
    url: z.string(), // /c/<conversation_id>?call=<call_id> — the answer deep link
    call_id: UuidSchema,
    conversation_id: UuidSchema,
    call_kind: CallKindSchema,
    // Decline routing (§2.9): DM → the worker POSTs /api/calls/:id/reject;
    // group → a decline is personal & ephemeral (§1.42), so the worker just
    // closes the notification (no REST call exists to make).
    is_group: z.boolean(),
  }),
});
export type CallRingPushPayload = z.infer<typeof CallRingPushPayloadSchema>;

// Silent retraction — "the call was handled somewhere" (answered on another
// device, rejected, cancelled, timed out to missed, or ended). The worker
// closes any shown notification with this tag and displays NOTHING. Sent to
// exactly the subscriptions the ring went to (the Redis `call:{id}:rang` set,
// dropped with the member set on terminal status).
export const CallRingStopPushPayloadSchema = z.object({
  kind: z.literal('call.ring.stop'),
  tag: z.string().startsWith(CALL_RING_PUSH_TAG_PREFIX),
});
export type CallRingStopPushPayload = z.infer<typeof CallRingStopPushPayloadSchema>;

// GET /api/call-selftest (§1.55) — authed, participant-FREE (no live call
// required: the whole point is finding out BEFORE a call fails), rate-limited
// CALL_SELFTEST_RATE_PER_HOUR/user. This is also the one authed read of the
// instance's TURN state: the admin panel and the §1.55 caller warning both
// consume `turn_configured` from here.
//
// turn_configured=false → turn is null: the instance has no TURN_SECRET (no
// relay service runs — ADR-014's empty-secret hard stop), so cross-network
// calls cannot work; same-network/host-candidate calls still can. When
// configured, `turn` carries SHORT-lived probe credentials
// (CALL_SELFTEST_CRED_TTL_S, username "<unix expiry>:selftest:<user_id>") for
// the client's relay-reachability gather; the verdict (relay reachable or
// not, candidate types found) is determined CLIENT-side — only the browser
// can test the UDP path from where the user actually sits.
export const CallSelftestResponseSchema = z.object({
  turn_configured: z.boolean(),
  turn: TurnCredentialsSchema.nullable(),
});
export type CallSelftestResponse = z.infer<typeof CallSelftestResponseSchema>;

// ---------------------------------------------------------------------------
// Moods & drunk mode (v0.8a — API.md §1.57, FEATURES #72–#73, ADR-018)
// ---------------------------------------------------------------------------

// One entry of a 🎢 swing set: a preset's {emoji, label} or a custom pair.
export const MoodSwingEntrySchema = z.object({
  emoji: z.string().min(1).max(MOOD_EMOJI_MAX_LEN),
  label: z.string().min(1).max(MOOD_LABEL_MAX_CHARS),
});
export type MoodSwingEntry = z.infer<typeof MoodSwingEntrySchema>;

// The OWNER's full mood state (GET/PUT /api/users/me/mood) — the only payload
// that ever carries visibility, expires_at or the swing set. Others get the
// bare Mood chip on UserLite/UserPublic, per-viewer filtered (§1.57).
export const MoodStateSchema = z.object({
  mood: MoodSchema.nullable(),
  visibility: MoodVisibilitySchema,
  expires_at: IsoDateTimeSchema.nullable(), // null iff mood is null
  swing_set: z
    .array(MoodSwingEntrySchema)
    .min(MOOD_SWING_SET_MIN)
    .max(MOOD_SWING_SET_MAX)
    .nullable(), // non-null iff mood.kind === 'swing'
});
export type MoodState = z.infer<typeof MoodStateSchema>;

// PUT /api/users/me/mood. Discriminated on kind: 'preset' names a
// MOOD_PRESETS label (server fills the emoji); 'custom' carries both;
// 'swing' carries the set (the server picks the first entry as the current
// chip and rotates from there); 'drunk' is bare — emoji/label are pinned
// (MOOD_DRUNK_EMOJI/LABEL). visibility omitted = 'everyone', EXCEPT drunk,
// which defaults 'connections' (the §1.57 guardrail; still overridable).
export const SetMoodRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preset'),
    label: z.string().min(1).max(MOOD_LABEL_MAX_CHARS),
    visibility: MoodVisibilitySchema.optional(),
  }),
  z.object({
    kind: z.literal('custom'),
    emoji: z.string().min(1).max(MOOD_EMOJI_MAX_LEN),
    label: z.string().min(1).max(MOOD_LABEL_MAX_CHARS),
    visibility: MoodVisibilitySchema.optional(),
  }),
  z.object({
    kind: z.literal('swing'),
    swing_set: z.array(MoodSwingEntrySchema).min(MOOD_SWING_SET_MIN).max(MOOD_SWING_SET_MAX),
    visibility: MoodVisibilitySchema.optional(),
  }),
  z.object({
    kind: z.literal('drunk'),
    visibility: MoodVisibilitySchema.optional(),
  }),
]);
export type SetMoodRequest = z.infer<typeof SetMoodRequestSchema>;

export const MoodResponseSchema = z.object({ mood_state: MoodStateSchema });
export type MoodResponse = z.infer<typeof MoodResponseSchema>;

// ---------------------------------------------------------------------------
// Activity strip (v0.8a — API.md §1.59, FEATURES #76)
// ---------------------------------------------------------------------------

export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityVisibilitySchema = z.enum(ACTIVITY_VISIBILITIES);
export type ActivityVisibility = z.infer<typeof ActivityVisibilitySchema>;

// SERVER-resolved per viewer at serialization time (the ref_summary/
// reply_context pattern): live state, never audience-widening — items whose
// underlying object the viewer may not see are silently DROPPED from the
// strip (no placeholders, no hidden-item counts). Deliberately summary-only:
// no joiner piles, no bodies, no counters — the strip links, the target
// surface shows. Moods NEVER appear here (no mood kind exists).
export const ActivitySummarySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('beacon'), // beacon_lit / beacon_sparked
    beacon_id: UuidSchema,
    vibe: z.enum(BEACON_VIBE_VALUES),
    custom_vibe_emoji: z.string().nullable(),
    custom_vibe_label: z.string().nullable(),
    note: z.string(),
    status: z.enum(['open', 'sparked', 'expired', 'cancelled']),
  }),
  z.object({
    type: z.literal('post'), // post_created
    post_id: UuidSchema,
    kind: z.enum(POST_KINDS),
    excerpt: z.string().max(REPLY_EXCERPT_MAX_CHARS).nullable(), // first 80 chars of the CURRENT body
  }),
  z.object({
    type: z.literal('listing'), // listing_posted
    listing_id: UuidSchema,
    kind: z.enum(LISTING_KINDS),
    title: z.string(),
    status: z.enum(['active', 'closed', 'expired']),
  }),
  z.object({
    type: z.literal('puzzle'), // puzzle_played — the no-spoiler share facts
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    solved: z.boolean(),
    attempts_used: z.number().int().min(1).max(PUZZLE_MAX_GUESSES),
  }),
  z.object({
    type: z.literal('game'), // game_won — visible only where the game was
    conversation_id: UuidSchema,
    seq: SeqSchema,
    opponent: UserLiteSchema.nullable(), // null = deleted account
  }),
]);
export type ActivitySummary = z.infer<typeof ActivitySummarySchema>;

export const ActivitySchema = z.object({
  id: UuidSchema,
  kind: ActivityKindSchema,
  created_at: IsoDateTimeSchema,
  summary: ActivitySummarySchema,
});
export type Activity = z.infer<typeof ActivitySchema>;

// GET /api/users/:username/activity — newest first, ≤ ACTIVITY_STRIP_MAX
// after per-viewer filtering. 404-shaped exactly like the profile (§1.14).
export const ActivityResponseSchema = z.object({
  activities: z.array(ActivitySchema),
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

// ---------------------------------------------------------------------------
// Releases / what's-new (v0.8a — API.md §1.61, FEATURES #80)
// ---------------------------------------------------------------------------

// GET /api/releases (authed): the instance's shipped releases (newest first,
// from instance_settings 'release_notes') + MY cursor. The client renders
// "new since your last visit" cards for releases after last_seen_release and
// the "new" badges in the Things-you-can-do directory (FEATURE_DIRECTORY
// `since` vs the releases list).
export const ReleasesResponseSchema = z.object({
  releases: z.array(ReleaseNoteSchema),
  last_seen_release: z.string().max(RELEASE_VERSION_MAX_CHARS).nullable(),
});
export type ReleasesResponse = z.infer<typeof ReleasesResponseSchema>;

// POST /api/releases/seen — moves my cursor (users.last_seen_release).
export const ReleaseSeenRequestSchema = z.object({
  version: z.string().min(1).max(RELEASE_VERSION_MAX_CHARS),
});
export type ReleaseSeenRequest = z.infer<typeof ReleaseSeenRequestSchema>;

// ===========================================================================
// v0.8b — community pack (API.md §1.62–§1.69; ADR-019 / ADR-020)
// ===========================================================================

// ---------------------------------------------------------------------------
// Anonymous reveal game (v0.8b — API.md §1.62, FEATURES #77, ADR-019)
// ---------------------------------------------------------------------------

export const AnonOptinSchema = z.enum(ANON_OPTIN_VALUES);
export type AnonOptin = z.infer<typeof AnonOptinSchema>;

export const AnonRevealModeSchema = z.enum(['none', 'timer', 'riddle']);
export type AnonRevealMode = z.infer<typeof AnonRevealModeSchema>;

// One anonymous message. TEXT ONLY — no attachments, no previews, no
// reactions (ADR-019: the game is words first). from_sender tells the two
// parties apart without naming either; the viewer knows their own role.
export const AnonMessageSchema = z.object({
  id: UuidSchema,
  thread_id: UuidSchema,
  from_sender: z.boolean(),
  body: z.string().min(1).max(ANON_BODY_MAX_CHARS),
  // true on the recipient's formal riddle answer (POST .../answer-riddle) —
  // the sender's client renders the "that's right ✓" confirm on these.
  is_riddle_answer: z.boolean().default(false),
  created_at: IsoDateTimeSchema,
});
export type AnonMessage = z.infer<typeof AnonMessageSchema>;

// VIEWER-SPECIFIC thread DTO — the whole game lives in how this serializes:
// role is the viewer's side; counterpart is the OTHER party's identity and is
// NULL for the recipient until revealed (live rule: revealed_at set, or
// reveal_at <= now()); the sender always sees the recipient (they chose
// them). The recipient's view of the sender's avatar rides ONLY the gated
// blur proxy (§1.62) until reveal — no UserLite, no media URL, nothing
// derivable. reveal_timer_s + reveal_at let the client animate the un-blur
// (factor = clamp((reveal_at - now)/reveal_timer_s, 0, 1)); the server
// renders the actual pixels.
export const AnonThreadSchema = z.object({
  id: UuidSchema,
  role: z.enum(['sender', 'recipient']),
  counterpart: UserLiteSchema.nullable(),
  reveal_mode: AnonRevealModeSchema,
  reveal_timer_s: z.number().int().positive().nullable(), // an ANON_TIMER_PRESETS_S entry, iff mode='timer'
  reveal_at: IsoDateTimeSchema.nullable(), // iff mode='timer'
  riddle_q: z.string().max(ANON_RIDDLE_MAX_CHARS).nullable(), // iff mode='riddle'
  reveal_requested: z.boolean(), // the recipient asked; shown to both sides
  revealed_at: IsoDateTimeSchema.nullable(),
  last_message: AnonMessageSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type AnonThread = z.infer<typeof AnonThreadSchema>;

// POST /api/anon/threads — opens (or appends to) MY open thread to user_id.
// Refusals are INVISIBLE and byte-identical (404 anon_unavailable): unknown
// user, 'nobody', an unmet 'connections', blocked either way, banned, self.
export const CreateAnonThreadRequestSchema = z.object({
  user_id: UuidSchema,
  body: z.string().min(1).max(ANON_BODY_MAX_CHARS),
});
export type CreateAnonThreadRequest = z.infer<typeof CreateAnonThreadRequestSchema>;

export const AnonMessageRequestSchema = z.object({
  body: z.string().min(1).max(ANON_BODY_MAX_CHARS),
});
export type AnonMessageRequest = z.infer<typeof AnonMessageRequestSchema>;

// POST /api/anon/threads/:id/set-reveal — SENDER only, pick the game.
export const SetRevealRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('timer'),
    timer_s: z.union([
      z.literal(ANON_TIMER_PRESETS_S[0]),
      z.literal(ANON_TIMER_PRESETS_S[1]),
      z.literal(ANON_TIMER_PRESETS_S[2]),
    ]),
  }),
  z.object({
    mode: z.literal('riddle'),
    riddle_q: z.string().min(1).max(ANON_RIDDLE_MAX_CHARS),
  }),
]);
export type SetRevealRequest = z.infer<typeof SetRevealRequestSchema>;

export const AnswerRiddleRequestSchema = z.object({
  answer: z.string().min(1).max(ANON_RIDDLE_MAX_CHARS),
});
export type AnswerRiddleRequest = z.infer<typeof AnswerRiddleRequestSchema>;

export const AnonThreadResponseSchema = z.object({ thread: AnonThreadSchema });
export type AnonThreadResponse = z.infer<typeof AnonThreadResponseSchema>;

export const AnonThreadsResponseSchema = z.object({
  threads: z.array(AnonThreadSchema),
});
export type AnonThreadsResponse = z.infer<typeof AnonThreadsResponseSchema>;

export const AnonMessagesResponseSchema = z.object({
  messages: z.array(AnonMessageSchema), // created_at ASC
  next_cursor: z.string().nullable(),
});
export type AnonMessagesResponse = z.infer<typeof AnonMessagesResponseSchema>;

// ---------------------------------------------------------------------------
// Suggestions & find-your-people (v0.8b — API.md §1.64, FEATURES #78, ADR-019)
// ---------------------------------------------------------------------------

// One people-you-may-know card. The signals are relationship evidence about
// MY network — mutual FACES first (the §1.36 rule), mutual_count carrying the
// rest; same_area is a boolean (the area TEXT stays owner-private, FEATURES
// #30); shared_groups counts non-ghost groups we are both in (ghost groups
// are unlisted EVERYWHERE, §1.68). Excluded entirely: me, blocked pairs,
// friends-of, pending connection requests either way, dismissed, banned.
export const SuggestionSchema = z.object({
  user: UserLiteSchema,
  mutual_count: z.number().int().nonnegative(),
  mutuals: z.array(UserLiteSchema).max(SUGGESTION_MUTUALS_PREVIEW_MAX),
  same_area: z.boolean(),
  shared_groups: z.number().int().nonnegative(),
  // v1.0 (#78c): overlap of the two PUBLIC §1.37 interest lists — the §1.65
  // discovery-card rule reused; already-public data, nothing new revealed.
  shared_interests: z.array(z.string()).max(DISCOVERY_SHARED_INTERESTS_MAX).default([]),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

// v1.0 (#78c): ?mutuals=&groups=&area=&interests= each NARROW the pool (the
// §1.65 filter doctrine — filters only ever narrow by what people chose to
// share). Absent flags change nothing; area with no area of mine (or
// interests with no public tags of mine) is an honest empty result.
export const SuggestionsQuerySchema = z.object({
  mutuals: z.coerce.boolean().optional(),
  groups: z.coerce.boolean().optional(),
  area: z.coerce.boolean().optional(),
  interests: z.coerce.boolean().optional(),
});
export type SuggestionsQuery = z.infer<typeof SuggestionsQuerySchema>;

export const SuggestionsResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema), // best-evidence first, ≤ SUGGESTIONS_MAX
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;

// ---------------------------------------------------------------------------
// v1.0a (#94): "My gallery" — a private view over MY OWN media (bound
// anywhere, or saved — e.g. the story auto-saver). Nothing here grants
// anyone else access; it is the uploader reading their uploads.
export const GalleryItemSchema = z.object({
  attachment: AttachmentSchema,
  // true = kept alive by a gallery save (deletable here); false = lives
  // wherever it is bound (delete it there).
  saved: z.boolean(),
  source: z.enum(['story']).nullable(),
});
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

export const GalleryQuerySchema = z.object({
  kind: z.enum(['image', 'video']).optional(),
  saved: z.coerce.boolean().optional(), // true → only saved items
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type GalleryQuery = z.infer<typeof GalleryQuerySchema>;

export const GalleryResponseSchema = z.object({
  items: z.array(GalleryItemSchema),
  next_cursor: z.string().nullable(),
});
export type GalleryResponse = z.infer<typeof GalleryResponseSchema>;

// v1.0a (#95): PATCH /api/conversations/:id/background — the shared chat
// background. Validation mirrors §1.60 (mine, image/video, ready, video
// caps); null clears. DM: any active member; group: admins (403 otherwise).
export const SetSharedBackgroundRequestSchema = z.object({
  attachment_id: UuidSchema.nullable(),
});
export type SetSharedBackgroundRequest = z.infer<typeof SetSharedBackgroundRequestSchema>;

// #95b: PATCH /api/conversations/:id/appearance — omitted = unchanged, null = clear.
export const SetSharedAppearanceRequestSchema = z
  .object({
    theme: ChatThemeSchema.nullable().optional(),
    wallpaper: ChatWallpaperSchema.nullable().optional(),
  })
  .refine((b) => b.theme !== undefined || b.wallpaper !== undefined, { message: 'nothing to change' });
export type SetSharedAppearanceRequest = z.infer<typeof SetSharedAppearanceRequestSchema>;
export const SharedAppearanceResponseSchema = z.object({
  theme: ChatThemeSchema.nullable(),
  wallpaper: ChatWallpaperSchema.nullable(),
});
export type SharedAppearanceResponse = z.infer<typeof SharedAppearanceResponseSchema>;

// ---------------------------------------------------------------------------
// Canvas stories — requests (v0.8b — API.md §1.66, FEATURES #79a, ADR-020)
// ---------------------------------------------------------------------------

// PATCH /api/stories/:id — author only; today only the canvas switch.
export const UpdateStoryRequestSchema = z.object({
  canvas_mode: StoryCanvasModeSchema,
});
export type UpdateStoryRequest = z.infer<typeof UpdateStoryRequestSchema>;

// POST /api/stories/:id/overlays. kind rides inside the payload union.
export const CreateOverlayRequestSchema = z.object({
  payload: StoryOverlayPayloadSchema,
});
export type CreateOverlayRequest = z.infer<typeof CreateOverlayRequestSchema>;

export const OverlayResponseSchema = z.object({ overlay: StoryOverlaySchema });
export type OverlayResponse = z.infer<typeof OverlayResponseSchema>;

// ---------------------------------------------------------------------------
// Public share pages (v0.8b — API.md §1.67, FEATURES #79c, ADR-020)
// ---------------------------------------------------------------------------

export const ShareObjectTypeSchema = z.enum(SHARE_OBJECT_TYPES);
export type ShareObjectType = z.infer<typeof ShareObjectTypeSchema>;

// POST /api/share-links — mint-or-return the object's ONE open token.
export const CreateShareLinkRequestSchema = z.object({
  type: ShareObjectTypeSchema,
  id: UuidSchema,
});
export type CreateShareLinkRequest = z.infer<typeof CreateShareLinkRequestSchema>;

// url is the app-origin PATH (/p/<token>, or /s/<token> for stories) — the
// web layer prefixes PUBLIC_ORIGIN (the §1.53 publicOrigin() rule governs
// every absolute URL and OG tag).
export const ShareLinkSchema = z.object({
  token: z.string(),
  url: z.string(),
  object: z.object({ type: ShareObjectTypeSchema, id: UuidSchema }),
  created_at: IsoDateTimeSchema,
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const ShareLinkResponseSchema = z.object({ share_link: ShareLinkSchema });
export type ShareLinkResponse = z.infer<typeof ShareLinkResponseSchema>;

// The author chip on a share page: NO id, NO UserLite — username +
// display_name + the token-gated avatar path (/api/share/:token/avatar/
// <user_id>?v=static), null while not 'ready'. Unauthenticated viewers get
// exactly what the OG unfurler gets, nothing more.
export const ShareAuthorChipSchema = z.object({
  username: z.string(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
  name_style: NameStyleSchema.default('none'),
});
export type ShareAuthorChip = z.infer<typeof ShareAuthorChipSchema>;

// A share-page media descriptor: the token-gated proxy path
// (/api/share/:token/media/<attachment_id>), never /api/media/:key.
export const ShareMediaSchema = z.object({
  attachment_id: UuidSchema,
  kind: AttachmentKindSchema,
  url: z.string(),
  thumb_url: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blurhash: z.string().nullable(),
});
export type ShareMedia = z.infer<typeof ShareMediaSchema>;

// One rendered message on a PUBLIC group's live page (seq > public_since_seq
// only; tombstones and system noise dropped). Senders show real identity —
// the switch was admin-confirmed and every member wears the banner (§1.68).
export const ShareMessageSchema = z.object({
  seq: SeqSchema,
  sender: ShareAuthorChipSchema.nullable(), // null = deleted account
  type: MessageTypeSchema,
  body: z.string().nullable(),
  media: z.array(ShareMediaSchema).default([]),
  created_at: IsoDateTimeSchema,
});
export type ShareMessage = z.infer<typeof ShareMessageSchema>;

// GET /api/share/:token/public — the SSR page's one read. Every variant
// resolves LIVE: object still exists, still public (audience / visibility /
// expiry / ban re-checked), token unrevoked — else 404 share_not_found,
// byte-identical for every cause. Interaction is NOT here: any action on the
// page routes to /register?next=<deep link> (the ?next gate).
export const SharePageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('post'),
    author: ShareAuthorChipSchema,
    kind: z.enum(POST_KINDS),
    body: z.string(),
    media: z.array(ShareMediaSchema),
    // Poll options + counts render read-only (counts on OPTIONS are a
    // decision tool — the §1.50 rule); voting gates to signup.
    poll: z
      .object({ question: z.string(), options: z.array(z.string()), counts: z.array(z.number().int()) })
      .nullable(),
    location_label: z.string().nullable(), // label only — never lat/lng to strangers
    created_at: IsoDateTimeSchema,
  }),
  z.object({
    type: z.literal('beacon'),
    creator: ShareAuthorChipSchema,
    vibe: z.enum(BEACON_VIBE_VALUES),
    custom_vibe_emoji: z.string().nullable(),
    custom_vibe_label: z.string().nullable(),
    note: z.string(),
    status: z.enum(['open', 'sparked', 'expired', 'cancelled']),
    starts_at: IsoDateTimeSchema,
    expires_at: IsoDateTimeSchema,
    // needs is the §1.15 utility number ("2 more and it's a plan") — NO
    // joiner faces and NO joiner identities to logged-out strangers, ever.
    needs: z.number().int().nonnegative(),
    location_label: z.string().nullable(),
    created_at: IsoDateTimeSchema,
  }),
  z.object({
    type: z.literal('listing'),
    author: ShareAuthorChipSchema,
    kind: z.enum(LISTING_KINDS),
    title: z.string(),
    body: z.string(),
    price_text: z.string().nullable(), // display text — no payments exist
    area: z.string(),
    status: z.enum(['active', 'closed', 'expired']),
    media: z.array(ShareMediaSchema),
    location_label: z.string().nullable(),
    created_at: IsoDateTimeSchema,
  }),
  z.object({
    type: z.literal('story'),
    author: ShareAuthorChipSchema,
    caption: z.string(),
    media: ShareMediaSchema,
    // Canvas overlays render read-only with their contributor chips (public
    // attribution is the §1.66 contract); drawing gates to signup.
    overlays: z.array(
      z.object({
        kind: z.enum(STORY_OVERLAY_KINDS),
        payload: StoryOverlayPayloadSchema,
        author_username: z.string(),
      }),
    ),
    expires_at: IsoDateTimeSchema, // the page dies with the story
    created_at: IsoDateTimeSchema,
  }),
  // visibility='invite_only': the CARD ONLY — never messages (§1.68).
  z.object({
    type: z.literal('group_card'),
    title: z.string(),
    description: z.string(),
    avatar_url: z.string().nullable(), // token-gated group-avatar proxy
    // Group size is join-decision utility (the ADR-012 trust-info argument,
    // re-made in ADR-020) — it never ranks, compares or rewards anyone.
    member_count: z.number().int().positive(),
    created_at: IsoDateTimeSchema,
  }),
  // visibility='public': the card + the read-only live tail. ONLY messages
  // with seq > public_since_seq, newest page first; older pages by cursor,
  // floored at public_since_seq ALWAYS (history is never retro-exposed).
  z.object({
    type: z.literal('group_live'),
    title: z.string(),
    description: z.string(),
    avatar_url: z.string().nullable(),
    member_count: z.number().int().positive(),
    messages: z.array(ShareMessageSchema), // ≤ SHARE_GROUP_PAGE_MESSAGES_MAX, seq ASC
    next_cursor: z.string().nullable(), // older messages; null at the floor
    created_at: IsoDateTimeSchema,
  }),
]);
export type SharePage = z.infer<typeof SharePageSchema>;

export const SharePageResponseSchema = z.object({ page: SharePageSchema });
export type SharePageResponse = z.infer<typeof SharePageResponseSchema>;

// ---------------------------------------------------------------------------
// Group visibility modes (v0.8b — API.md §1.68, FEATURES #79d, ADR-020)
// ---------------------------------------------------------------------------

export const GroupVisibilitySchema = z.enum(GROUP_VISIBILITIES);
export type GroupVisibility = z.infer<typeof GroupVisibilitySchema>;

// PATCH /api/conversations/:id/visibility — group admins only. Switching TO
// 'public' demands confirm:true (400 confirm_required otherwise) and stamps
// public_since_seq = last_seq in the same transaction. A GHOST group can
// never switch away (400 ghost_is_forever — members spoke under masks;
// ADR-020). description edits ride the same PATCH.
export const UpdateGroupVisibilityRequestSchema = z.object({
  visibility: GroupVisibilitySchema.optional(),
  description: z.string().max(GROUP_DESCRIPTION_MAX_CHARS).optional(),
  confirm: z.boolean().default(false),
});
export type UpdateGroupVisibilityRequest = z.infer<typeof UpdateGroupVisibilityRequestSchema>;

// POST /api/conversations/:id/join — 'public' joins at once (200 + the
// conversation); 'invite_only' parks a request (202 {status:'requested'});
// 'private'/'ghost' answer 404 not_found, byte-identical to an unknown id
// (unlisted means unlisted).
export const GroupJoinResponseSchema = z.union([
  z.object({ status: z.literal('joined'), conversation: ConversationSchema }),
  z.object({ status: z.literal('requested') }),
]);
export type GroupJoinResponse = z.infer<typeof GroupJoinResponseSchema>;

export const GroupJoinRequestRowSchema = z.object({
  user: UserLiteSchema,
  created_at: IsoDateTimeSchema,
});
export type GroupJoinRequestRow = z.infer<typeof GroupJoinRequestRowSchema>;

export const GroupJoinRequestsResponseSchema = z.object({
  requests: z.array(GroupJoinRequestRowSchema), // oldest first — a queue
});
export type GroupJoinRequestsResponse = z.infer<typeof GroupJoinRequestsResponseSchema>;

// PUT /api/conversations/:id/mask — MY mask in a ghost group (members pick;
// join/switch auto-assigns from the GHOST_MASK_* pools first). Unique per
// group → 409 mask_taken.
export const SetMaskRequestSchema = z.object({
  mask_name: z.string().min(1).max(MASK_NAME_MAX_CHARS),
  mask_emoji: z.string().min(1).max(MASK_EMOJI_MAX_LEN),
});
export type SetMaskRequest = z.infer<typeof SetMaskRequestSchema>;

// ---------------------------------------------------------------------------
// Support inbox (v0.8b — API.md §1.69, FEATURES #81, ADR-020)
// ---------------------------------------------------------------------------

export const SupportCategorySchema = z.enum(SUPPORT_CATEGORIES);
export type SupportCategory = z.infer<typeof SupportCategorySchema>;

export const SupportTicketStatusSchema = z.enum(SUPPORT_TICKET_STATUSES);
export type SupportTicketStatus = z.infer<typeof SupportTicketStatusSchema>;

// The user's own ticket row. The dialogue itself lives in the per-user
// "Bored Chat Support" conversation (§1.69) — ordinary messages, ordinary
// push/receipts; the ticket is the admin inbox's index card.
export const SupportTicketSchema = z.object({
  id: UuidSchema,
  category: SupportCategorySchema,
  body: z.string().max(SUPPORT_BODY_MAX_CHARS),
  attachment: AttachmentSchema.nullable(), // the optional screenshot
  status: SupportTicketStatusSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type SupportTicket = z.infer<typeof SupportTicketSchema>;

export const CreateSupportTicketRequestSchema = z.object({
  category: SupportCategorySchema,
  body: z.string().min(1).max(SUPPORT_BODY_MAX_CHARS),
  attachment_id: UuidSchema.optional(), // mine, kind image, ready
});
export type CreateSupportTicketRequest = z.infer<typeof CreateSupportTicketRequestSchema>;

export const SupportTicketResponseSchema = z.object({ ticket: SupportTicketSchema });
export type SupportTicketResponse = z.infer<typeof SupportTicketResponseSchema>;

export const SupportTicketsResponseSchema = z.object({
  tickets: z.array(SupportTicketSchema), // mine, created_at DESC
});
export type SupportTicketsResponse = z.infer<typeof SupportTicketsResponseSchema>;

// Admin inbox row: the ticket + who filed it.
export const AdminSupportTicketSchema = SupportTicketSchema.extend({
  user: UserLiteSchema.nullable(), // null = account deleted since
});
export type AdminSupportTicket = z.infer<typeof AdminSupportTicketSchema>;

export const AdminSupportTicketsResponseSchema = z.object({
  tickets: z.array(AdminSupportTicketSchema), // open first, then created_at DESC
  next_cursor: z.string().nullable(),
});
export type AdminSupportTicketsResponse = z.infer<typeof AdminSupportTicketsResponseSchema>;

export const AdminSupportReplyRequestSchema = z.object({
  body: z.string().min(1).max(SUPPORT_BODY_MAX_CHARS),
});
export type AdminSupportReplyRequest = z.infer<typeof AdminSupportReplyRequestSchema>;

export const AdminSupportTicketResponseSchema = z.object({
  ticket: AdminSupportTicketSchema,
  // The support-conversation dialogue for THIS user (the user is talking TO
  // the operator — consent is structural, unlike private chats; ADR-020).
  messages: z.array(MessageSchema),
});
export type AdminSupportTicketResponse = z.infer<typeof AdminSupportTicketResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: content moderation, report context, update banner (v0.8b — API.md
// §1.69, FEATURES #81, ADR-020)
// ---------------------------------------------------------------------------

export const AdminContentTypeSchema = z.enum(ADMIN_CONTENT_TYPES);
export type AdminContentType = z.infer<typeof AdminContentTypeSchema>;

// One row of the content tab: PUBLIC surfaces only (public posts, public
// beacons, all board listings). These are things anyone on the instance can
// already read — showing excerpts here crosses no privacy line (unlike
// messages, which never appear).
export const AdminContentRowSchema = z.object({
  type: AdminContentTypeSchema,
  id: UuidSchema,
  author: UserLiteSchema.nullable(),
  // type-appropriate glance data: post → body excerpt; beacon → vibe+note;
  // listing → kind+title.
  title: z.string(), // listing title / beacon vibe label / '' for posts
  excerpt: z.string(), // first 80 chars of the public text
  status: z.string(), // the object's own status enum, as stored
  created_at: IsoDateTimeSchema,
});
export type AdminContentRow = z.infer<typeof AdminContentRowSchema>;

export const AdminContentQuerySchema = z.object({
  type: AdminContentTypeSchema.optional(), // omitted = all three
  q: z.string().max(80).optional(), // ILIKE over title/body
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type AdminContentQuery = z.infer<typeof AdminContentQuerySchema>;

export const AdminContentResponseSchema = z.object({
  items: z.array(AdminContentRowSchema), // created_at DESC
  next_cursor: z.string().nullable(),
});
export type AdminContentResponse = z.infer<typeof AdminContentResponseSchema>;

// POST /api/admin/content/:type/:id/takedown — reason REQUIRED: it is shown
// to the author (neutrally, via their Support conversation) and ring-logged.
export const TakedownRequestSchema = z.object({
  reason: z.string().min(1).max(TAKEDOWN_REASON_MAX_CHARS),
});
export type TakedownRequest = z.infer<typeof TakedownRequestSchema>;

// GET /api/admin/reports/:id/context — THE one admin surface that shows
// message bodies, and only because the REPORTER consented at report time
// (include_context; REPORT_CONTEXT_CONSENT_COPY is the exact copy they saw).
// The slice is the reported message ± REPORT_CONTEXT_RADIUS by seq, resolved
// LIVE (tombstones show as deleted); attachments are kind/mime metadata only
// — no admin media URLs exist. Ghost masks do NOT apply here (the server was
// never anonymous; §1.68). Every view is ring-logged.
export const AdminContextMessageSchema = z.object({
  seq: SeqSchema,
  sender: UserLiteSchema.nullable(),
  type: MessageTypeSchema,
  body: z.string().nullable(), // the consented disclosure; null for body-less kinds
  attachments: z.array(z.object({ kind: AttachmentKindSchema, mime: z.string() })),
  created_at: IsoDateTimeSchema,
  deleted: z.boolean(),
  reported: z.boolean(), // true on the reported seq itself
});
export type AdminContextMessage = z.infer<typeof AdminContextMessageSchema>;

export const ReportContextResponseSchema = z.object({
  context: z.object({
    conversation_id: UuidSchema,
    messages: z.array(AdminContextMessageSchema), // seq ASC, ≤ 2×radius+1
  }),
});
export type ReportContextResponse = z.infer<typeof ReportContextResponseSchema>;

// GET /api/admin/update — the "update available" banner's read. running_commit
// is baked at image build (GIT_COMMIT build arg; null in dev). latest_commit
// comes from the worker's cached HTTPS smart-protocol peek at the instance
// repo remote's HEAD; update_available is NULL when the remote is unreachable
// or no commit is baked (documented honesty — never a guess). The update
// itself runs on the HOST (./bored update / autoupdate): the container never
// gets docker.sock, so the banner instructs, it never executes.
export const AdminUpdateStatusSchema = z.object({
  running_commit: z.string().nullable(),
  running_version: z.string().nullable(), // newest instance release_notes version
  latest_commit: z.string().nullable(),
  update_available: z.boolean().nullable(),
  checked_at: IsoDateTimeSchema.nullable(),
});
export type AdminUpdateStatus = z.infer<typeof AdminUpdateStatusSchema>;

export const AdminUpdateResponseSchema = z.object({ update: AdminUpdateStatusSchema });
export type AdminUpdateResponse = z.infer<typeof AdminUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// §1.70 Passkeys (v0.9 — ADR-021, FEATURES #82)
// ---------------------------------------------------------------------------

// The WebAuthn request/response JSON (PublicKeyCredentialCreationOptionsJSON,
// RegistrationResponseJSON, …) is the W3C-specified wire format produced and
// consumed by @simplewebauthn (version-pinned in ADR-021). The contract
// deliberately does NOT re-pin that shape — the library owns it; we validate
// only that it is a JSON object and let verification do the real work.
export const WebAuthnJsonSchema = z.record(z.unknown());
export type WebAuthnJson = z.infer<typeof WebAuthnJsonSchema>;

export const PasskeyInfoSchema = z.object({
  id: UuidSchema,
  nickname: z.string().max(PASSKEY_NICKNAME_MAX_CHARS).nullable(),
  transports: z.array(z.string()), // authenticator hints ('internal','hybrid',…), advisory
  device_type: z.enum(PASSKEY_DEVICE_TYPES),
  backed_up: z.boolean(), // synced credential (e.g. iCloud/Google) vs device-bound
  created_at: IsoDateTimeSchema,
  last_used_at: IsoDateTimeSchema.nullable(),
});
export type PasskeyInfo = z.infer<typeof PasskeyInfoSchema>;

export const PasskeysResponseSchema = z.object({ passkeys: z.array(PasskeyInfoSchema) });
export type PasskeysResponse = z.infer<typeof PasskeysResponseSchema>;

export const PasskeyRegisterOptionsResponseSchema = z.object({ options: WebAuthnJsonSchema });
export type PasskeyRegisterOptionsResponse = z.infer<typeof PasskeyRegisterOptionsResponseSchema>;

export const PasskeyRegisterRequestSchema = z.object({
  response: WebAuthnJsonSchema, // RegistrationResponseJSON from the browser
  nickname: z.string().min(1).max(PASSKEY_NICKNAME_MAX_CHARS).optional(),
});
export type PasskeyRegisterRequest = z.infer<typeof PasskeyRegisterRequestSchema>;

export const PasskeyRegisterResponseSchema = z.object({ passkey: PasskeyInfoSchema });
export type PasskeyRegisterResponse = z.infer<typeof PasskeyRegisterResponseSchema>;

export const RenamePasskeyRequestSchema = z.object({
  nickname: z.string().min(1).max(PASSKEY_NICKNAME_MAX_CHARS),
});
export type RenamePasskeyRequest = z.infer<typeof RenamePasskeyRequestSchema>;

// Login. username is LOOSE (max-length only, the §1.1 invite_token doctrine):
// an unknown username answers the SAME 200 with empty allowCredentials as a
// user with no passkeys — never an enumeration oracle. Omitted username =
// discoverable-credential (resident key) flow.
export const PasskeyLoginOptionsRequestSchema = z.object({
  username: z.string().max(254).optional(),
});
export type PasskeyLoginOptionsRequest = z.infer<typeof PasskeyLoginOptionsRequestSchema>;

// challenge_ref binds the verify call to the Redis-stored challenge
// (WEBAUTHN_CHALLENGE_TTL_S, one-shot) — the logged-out client has no other
// anchor. It is random, single-use, and worthless without the matching
// authenticator assertion.
export const PasskeyLoginOptionsResponseSchema = z.object({
  challenge_ref: z.string(),
  options: WebAuthnJsonSchema,
});
export type PasskeyLoginOptionsResponse = z.infer<typeof PasskeyLoginOptionsResponseSchema>;

export const PasskeyLoginRequestSchema = z.object({
  challenge_ref: z.string().min(1).max(128),
  response: WebAuthnJsonSchema, // AuthenticationResponseJSON from the browser
});
export type PasskeyLoginRequest = z.infer<typeof PasskeyLoginRequestSchema>;
// Response: LoginOutcome (§1.1) — {user} + Set-Cookie, or the §1.73 TOTP
// challenge when the account is TOTP-armed.

// ---------------------------------------------------------------------------
// §1.71 QR / cross-device login (v0.9 — ADR-021, FEATURES #83)
// ---------------------------------------------------------------------------

// Minted by the LOGGED-OUT laptop. code is returned ONCE (the server keeps
// sha256 only): it rides the QR as <origin>/link/<code> and is the poll
// capability. display_code is the human fallback the phone can type instead
// of scanning. url is the app-origin PATH /link/<code> (the §1.11 url rule).
export const CreateLoginLinkResponseSchema = z.object({
  code: z.string(),
  display_code: z.string().length(LOGIN_LINK_DISPLAY_CODE_LEN),
  url: z.string(),
  expires_at: IsoDateTimeSchema,
});
export type CreateLoginLinkResponse = z.infer<typeof CreateLoginLinkResponseSchema>;

// Codes arrive LOOSE everywhere (≤ 64 chars; normalized route-side) — a
// mangled paste fails verification with the same 410 as an expired link,
// never schema validation.
export const PollLoginLinkRequestSchema = z.object({ code: z.string().min(1).max(64) });
export type PollLoginLinkRequest = z.infer<typeof PollLoginLinkRequestSchema>;

// 'pending' while unapproved (laptop re-polls every LOGIN_LINK_POLL_INTERVAL_MS);
// the first poll AFTER approval mints the session (Set-Cookie on this very
// response), flips the row to consumed, and answers 'consumed' + user. Every
// later poll — and any unknown/expired/foreign code — is 410 link_gone,
// byte-identical.
export const PollLoginLinkResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), expires_at: IsoDateTimeSchema }),
  z.object({ status: z.literal('consumed'), user: UserPrivateSchema }),
]);
export type PollLoginLinkResponse = z.infer<typeof PollLoginLinkResponseSchema>;

export const LookupLoginLinkRequestSchema = z.object({ code: z.string().min(1).max(64) });
export type LookupLoginLinkRequest = z.infer<typeof LookupLoginLinkRequestSchema>;

// What the phone's approve sheet shows about the laptop asking to be logged
// in: UA (parsed client-side into "Chrome on Linux" style) + a COARSE ip hint
// — enough to say "that's my laptop", nothing more.
export const LoginLinkInfoSchema = z.object({
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  user_agent: z.string().nullable(),
  ip_hint: z.string().nullable(),
});
export type LoginLinkInfo = z.infer<typeof LoginLinkInfoSchema>;

export const LookupLoginLinkResponseSchema = z.object({ link: LoginLinkInfoSchema });
export type LookupLoginLinkResponse = z.infer<typeof LookupLoginLinkResponseSchema>;

// code may be the FULL code (QR path /link/<code>) or the 6-char display
// code (typed) — the server tries both hashes.
export const ApproveLoginLinkRequestSchema = z.object({ code: z.string().min(1).max(64) });
export type ApproveLoginLinkRequest = z.infer<typeof ApproveLoginLinkRequestSchema>;

// ---------------------------------------------------------------------------
// §1.72 Recovery codes (v0.9 — ADR-021, FEATURES #84)
// ---------------------------------------------------------------------------

export const RecoveryCodesStatusResponseSchema = z.object({
  total: z.number().int().nonnegative(), // codes in the current generation
  remaining: z.number().int().nonnegative(), // unused among them
  generated_at: IsoDateTimeSchema.nullable(), // null = none exist (pre-v0.9 account)
});
export type RecoveryCodesStatusResponse = z.infer<typeof RecoveryCodesStatusResponseSchema>;

// Regeneration re-proves the password (a stolen unlocked phone must not be
// able to mint fresh codes silently) and INVALIDATES the old set.
export const RegenerateRecoveryCodesRequestSchema = z.object({ password: z.string().min(1) });
export type RegenerateRecoveryCodesRequest = z.infer<typeof RegenerateRecoveryCodesRequestSchema>;

// §1.72 change password while signed in: re-proves the current password and
// signs out every OTHER device (this session stays).
export const ChangePasswordRequestSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(PASSWORD_MIN_LENGTH),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export const ChangePasswordResponseSchema = z.object({ ok: z.literal(true) });
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;

export const RecoveryCodesResponseSchema = z.object({
  recovery_codes: z.array(z.string()), // display form, shown ONCE
});
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponseSchema>;

// Recovery login: consumes one code atomically, revokes ALL sessions (4401),
// notifies via the §1.69 Support conversation + push, and answers a one-shot
// reset_token (Redis, RESET_TOKEN_TTL_S) — NO session yet: recovery FORCES a
// new password first.
export const RecoverRequestSchema = z.object({
  username_or_email: z.string().min(1),
  code: z.string().min(1).max(64), // loose; normalized route-side
});
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;

export const RecoverResponseSchema = z.object({ reset_token: z.string() });
export type RecoverResponse = z.infer<typeof RecoverResponseSchema>;

export const ResetPasswordRequestSchema = z.object({
  reset_token: z.string().min(1).max(128),
  new_password: z.string().min(PASSWORD_MIN_LENGTH),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const ResetPasswordResponseSchema = z.object({ user: UserPrivateSchema });
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;

// ---------------------------------------------------------------------------
// §1.73 TOTP 2FA (v0.9 — ADR-021, FEATURES #85)
// ---------------------------------------------------------------------------

// Setup: a PENDING secret (Redis, TOTP_SETUP_TTL_S — nothing touches the
// users row until a valid code proves the authenticator has it). otpauth_uri
// renders as a QR client-side (hand-rolled SVG encoder, ADR-021); manual_key
// is the same secret as grouped base32 for copy/type-in — ALWAYS shown.
export const TotpSetupResponseSchema = z.object({
  otpauth_uri: z.string(),
  manual_key: z.string(),
  expires_at: IsoDateTimeSchema,
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

export const TotpEnableRequestSchema = z.object({
  code: z.string().regex(TOTP_CODE_REGEX),
});
export type TotpEnableRequest = z.infer<typeof TotpEnableRequestSchema>;

// Disable requires proof: the current 6-digit code OR one recovery code
// (consumed) — exactly one of the two fields.
export const TotpDisableRequestSchema = z
  .object({
    code: z.string().regex(TOTP_CODE_REGEX).optional(),
    recovery_code: z.string().min(1).max(64).optional(),
  })
  .refine((d) => (d.code === undefined) !== (d.recovery_code === undefined), {
    message: 'exactly one of code / recovery_code',
  });
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;

// The second half of a TOTP-gated login (§1.1/§1.70 LoginOutcome handed out
// totp_token). Success mints the standard session → {user} + Set-Cookie.
export const TotpVerifyRequestSchema = z.object({
  totp_token: z.string().min(1).max(128),
  code: z.string().regex(TOTP_CODE_REGEX),
});
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// §1.74 Admin Authentication settings (v0.9 — ADR-021, FEATURES #86)
// ---------------------------------------------------------------------------
// The settings DTOs live with InstanceSettings above (AuthSettingsSchema /
// AuthSettingsPatchSchema). Test send exists in the contract but answers
// 503 mailer_unavailable until a mailer ships (ADR-021 honesty).

export const SmtpTestSendRequestSchema = z.object({ to: z.string().email() });
export type SmtpTestSendRequest = z.infer<typeof SmtpTestSendRequestSchema>;
