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
  BEACON_VIBES,
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

// v0.3 beacons (API.md §1.15): the fixed vibe chip set.
export const BeaconVibeSchema = z.enum(BEACON_VIBES);
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
export const SendMessageRequestSchema = z.object({
  client_msg_id: UuidSchema, // idempotency key; replay returns 200 with the original row
  type: z.enum(['text', 'image', 'video', 'file', 'audio', 'vibe_check', 'puzzle_result']),
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
  created_at: IsoDateTimeSchema,
});
export type Beacon = z.infer<typeof BeaconSchema>;

// starts_at/expires_at are CLIENT-computed from the now/tonight/weekend preset
// chips (the server is timezone-blind; API.md §1.15 documents the preset
// mapping) and server-validated against the BEACON_* window bounds.
// audience omitted ⇒ the creator's beacon_default_audience setting.
export const CreateBeaconRequestSchema = z.object({
  vibe: BeaconVibeSchema,
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
});
export type CreateBeaconRequest = z.infer<typeof CreateBeaconRequestSchema>;

export const BeaconResponseSchema = z.object({ beacon: BeaconSchema });
export type BeaconResponse = z.infer<typeof BeaconResponseSchema>;

export const ListBeaconsResponseSchema = z.object({ beacons: z.array(BeaconSchema) });
export type ListBeaconsResponse = z.infer<typeof ListBeaconsResponseSchema>;

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

export const PostCommentSchema = z.object({
  id: UuidSchema,
  post_id: UuidSchema,
  author: UserLiteSchema,
  body: z.string().min(1).max(POST_COMMENT_MAX_CHARS),
  created_at: IsoDateTimeSchema,
});
export type PostComment = z.infer<typeof PostCommentSchema>;

// comments = the latest POST_COMMENTS_PREVIEW_MAX in created_at ASC;
// has_more_comments carries the rest (no comment COUNT is ever serialized).
export const PostSchema = z.object({
  id: UuidSchema,
  author: UserLiteSchema,
  body: z.string().max(POST_BODY_MAX_CHARS),
  attachments: z.array(AttachmentSchema).max(POST_MAX_ATTACHMENTS),
  reactions: z.array(PostReactionAggregateSchema),
  comments: z.array(PostCommentSchema),
  has_more_comments: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type Post = z.infer<typeof PostSchema>;

// At least one of body / attachment_ids (route-enforced → 400 empty_post).
export const CreatePostRequestSchema = z.object({
  body: z.string().max(POST_BODY_MAX_CHARS).default(''),
  attachment_ids: z.array(UuidSchema).max(POST_MAX_ATTACHMENTS).default([]),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const PostResponseSchema = z.object({ post: PostSchema });
export type PostResponse = z.infer<typeof PostResponseSchema>;

export const FeedQuerySchema = z.object({
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

export const CreateCommentRequestSchema = z.object({
  body: z.string().min(1).max(POST_COMMENT_MAX_CHARS),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;

export const CommentResponseSchema = z.object({ comment: PostCommentSchema });
export type CommentResponse = z.infer<typeof CommentResponseSchema>;

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

// GET /api/users/:username (v0.5a shape — additive: `profile` joins `user`).
export const UserProfileResponseSchema = z.object({
  user: UserPublicSchema,
  profile: ProfileSchema,
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
