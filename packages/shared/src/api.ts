// REST contract (docs/API.md) — Zod schemas + inferred types for every DTO.
// Field names follow docs/API.md exactly. This file IS the contract.
import { z } from 'zod';
import {
  AREA_MAX_CHARS,
  BEACON_NOTE_MAX_CHARS,
  BEACON_ROLE_LABEL_MAX_CHARS,
  BEACON_SPARK_THRESHOLD_MAX,
  BEACON_SPARK_THRESHOLD_MIN,
  BEACON_VIBES,
  INVITE_TOKEN_REGEX,
  KUDOS_KINDS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PASSWORD_MIN_LENGTH,
  POLL_OPTION_MAX_CHARS,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX_CHARS,
  REACTION_EMOJI_MAX_LEN,
  REPORT_REASON_MAX_CHARS,
  USERNAME_REGEX,
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

export const AttachmentKindSchema = z.enum(['image', 'video', 'file']);
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
export const MessageTypeSchema = z.enum(['text', 'image', 'video', 'file', 'system', 'poll']);
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

export const MessageMetadataSchema = z.object({
  link_preview: LinkPreviewSchema.optional(),
  system: SystemEventMetadataSchema.optional(),
  afterglow: AfterglowMetadataSchema.optional(), // v0.3; on the recap system message
});
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

// v0.2 reactions (API.md §1.12). Zod's max() counts UTF-16 units — stricter
// than the DB CHECK's codepoint count for astral emoji, so Zod is binding.
export const ReactionEmojiSchema = z.string().min(1).max(REACTION_EMOJI_MAX_LEN);
export type ReactionEmoji = z.infer<typeof ReactionEmojiSchema>;

// One aggregate chip per emoji on a message, from the viewer's perspective.
// Server orders by first-reaction time (min created_at per emoji) so chips
// never reshuffle as counts change.
export const ReactionAggregateSchema = z.object({
  emoji: ReactionEmojiSchema,
  count: z.number().int().positive(),
  mine: z.boolean(),
});
export type ReactionAggregate = z.infer<typeof ReactionAggregateSchema>;

export const MessageSchema = z.object({
  id: UuidSchema,
  conversation_id: UuidSchema,
  seq: z.number().int().positive(),
  sender_id: UuidSchema.nullable(), // null = system
  type: MessageTypeSchema,
  body: z.string().nullable(),
  metadata: MessageMetadataSchema,
  reply_to_id: UuidSchema.nullable(),
  attachments: z.array(AttachmentSchema),
  // v0.2: aggregated reactions. default([]) keeps pre-v0.2 payloads (IndexedDB
  // rows, old fixtures) parsing clean; the server always emits the array.
  reactions: z.array(ReactionAggregateSchema).default([]),
  // v0.3 (§1.17): populated iff type === 'poll'; viewer-specific (my_vote).
  // default(null) keeps pre-v0.3 payloads parsing clean.
  poll: PollSchema.nullable().default(null),
  created_at: IsoDateTimeSchema,
  edited_at: IsoDateTimeSchema.nullable(),
  deleted_at: IsoDateTimeSchema.nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ParticipantRoleSchema = z.enum(['member', 'admin']);
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

export const ConversationTypeSchema = z.enum(['dm', 'group']);
export type ConversationType = z.infer<typeof ConversationTypeSchema>;

export const ConversationSchema = z.object({
  id: UuidSchema,
  type: ConversationTypeSchema,
  title: z.string().nullable(),
  avatar: AvatarSchema,
  created_by: UuidSchema.nullable(),
  last_seq: SeqSchema,
  last_message_at: IsoDateTimeSchema.nullable(),
  participants: z.array(ParticipantSchema),
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

export const SendMessageRequestSchema = z.object({
  client_msg_id: UuidSchema, // idempotency key; replay returns 200 with the original row
  type: z.enum(['text', 'image', 'video', 'file']),
  body: z.string().max(MAX_MESSAGE_BODY_CHARS).optional(),
  attachment_ids: z.array(UuidSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  metadata: z
    .object({ link_preview: LinkPreviewSchema.optional() })
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
// inviter); 'group' = scoped to that group conversation.
export const InviteKindSchema = z.enum(['dm', 'group']);
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

export const AddReactionRequestSchema = z.object({ emoji: ReactionEmojiSchema });
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
