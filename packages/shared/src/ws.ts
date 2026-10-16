// WebSocket protocol (docs/API.md §2) — JSON text frames {"t": "<event>", "d": {...}}.
// Unknown `t` values MUST be ignored by both sides (forward compatibility), so
// consumers should fall back to ignoring frames that fail the discriminated parse.
import { z } from 'zod';
import { PRESENCE_SUB_MAX } from './constants.js';
import {
  AttachmentSchema,
  ConversationSchema,
  IsoDateTimeSchema,
  LinkPreviewSchema,
  MessageSchema,
  SeqSchema,
  UserPublicSchema,
  UuidSchema,
} from './api.js';

// ---------------------------------------------------------------------------
// Server → client events (§2.3)
// ---------------------------------------------------------------------------

export const HelloEventSchema = z.object({
  t: z.literal('hello'),
  d: z.object({
    user_id: UuidSchema,
    session_id: UuidSchema,
    server_time: IsoDateTimeSchema,
    heartbeat_ms: z.number().int().positive(),
  }),
});
export type HelloEvent = z.infer<typeof HelloEventSchema>;

export const MsgNewEventSchema = z.object({
  t: z.literal('msg.new'),
  d: z.object({
    conversation_id: UuidSchema,
    message: MessageSchema,
  }),
});
export type MsgNewEvent = z.infer<typeof MsgNewEventSchema>;

// Full fresh DTO — replace by (conversation_id, seq).
export const MsgUpdatedEventSchema = z.object({
  t: z.literal('msg.updated'),
  d: z.object({
    conversation_id: UuidSchema,
    message: MessageSchema,
  }),
});
export type MsgUpdatedEvent = z.infer<typeof MsgUpdatedEventSchema>;

// To the uploader only, when processing finishes before the attachment is bound.
export const AttachmentReadyEventSchema = z.object({
  t: z.literal('attachment.ready'),
  d: z.object({
    attachment: AttachmentSchema,
  }),
});
export type AttachmentReadyEvent = z.infer<typeof AttachmentReadyEventSchema>;

// Coalesced server-side: at most one per (conversation, user) per 1000 ms.
export const ReceiptEventSchema = z.object({
  t: z.literal('receipt'),
  d: z.object({
    conversation_id: UuidSchema,
    user_id: UuidSchema,
    last_delivered_seq: SeqSchema,
    last_read_seq: SeqSchema,
  }),
});
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;

export const ServerTypingEventSchema = z.object({
  t: z.literal('typing'),
  d: z.object({
    conversation_id: UuidSchema,
    user_id: UuidSchema,
    expires_at: IsoDateTimeSchema,
  }),
});
export type ServerTypingEvent = z.infer<typeof ServerTypingEventSchema>;

export const PresenceEventSchema = z.object({
  t: z.literal('presence'),
  d: z.object({
    user_id: UuidSchema,
    online: z.boolean(),
    last_seen_at: IsoDateTimeSchema.optional(),
  }),
});
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

export const ConvNewEventSchema = z.object({
  t: z.literal('conv.new'),
  d: z.object({
    conversation: ConversationSchema,
  }),
});
export type ConvNewEvent = z.infer<typeof ConvNewEventSchema>;

export const ConvUpdatedEventSchema = z.object({
  t: z.literal('conv.updated'),
  d: z.object({
    conversation: ConversationSchema,
  }),
});
export type ConvUpdatedEvent = z.infer<typeof ConvUpdatedEventSchema>;

export const UserUpdatedEventSchema = z.object({
  t: z.literal('user.updated'),
  d: z.object({
    user: UserPublicSchema,
  }),
});
export type UserUpdatedEvent = z.infer<typeof UserUpdatedEventSchema>;

export const PreviewReadyEventSchema = z.object({
  t: z.literal('preview.ready'),
  d: z.object({
    url_hash: z.string(),
    status: z.enum(['ok', 'failed']),
    preview: LinkPreviewSchema.optional(),
  }),
});
export type PreviewReadyEvent = z.infer<typeof PreviewReadyEventSchema>;

export const ErrorEventSchema = z.object({
  t: z.literal('error'),
  d: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const ServerEventSchema = z.discriminatedUnion('t', [
  HelloEventSchema,
  MsgNewEventSchema,
  MsgUpdatedEventSchema,
  AttachmentReadyEventSchema,
  ReceiptEventSchema,
  ServerTypingEventSchema,
  PresenceEventSchema,
  ConvNewEventSchema,
  ConvUpdatedEventSchema,
  UserUpdatedEventSchema,
  PreviewReadyEventSchema,
  ErrorEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ---------------------------------------------------------------------------
// Client → server events (§2.4) — ephemeral signals only; durable writes are REST
// ---------------------------------------------------------------------------

// "I have durably stored everything up to seq." Push acceptance never sends this
// (receipt honesty) — only a running client after its IndexedDB write commits.
export const DeliveredEventSchema = z.object({
  t: z.literal('delivered'),
  d: z.object({
    conversation_id: UuidSchema,
    seq: SeqSchema,
  }),
});
export type DeliveredEvent = z.infer<typeof DeliveredEventSchema>;

// Monotonic; server also raises last_delivered_seq (read implies delivered).
export const ReadEventSchema = z.object({
  t: z.literal('read'),
  d: z.object({
    conversation_id: UuidSchema,
    seq: SeqSchema,
  }),
});
export type ReadEvent = z.infer<typeof ReadEventSchema>;

// No typing.stop — the 6 s expiry handles death mid-keystroke.
export const ClientTypingEventSchema = z.object({
  t: z.literal('typing'),
  d: z.object({
    conversation_id: UuidSchema,
  }),
});
export type ClientTypingEvent = z.infer<typeof ClientTypingEventSchema>;

export const PresenceSubEventSchema = z.object({
  t: z.literal('presence.sub'),
  d: z.object({
    user_ids: z.array(UuidSchema).min(1).max(PRESENCE_SUB_MAX),
  }),
});
export type PresenceSubEvent = z.infer<typeof PresenceSubEventSchema>;

export const PresenceUnsubEventSchema = z.object({
  t: z.literal('presence.unsub'),
  d: z.object({
    user_ids: z.array(UuidSchema).min(1).max(PRESENCE_SUB_MAX),
  }),
});
export type PresenceUnsubEvent = z.infer<typeof PresenceUnsubEventSchema>;

export const ClientEventSchema = z.discriminatedUnion('t', [
  DeliveredEventSchema,
  ReadEventSchema,
  ClientTypingEventSchema,
  PresenceSubEventSchema,
  PresenceUnsubEventSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ---------------------------------------------------------------------------
// Close codes (§2.10)
// ---------------------------------------------------------------------------

export const WS_CLOSE_CODES = {
  /** unauthenticated / session revoked or expired → probe /api/users/me */
  UNAUTHENTICATED: 4401,
  /** server going away / heartbeat timeout → reconnect with backoff */
  GOING_AWAY: 1001,
  /** protocol violation (repeated malformed frames) → reconnect once; report */
  POLICY_VIOLATION: 1008,
  /** overloaded, try later → reconnect with backoff, min 10 s */
  TRY_AGAIN_LATER: 1013,
} as const;
export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];
