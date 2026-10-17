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
  LISTING_ROOM_PHOTOS_MAX,
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

// v0.3 (API.md §0): the minimal embeddable identity — beacon joiner piles,
// seen-by lists, blocked lists, role assignees. Deliberately carries NO
// last_seen_at and NO area (privacy surfaces never ride list DTOs).
export const UserLiteSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  display_name: z.string(),
  avatar: AvatarSchema,
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
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const LoginRequestSchema = z.object({
  username_or_email: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({ user: UserPrivateSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

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

export const ReportKindSchema = z.enum(['user', 'message', 'beacon']);
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
  }),
  z.object({
    kind: z.literal('beacon'),
    beacon_id: UuidSchema,
    reason: z.string().max(REPORT_REASON_MAX_CHARS).default(''),
  }),
]);
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

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
});
export type Story = z.infer<typeof StorySchema>;

export const CreateStoryRequestSchema = z.object({
  attachment_id: UuidSchema, // mine, kind image|video, unbound
  caption: z.string().max(STORY_CAPTION_MAX_CHARS).default(''),
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
  tags: z
    .array(z.string().min(1).max(LISTING_GIG_TAG_MAX_CHARS))
    .max(LISTING_GIG_TAGS_MAX)
    .default([]),
});
export type GigDetails = z.infer<typeof GigDetailsSchema>;

// kind='ride' (FEATURES #40). departs_at doubles as the listing's expires_at.
export const RideDetailsSchema = z.object({
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
  attachment_ids: z.array(UuidSchema).max(LISTING_ROOM_PHOTOS_MAX).default([]),
});
export type RoomDetails = z.infer<typeof RoomDetailsSchema>;

// kind='place_review' (FEATURES #42). rating here is about a PLACE, not a
// person — PSYCHOLOGY rule 3 is about scoring people; venues are fair game.
// These never expire and later feed beacon venue suggestions.
export const PlaceReviewDetailsSchema = z.object({
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
  // §1.38 room photos, resolved server-side from details.attachment_ids
  // ([] for every other kind).
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
  kind: z.enum(['user', 'message', 'beacon']),
  reporter: UserLiteSchema.nullable(), // null = account deleted since
  reason: z.string(),
  status: z.enum(['open', 'closed']),
  created_at: IsoDateTimeSchema,
  closed_at: IsoDateTimeSchema.nullable(),
  closed_by: UserLiteSchema.nullable().default(null),
  close_note: z.string().default(''),
  // Exactly one of these three is non-null, matching `kind` (unless the
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

// §1.41 instance settings (instance_settings key/value jsonb; one key today).
// invites_enabled=false is enforced at invite MINT (403 invites_disabled) and
// ACCEPT (403 invites_disabled, no use_count claim); register-with-token
// degrades to invite: null per §1.1.
export const InstanceSettingsSchema = z.object({
  invites_enabled: z.boolean(),
});
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

export const UpdateInstanceSettingsRequestSchema = InstanceSettingsSchema.partial();
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

// My own opt-in state (owner-only — nobody else ever sees this DTO).
export const DiscoveryOptinSchema = z.object({
  scope: DiscoveryScopeSchema,
  note: z.string().max(DISCOVERY_NOTE_MAX_CHARS),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});
export type DiscoveryOptin = z.infer<typeof DiscoveryOptinSchema>;

export const DiscoveryOptinRequestSchema = z.object({
  scope: DiscoveryScopeSchema,
  note: z.string().max(DISCOVERY_NOTE_MAX_CHARS).default(''),
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
});
export type DiscoveryCard = z.infer<typeof DiscoveryCardSchema>;

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
