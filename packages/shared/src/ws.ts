// WebSocket protocol (docs/API.md §2) — JSON text frames {"t": "<event>", "d": {...}}.
// Unknown `t` values MUST be ignored by both sides (forward compatibility), so
// consumers should fall back to ignoring frames that fail the discriminated parse.
import { z } from 'zod';
import { PRESENCE_SUB_MAX } from './constants.js';
import {
  AttachmentSchema,
  BeaconRoleSchema,
  BeaconSchema,
  ConversationSchema,
  IsoDateTimeSchema,
  KudosKindSchema,
  LinkPreviewSchema,
  MessageSchema,
  ReactionEmojiSchema,
  SeqSchema,
  UserLiteSchema,
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

// v0.2 (API.md §1.12/§2.3): one frame per reaction add/remove, fanned out to
// all active participants via the Redis `events` channel — deliberately NOT a
// full msg.updated (a reaction flurry must not re-ship message DTOs with
// attachments). `count` is the NEW total for (conversation_id, seq, emoji);
// count 0 removes the chip. `mine` is derived client-side (user_id === me).
// Deltas are safe to apply out of order per actor because the server emits one
// frame per successful idempotent write; a reconnect re-reads aggregates from
// message DTOs (reactions[]) instead of replaying frames.
export const ReactionUpdatedEventSchema = z.object({
  t: z.literal('reaction.updated'),
  d: z.object({
    conversation_id: UuidSchema,
    seq: z.number().int().positive(),
    emoji: ReactionEmojiSchema,
    count: z.number().int().nonnegative(),
    user_id: UuidSchema,
    removed: z.boolean(),
  }),
});
export type ReactionUpdatedEvent = z.infer<typeof ReactionUpdatedEventSchema>;

export const PreviewReadyEventSchema = z.object({
  t: z.literal('preview.ready'),
  d: z.object({
    url_hash: z.string(),
    status: z.enum(['ok', 'failed']),
    preview: LinkPreviewSchema.optional(),
  }),
});
export type PreviewReadyEvent = z.infer<typeof PreviewReadyEventSchema>;

// v0.3 (API.md §1.15/§2.3): a new beacon, fanned out ONLY to sockets of users
// in its audience (friends / same-area / public, minus blocks) — never to
// anyone who cannot join it (PSYCHOLOGY design rule 2). The beacon DTO is
// viewer-specific, so the gateway stamps my_state/conversation_id per
// recipient before sending.
export const BeaconNewEventSchema = z.object({
  t: z.literal('beacon.new'),
  d: z.object({
    beacon: BeaconSchema,
  }),
});
export type BeaconNewEvent = z.infer<typeof BeaconNewEventSchema>;

// Joins / leave / spark / expiry / cancellation. To the audience; on spark the
// payload sent to NON-joiners carries status 'sparked' with conversation_id
// null (their card simply retires) — spark details reach joiners + creator
// only. reping = true marks the one "needs 1 more" re-notification
// (repinged_at guard: at most once per beacon).
export const BeaconUpdatedEventSchema = z.object({
  t: z.literal('beacon.updated'),
  d: z.object({
    beacon: BeaconSchema,
    reping: z.boolean().default(false),
  }),
});
export type BeaconUpdatedEvent = z.infer<typeof BeaconUpdatedEventSchema>;

// PRIVATE kudos delivery — to the RECIPIENT's sockets only, never fanned to
// the group, never counted publicly (API.md §1.15; PSYCHOLOGY §9).
export const BeaconKudosEventSchema = z.object({
  t: z.literal('beacon.kudos'),
  d: z.object({
    beacon_id: UuidSchema,
    kind: KudosKindSchema,
    from: UserLiteSchema,
  }),
});
export type BeaconKudosEvent = z.infer<typeof BeaconKudosEventSchema>;

// v0.3 plan roles (API.md §1.16): the FULL roles list on every change (add /
// claim / release / complete / delete), to the plan conversation's active
// participants. A dedicated event — deliberately not conv.updated, which
// re-ships the whole Conversation DTO with participants; roles belong to the
// beacon and are small (≤ BEACON_ROLES_MAX). Full-list replace means frames
// are idempotent and reorder-safe; reconnects reconcile from
// GET /api/beacons/:id/roles, never frame replay.
export const PlanUpdatedEventSchema = z.object({
  t: z.literal('plan.updated'),
  d: z.object({
    beacon_id: UuidSchema,
    conversation_id: UuidSchema,
    roles: z.array(BeaconRoleSchema),
  }),
});
export type PlanUpdatedEvent = z.infer<typeof PlanUpdatedEventSchema>;

// v0.3 polls (API.md §1.17): one frame per effective vote/unvote, to all
// active participants — the reaction.updated pattern, not a msg.updated
// re-ship. counts is the NEW aggregate (same length as options). user_id /
// option_idx (the voter's new choice, null = unvoted) ride ONLY the frame
// sent to the voter's OWN sockets, so my_vote can reconcile cross-device;
// everyone else receives aggregates only — per-voter ballots must never be
// reconstructible from the wire (§1.17: no per-voter lists, a poll is a
// decision tool, not a scoreboard). Reconnect truth is message DTOs
// (message.poll), never frame replay.
export const PollUpdatedEventSchema = z.object({
  t: z.literal('poll.updated'),
  d: z.object({
    poll_id: UuidSchema,
    conversation_id: UuidSchema,
    seq: z.number().int().positive(),
    counts: z.array(z.number().int().nonnegative()),
    total_votes: z.number().int().nonnegative(),
    user_id: UuidSchema.optional(),
    option_idx: z.number().int().nonnegative().nullable().optional(),
  }),
});
export type PollUpdatedEvent = z.infer<typeof PollUpdatedEventSchema>;

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
  ReactionUpdatedEventSchema,
  PreviewReadyEventSchema,
  BeaconNewEventSchema,
  BeaconUpdatedEventSchema,
  BeaconKudosEventSchema,
  PlanUpdatedEventSchema,
  PollUpdatedEventSchema,
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
