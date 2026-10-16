// REST contract (docs/API.md) — Zod schemas + inferred types for every DTO.
// Field names follow docs/API.md exactly. This file IS the contract.
import { z } from 'zod';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_BODY_CHARS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PASSWORD_MIN_LENGTH,
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

export const UserPublicSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  display_name: z.string(),
  bio: z.string(),
  avatar: AvatarSchema,
  last_seen_at: IsoDateTimeSchema.nullable(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const UserPrivateSchema = UserPublicSchema.extend({
  email: z.string(),
  email_verified: z.boolean(),
  avatar_motion: AvatarMotionSchema,
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

export const MessageTypeSchema = z.enum(['text', 'image', 'video', 'file', 'system']);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const SystemEventMetadataSchema = z.object({
  event: z.string(),
  actor_id: UuidSchema.optional(),
  target_id: UuidSchema.optional(),
});
export type SystemEventMetadata = z.infer<typeof SystemEventMetadataSchema>;

export const MessageMetadataSchema = z.object({
  link_preview: LinkPreviewSchema.optional(),
  system: SystemEventMetadataSchema.optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

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
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({ user: UserPrivateSchema });
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
