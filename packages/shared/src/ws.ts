// WebSocket protocol (docs/API.md §2) — JSON text frames {"t": "<event>", "d": {...}}.
// Unknown `t` values MUST be ignored by both sides (forward compatibility), so
// consumers should fall back to ignoring frames that fail the discriminated parse.
import { z } from 'zod';
import {
  CALL_ICE_CANDIDATE_MAX_CHARS,
  CALL_SDP_MAX_CHARS,
  PRESENCE_SUB_MAX,
  YOUTUBE_VIDEO_ID_REGEX,
} from './constants.js';
import {
  ChatThemeSchema,
  ChatWallpaperSchema,
  AnonMessageSchema,
  AnonThreadSchema,
  AttachmentSchema,
  CallConnStateSchema,
  CallKindSchema,
  CallSchema,
  BeaconRoleSchema,
  BeaconSchema,
  ConnectionSchema,
  ConversationPrefsSchema,
  ConversationSchema,
  PostSchema,
  StorySchema,
  IsoDateTimeSchema,
  KudosKindSchema,
  LinkPreviewSchema,
  MessageSchema,
  ReactionEmojiSchema,
  ReactionKindSchema,
  ScheduledMessageSchema,
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
// attachments). The frame is a one-actor delta: `user_id` + `removed`; the
// recipient resolves the reactor's FACE from the participants it already
// holds and adds/removes it on the chip (no count ever rides the wire —
// PSYCHOLOGY rule 3). `mine` is derived client-side (user_id === me).
// Deltas are safe to apply out of order per actor because the server emits one
// frame per successful idempotent write; a reconnect re-reads aggregates from
// message DTOs (reactions[]) instead of replaying frames.
// v0.4 (§1.19) adds `kind` (default 'emoji' keeps v0.2 frames parsing clean).
// For kind='stamp' frames, emoji carries the STAMP_REACTION_KEY sentinel;
// recipients resolve the stamper's avatar from user_id against the
// participants they already hold (Message.stamps is the reconnect truth,
// exactly like reactions[].reactors for emoji).
export const ReactionUpdatedEventSchema = z.object({
  t: z.literal('reaction.updated'),
  d: z.object({
    conversation_id: UuidSchema,
    seq: z.number().int().positive(),
    kind: ReactionKindSchema.default('emoji'),
    emoji: ReactionEmojiSchema,
    user_id: UuidSchema,
    // The actor's face rides the frame: channel members are never in
    // Conversation.participants, so recipients cannot resolve every reactor
    // locally. Inside a ghost group non-admins get the MASK here (and the
    // pseudo-id above) — the same identity the DTO's reactors[] carries.
    // optional() on the WIRE only (the v0.4 `kind` default convention): the
    // server always sends it, but a web bundle paired with a not-yet-
    // restarted api must not drop every frame during the deploy window —
    // the store falls back to its participants lookup when it is absent.
    user: UserLiteSchema.optional(),
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

// Joins / leave / spark / expiry / cancellation — and, from v0.7, creator
// edits (API.md §1.47). To the audience; on spark the payload sent to
// NON-joiners carries status 'sparked' with conversation_id null (their card
// simply retires) — spark details reach joiners + creator only. reping = true
// marks the one "needs 1 more" re-notification (repinged_at guard: at most
// once per beacon). edited = true marks a creator edit; changed names the
// edited fields (a subset of BEACON_EDITABLE_FIELDS) so cards can flash the
// right chips — the DTO carries the full new state either way. Defaults keep
// pre-v0.7 frames parsing clean.
export const BeaconUpdatedEventSchema = z.object({
  t: z.literal('beacon.updated'),
  d: z.object({
    beacon: BeaconSchema,
    reping: z.boolean().default(false),
    edited: z.boolean().default(false),
    changed: z.array(z.string()).default([]),
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

// v1.0a (API.md §1.60, #95): the SHARED chat background changed — to ALL
// active members' sockets (unlike prefs.updated, which is owner-only: this
// is conversation-level state everyone renders). Full replace; reconnects
// reconcile from the prefs GET.
export const ConvBackgroundEventSchema = z.object({
  t: z.literal('conv.background'),
  d: z.object({
    conversation_id: UuidSchema,
    background: AttachmentSchema.nullable(),
  }),
});
export type ConvBackgroundEvent = z.infer<typeof ConvBackgroundEventSchema>;

// #95b: the shared theme/wallpaper changed — to every ACTIVE member (same
// audience as conv.background). Full replace of both fields.
export const ConvAppearanceEventSchema = z.object({
  t: z.literal('conv.appearance'),
  d: z.object({
    conversation_id: UuidSchema,
    theme: ChatThemeSchema.nullable(),
    wallpaper: ChatWallpaperSchema.nullable(),
  }),
});
export type ConvAppearanceEvent = z.infer<typeof ConvAppearanceEventSchema>;

// v0.4 (API.md §1.24): a chat-prefs change (theme / wallpaper / nicknames) —
// to the OWNER's own sockets ONLY (prefs are personal, my-view-only state; no
// other participant ever learns them). Full prefs replace: idempotent and
// reorder-safe; reconnects reconcile from GET /api/conversations/:id/prefs.
export const PrefsUpdatedEventSchema = z.object({
  t: z.literal('prefs.updated'),
  d: z.object({
    conversation_id: UuidSchema,
    prefs: ConversationPrefsSchema,
  }),
});
export type PrefsUpdatedEvent = z.infer<typeof PrefsUpdatedEventSchema>;

// v0.4 (API.md §1.26): a scheduled message changed state (created / cancelled
// / delivered) — to the AUTHOR's own sockets only (cross-device sync of the
// scheduled list; a pending schedule is private until delivery). The delivery
// itself reaches everyone as an ordinary msg.new.
export const ScheduledUpdatedEventSchema = z.object({
  t: z.literal('scheduled.updated'),
  d: z.object({
    scheduled: ScheduledMessageSchema,
  }),
});
export type ScheduledUpdatedEvent = z.infer<typeof ScheduledUpdatedEventSchema>;

// v0.5a (API.md §1.28): a connection changed — to THE TWO PARTIES ONLY, and
// not even both for every transition: request → requester's own sockets +
// addressee; accept → both; decline → addressee's own sockets only (the
// requester is never pinged about a rejection — liking gap, PSYCHOLOGY §9);
// remove → remover's own sockets only. The DTO is viewer-specific (direction/
// user are per-recipient), stamped at the gateway like beacon.*.
export const ConnectionUpdatedEventSchema = z.object({
  t: z.literal('connection.updated'),
  d: z.object({
    connection: ConnectionSchema,
    // true = the row is gone (decline/remove); the DTO is its last state.
    removed: z.boolean().default(false),
  }),
});
export type ConnectionUpdatedEvent = z.infer<typeof ConnectionUpdatedEventSchema>;

// v0.5a (API.md §1.34): a new story — ONLY to sockets of the author's
// FRIENDS-OF audience minus blocks (never to anyone who cannot view it).
// viewed is stamped false per recipient. NO push for stories (ambient,
// user-pulled; PSYCHOLOGY §6 digest rule). Expiry fans nothing — expired
// stories simply drop out of the next GET.
export const StoryNewEventSchema = z.object({
  t: z.literal('story.new'),
  d: z.object({
    story: StorySchema,
  }),
});
export type StoryNewEvent = z.infer<typeof StoryNewEventSchema>;

// v0.5a (API.md §1.36): a new feed post — ONLY to sockets of the author's
// FRIENDS-OF audience minus blocks. No push (the feed is pulled, never
// pushed). Reactions/comments do NOT fan out live — viewers reconcile from
// GET /api/feed / GET /api/posts/:id when THEY return to the feed (no
// approval pings; PSYCHOLOGY design rules 3/4).
export const PostNewEventSchema = z.object({
  t: z.literal('post.new'),
  d: z.object({
    post: PostSchema,
  }),
});
export type PostNewEvent = z.infer<typeof PostNewEventSchema>;

// ---------------------------------------------------------------------------
// v0.6 call signaling (API.md §1.42 + §2.12, ADR-014). EPHEMERAL by contract:
// these frames are relayed per recipient through the gateway and NEVER
// persisted — no replay on reconnect, no table. The durable truth is the
// calls row (REST); the gateway validates every inbound frame (sender must be
// an active participant of the call's conversation and — past the invite
// stage — a live member of the call), stamps from_user server-side (sender
// claims are ignored), and relays. SDP/candidate payloads are opaque strings
// to the server: bounded, validated for shape, never parsed.
// ---------------------------------------------------------------------------

// RTCIceCandidateInit, bounded. Opaque to the server.
export const IceCandidateSchema = z.object({
  candidate: z.string().max(CALL_ICE_CANDIDATE_MAX_CHARS),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type IceCandidate = z.infer<typeof IceCandidateSchema>;

// Relayed call.invite — to every OTHER active participant's sockets (minus
// blocks, suspension; §2.12). The gateway enriches with conversation_id +
// kind + from_user so callees can ring with zero extra fetches.
export const CallInviteEventSchema = z.object({
  t: z.literal('call.invite'),
  d: z.object({
    call_id: UuidSchema,
    conversation_id: UuidSchema,
    kind: CallKindSchema,
    from_user: UuidSchema,
  }),
});
export type CallInviteEvent = z.infer<typeof CallInviteEventSchema>;

// Relayed point signals (ringing → initiator; accept/reject → initiator +
// the sender's own other sockets, which stop ringing; leave/end → all live
// call members). One schema per t, same tiny shape.
const callSignalD = z.object({
  call_id: UuidSchema,
  from_user: UuidSchema,
});
export const CallRingingEventSchema = z.object({ t: z.literal('call.ringing'), d: callSignalD });
export type CallRingingEvent = z.infer<typeof CallRingingEventSchema>;
export const CallAcceptEventSchema = z.object({ t: z.literal('call.accept'), d: callSignalD });
export type CallAcceptEvent = z.infer<typeof CallAcceptEventSchema>;
export const CallRejectEventSchema = z.object({ t: z.literal('call.reject'), d: callSignalD });
export type CallRejectEvent = z.infer<typeof CallRejectEventSchema>;
export const CallLeaveEventSchema = z.object({ t: z.literal('call.leave'), d: callSignalD });
export type CallLeaveEvent = z.infer<typeof CallLeaveEventSchema>;
export const CallEndEventSchema = z.object({ t: z.literal('call.end'), d: callSignalD });
export type CallEndEvent = z.infer<typeof CallEndEventSchema>;

// v0.7.1 (§2.12, ADR-017): a member's self-reported per-call connection state,
// relayed to all live call members (the call.leave recipient set) so tiles can
// say "reconnecting" truthfully. Ephemeral like every frame here — reconnect
// truth stays call.updated + re-negotiation, never a replay of these.
export const CallStateEventSchema = z.object({
  t: z.literal('call.state'),
  d: z.object({
    call_id: UuidSchema,
    from_user: UuidSchema,
    state: CallConnStateSchema,
  }),
});
export type CallStateEvent = z.infer<typeof CallStateEventSchema>;

// Relayed SDP exchange — to the NAMED recipient's sockets only (to_user is
// consumed by the gateway; from_user is stamped on the way out).
export const CallOfferEventSchema = z.object({
  t: z.literal('call.offer'),
  d: z.object({
    call_id: UuidSchema,
    from_user: UuidSchema,
    sdp: z.string().max(CALL_SDP_MAX_CHARS),
  }),
});
export type CallOfferEvent = z.infer<typeof CallOfferEventSchema>;

export const CallAnswerEventSchema = z.object({
  t: z.literal('call.answer'),
  d: z.object({
    call_id: UuidSchema,
    from_user: UuidSchema,
    sdp: z.string().max(CALL_SDP_MAX_CHARS),
  }),
});
export type CallAnswerEvent = z.infer<typeof CallAnswerEventSchema>;

export const CallIceEventSchema = z.object({
  t: z.literal('call.ice'),
  d: z.object({
    call_id: UuidSchema,
    from_user: UuidSchema,
    candidate: IceCandidateSchema,
  }),
});
export type CallIceEvent = z.infer<typeof CallIceEventSchema>;

// SERVER-emitted (not relayed) on every durable status change — create, first
// join (ringing→ongoing), member join/leave, reject, end, ring timeout — to
// all active participants of the conversation. Full-DTO replace by call.id;
// reconnect truth is GET /api/conversations/:id/calls, never frame replay.
export const CallUpdatedEventSchema = z.object({
  t: z.literal('call.updated'),
  d: z.object({
    call: CallSchema,
  }),
});
export type CallUpdatedEvent = z.infer<typeof CallUpdatedEventSchema>;

// ---------------------------------------------------------------------------
// v0.6 watch together (API.md §1.43 + §2.12). Ephemeral only: one active
// session per conversation in Redis with a TTL the host's syncs refresh. The
// relayed start/sync frames carry the FULL state (video_id + host included)
// so a participant who opens the chat mid-session locks on from the next
// sync — no replay, no REST read.
// ---------------------------------------------------------------------------

const watchStateD = z.object({
  conversation_id: UuidSchema,
  video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX),
  host: UuidSchema,
  position_s: z.number().nonnegative(),
  playing: z.boolean(),
});
export const WatchStartEventSchema = z.object({ t: z.literal('watch.start'), d: watchStateD });
export type WatchStartEvent = z.infer<typeof WatchStartEventSchema>;
export const WatchSyncEventSchema = z.object({ t: z.literal('watch.sync'), d: watchStateD });
export type WatchSyncEvent = z.infer<typeof WatchSyncEventSchema>;

export const WatchStopEventSchema = z.object({
  t: z.literal('watch.stop'),
  d: z.object({
    conversation_id: UuidSchema,
  }),
});
export type WatchStopEvent = z.infer<typeof WatchStopEventSchema>;

// ---------------------------------------------------------------------------
// v0.6 discovery & roulette (API.md §1.44/§1.45, ADR-015)
// ---------------------------------------------------------------------------

// To BOTH parties of a mutual wave, each frame stamped with the OTHER party
// (viewer-specific, the connection.updated pattern). A single un-reciprocated
// wave fans out NOTHING to anyone, ever (ADR-015).
export const DiscoveryMatchedEventSchema = z.object({
  t: z.literal('discovery.matched'),
  d: z.object({
    conversation_id: UuidSchema,
    user: UserLiteSchema,
  }),
});
export type DiscoveryMatchedEvent = z.infer<typeof DiscoveryMatchedEventSchema>;

// To both matched users' sockets; carries the provisional DM (roulette rider
// set, viewer-specific kept=false). The icebreaker arrives as normal msg.new.
export const RouletteMatchedEventSchema = z.object({
  t: z.literal('roulette.matched'),
  d: z.object({
    conversation: ConversationSchema,
  }),
});
export type RouletteMatchedEvent = z.infer<typeof RouletteMatchedEventSchema>;

// The window lapsed without both keeps: the conversation and its messages are
// HARD-DELETED server-side; clients drop local state for it on this frame
// (offline clients reconcile via GET /sync — the conversation is simply
// absent, §2.8). Deliberately carries no "who didn't keep" (no rejection
// surface; ADR-015).
export const RouletteExpiredEventSchema = z.object({
  t: z.literal('roulette.expired'),
  d: z.object({
    conversation_id: UuidSchema,
  }),
});
export type RouletteExpiredEvent = z.infer<typeof RouletteExpiredEventSchema>;

// ---------------------------------------------------------------------------
// v0.8b community pack (API.md §1.62–§1.68, ADR-019 / ADR-020)
// ---------------------------------------------------------------------------

// §1.62: to the TWO parties of an anonymous thread only, each frame
// VIEWER-STAMPED (the beacon.*/connection.updated pattern): role/counterpart
// resolve per recipient, so the recipient's frame carries counterpart null
// until reveal while the sender's names the recipient — one envelope never
// ships one party's view to the other. Fired on new messages (message
// non-null), reveal-mode changes, reveal requests, and the reveal itself
// (timer sweep or sender tap). Reconnect truth is GET /api/anon/threads —
// never frame replay.
export const AnonUpdatedEventSchema = z.object({
  t: z.literal('anon.updated'),
  d: z.object({
    thread: AnonThreadSchema,
    message: AnonMessageSchema.nullable(),
  }),
});
export type AnonUpdatedEvent = z.infer<typeof AnonUpdatedEventSchema>;

// §1.66: full-story replace on canvas changes (overlay add/remove/approve,
// canvas_mode switch) — to the story's AUDIENCE sockets only (friends-of
// minus blocks, the story.new set), viewer-stamped (viewed; pending overlays
// serialize only to their author and the story author). A pending-only change
// fans only to those two. Reconnect truth is GET /api/stories.
export const StoryUpdatedEventSchema = z.object({
  t: z.literal('story.updated'),
  d: z.object({
    story: StorySchema,
  }),
});
export type StoryUpdatedEvent = z.infer<typeof StoryUpdatedEventSchema>;

// §1.63: the in-app wave nudge — to the recipient's own sockets, at most once
// per opt-in hour (worker-claimed), ONLY when the visible pool ≥ NUDGE_MIN_POOL
// and the recipient's wave_nudges setting is on. Carries NOTHING but the fact:
// no identity, no count, no deep link to a specific card (ADR-019; the
// no-rejection rule). The offline counterpart is the §2.9 nudge push.
export const DiscoveryNudgeEventSchema = z.object({
  t: z.literal('discovery.nudge'),
  d: z.object({}),
});
export type DiscoveryNudgeEvent = z.infer<typeof DiscoveryNudgeEventSchema>;

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
  PrefsUpdatedEventSchema,
  ConvBackgroundEventSchema,
  ConvAppearanceEventSchema,
  ScheduledUpdatedEventSchema,
  ConnectionUpdatedEventSchema,
  StoryNewEventSchema,
  PostNewEventSchema,
  // v0.6 (§2.12): relayed signaling + server-emitted call/discovery events.
  CallInviteEventSchema,
  CallRingingEventSchema,
  CallAcceptEventSchema,
  CallRejectEventSchema,
  CallOfferEventSchema,
  CallAnswerEventSchema,
  CallIceEventSchema,
  CallLeaveEventSchema,
  CallEndEventSchema,
  CallUpdatedEventSchema,
  // v0.7.1 (§2.12, ADR-017): relayed connection-state reporting.
  CallStateEventSchema,
  WatchStartEventSchema,
  WatchSyncEventSchema,
  WatchStopEventSchema,
  DiscoveryMatchedEventSchema,
  RouletteMatchedEventSchema,
  RouletteExpiredEventSchema,
  // v0.8b (§1.62/§1.63/§1.66, ADR-019/ADR-020): anonymous threads, wave
  // nudges, canvas stories.
  AnonUpdatedEventSchema,
  StoryUpdatedEventSchema,
  DiscoveryNudgeEventSchema,
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

// ---------------------------------------------------------------------------
// v0.6 client signaling frames (§2.12). All EPHEMERAL: validated by Zod at
// the gateway, authorized per frame (active participant of the call's
// conversation / the conversation; live call member past the invite stage),
// relayed to the named recipients, and dropped — never persisted, never
// replayed. from_user on the relayed frame is stamped by the gateway; to_user
// here is consumed by it. Durable call-state transitions are REST (§1.42):
// these frames never write the calls row.
// ---------------------------------------------------------------------------

// Sent by the initiator right after POST .../calls returns 201; relayed to
// every other active participant (call_id is enriched with conversation_id +
// kind from the call row on the way out).
export const ClientCallInviteEventSchema = z.object({
  t: z.literal('call.invite'),
  d: z.object({ call_id: UuidSchema }),
});
export type ClientCallInviteEvent = z.infer<typeof ClientCallInviteEventSchema>;

const clientCallSignalD = z.object({ call_id: UuidSchema });
// Callee device → initiator: "ringing here" (caller UI flips to Ringing…).
export const ClientCallRingingEventSchema = z.object({
  t: z.literal('call.ringing'),
  d: clientCallSignalD,
});
export type ClientCallRingingEvent = z.infer<typeof ClientCallRingingEventSchema>;
// Accept/reject race ahead of the REST join/reject so UIs react instantly
// (and the sender's OTHER devices stop ringing). The durable flip is REST.
export const ClientCallAcceptEventSchema = z.object({
  t: z.literal('call.accept'),
  d: clientCallSignalD,
});
export type ClientCallAcceptEvent = z.infer<typeof ClientCallAcceptEventSchema>;
export const ClientCallRejectEventSchema = z.object({
  t: z.literal('call.reject'),
  d: clientCallSignalD,
});
export type ClientCallRejectEvent = z.infer<typeof ClientCallRejectEventSchema>;
// Leaving/ending mid-call (the REST end/leave is the durable record; these
// make the remote tiles drop instantly).
export const ClientCallLeaveEventSchema = z.object({
  t: z.literal('call.leave'),
  d: clientCallSignalD,
});
export type ClientCallLeaveEvent = z.infer<typeof ClientCallLeaveEventSchema>;
export const ClientCallEndEventSchema = z.object({
  t: z.literal('call.end'),
  d: clientCallSignalD,
});
export type ClientCallEndEvent = z.infer<typeof ClientCallEndEventSchema>;

// v0.7.1 (§2.12, ADR-017): self-reported connection state. Sent on every
// transition of the client's AGGREGATE call connectivity (connecting /
// connected / reconnecting / failed) — at most one frame per transition, so a
// healthy call sends two, ever. Live-call-member-gated like call.leave;
// from_user is stamped server-side on the way out. ICE restart itself needs
// NO new frame: it is restartIce() + a re-offer riding the existing
// call.offer/call.answer pair under the §2.12 perfect-negotiation rule.
export const ClientCallStateEventSchema = z.object({
  t: z.literal('call.state'),
  d: z.object({
    call_id: UuidSchema,
    state: CallConnStateSchema,
  }),
});
export type ClientCallStateEvent = z.infer<typeof ClientCallStateEventSchema>;

// SDP exchange, addressed per peer (mesh rule: the JOINING peer offers to
// every existing member — §2.12).
export const ClientCallOfferEventSchema = z.object({
  t: z.literal('call.offer'),
  d: z.object({
    call_id: UuidSchema,
    to_user: UuidSchema,
    sdp: z.string().max(CALL_SDP_MAX_CHARS),
  }),
});
export type ClientCallOfferEvent = z.infer<typeof ClientCallOfferEventSchema>;
export const ClientCallAnswerEventSchema = z.object({
  t: z.literal('call.answer'),
  d: z.object({
    call_id: UuidSchema,
    to_user: UuidSchema,
    sdp: z.string().max(CALL_SDP_MAX_CHARS),
  }),
});
export type ClientCallAnswerEvent = z.infer<typeof ClientCallAnswerEventSchema>;
export const ClientCallIceEventSchema = z.object({
  t: z.literal('call.ice'),
  d: z.object({
    call_id: UuidSchema,
    to_user: UuidSchema,
    candidate: IceCandidateSchema,
  }),
});
export type ClientCallIceEvent = z.infer<typeof ClientCallIceEventSchema>;

// Host starts a watch-together session; the server parses the video id out of
// the URL (extractYoutubeVideoId — rejects with error watch_bad_url).
export const ClientWatchStartEventSchema = z.object({
  t: z.literal('watch.start'),
  d: z.object({
    conversation_id: UuidSchema,
    url: z.string().max(2048),
  }),
});
export type ClientWatchStartEvent = z.infer<typeof ClientWatchStartEventSchema>;

// HOST-ONLY (others' sync frames are refused with error watch_not_host);
// refreshes the session TTL. Send on every play/pause/seek and at least every
// WATCH_KEEPALIVE_S as a keepalive.
export const ClientWatchSyncEventSchema = z.object({
  t: z.literal('watch.sync'),
  d: z.object({
    conversation_id: UuidSchema,
    position_s: z.number().nonnegative(),
    playing: z.boolean(),
  }),
});
export type ClientWatchSyncEvent = z.infer<typeof ClientWatchSyncEventSchema>;

// Host ends the session (any participant may stop it once the host has no
// live socket — §1.43).
export const ClientWatchStopEventSchema = z.object({
  t: z.literal('watch.stop'),
  d: z.object({ conversation_id: UuidSchema }),
});
export type ClientWatchStopEvent = z.infer<typeof ClientWatchStopEventSchema>;

export const ClientEventSchema = z.discriminatedUnion('t', [
  DeliveredEventSchema,
  ReadEventSchema,
  ClientTypingEventSchema,
  PresenceSubEventSchema,
  PresenceUnsubEventSchema,
  // v0.6 (§2.12)
  ClientCallInviteEventSchema,
  ClientCallRingingEventSchema,
  ClientCallAcceptEventSchema,
  ClientCallRejectEventSchema,
  ClientCallOfferEventSchema,
  ClientCallAnswerEventSchema,
  ClientCallIceEventSchema,
  ClientCallLeaveEventSchema,
  ClientCallEndEventSchema,
  // v0.7.1 (§2.12)
  ClientCallStateEventSchema,
  ClientWatchStartEventSchema,
  ClientWatchSyncEventSchema,
  ClientWatchStopEventSchema,
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
