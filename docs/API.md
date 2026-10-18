# SocialChat — API & WebSocket Protocol (v1.0)

## 0. Conventions

- Base path `/api`, JSON bodies, UTF-8. All DTOs and WS payloads are Zod schemas in
  `packages/shared` — the single source of truth imported by web, api, and worker.
- **Auth:** httpOnly session cookie `sid` on every request and on the WS upgrade.
  Unauthenticated → `401 {"error":"unauthenticated"}`.
- **CSRF:** every mutating request (POST/PATCH/DELETE) must send `X-Requested-With: fetch`,
  else `403`.
- **Errors:** `{"error": "<machine_code>", "message"?: "<human>"}` with proper status
  (400 validation, 401, 403, 404, 409 conflict, 413 too large, 415 bad media type,
  429 rate limited + `Retry-After`).
- **Idempotency:** message sends carry a client-generated `client_msg_id` (UUIDv7); replays
  return the previously created row with `200` instead of `201`.
- **Pagination:** `limit` default 50, max 100. Message history pages by `seq`; lists page by
  cursor where noted.
- **Timestamps:** ISO-8601 UTC strings. **IDs:** UUIDv7 strings. **seq:** integers (JSON number;
  safe — per-conversation counters won't approach 2^53).

### Core DTOs

```ts
UserPublic = { id, username, display_name, bio,
  avatar: { status: 'none'|'processing'|'ready'|'failed', version: number,
            static_url: string|null, animated_url: string|null },
  last_seen_at: string|null }

UserPrivate = UserPublic & { email, email_verified: boolean, avatar_motion: 'auto'|'reduced'|'off',
  created_at }

Attachment = { id, kind: 'image'|'video'|'file', mime, size_bytes,
  width: number|null, height: number|null, duration_ms: number|null,
  blurhash: string|null, status: 'pending'|'ready'|'failed',
  url: string,            // GET /api/media/:key (original)
  thumb_url: string|null, // 512px WebP thumb / video poster; null while pending
  file_name: string|null }

LinkPreview = { url, site_name: string|null, title: string|null,
  description: string|null, image_url: string|null }   // image_url is OUR origin, never hotlinked

ReactionAggregate = { emoji: string(≤16), count: number, mine: boolean }  // v0.2 §1.12; one chip
  // per emoji, ordered by first reaction (min created_at) so chips never reshuffle

Message = { id, conversation_id, seq, sender_id: string|null,  // null = system
  type: 'text'|'image'|'video'|'file'|'system', body: string|null,
  metadata: { link_preview?: LinkPreview, system?: { event: string, actor_id?: string, target_id?: string } },
  reply_to_id: string|null, attachments: Attachment[],
  reactions: ReactionAggregate[],   // v0.2; Zod default [] so pre-v0.2 payloads parse clean
  created_at, edited_at: string|null, deleted_at: string|null }

Participant = { user: UserPublic, role: 'member'|'admin', joined_at, join_seq,
  left_at: string|null, last_delivered_seq, last_read_seq, muted_until: string|null }

Conversation = { id, type: 'dm'|'group', title: string|null,
  avatar: { status, version, static_url: string|null, animated_url: string|null },
  created_by: string|null, last_seq, last_message_at: string|null,
  participants: Participant[], created_at }

ConversationListItem = Conversation & { unread_count: number,   // last_seq - my last_read_seq
  last_message: Message|null }

// v0.2 invites (§1.11). InvitePublic.inviter.avatar URLs point at the
// token-gated proxy /api/invites/:token/avatar — NEVER /api/media/:key — and
// are null unless status='valid' and the inviter's avatar is 'ready'.
InvitePublic = { status: 'valid'|'expired'|'exhausted'|'revoked',
  kind: 'dm'|'group', group_title: string|null,   // non-null iff kind='group'
  inviter: { username, display_name, avatar: Avatar }, expires_at }

InvitePrivate = { id, token, url,   // url is the app-origin PATH /join/<token>
  kind: 'dm'|'group', conversation_id: string|null,  // null = DM-with-inviter
  status, created_at, expires_at, max_uses, use_count, revoked_at: string|null }

// ---- v0.3 (§1.13–§1.18; ADR-008/ADR-009) ----

// The minimal embeddable identity: joiner piles, seen-by lists, blocked lists,
// role assignees. Deliberately NO last_seen_at and NO area.
UserLite = { id, username, display_name, avatar: Avatar }

// v0.3 changes to existing DTOs:
//  UserPublic  += { beacons_created, beacons_sparked }  // plan karma: profile
//    facts, never ranked/compared (PSYCHOLOGY rule 3); last_seen_at is null
//    when show_last_seen (or a block) hides it from the viewer (§1.13).
//  UserPrivate += { area: string|null }   // self-declared coarse area — OWNER
//    ONLY, never serialized to others (FEATURES #30); edited via PATCH /users/me.
//  Message.type += 'poll'; Message += { poll: Poll|null }  // §1.17
//  Message.metadata += { afterglow? }                      // §1.15 recap
//  Participant.last_read_seq is serialized as 0 unless the viewer may see that
//    participant's read state (§1.13 reciprocal receipts) — delivered is never
//    filtered.

UserSettings = { read_receipts: boolean,             // RECIPROCAL, §1.13
  show_last_seen: 'everyone'|'dm_partners'|'nobody',
  show_typing: boolean, invites_paused: boolean,
  beacon_default_audience: 'friends'|'area'|'public',
  group_add_policy: 'everyone'|'dm_partners'|'nobody' }

// Viewer-specific. joiners = avatar pile (first 12 by join order; joiner_count
// carries the rest); needs = max(0, spark_threshold - joiner_count).
// conversation_id is non-null ONLY for the creator/joiners of a sparked
// beacon. area is the creator snapshot, only ever sent to matching viewers.
Beacon = { id, creator: UserLite, vibe, note, audience: 'friends'|'area'|'public',
  area: string|null, starts_at, expires_at, spark_threshold: 2..10,
  status: 'open'|'sparked'|'expired'|'cancelled',
  joiner_count, needs, joiners: UserLite[],
  my_state: 'creator'|'joined'|'none', conversation_id: string|null,
  ritual: { rrule, count, skips }|null, created_at }

BeaconRole = { id, beacon_id, label, assignee: UserLite|null, done: boolean,
  created_at }

// Rides Message.poll on type='poll' messages. counts aligns with options;
// my_vote is the viewer's option index (null = not voted). No voter lists,
// no vote timestamps.
Poll = { id, conversation_id, seq, question, options: string[2..6],
  closes_at: string|null, counts: number[], total_votes, my_vote: number|null }

// §1.15 afterglow recap system message metadata. run_it_back = the source
// beacon id (POST /api/beacons/:id/run-it-back re-creates it one-tap).
AfterglowMetadata = { beacon_id, vibe, participant_ids: string[],
  photo_attachment_ids: string[], run_it_back }

// ---- v0.4 (§1.19–§1.27; ADR-010) ----

// v0.4 changes to existing DTOs:
//  Message.type += 'audio' | 'vibe_check' | 'game_ttt' | 'puzzle_result'
//  Message += { stamps: UserLite[],        // §1.19 — FACES, not a counter;
//                                          // avatars version-busted as usual
//               vibe: VibeCheck|null }     // §1.23 — iff type='vibe_check'
//  Message.metadata += { doodle?: true,              // §1.21
//                        effect?: MessageEffect,     // §1.22
//                        vibe_reply_seq?: number,    // §1.23
//                        stamp?: true,               // §1.23 (vibe stamp reply)
//                        capsule?: true,             // §1.26
//                        game?: GameTttState,        // §1.27, iff type='game_ttt'
//                        puzzle?: PuzzleResult }     // §1.27, iff type='puzzle_result'
//  Attachment.kind += 'audio'; Attachment += { waveform: number[48]|null } // §1.20
//  Conversation += { disappear_ttl_s: number|null }  // §1.25, conversation-wide
//  SystemEventMetadata += { ttl_s?: number|null }    // §1.25 'disappear_changed'
//  ReactionAggregate is UNCHANGED (emoji chips only; stamps ride Message.stamps)

MessageEffect = 'confetti'|'hearts'|'fireworks'|'snow'   // §1.22, DB CHECK-pinned

// §1.23. Vibe reply refs inlined on the vibe message so the collage strip
// renders with zero extra fetches. replies = first 12 by seq
// (VIBE_REPLIES_PREVIEW_MAX); reply_count carries the rest; my_reply_seq is
// viewer-specific. kind derived: stamp > doodle > image. thumb_url is the
// reply's first attachment thumb (null for stamps — the tile is user.avatar).
VibeCheck = { prompt, reply_count, my_reply_seq: number|null,
  replies: [{ seq, user: UserLite, kind: 'image'|'doodle'|'stamp',
              thumb_url: string|null }] }

// §1.27 tic-tac-toe — the whole game state, on the game message's
// metadata.game. board is 9 cells row-major; turn/winner are symbols.
GameTttState = { board: ('x'|'o'|null)[9], players: {x: user_id, o: user_id},
  turn: 'x'|'o', winner: 'x'|'o'|'draw'|null }

// §1.27 daily-puzzle share (metadata.puzzle on type='puzzle_result').
// Score rows only ('g'/'y'/'x' per letter) — no letters, no word, no spoiler.
// SERVER-populated from the sender's stored attempt; unforgeable.
PuzzleResult = { date: 'YYYY-MM-DD', attempts_used, solved: boolean,
  grid: string[] }   // each row matches /^[gyx]{5}$/

// §1.24 — PERSONAL (my view only, synced across my devices, never shown to
// anyone else). nicknames maps target user id → my nickname for them.
ConversationPrefs = { conversation_id, theme: ChatTheme|null,
  wallpaper: ChatWallpaper|null, nicknames: Record<user_id, string(≤32)> }

// §1.26 — the author's own view. A time capsule is metadata.capsule=true.
ScheduledMessage = { id, conversation_id,
  type: 'text'|'image'|'video'|'file'|'audio', body: string|null,
  attachments: Attachment[], metadata: { effect?, capsule?: true },
  deliver_at, status: 'pending'|'sent'|'cancelled', created_at,
  sent_at: string|null, sent_seq: number|null }

// ---- v0.5a (§1.28–§1.37; ADR-011) ----

// v0.5a changes to existing DTOs:
//  Conversation.type += 'channel'                        // §1.35
//  Participant.role += 'owner'                           // §1.35, channels only
//  Conversation += { pins: ConversationPin[] }           // §1.32; Zod default []
//    For type='channel', Conversation.participants carries ONLY the viewer's
//    own row + the owner + admins — never the member body, and never a member
//    COUNT (PSYCHOLOGY rule 3: no follower counts). §1.35 has the paged read.
//  Message += { reply_to_seq: number|null,               // §1.29; default null
//               reply_context: ReplyContext|null }       // §1.29; server-resolved
//    (reply_to_id is RETIRED — always null from v0.5a on; seq is the identity)
//  Message.metadata += { mentions?: user_id[],           // §1.33, SERVER-written
//                        forwarded_from?: ForwardedFrom }// §1.31, snapshot
//  InviteKind += 'channel'; InvitePublic.group_title is non-null for group AND
//    channel kinds (field name kept stable)               // §1.35
//  The edited badge is Message.edited_at != null          // §1.30 — no new field
//  FRIENDS-OF (the v0.5a audience primitive) = accepted connections ∪
//    dm-partners, minus §1.14 blocks; the beacons 'friends' audience and the
//    beacon_default_audience setting RESOLVE to friends-of from v0.5a on while
//    keeping the stored enum value 'friends' (§1.28). show_last_seen /
//    group_add_policy 'dm_partners' still mean DM partners literally.

Connection = { id, user: UserLite,          // the OTHER party, viewer-specific
  direction: 'incoming'|'outgoing', status: 'pending'|'accepted',
  created_at, responded_at: string|null }

// §1.29 — resolved server-side at serialization time (edits and tombstones of
// the referenced message are always reflected; no client-side joins).
ReplyContext = { seq, author: UserLite|null, type: MessageType,
  excerpt: string|null,   // first 80 chars of the CURRENT body; null for
                          // body-less kinds and tombstones
  deleted: boolean }      // referenced message tombstoned → render "message deleted"

ForwardedFrom = { username, display_name }  // §1.31 — original-author SNAPSHOT,
  // not an FK, not a UserLite (no avatar reach into foreign conversations);
  // the forwarder is sender_id — forwarding never spoofs authorship

ConversationPin = { seq, pinned_by: user_id|null, created_at }  // §1.32

Story = { id, author: UserLite, attachment: Attachment,
  caption: string(≤140), audience: 'friends_of', created_at, expires_at,
  viewed: boolean }       // viewer-specific; NO view counts anywhere

StoryAuthorGroup = { author: UserLite, stories: Story[] }  // §1.34 ordering rules

// §1.36 — named FACES, never a numeric total: reactors = first 12 by
// first-reaction order, has_more carries the rest. No count field exists.
PostReactionAggregate = { emoji, reactors: UserLite[], has_more: boolean,
  mine: boolean }

PostComment = { id, post_id, author: UserLite, body: string(≤500), created_at }

Post = { id, author: UserLite, body: string(≤2000), attachments: Attachment[],
  reactions: PostReactionAggregate[],
  comments: PostComment[],        // latest 3, created_at ASC
  has_more_comments: boolean,     // no comment COUNT is ever serialized
  created_at }

ProfileEntry = { id, kind: 'work'|'skill', title: string(≤80), detail: string(≤160) }

Profile = { interests: string[](≤10, each ≤24),
  entries: ProfileEntry[],        // order_idx ASC, ≤ 12
  media: Attachment[] }           // the 3-GIF strip, order_idx ASC, ≤ 3

// ---- v0.5b (§1.38–§1.41; ADR-012/ADR-013) ----

// v0.5b changes to existing DTOs:
//  Message.metadata += { listing_ref?: ListingRef }   // §1.39 — SERVER-written
//    snapshot {listing_id, kind, title} on the 'listing_contact' DM context
//    message and the 'team_up' group kickoff (the forwarded_from pattern:
//    keeps rendering after the listing is gone).
//  GET /api/users/:username response += { trust: Trust }  // §1.40; Zod default
//    {review_count: 0, avg_rating: null, recent: []} keeps old payloads clean.
//  NO new WS events and NO push anywhere in v0.5b outside the admin 4401
//  closes — the board is pull-based by design (§1.38).

ListingKind = 'gig'|'ride'|'room'|'place_review'

// Per-kind details payloads (jsonb, Zod discriminated union — shape authority
// is packages/shared; the DB pins only jsonb_typeof):
GigDetails         = { direction: 'offering'|'seeking', tags: string[](≤5, each ≤24) }
RideDetails        = { from_text: string(≤80), to_text: string(≤80),
                       departs_at, seats: 1..8 }
RoomDetails        = { monthly_price_text: string(≤40)|null,
                       available_from: 'YYYY-MM-DD'|null,
                       attachment_ids: uuid[](≤6) }   // §1.6 uploads, kind image
PlaceReviewDetails = { place_name: string(≤80), rating: 1..5 }  // a PLACE, not a person

Listing = { id, author: UserLite, kind: ListingKind, title: string(≤80),
  body: string(≤2000), price_text: string(≤40)|null,  // DISPLAY TEXT ONLY — no payments exist
  area: string,                   // author-area snapshot at mint (citext equality)
  is_public: boolean,             // false = my area only
  details: <per kind, above>,
  status: 'active'|'closed'|'expired',
  photos: Attachment[],           // room listings: resolved from details.attachment_ids; else []
  my_contacted: boolean,          // viewer-specific; false for the author
  conversation_id: string|null,   // §1.39 team-up group — author + picked members ONLY, else null
  created_at, expires_at: string|null }  // gig/room +30d; ride = departs_at; place_review null

// §1.40 marketplace trust. listing_kind is a SNAPSHOT (reviews survive the
// listing); the listing itself is deliberately not resolved.
PersonReview = { id, reviewer: UserLite, rating: 1..5, body: string(≤500),
  listing_kind: ListingKind, created_at }

Trust = { review_count: number,
  avg_rating: number|null,        // 1 decimal; null under TRUST_AVG_MIN_REVIEWS (3)
  recent: PersonReview[] }        // newest ≤ 5, minus blocked-pair reviewers

// ---- §1.41 admin-only DTOs (never served to non-admins; METADATA ONLY —
// no private message bodies exist in any admin payload, by contract) ----

AdminUserRow = { id, username, display_name, created_at,
  last_seen_bucket: 'today'|'this_week'|'this_month'|'older'|'never',
  registration_ip: string|null,   // null once the retention GC aged it out
  last_session: { ip: string|null, user_agent: string|null, last_seen_at }|null,
  session_count: number, storage_bytes: number,
  is_admin: boolean, suspended: boolean, banned: boolean }

AdminReport = { id, kind: 'user'|'message'|'beacon', reporter: UserLite|null,
  reason, status: 'open'|'closed', created_at,
  closed_at: string|null, closed_by: UserLite|null, close_note: string,
  // exactly one non-null, matching kind (null if the target was deleted since):
  target_user: UserLite|null,
  target_message: { conversation_id, seq, sender: UserLite|null,
                    type: MessageType, created_at, deleted: boolean }|null,  // NO body, ever
  target_beacon: { id, vibe, status, creator: UserLite|null }|null }

AdminMetrics = { registrations_per_day: DayCount[], active_users_per_day: DayCount[],
  messages_per_day: DayCount[],   // each 30 days (ADMIN_METRICS_WINDOW_DAYS)
  users_total, open_beacons, active_listings, open_reports, storage_total_bytes }
DayCount = { date: 'YYYY-MM-DD', count: number }

AdminLogEntry = { ts, level: 'warn'|'error'|'admin', msg,
  actor: {id, username}|null,     // non-null on level 'admin' (the acting admin)
  data?: object }                 // structured remainder of the log line

InstanceSettings = { invites_enabled: boolean }

// ---- v0.6 (§1.42–§1.46 + §2.12; ADR-014/ADR-015) ----

// v0.6 changes to existing DTOs:
//  Conversation += { origin: 'discovery'|'roulette'|null,  // how this DM came
//    to exist; drives the client's one-time PRIVATE expectation-feedback
//    prompt (§1.45). Zod default null keeps pre-v0.6 payloads parsing clean.
//                    roulette: {expires_at, kept: boolean}|null }  // non-null
//    ONLY while a roulette DM is provisional; kept is the VIEWER's own keep —
//    the other party's keep state is never serialized (no pressure surface).
//  Message.metadata += { call_ref?: CallRef,   // §1.42, SERVER-written on the
//                                              // missed-call system message
//                        rescue?: true }       // §1.46, SERVER-written SOS flag
//  SystemEventMetadata.event gains 'call_missed', 'discovery_matched',
//    'roulette_matched', 'roulette_kept' (event is an open string — no schema
//    change; listed for renderers).

// The durable call LOG row (§1.42). participant_ids = the CURRENT live mesh
// members (Redis truth, ids only — clients resolve faces from participants
// they already hold); [] once terminal. Signaling is NEVER in here (§2.12).
Call = { id, conversation_id, initiator_id: string|null, kind: 'audio'|'video',
  is_group: boolean,
  status: 'ringing'|'ongoing'|'completed'|'missed'|'rejected'|'failed',
  participant_ids: string[], started_at,
  answered_at: string|null, ended_at: string|null }

// coturn static-auth-secret format (ADR-014): username "<unix expiry>:<user_id>",
// credential base64(HMAC-SHA1(TURN_SECRET, username)). TTL 1 h (TURN_CRED_TTL_S).
TurnCredentials = { username, credential, uris: string[], expires_at }

CallRef = { call_id, kind, status, duration_s: number|null }  // §1.42 snapshot
  // on the missed-call system message (the forwarded_from pattern)

// §1.44. My own opt-in — owner-only, never serialized to others.
DiscoveryOptin = { scope: 'area'|'public', note: string(≤80), created_at, expires_at }

// §1.44. A stranger's card: UserLite ONLY (no last_seen, no area text — the
// area MATCH is server-side; FEATURES #30). waved = I already waved at them;
// who waved at THEM is never serialized (a single wave notifies nobody).
DiscoveryCard = { user: UserLite, scope, note, expires_at, waved: boolean }

// §1.45, PSYCHOLOGY finding #10. The anonymous instance-wide aggregate —
// better_percent is null under ENCOURAGEMENT_MIN_SAMPLES (10).
Encouragement = { sample_size: number, better_percent: number|null }

// ---- v0.7 (§1.47–§1.54; ADR-016) ----

// v0.7 changes to existing DTOs (every new field has a Zod default, so
// pre-v0.7 payloads — IndexedDB rows, old fixtures — parse clean):
//  Beacon.vibe gains 'custom' (BEACON_VIBE_VALUES); Beacon += {
//    custom_vibe_emoji: string|null, custom_vibe_label: string|null,
//      // §1.47 — non-null iff vibe='custom' (DB shape CHECK)
//    location: Location|null,     // §1.52 place chip
//    edited_at: string|null }     // §1.47 edited marker (no edit history,
//                                 // the §1.30 edited_at pattern)
//  Message.type += 'location' (§1.52); Message.metadata += {
//    location?: Location,         // required on type='location'
//    join_me?: true }             // the "📍 Join me here" variant
//  Post += { kind: 'text'|'poll'|'game'|'join_card',   // §1.50, default 'text'
//    audience: 'friends_of'|'public',                  // §1.49, default 'friends_of'
//    poll: PostPoll|null,         // iff kind='poll'; my_vote viewer-specific
//    game: PostGame|null,         // iff kind='game'
//    ref: PostRef|null,           // iff kind='join_card' (stored verbatim)
//    ref_summary: JoinCardSummary|null,  // viewer-resolved live state; null =
//                                 // gone / not visible to this viewer
//    location: Location|null }    // §1.52
//  PostComment.body loses its 1-char min (an image-only comment is legal);
//  PostComment += { attachment: Attachment|null,       // §1.51
//    reactions: CommentReactionAggregate[] }           // §1.51 — faces
//  Listing (every kind) += { location: Location|null,  // §1.52
//    edited_at: string|null }     // §1.48 edited marker
//  GET /api/feed gains ?lane=friends|discover (§1.49).
//  beacon.updated (§2.3) gains { edited: boolean, changed: string[] }.

// §1.52 — THE location shape, everywhere one can appear (posts, beacons,
// listings, metadata.location on 'location' messages). label is required;
// lat/lng are OPTIONAL, both-or-neither, and only ever a user-initiated
// one-tap SNAPSHOT (no live GPS, no tracking — FEATURES #30 spirit). Clients
// render map LINKS (geo:/OSM/Google URLs) — never tile embeds, never a map
// API key (golden rule 7).
Location = { label: string(≤80), lat?: -90..90, lng?: -180..180 }

// §1.50 poll posts. counts ARE serialized: a vote tally on OPTIONS is a
// decision tool, not approval attached to a person (ADR-016 argues the
// distinction vs PSYCHOLOGY rule 3). No voter lists, no vote timestamps.
PostPoll = { question: string(≤120), options: string[2..6](each ≤80),
  counts: number[], total_votes, my_vote: number|null }

// §1.50 game posts: an open tic-tac-toe challenge. players = post.author
// (x, moves first) vs claimed_by (o); the board is an ordinary §1.27
// game_ttt message in the pair's DM — the post only shows the claim.
PostGame = { state: 'open'|'claimed', claimed_by: UserLite|null }

// §1.50 join_card target, stored verbatim; live state rides ref_summary.
PostRef = { type: 'beacon'|'listing', id }

// §1.50 — SERVER-resolved per viewer at serialization time (the
// reply_context pattern): always current (spark/expiry/close included) and
// never audience-widening — a viewer the ref is invisible to gets null.
// joiners ≤ JOIN_CARD_SUMMARY_JOINERS_MAX (4) faces.
JoinCardSummary =
  | { type: 'beacon', id, vibe, custom_vibe_emoji, custom_vibe_label, note,
      status, starts_at, expires_at, joiners: UserLite[], needs,
      my_state, location: Location|null }
  | { type: 'listing', id, kind: ListingKind, title, price_text: string|null,
      status, area, my_contacted: boolean, location: Location|null }

// §1.51 — one chip per (emoji, kind): capped FACES, never a numeric total
// (the PostReactionAggregate rule). Stamps are kind='stamp' with the
// ':stamp:' sentinel as emoji (§1.19 machinery); reactors = first
// COMMENT_REACTORS_PREVIEW_MAX (6) by first-reaction order.
CommentReactionAggregate = { emoji, kind: 'emoji'|'stamp',
  reactors: UserLite[], has_more: boolean, mine: boolean }

// ---- v0.8a (§1.57–§1.61; ADR-018) ----

// v0.8a changes to existing DTOs (every new field has a Zod default, so
// pre-v0.8 payloads — IndexedDB rows, old fixtures — parse clean):
//  UserLite += { mood: Mood|null,          // §1.57 — resolved PER-VIEWER at
//                                          // serialization time (visibility +
//                                          // §1.14 blocks; expired ⇒ null)
//                name_style: NameStyle }   // §1.58 — viewer-independent
//  UserPublic += the same two fields (profiles, user.updated frames).
//  UserSettings += { mood_effects: boolean,            // §1.58, default true
//    activity_beacons / activity_posts / activity_listings / activity_games:
//      'public'|'connections'|'private' }              // §1.59, default 'connections'
//  Message.metadata += { undone?: true }   // §1.57 drunk send-undo tombstone:
//                                          // render NOTHING, not a stub
//  ConversationPrefs += { background: Attachment|null }  // §1.60, owner-only
//  InstanceSettings += { release_notes: ReleaseNote[] }  // §1.61
//  Conversation.last_message_at doubles as the §1.57 cold-contact DTO flag
//    (client compares against COLD_CONTACT_THRESHOLD_S — no new endpoint).

// §1.57 — what OTHERS see of a mood (iff visibility + blocks allow): the
// current chip only. Deliberately NO expires_at (a countdown on someone's
// feelings is a seen-at timestamp in disguise) and NO swing_set; for
// kind='swing' this is the CURRENT entry (kind lets clients morph-animate).
Mood = { emoji: string(≤16), label: string(≤24),
  kind: 'preset'|'custom'|'swing'|'drunk' }

// §1.57 — the OWNER's full state (GET/PUT /api/users/me/mood only).
MoodState = { mood: Mood|null, visibility: 'everyone'|'connections'|'nobody',
  expires_at: string|null,                  // null iff mood is null
  swing_set: {emoji, label}[2..6]|null }    // non-null iff kind='swing'

NameStyle = 'none'|'glow'|'shimmer'|'rainbow'|'surprise'   // §1.58, CHECK-pinned

// §1.59 — one strip item, SERVER-resolved per viewer at serialization time
// (the ref_summary/reply_context pattern): live state, never audience-
// widening; invisible items are silently DROPPED (no placeholders, no
// hidden-item counts). Summary-only by design: no joiner piles, no bodies.
Activity = { id, kind: 'beacon_lit'|'beacon_sparked'|'post_created'|
  'listing_posted'|'puzzle_played'|'game_won', created_at,
  summary:
    | { type: 'beacon', beacon_id, vibe, custom_vibe_emoji, custom_vibe_label,
        note, status }
    | { type: 'post', post_id, kind: PostKind, excerpt: string(≤80)|null }
    | { type: 'listing', listing_id, kind: ListingKind, title, status }
    | { type: 'puzzle', date: 'YYYY-MM-DD', solved: boolean, attempts_used }
    | { type: 'game', conversation_id, seq, opponent: UserLite|null } }

// §1.61 — one shipped release (instance_settings key 'release_notes',
// newest first; seeded/appended by migrations).
ReleaseNote = { version: string(≤20), date: 'YYYY-MM-DD', title: string(≤80),
  items: string[1..12](each ≤200) }

// ---- v0.8b (§1.62–§1.69; ADR-019 / ADR-020) ----

// v0.8b changes to existing DTOs (every new field has a Zod default, so
// pre-v0.8b payloads — IndexedDB rows, old fixtures — parse clean):
//  UserLite += { mask_emoji: string|null }   // §1.68 — non-null ONLY inside
//    ghost-group serializations to non-admin members: the whole UserLite is
//    then the MASK (pseudo-id, username '', display_name = mask name, empty
//    avatar shell, mood null, name_style 'none', this emoji as the glyph).
//  UserSettings += { anon_messages: 'nobody'|'connections'|'everyone',
//                      // §1.62, default 'connections'
//                    wave_nudges: boolean }  // §1.63, default true
//  Conversation += { visibility: 'private'|'invite_only'|'public'|'ghost',
//                      // §1.68, groups only, default 'private'
//                    description: string(≤300),          // §1.68
//                    public_since_seq: number|null,      // §1.68 — non-null
//    iff visibility='public'; its presence IS the member banner flag, and
//    ONLY messages with seq > it ever render publicly.
//                    my_mask: {name, emoji}|null }       // §1.68 — the
//    viewer's OWN current mask in a 👻 ghost group (their own participant row
//    serializes REAL so clients can find themselves; this field is the one
//    place a member reads the pseudonym+emoji the others see them as — incl.
//    the auto-mask a 409 mask_taken left in place). null outside ghost groups.
//  Story += { canvas_mode: 'off'|'open'|'approve',       // §1.66, default 'off'
//             overlays: StoryOverlay[] }                 // §1.66, default []
//  Message.metadata += { support?: {ticket_id} }         // §1.69 — operator
//    messages in the per-user Support conversation (sender_id NULL).
//  CreateReport gains kinds 'anon_message' (§1.62) and 'story_overlay'
//    (§1.66); message reports gain include_context (§1.69); non-user
//    share-page reports are their own endpoint (§1.67).
//  DiscoveryOptin/DiscoveryCard += { vibe: DiscoveryVibe|null }; DiscoveryCard
//    += { shared_interests: string[] ≤3 }; GET /api/discovery/cards gains
//    filters (§1.65).
//  AdminReport.kind widens; AdminReport gains target_anon_message /
//    target_overlay / target_share_page previews and
//    target_message.context_available (§1.69).

// §1.62 — one anonymous message. TEXT ONLY (no attachments, by design).
AnonMessage = { id, thread_id, from_sender: boolean, body: string(1..500),
  is_riddle_answer: boolean, created_at }

// §1.62 — VIEWER-SPECIFIC: role is the viewer's side; counterpart is the
// OTHER party and is NULL for the recipient until revealed (live rule:
// revealed_at set OR reveal_at <= now()); the sender always sees the
// recipient. The recipient's view of the sender's avatar rides ONLY the
// token-of-the-thread blur proxy (§1.62) until reveal.
AnonThread = { id, role: 'sender'|'recipient', counterpart: UserLite|null,
  reveal_mode: 'none'|'timer'|'riddle',
  reveal_timer_s: 3600|21600|86400|null,  // iff mode='timer'
  reveal_at: string|null,                 // iff mode='timer'
  riddle_q: string(≤200)|null,            // iff mode='riddle'
  reveal_requested: boolean, revealed_at: string|null,
  last_message: AnonMessage|null, created_at }

// §1.64 — one people-you-may-know card. Mutual FACES first, count carries the
// rest (relationship evidence about MY network, not public approval —
// ADR-019); same_area is a boolean (the area TEXT stays owner-private);
// shared_groups counts non-ghost groups only.
Suggestion = { user: UserLite, mutual_count, mutuals: UserLite[](≤3),
  same_area: boolean, shared_groups: number }

// §1.66 — one attributed VECTOR overlay layer (never burned into the image).
// payload is a per-kind union (shape authority: packages/shared):
//   stroke {points: {x,y}[2..256] (normalized 0..1), color: #rrggbb, width: 1..24}
//   emoji  {emoji ≤16, x, y, scale: 0.5..3}
//   text   {text: 1..80, x, y}
// status 'pending' serializes only to the overlay author + story author;
// 'removed' serializes to NOBODY (the tombstone exists for reports).
StoryOverlay = { id, story_id, author: UserLite, kind: 'stroke'|'emoji'|'text',
  payload: <per kind>, status: 'live'|'pending'|'removed', created_at }

// §1.67 — a minted share link. url is the app-origin PATH (/p/<token>;
// /s/<token> for stories); PUBLIC_ORIGIN prefixes it everywhere absolute.
ShareLink = { token, url, object: {type: 'post'|'beacon'|'listing'|'story'|'group', id},
  created_at }

// §1.67 — the unauthenticated page read (GET /api/share/:token/public).
// Author chips carry NO ids and NO UserLite (username, display_name,
// token-gated avatar_url, name_style); all media URLs are the token-gated
// proxy paths, never /api/media/:key. Variants: post | beacon | listing |
// story | group_card (invite_only: the card ONLY) | group_live (public:
// card + read-only tail, seq > public_since_seq only). §1.67 has the shapes.
SharePage = <discriminated union, §1.67>

// §1.68 — one pending invite_only join request (admin read; oldest first).
GroupJoinRequestRow = { user: UserLite, created_at }

// §1.69 — a support ticket (the admin inbox's index card; the dialogue lives
// in the per-user Support conversation).
SupportTicket = { id, category: 'bug'|'question'|'idea'|'safety',
  body: string(≤2000), attachment: Attachment|null,
  status: 'open'|'answered'|'closed', created_at, updated_at }
AdminSupportTicket = SupportTicket & { user: UserLite|null }

// §1.69 — one row of the admin content tab (PUBLIC surfaces only).
AdminContentRow = { type: 'post'|'beacon'|'listing', id, author: UserLite|null,
  title, excerpt, status, created_at }

// §1.69 — the consented report-context slice (the ONE admin surface with
// message bodies; see the consent rule there).
AdminContextMessage = { seq, sender: UserLite|null, type: MessageType,
  body: string|null, attachments: {kind, mime}[], created_at,
  deleted: boolean, reported: boolean }

// §1.69 — the update banner's read.
AdminUpdateStatus = { running_commit: string|null, running_version: string|null,
  latest_commit: string|null, update_available: boolean|null,
  checked_at: string|null }
```

Avatar URLs are content-hashed media-proxy URLs (`/api/media/:key`), immutable-cacheable;
`avatar.version` tells clients when to swap.

---

## 1. REST endpoints

### 1.1 Auth

| Method & path | Request | Response |
|---|---|---|
| `POST /api/auth/register` | `{username, email, password, display_name, invite_token?}` (username `^[a-z0-9_]{3,24}$`, password ≥ 8; `invite_token` from `/join/<token>`, v0.2 §1.11 — accepted as a loose opaque string (≤ 256 chars), NOT shape-validated at the schema: a malformed/truncated token degrades to `invite: null` like any other bad invite) | `201 {user: UserPrivate, invite: {conversation_id}\|null}` + `Set-Cookie: sid`. `invite` names the DM created with the inviter (or the group joined) when a **valid** `invite_token` rode along; registration NEVER fails because of a bad/expired/exhausted invite — the account is created and `invite` is `null`. `409 username_taken \| email_taken`. Rate 3/hour/IP. |
| `POST /api/auth/login` | `{username_or_email, password}` | `200 {user: UserPrivate}` + cookie. `401 bad_credentials`. Rate 10/min/IP. |
| `POST /api/auth/logout` | — | `204`; deletes session row, clears cookie, **closes that session's live sockets (4401)**. |
| `GET /api/auth/sessions` | — | `200 {sessions: [{id, user_agent, ip, created_at, last_seen_at, current: boolean}]}` |
| `DELETE /api/auth/sessions/:id` | — | `204`; revokes + closes its sockets. `404` if not yours. |

Password reset is CLI-only in MVP: `node dist/cli.js reset-password <username>` (prints a
temporary password, revokes all sessions). **v0.9 (§1.70–§1.73) adds user-facing session
minting paths** — passkey login, QR cross-device login, recovery-code reset, and TOTP
gating of password/passkey logins (`POST /api/auth/login` then answers the §1.73
LoginOutcome: `{user}` or `{totp_required, totp_token}`); register additionally returns
the §1.72 `recovery_codes` once. The CLI reset remains the operator path.

### 1.2 Users & profiles

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/me` | — | `200 {user: UserPrivate}` |
| `PATCH /api/users/me` | `{display_name?, bio?, avatar_motion?}` | `200 {user: UserPrivate}` |
| `POST /api/users/me/avatar` | multipart, field `file` (gif/webp/apng/png/jpeg/mp4, ≤ 15 MB; magic-byte sniffed) | `202 {avatar: {status:'processing', version}}`; completion arrives as WS `user.updated`. `415` on bad type. |
| `DELETE /api/users/me/avatar` | — | `200 {avatar: {status:'none', ...}}` |
| `GET /api/users/:username` | — | `200 {user: UserPublic}` |
| `GET /api/users?q=<text>` | — | `200 {users: UserPublic[]}` (prefix ILIKE on username/display_name, limit 20) |

### 1.3 Sync (the reconnect anchor)

| Method & path | Response |
|---|---|
| `GET /api/sync` | `200 {server_time, me: UserPrivate, conversations: ConversationListItem[]}` — **every** active conversation (where I haven't left), each with full participants + all watermarks + `last_seq` + `last_message`. O(conversations), unconditionally correct; see §2.8. |

### 1.4 Conversations

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations` | `{type:'dm', user_id}` or `{type:'group', title, user_ids: string[]}` | `201 {conversation}`; DM replays dedupe via `dm_key` → `200` with the existing one. Group: creator becomes `admin`; `user_ids` ≤ 255 (+ creator = cap 256) else `400 group_too_large`. Fans out WS `conv.new`. |
| `GET /api/conversations?cursor=&limit=` | — | `200 {conversations: ConversationListItem[], next_cursor: string\|null}` ordered by `last_message_at DESC` (UI list; `GET /sync` is the reconnect snapshot) |
| `GET /api/conversations/:id` | — | `200 {conversation}` (participants only) |
| `PATCH /api/conversations/:id` | `{title}` (admin, groups) | `200 {conversation}` + WS `conv.updated` |
| `POST /api/conversations/:id/avatar` | multipart `file` (admin, groups; same rules as user avatar) | `202 {avatar:{status:'processing'}}`; completion via `conv.updated` |
| `POST /api/conversations/:id/participants` | `{user_ids: string[]}` (admin; total ≤ 256) | `200 {conversation}`; sets each `join_seq = last_seq`; inserts a `system` message (bumps seq); WS `conv.updated` to members + `conv.new` to joiners |
| `DELETE /api/conversations/:id/participants/:userId` | — (self = leave; admin = remove) | `204`; sets `left_at`; `system` message; WS `conv.updated` |
| `DELETE /api/conversations/:id` | — | `204` — delete a **group** (any admin) or a **channel** (owner only) **for everyone** (owner ask, 2026-10-18). Every member is marked left and receives `conv.updated` (their client drops the conversation), then the row is hard-deleted (messages, participants, pins, invites cascade; listings/beacons that pointed at it go null) and media objects are released refcount-guarded — the §1.45 sweep recipe. DMs → `400 not_deletable` (leave or block instead); member without the role → `403 not_admin`; non-member or already gone → `404`. |

### 1.5 Messages

| Method & path | Request | Response |
|---|---|---|
| `GET /api/conversations/:id/messages?after_seq=&before_seq=&limit=50` | exactly one of `after_seq` (ascending, catch-up) or `before_seq` (descending, history scroll) | `200 {messages: Message[]}` — index-only walk of `(conversation_id, seq)`; **visibility floor:** only rows with `seq > my join_seq` (and `seq <= seq at left_at` for departed members) |
| `POST /api/conversations/:id/messages` | `{client_msg_id, type: 'text'\|'image'\|'video'\|'file', body?, attachment_ids?: string[], reply_to_seq? (v0.5a §1.29), metadata?: {link_preview?: LinkPreview}}` | `201 {message}` (`200` on idempotent replay). Must be an active participant. `attachment_ids` must be yours and unbound (binds them, clears `share_import_id`). `metadata.link_preview` is validated against the `link_previews` cache row for the same URL, then **snapshotted into the message**. Server extracts the first URL from `body` when no snapshot was supplied and enqueues an unfurl → recipients get the card via `msg.updated`. Transaction: bump `last_seq` → insert → raise sender's own watermarks to the new seq → commit → fan out `msg.new` → enqueue push for offline participants. |

**The send path is REST-only.** The WS never carries durable writes: retries are idempotent,
the share composer works before a socket exists, and a dropped socket can never lose a message.

### 1.6 Uploads & media

| Method & path | Request | Response |
|---|---|---|
| `POST /api/uploads` | streaming multipart, field `file` (+ optional `share_import_id`) | `201 {attachment: Attachment}`. MIME **sniffed from magic bytes** (client claim advisory); images: EXIF-stripped, 512px WebP thumb + blurhash computed inline → `status:'ready'`; video: stored + `media` job enqueued (ffprobe, poster via `-vf thumbnail`, faststart remux) → `status:'pending'`, hydrates via WS; files: stored verbatim → `ready`. Limits: image 25 MB, video 100 MB, file 100 MB → `413`. An image sharp cannot decode (HEVC-coded HEIC — no codec in the stock build) → `415 image_undecodable`; never stored verbatim (v1.0a #91 — the web client converts HEIC→JPEG before upload, so this only hits alien files). |
| `GET /api/uploads/:id` | — | `200 {attachment}` (poll fallback for `attachment.ready`) |
| `GET /api/media/:key` | — | Streaming proxy from MinIO. Auth: requester must own the object or share a conversation with it (avatars of any user are readable by authed users). `Cache-Control: private, max-age=31536000, immutable`. Files: `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, sniffed MIME. |

### 1.7 Link previews

| Method & path | Request | Response |
|---|---|---|
| `POST /api/previews` | `{url}` | `200 {status:'ok', url_hash, preview: LinkPreview}` on cache hit; `202 {status:'pending', url_hash}` on miss (unfurl job enqueued in the **worker**; result arrives as WS `preview.ready`); `200 {status:'failed', url_hash}` if negative-cached (1 h). Rate: **30/hour/user** → `429`. |
| `GET /api/previews/:url_hash` | — | `200 {status, preview?}` (poll fallback) |

### 1.8 Share target

| Method & path | Request | Response |
|---|---|---|
| `POST /share` *(web app route, the manifest `action`)* | multipart from the OS share sheet: `share_title?`, `share_text?`, `share_url?`, `media[]?` | Logged in → forwards to `POST /api/share-imports`, replies `303 → /compose?import=<id>`. Logged out → forwards to `POST /api/share-stash`, replies `303 → /login?next=/share/claim/<stash_id>`. |
| `POST /api/share-imports` | multipart `{title?, text?, url?, media[]?}` | `201 {import: ShareImport}` — files uploaded as attachments bound to the import; row persisted immediately; **unfurl enqueued eagerly** when `url` present. |
| `GET /api/share-imports/:id` | — | `200 {import: {id, title, text_body, url, status, attachments: Attachment[], preview: {status, preview?}\|null, created_at}}` |
| `DELETE /api/share-imports/:id` | — | `204` — marks `consumed` (called by composer after send, or on discard) |
| `POST /api/share-stash` | multipart, **unauthenticated**; ≤ 30 MB total, ≤ 3 open stashes/IP, 30-min TTL | `201 {stash_id}` — raw payload parked in Redis + `stash/` objects |
| `POST /api/share-imports/claim` | `{stash_id}` (authed) | `201 {import}` — promotes the stash to a real import (uploads adopted, unfurl enqueued); `404` if expired |

### 1.9 Web push

| Method & path | Request | Response |
|---|---|---|
| `GET /api/push/vapid` | — | `200 {public_key}` |
| `POST /api/push/subscriptions` | `{endpoint, keys: {p256dh, auth}}` | `201 {id}` (upsert by endpoint) |
| `DELETE /api/push/subscriptions` | `{endpoint}` | `204` |

### 1.10 Ops

| Method & path | Response |
|---|---|
| `GET /healthz` | `200 {ok: true}` (public; compose healthcheck) |

### 1.11 Invites (v0.2 — ADR-007, ARCHITECTURE §9)

Any user mints invite tokens; sharing the link `https://<domain>/join/<token>`
(a **web app** route — the API only ever sees the path in `InvitePrivate.url`)
lets anyone register straight into a DM with the inviter, or into the group the
invite is scoped to. Tokens are 32 random bytes base64url (43 chars), generated
like session tokens but stored **plaintext** with a unique index (ADR-007:
the owner list must re-display the URL; the token is a revocable capability,
not a credential). Defaults: `expires_at = now()+7d` (`INVITE_TTL_S`),
`max_uses = 50` (`INVITE_MAX_USES`). `status` is derived, precedence
`revoked > expired > exhausted > valid`.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/invites` | `{conversation_id?}` — omitted = DM-with-inviter invite; set = group invite (minter must be an **admin** of that group, matching §1.4 participant adds) | `201 {invite: InvitePrivate}`. `400 invite_bad_scope` (a DM conversation_id), `403 forbidden` (group, not admin), `404 not_found` (unknown/not-a-participant conversation), `409 invite_limit` (more than 20 simultaneously **open** — i.e. `valid` — invites (`INVITE_OPEN_MAX`, shared constant); revoke one or let one lapse first). Rate **30/hour/user** (`INVITE_CREATE_RATE_PER_HOUR`). |
| `GET /api/invites` | — | `200 {invites: InvitePrivate[]}` — mine, `created_at DESC`, capped at 100 (no cursor in v0.2). Includes revoked/expired rows so the list explains dead links. |
| `DELETE /api/invites/:id` | — | `204` — revoke (sets `revoked_at`; idempotent re-revoke is also `204`). `404 not_found` if not mine. Existing joins are NOT undone. |
| `GET /api/invites/:token/public` | **UNAUTHENTICATED** | `200 {invite: InvitePublic}` for any existing token, whatever its status (the join page renders expired/revoked states by name); avatar URLs are null unless `valid`. `404 invite_not_found` for unknown tokens. Rate **60/hour/IP** (`INVITE_PUBLIC_RATE_PER_HOUR_PER_IP`). |
| `GET /api/invites/:token/avatar?v=static\|animated` | **UNAUTHENTICATED**; `v` default `static` (OG unfurlers get the universally supported JPEG); extra `ver` cache-buster param accepted and ignored | Streaming proxy of the inviter's current avatar from MinIO. **Valid-token-gated**: any non-`valid` status, or inviter avatar not `ready` → `404` (revocation instantly kills the proxy). `v=animated` falls back to static when no animated rendition exists. `Cache-Control: private, max-age=300` (`INVITE_AVATAR_CACHE_TTL_S` — short: the avatar can change version while the token lives). Rate **120/hour/IP** (`INVITE_AVATAR_RATE_PER_HOUR_PER_IP`). |
| `POST /api/invites/:token/accept` | — (**authed**; the already-logged-in join path) | `200 {conversation_id}`. `404 invite_not_found`; `410 invite_expired \| invite_exhausted \| invite_revoked`; `400 invite_own` (your own invite); `400 group_too_large` (group at the 256 cap). |

**Accept semantics (both paths — `accept` and register-with-token):**

- Atomic guard, no over-redemption under concurrency:
  `UPDATE invites SET use_count = use_count + 1 WHERE id = $1 AND revoked_at IS
  NULL AND expires_at > now() AND use_count < max_uses RETURNING *` — zero rows
  means not acceptable.
- DM invite: create-or-dedupe the DM via `dm_key` exactly like
  `POST /api/conversations {type:'dm'}`. Group invite: insert participant with
  `join_seq = last_seq` (the §1.4 history floor), `role='member'`.
- A `system` message is dropped in the joined conversation:
  `metadata.system = {event: 'invite_joined', actor_id: <joiner>, target_id:
  <inviter>}`, body `joined via invite` — same shape as `participant_added`.
- Fan-out mirrors §1.4: `conv.new` to the joiner, `conv.updated` to members,
  all via the Redis `events` channel.
- Idempotent re-accept: already an **active** participant (group member, or an
  active party of the existing DM) → `200 {conversation_id}` **without**
  incrementing `use_count` and without a system message. That dedupe resolves
  **before** status validation, so it answers `200` even when the invite has
  since expired, been revoked or become exhausted; a genuinely-new join (first
  join, or any re-join after leaving — DM and group alike) validates status
  and claims a use.
- A DM joiner who had **left** the DM is a genuinely-new join: the invite must
  still be `valid` (a revoked/expired/exhausted token is NOT a permanent
  re-entry capability for an ex-member — ADR-007's revocable capability) and a
  use is claimed; the participant row is then upserted with the §1.4 re-join
  semantics (fresh `join_seq = last_seq` history floor, `left_at`/`left_seq`
  cleared, watermarks raised to the floor), the `invite_joined` system message
  is dropped and the join fan-out below re-announces the conversation.
- Register-with-token runs accept AFTER the user row + session commit; any
  invite failure leaves registration successful with `invite: null`.

### 1.12 Reactions (v0.2)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/messages/:seq/reactions` | `{emoji}` — 1..16 chars (`REACTION_EMOJI_MAX_LEN`; Zod counts UTF-16 units, the DB CHECK codepoints — Zod is binding) | `204` — **idempotent**: re-adding an emoji you already hold is `204`, no event. Must be an active participant; `:seq` must be a visible message (within your `join_seq` floor) else `404 not_found`. A 9th **distinct** emoji by the same user on the same message → `409 reaction_limit` (`REACTIONS_PER_USER_PER_MESSAGE_MAX=8`). |
| `DELETE /api/conversations/:id/messages/:seq/reactions/:emoji` | `:emoji` URL-encoded | `204` — **idempotent**: deleting a reaction you don't hold is `204`, no event. |

Aggregates ride message DTOs as `reactions: [{emoji, count, mine}]` (ordered by
first reaction per emoji). Each **effective** add/remove fans out one
`reaction.updated` WS frame (§2.3) through the Redis `events` channel — a
deliberate delta, not a `msg.updated` re-ship. Clients reconcile on reconnect
from DTO aggregates (sync/history refetch), never by replaying frames.

### 1.13 Privacy settings (v0.3 — ADR-009)

Settings are columns on `users` (one row read on the presence/typing/receipt
hot paths — the `avatar_motion` pattern; ADR-009). Every setting is enforced
**server-side** at the points below; clients only mirror state. There is no
"all notifications off" switch anywhere, by design (PSYCHOLOGY §6).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/me/settings` | — | `200 {settings: UserSettings}` |
| `PATCH /api/users/me/settings` | any subset of `UserSettings` | `200 {settings}` — applies immediately (serialization-time filtering; nothing stored is rewritten) |

The coarse profile `area` (gates `'area'` beacons, §1.15) is identity, not a
setting: `PATCH /api/users/me {area}` (`≤ 64` chars, `null` clears). It is
**owner-private** — in `UserPrivate` only, never shown to anyone (FEATURES #30).

**Enforcement points, per setting (binding for builders):**

| Setting | Server-side enforcement |
|---|---|
| `read_receipts` (default `true`) | **Reciprocal.** Watermarks always advance (unread counts, §2.9 push guards unchanged). Filtering is at serialization: (a) `Participant.last_read_seq` serialized to viewer V for participant P is the true value only when `P = V` or **both** P and V have receipts on — else `0`; `last_delivered_seq` is never filtered. (b) `receipt` WS frames from a receipts-off reader go to others with `last_read_seq: 0` (own devices get the true value for cross-device unread sync); the gateway also clamps others' `last_read_seq` to `0` in frames **to** a receipts-off viewer. (c) §1.18 seen-by: receipts-off users never appear in `seen` (they cap at `delivered`); a receipts-off **viewer** gets `403 read_receipts_off` from that endpoint. |
| `show_last_seen` (default `everyone`) | `UserPublic.last_seen_at` serialized `null` unless the viewer qualifies (`dm_partners` = shares an active DM with the owner; `nobody` = no one). `presence` WS frames to non-qualifying subscribers omit `last_seen_at`; the `online` boolean is unaffected (it is live state, not a timestamp). |
| `show_typing` (default `true`) | Suppressed **at the gateway**: inbound `typing` frames from a user with it off are dropped before rebroadcast. No error frame — typing is best-effort ephemera. |
| `invites_paused` (default `false`) | `POST /api/invites` → `403 invites_paused`. `POST /api/invites/:token/accept` on any invite whose **inviter** is paused → `403 invites_paused` (no `use_count` claim). Register-with-token degrades to `invite: null` per §1.1. `GET /:token/public` still renders (the join page shows the paused state on accept failure). |
| `beacon_default_audience` (default `friends`) | Used by `POST /api/beacons` when `audience` is omitted (§1.15). Pure default — no other enforcement. |
| `group_add_policy` (default `everyone`) | Checked per **target** user T on `POST /api/conversations {type:'group'}` and `POST /api/conversations/:id/participants`: `nobody` denies; `dm_partners` denies unless the adder shares an active DM with T. Any denied target fails the whole request: `403 {error:'group_add_denied', user_ids:[denied]}`. Blocks produce the **same** response (§1.14) so a 403 never confirms a block. Joining via a group invite (§1.11) is the joiner's own action — the policy governs being *added*, not joining. |
| `mood_effects` (v0.8a, default `true`) | None server-side — a per-VIEWER render toggle (§1.58): whether MY client performs other people's mood-reactive bubble effects. Stored here purely for cross-device sync. |
| `activity_beacons` / `activity_posts` / `activity_listings` / `activity_games` (v0.8a, default `connections`) | Per-group visibility of my §1.59 activity strip, enforced at strip serialization and ALWAYS intersected with the underlying object's own audience (§1.59 table) — the toggle narrows, never widens. |
| `anon_messages` (v0.8b, default `connections`) | Who may open a §1.62 anonymous thread to me (`nobody` / `connections` = accepted §1.28 connections literally / `everyone`). Enforced INVISIBLY at `POST /api/anon/threads`: an opt-out, an unmet `connections` and a §1.14 block all answer the same `404 anon_unavailable` — the setting is never confirmable from outside. |
| `wave_nudges` (v0.8b, default `true`) | May the worker send me the §1.63 batched anonymous wave nudge during a live discovery opt-in. Off suppresses both the push and the in-app `discovery.nudge` frame; nothing else changes (waves still park silently). |

### 1.14 Blocks & reports (v0.3 — ADR-009)

| Method & path | Request | Response |
|---|---|---|
| `PUT /api/users/:id/block` | — | `204` (idempotent re-block `204`). `400 block_self`. `404 not_found` unknown id. Does NOT leave shared groups or delete history. |
| `DELETE /api/users/:id/block` | — | `204` (idempotent). |
| `GET /api/users/me/blocks` | — | `200 {users: UserLite[]}` — my block list, newest first (the management surface; no timestamps exposed). |
| `POST /api/reports` | `{kind:'user', user_id, reason?}` \| `{kind:'message', conversation_id, seq, reason?}` \| `{kind:'beacon', beacon_id, reason?}` — `reason ≤ 500` | `201 {id}`. Target must be referenceable by the reporter (message: visible per §1.5 floor; beacon: §1.15-visible or previously joined; user: exists). Stored `status:'open'` for the future admin dashboard (FEATURES #54) — no fan-out, no notification to anyone. Rate **10/hour/user** (`REPORT_RATE_PER_HOUR`) → `429`. |

**Block enforcement (binding, per surface).** Principle: wherever a `403`
would *confirm* the block, the answer is **404-shaped** — identical to the
resource never existing. Let B = either direction of a blocked pair.

| Surface | Enforcement |
|---|---|
| DM create | `POST /api/conversations {type:'dm'}` between B → `404 not_found` (same body as an unknown `user_id`). Never `403`. |
| Existing DM | The conversation and history remain readable, but `POST .../messages` into a DM between B → `404 not_found` (frozen both directions). |
| Group adds | Adding each other → `403 group_add_denied`, byte-identical to the §1.13 policy denial — the 403 reveals *a* refusal, never *which* one. |
| Group invites | `POST /api/invites/:token/accept` where inviter⊥joiner are B → `404 invite_not_found`. |
| Existing shared groups | Both stay; messages and §1.18 receipts keep working (group function). Presence, typing, and last-seen between B are suppressed; each is omitted from the other's §1.18 lists and §1.15 joiner piles. |
| Beacons | Invisible both directions (list, radar count, `beacon.new`/`beacon.updated` fan-out). Join/kudos/report-visibility on each other's beacons → `404 beacon_not_found`. The server never sparks a blocked pair into one brand-new plan group: an **open beacon whose joiner pile already holds anyone blocked w.r.t. the viewer** is unjoinable and therefore invisible to them (list, radar, fan-out, push; join → `404 beacon_not_found`), and the join transaction re-checks the committed pile under the beacon row lock so concurrent joins cannot race past it. |
| Presence / last-seen | `presence.sub` on each other silently dropped (the existing not-shared-a-conversation rule); `last_seen_at` always `null`. |
| Profile & search | `GET /api/users/:username` → `404 not_found` both directions; `GET /api/users?q=` excludes both directions. (The blocker manages the relationship from `GET /api/users/me/blocks`.) |
| Kudos | `POST /api/beacons/:id/kudos` targeting each other → `404 not_found`. |
| Web push | No push is ever generated between B (the fan-out exclusions above make this structural). |

### 1.15 Beacons (v0.3 — ADR-008, PSYCHOLOGY §1/§3/§5)

The "I'm bored" flow. A beacon is a joinable intent card, not an event: vibe
chip + optional note, a time window, an audience, and a spark threshold.
`201` responses return the full DTO immediately — the creator lands on the
live plan card (pre-building roles, watching the pile) and **never sees a
waiting state** (PSYCHOLOGY §1).

**Audience** (resolved at read/fan-out time, always minus §1.14 blocks):
`friends` = users sharing a DM conversation with the creator (both active
participants) — **upgraded in v0.5a (§1.28): `friends` resolves to FRIENDS-OF
= accepted connections ∪ dm-partners; the stored enum value is unchanged**;
`area` = users whose `users.area` equals the beacon's `area`
snapshot (citext, case-insensitive); `public` = all users. The `area` value is
snapshotted from the creator at mint so the audience cannot drift.

**Window presets.** `starts_at`/`expires_at` are client-computed from the
chips — the server is timezone-blind. Mapping: **now** → `[now, now+4h]`;
**tonight** → `[18:00, 23:59]` local today; **weekend** → `[Sat 10:00,
Sun 23:59]` local. Server validation: `starts_at ≥ now−300s`,
`expires_at − starts_at ≥ 30 min` (`BEACON_MIN_WINDOW_S`), `expires_at ≤
now + 7d` (`BEACON_MAX_HORIZON_S`). The countdown to `starts_at` is a feature
(anticipation, PSYCHOLOGY §5) — clients render it from the DTO, no extra API.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/beacons` | `{vibe, note?≤140, audience?, spark_threshold?: 2..10, starts_at, expires_at}` — `audience` defaults to my `beacon_default_audience`; threshold defaults 2 (= groups of 3+, PSYCHOLOGY §3) | `201 {beacon}`. `400 area_required` (audience `area`, my `area` null), `409 beacon_limit` (> 3 simultaneously open, `BEACON_OPEN_MAX`). Rate **10/hour/user**. Bumps my `beacons_created`. Fans `beacon.new` **only to the audience** (never to anyone who can't join — PSYCHOLOGY rule 2); push to offline audience (a beacon is a live invite, §2.9 guards apply). |
| `GET /api/beacons` | — | `200 {beacons: Beacon[]}` ordered `expires_at ASC` (most urgent first): all `open` beacons visible to me (audience ∪ mine), plus `sparked` ones where I am creator/joiner and `expires_at > now` (the countdown card). Sparked beacons vanish for everyone else — a beacon is visible **only while the viewer can still join** it (FoMO-safe). Joiner piles exclude users blocked w.r.t. the viewer. |
| `GET /api/beacons/radar` | — | `200 {active_visible_count}` — count of `open` beacons visible to me, excluding my own. **Aggregate only**: no names, no faces, no list (FEATURES #26). |
| `POST /api/beacons/:id/join` | — | `200 {beacon}` — idempotent re-join `200` no-op. `404 beacon_not_found` (unknown, not in audience, or blocked — identical), `400 beacon_own` (creator), `410 beacon_closed` (not `open` / past `expires_at`). May spark (below) or re-ping (below). Fans `beacon.updated` to the audience. |
| `DELETE /api/beacons/:id/join` | — | `200 {beacon}` — leave while `open`; idempotent. `409 beacon_sparked` after spark (leave the plan conversation instead, §1.4). Fans `beacon.updated`. |
| `POST /api/beacons/:id/cancel` | — (creator) | `200 {beacon}` status `cancelled`. `403 forbidden` (not creator), `409 beacon_sparked` (plans survive their beacon). Fans `beacon.updated` — cards silently retire, no "cancelled on you" copy. |
| `POST /api/beacons/:id/ritualize` | — (creator) | `200 {beacon}` — sets `ritual = {rrule:'FREQ=WEEKLY', count: 1, skips: 0}`. Requires `sparked` ("make it a ritual" after a good plan), **or** the latest run of a paused chain in any status — that is the resume path (re-arms with `skips: 0`). `409 beacon_not_sparked` otherwise. |
| `POST /api/beacons/:id/run-it-back` | — | `201 {beacon}` — one-tap re-create from the afterglow recap. `:id` must be a `sparked` beacon I created or joined (else `404`). New beacon: creator = **me**, copies vibe/note/audience/threshold, window = `[now, now + original duration]`. `400 area_required` if audience `area` and my `area` is null. Bumps my `beacons_created`; fans `beacon.new`. Run-it-back IS a mint: it draws on the same **10/hour** `POST /api/beacons` budget (shared fixed-window key) → `429`, so a cancel/re-run loop cannot push-spam the audience. |
| `POST /api/beacons/:id/kudos` | `{to_user_id, kind: 'glad_you_came'\|'glad_you_posted'}` | `204` — idempotent per `(beacon, me, recipient)` (PK), re-sends change nothing. Both parties must be in the spark group; `glad_you_posted` must target the creator; self-kudos `400`. Window: spark → `expires_at + 7d` (`BEACON_KUDOS_WINDOW_S`), else `410 beacon_closed`. Blocked pair → `404 not_found`. Delivery: `beacon.kudos` WS frame + push **to the recipient only**. Never aggregated publicly anywhere — the creator's "3 people were glad you posted" is their own private event stream (PSYCHOLOGY §9, rule 3). |

**Spark (atomic, in the join transaction).** `spark_threshold` counts joiners
(creator excluded). Join locks the beacon row (`SELECT … FOR UPDATE`), inserts
the join (`ON CONFLICT DO NOTHING`), recounts; at `count ≥ spark_threshold` it,
in the same transaction: creates a `group` conversation (creator `admin`, all
joiners `member`, `join_seq = 0` — founding members see the whole plan),
inserts the **icebreaker** system message (`metadata.system = {event:
'beacon_sparked'}`, body = `BEACON_ICEBREAKERS[hash(beacon_id) % len]`),
inserts the **auto venue poll** (a §1.17 `poll` message, sender `null`,
question `BEACON_VENUE_POLL_QUESTION`, options `BEACON_VENUE_POLL_OPTIONS`),
flips the beacon via the guarded `UPDATE … SET status='sparked',
conversation_id=$c WHERE id=$1 AND status='open'`, bumps the creator's
`beacons_sparked` (and `ritual_count` if a ritual run), and enqueues the
afterglow job (delay = `expires_at + 2h − now`). Fan-out after commit:
`conv.new` + `beacon.updated` (with `conversation_id`) + push **to joiners +
creator only**; the rest of the audience gets `beacon.updated` with status
`sparked` and `conversation_id: null` — their card retires, they are never
told what they're missing (PSYCHOLOGY rule 2 — no spark details, ever).

**Re-ping ("needs 1 more", PSYCHOLOGY §3).** When a join brings the count to
exactly `spark_threshold − 1` and `repinged_at IS NULL`, the guarded
`UPDATE beacons SET repinged_at = now() WHERE id=$1 AND repinged_at IS NULL
AND status='open'` claims the one re-notification: `beacon.updated` with
`reping: true` + push to the audience (non-joiners). **At most once per
beacon**, ever — including ritual re-runs (each run is a new row, so each run
gets one).

**Expiry.** Worker sweep (queue `beacons`, every minute): `UPDATE beacons SET
status='expired' WHERE status='open' AND expires_at <= now()` → `beacon.updated`
to the audience. No push, no copy — unsparked beacons die silently.

**Rituals (PSYCHOLOGY §7 — forgiving calendars, never streaks).** Each weekly
run is a **new beacon row** chained by `ritual_parent_id` (one child max,
partial unique index). The worker (hourly) takes each terminal ritual run
(`now > expires_at`, no child) and mints the next: same
vibe/note/audience/threshold/rrule, `starts_at` advanced in 7-day steps past
`now`, same duration; `ritual_count` carries over (it increments **on spark**
— it counts UP: "12 chai nights", never down, never a streak);
`ritual_skips = sparked ? 0 : skips + 1`. At `ritual_skips ≥ 2`
(`RITUAL_AUTO_PAUSE_SKIPS`) the worker simply does **not** create the next run
— the chain auto-pauses with **zero guilt copy**: no notification, no "you
broke it" (never-build list). Resume = `ritualize` the latest run. Worker-made
runs do **not** bump `beacons_created`, and fan `beacon.new` to the audience
like any open beacon.

**Afterglow (PSYCHOLOGY §8).** 2 h after a **sparked** beacon's `expires_at`
(delayed job + `beacons_afterglow_idx` safety sweep) the worker posts a recap
**system message in the plan conversation** (never outside it): body is a
playful one-liner naming the crew; `metadata.afterglow = {beacon_id, vibe,
participant_ids, photo_attachment_ids (image attachments posted in the
conversation between spark and expires_at+2h, newest-first, ≤ 6),
run_it_back: beacon_id}`. `run_it_back` is the one-tap token for
`POST /api/beacons/:id/run-it-back` — the id is the capability; spark-group
membership is the authorization. Delivered as a normal `msg.new`; it rides the
seq log so offline members catch it via `GET /sync`.

### 1.16 Plan roles (v0.3 — PSYCHOLOGY §4)

Named micro-roles on a **sparked** beacon's plan card ("Priya books the
table"). Visible contribution, never anonymous pooling: a role is a label +
one named assignee + a done state. Caller must be in the spark group (creator
or joiner), else `404 beacon_not_found`; the beacon must be `sparked`, else
`409 beacon_not_sparked`.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/beacons/:id/roles` | — | `200 {roles: BeaconRole[]}` ordered `created_at ASC` (the reconnect/reconcile read) |
| `POST /api/beacons/:id/roles` | `{label ≤ 40}` | `201 {role}` (unassigned). `409 role_limit` past 12 (`BEACON_ROLES_MAX`). |
| `POST /api/beacons/:id/roles/:roleId/claim` | — | `200 {role}` — assigns **me**. `409 role_taken` if assigned to someone else; re-claiming my own is idempotent `200`. |
| `DELETE /api/beacons/:id/roles/:roleId/claim` | — | `200 {role}` — release (assignee or beacon creator). Idempotent on unassigned. |
| `POST /api/beacons/:id/roles/:roleId/complete` | — | `200 {role}` with `done: true` (assignee or creator). Idempotent. Done states are per-person checkmarks on the card — no percentages, no progress bars. |
| `DELETE /api/beacons/:id/roles/:roleId` | — | `204` (beacon creator only). |

**Fan-out decision (documented, binding):** every mutation emits one
**`plan.updated`** WS frame — a dedicated event, deliberately **not**
`conv.updated` (which re-ships the whole Conversation DTO with participants;
roles are beacon state, not conversation state). The frame carries the **full
roles list** (≤ 12 rows), so frames are idempotent and reorder-safe; recipients
are the plan conversation's active participants. Reconnects reconcile from
`GET /api/beacons/:id/roles`, never frame replay (the §2.8 doctrine).

### 1.17 Polls (v0.3)

A poll **is a message** (`type: 'poll'`) riding the gapless seq log; the poll
row is keyed by the message identity `(conversation_id, seq)` — the §1.12
reactions pattern. It renders inline in chat, powers the sparked-beacon venue
poll, and later feeds plan food polls (PSYCHOLOGY §5).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/polls` | `{client_msg_id, question ≤ 200, options: string[2..6] (each ≤ 80), closes_at?}` | `201 {message}` (`200` idempotent replay via `client_msg_id`, §1.5). `message.type='poll'`, `message.poll` populated. Active participant only. Transaction = §1.5 send (seq bump, watermark raise, `msg.new` fan-out, push). |
| `POST /api/polls/:id/vote` | `{option_idx}` | `200 {poll}` — UPSERT on `(poll_id, user_id)`: **revoting replaces**. `400 bad_option` (idx ≥ options length), `409 poll_closed` (past `closes_at`), `404 not_found` (not a participant / outside my §1.5 visibility floor). |
| `DELETE /api/polls/:id/vote` | — | `200 {poll}` — unvote; idempotent. `409 poll_closed` after close. |

Aggregates ride the message DTO (`message.poll.counts/total_votes/my_vote`).
Each **effective** vote change fans out one `poll.updated` delta frame (§2.3)
to active participants — not a `msg.updated` re-ship. No per-voter lists and
no vote timestamps in any payload; a poll is a decision tool, not a scoreboard.
`user_id`/`option_idx` identify the voter **only on the frame sent to the
voter's own sockets** (cross-device `my_vote` reconcile); every other
participant receives counts/total_votes alone, so no client can accumulate a
per-voter ballot map from the deltas.

### 1.18 Seen-by receipts (v0.3 — ADR-009)

| Method & path | Response |
|---|---|
| `GET /api/conversations/:id/messages/:seq/receipts` | `200 {seen: UserLite[], delivered: UserLite[]}`. `403 read_receipts_off` when **my own** `read_receipts` is off (reciprocity, §1.13). `404 not_found` if the message is outside my §1.5 visibility floor. |

Computed **from the §2.5 watermarks** — zero new state: over active
participants excluding the sender, `seen` = `last_read_seq ≥ seq`, `delivered`
= `last_delivered_seq ≥ seq` and not in `seen`. **No timestamps anywhere in
the response**, and both lists are ordered by `username` — never by recency
(a "seen 43 min ago" timestamp turns a receipt into a reply deadline;
PSYCHOLOGY never-build list). Participants with `read_receipts` off appear at
most in `delivered`, whatever their true read state. Users blocked w.r.t. the
viewer are omitted from both lists. This endpoint is the foundation for story
view lists (v0.5, FEATURES #27).

### 1.19 Avatar stamps (v0.4 — ADR-010)

React with your own animated avatar. A stamp is a `message_reactions` row with
`kind='stamp'` and the `STAMP_REACTION_KEY` sentinel (`:stamp:`) in the emoji
column — the existing PK `(conversation_id, seq, user_id, emoji)` therefore
enforces the **one stamp per user per message** cap with no new state. The
**same §1.12 routes** gain a `kind` field; every pre-v0.4 payload (`{emoji}`)
stays valid byte-for-byte (`kind` defaults to `'emoji'`).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/messages/:seq/reactions` | `{kind?: 'emoji'\|'stamp', emoji?}` — `emoji` required iff `kind='emoji'`, forbidden for `'stamp'` (400 otherwise) | `204` — idempotent, §1.12 semantics unchanged. Stamps additionally require **my** avatar `status='ready'` → else `409 stamp_no_avatar` (there is no face to stamp with). A stamp never consumes one of the 8 distinct-emoji slots (`REACTIONS_PER_USER_PER_MESSAGE_MAX` counts `kind='emoji'` rows only). |
| `DELETE /api/conversations/:id/messages/:seq/reactions/:emoji` | for a stamp, `:emoji` is the URL-encoded sentinel `:stamp:` | `204` — idempotent, as §1.12. |

**Rendering contract:** stamps are **faces, not counters**. `Message.stamps`
carries the stampers as `UserLite[]` in first-stamp order; the client renders
each reactor's avatar — animated WebP under the §5 motion rules
(`prefers-reduced-motion` + `avatar_motion`), static JPEG otherwise —
version-busted via `avatar.version` exactly like every other avatar surface.
No count badge, no aggregation (PSYCHOLOGY rule 3: name people, never scores).
Fan-out is the same `reaction.updated` delta frame, now carrying `kind` (§2.3);
recipients resolve the stamper's avatar from the participants they already
hold. Reconnect truth is `Message.stamps`, never frame replay. Blocked pairs
in shared groups: stamps keep working like reactions (group function, §1.14).

### 1.20 Voice notes (v0.4 — ADR-010)

A voice note is a message of `type='audio'` with exactly **one** `audio`
attachment, riding the **existing** §1.6 proxied upload pipeline end to end —
no new upload machinery.

- **Upload:** `POST /api/uploads` sniffs magic bytes; the new audio allowlist
  (`AUDIO_MIME_ALLOWLIST`) is **ogg/opus (`audio/ogg`), webm/opus
  (`audio/webm`), m4a/aac (`audio/mp4`), mp3 (`audio/mpeg`)**; anything else →
  `415`. Size cap `MAX_AUDIO_BYTES` (10 MB, enforced while streaming) → `413`.
  Response: `201 {attachment}` with `kind:'audio'`, `status:'pending'`,
  `waveform: null`.
- **Worker (queue `media`, same job family as video):** ffprobe the duration —
  longer than `MAX_AUDIO_DURATION_S` (5 min) flips the attachment to
  `'failed'` (a recording-side client should never hit this; the cap is
  server-truth). Then split the duration into `AUDIO_WAVEFORM_BUCKETS` (48)
  equal segments and measure each segment's peak level (ffmpeg `astats` per
  segment; `volumedetect` is the acceptable fallback), normalized to integers
  `0..AUDIO_WAVEFORM_PEAK_MAX` (100). Write `duration_ms` + `waveform`, set
  `status='ready'`.
- **Hydration is the existing contract, reused verbatim:** attachment already
  bound to a message → participants get `msg.updated` (full DTO); not yet
  bound (composer open) → uploader gets `attachment.ready`. `GET
  /api/uploads/:id` stays the poll fallback.
- **Send:** ordinary `POST .../messages` with `type:'audio'` and the one
  attachment id (`400 audio_attachment_required` when missing/not audio/more
  than one/**`status='failed'`** — a worker-rejected over-length recording is
  never bindable — at send time, §1.26 schedule time, or §1.26 delivery time
  (the delivery transaction re-checks and cancels an audio schedule whose
  recording failed) — so the duration cap is
  enforced, not advisory; `'pending'` binds fine and hydrates via
  `msg.updated`). Push snippet for audio messages is `"Voice note"`.
- **DTO:** `Attachment.waveform` (48 ints) is inlined so bubbles render the
  scrubber with zero extra fetches; `duration_ms` drives the timestamp label.
  Playback UI must not autoplay — tap to play, like every media surface.

### 1.21 Doodles (v0.4)

A doodle is an ordinary **PNG image message** drawn on a client canvas (export
≤ `DOODLE_CANVAS_MAX_PX` = 1024 px) and sent with `metadata.doodle: true` —
**zero new server machinery**: the §1.6 image pipeline (EXIF strip, thumb,
blurhash, inline `ready`) applies unchanged, and the server merely accepts and
stores the flag (route check: `doodle` is valid only on `type='image'`, else
`400 bad_metadata`). Clients render doodle messages with the sketchy
hand-drawn frame (Bored Blob design language); the flag also marks vibe-check
replies as `kind:'doodle'` tiles (§1.23). Self-hosted rule: doodles and
uploads are the only "sticker" sources — there is no third-party GIF/sticker
API anywhere.

### 1.22 Message effects (v0.4 — ADR-010)

`metadata.effect ∈ {confetti, hearts, fireworks, snow}` (`MESSAGE_EFFECTS`,
DB CHECK-pinned), settable on any client-sent §1.5/§1.20 message.

**Consent rule (binding, PSYCHOLOGY "user-pulled, not app-pushed"):** when a
trigger phrase is typed (`EFFECT_TRIGGERS`: "congrats", "happy birthday",
"love you", "it's snowing", …) the composer may **suggest** the matching
effect as a tappable chip — the effect is attached **only when the sender
confirms**. It is never auto-attached, and the server never injects one.

**Playback rules (binding):** an effect plays **once per viewer per message**
— the client records played `(conversation_id, seq)` pairs locally (IndexedDB)
and never replays on scroll-back, reconnect, or re-render. Under
`prefers-reduced-motion` the animation is **fully replaced** by a static
badge/emoji on the bubble (not a reduced animation — none at all). Effects
never make sound. The push payload is unaffected.

### 1.23 Vibe checks (v0.4 — ADR-010)

"Everyone answers a prompt." A vibe check is a message (`type='vibe_check'`)
whose **body is the prompt** — picked from the rotating client-side deck
(`VIBE_CHECK_PROMPTS`, 24 entries) or custom-typed, ≤
`VIBE_CHECK_PROMPT_MAX_CHARS` (120). Sent via the ordinary §1.5 route
(`type:'vibe_check'`, `body` required → else `400 prompt_required`); the full
§1.5 transaction, fan-out and push apply.

**Replies are ordinary messages** in the same conversation carrying
`metadata.vibe_reply_seq = <the vibe message's seq>`:

- an **image** message (photo), a **doodle** (§1.21), or a **stamp reply**
  (`type:'text'`, no body, no attachments, `metadata.stamp: true` — the tile
  is the sender's avatar). `stamp` is valid only alongside `vibe_reply_seq`
  (`400 bad_metadata` otherwise); other reply shapes → `400 bad_vibe_reply`.
- `vibe_reply_seq` must reference a visible (§1.5 floor), non-deleted
  `vibe_check` message in the same conversation → else `404 not_found`.
- **One reply per user per vibe check** (the collage is one face each):
  a second reply → `409 vibe_already_replied`.

**Aggregation:** the vibe message's DTO carries `vibe = {prompt, reply_count,
replies[≤12], my_reply_seq}` (§0). Every accepted reply fans out the reply's
own `msg.new` **plus** a `msg.updated` full-DTO re-ship of the vibe message —
the existing hydration path, so the collage strip grows live and reconnects
reconcile from the DTO as always. Replies tombstoned by §1.25 drop out of the
aggregate (and the collage) on the same `msg.updated`.

### 1.24 Chat themes, wallpapers & nicknames (v0.4 — ADR-010)

Per-user-per-conversation prefs. **Themes and wallpapers are PERSONAL — they
change MY view only.** They are never serialized to any other participant, and
no event about them ever reaches another user: picking the `grape` theme tells
nobody anything. (This is the explicit opposite of §1.25's conversation-wide
TTL.) Synced across my devices via the `prefs.updated` WS event (own sockets
only). Nicknames follow the same rule: the map is the **owner's** private
labels (self-nicknames allowed); rendering replaces display names in my view
only.

Fixed sets (text + CHECK, the house enum pattern): `theme ∈ CHAT_THEMES`
(8 palettes: classic, sunset, ocean, forest, grape, bubblegum, mono,
midnight), `wallpaper ∈ CHAT_WALLPAPERS` (6 **CSS patterns** — dots, grid,
waves, stars, scribbles, blobs; **no wallpaper uploads in v0.4**). `null` =
app default. Themes restyle bubbles/accents; wallpapers paint the scroll
background; both honor dark mode and `prefers-reduced-motion` (patterns are
static by construction).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/conversations/:id/prefs` | — | `200 {prefs: ConversationPrefs}` (mine for this conversation; defaults `{theme: null, wallpaper: null, nicknames: {}}` when unset). Active participant only → else `404 not_found`. |
| `PATCH /api/conversations/:id/prefs` | `{theme?: ChatTheme\|null, wallpaper?: ChatWallpaper\|null, nicknames?: Record<user_id, string(≤32)\|null>}` — omitted = unchanged; explicit `null` resets a theme/wallpaper or **removes** a nickname | `200 {prefs}` (the full new state) + `prefs.updated` to **my own** sockets. Nickname targets must be participants (past or present) of the conversation → else `400 bad_nickname_target`. |

Storage: `conversation_prefs (conversation_id, user_id, theme, wallpaper)` +
`member_nicknames (conversation_id, owner_id, target_id, nickname ≤ 32)`
(migration 0004). Rows cascade with the conversation and the user.

### 1.25 Disappearing messages (v0.4 — ADR-010)

`conversations.disappear_ttl_s` — `null` = off, else one of
`DISAPPEAR_TTL_OPTIONS_S` (**1 h, 24 h, 7 d, 30 d**; CHECK-pinned). This is
**conversation-wide state** (everyone shares the same TTL), unlike §1.24.

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/conversations/:id/disappearing` | `{ttl_s: 3600\|86400\|604800\|2592000\|null}` | `200 {conversation}`. Permission: DM → **any active participant**; group → **admin only** (`403 forbidden`). A DM **frozen by a block (§1.14) refuses the toggle `404`-shaped**, byte-identical to an unknown conversation, in both directions — like sends and schedules: the toggle pushes `disappear_changed` fan-out and arms the sweep against the shared history, so it is a write surface and blocks apply. Idempotent re-set of the same value is `200` with no system message. Every effective change inserts a `system` message (bumps seq): `metadata.system = {event:'disappear_changed', actor_id, ttl_s}` — the announcement IS the audit trail — and fans out `conv.updated` + the system message's `msg.new`. |

**Sweep (worker queue `timers`, repeatable, every
`DISAPPEAR_SWEEP_INTERVAL_S`):** for each conversation with a TTL
(`conversations_disappearing_idx`), **tombstone** messages with
`created_at < now() − ttl` (walked via `messages_disappear_sweep_idx`):

- `deleted_at = now()`, `body = NULL`, `metadata = '{}'`; the row — and its
  **seq — is never deleted or reused**, so sync cursors, watermarks, unread
  math and §1.5 pagination are untouched by construction (ADR-003 survives).
- attachments of the message: MinIO objects deleted, attachment rows deleted.
- dependent rows keyed by `(conversation_id, seq)` are removed explicitly
  (reactions/stamps, poll + votes) — the message row survives, so FK cascades
  don't fire on their own.
- `type` and `sender_id` survive (tombstones render "message expired" in the
  right bubble position); **`system` messages are exempt** (announcements and
  recaps persist).
- fan-out: one `msg.updated` per tombstone to active participants (batch-
  bounded per run; offline clients reconcile via sync + history refetch, where
  tombstones arrive as ordinary DTOs with `deleted_at` set).

The TTL clock starts at each message's `created_at` — including for §1.26
scheduled deliveries (delivery time, not schedule time). Messages sent while
the TTL was off never retroactively expire: the sweep compares against the
**current** TTL, so turning it on applies to old messages too — the system
message states this plainly ("new and existing messages disappear after …").

### 1.26 Scheduled messages & time capsules (v0.4 — ADR-010)

Write now, deliver later, as a **real §1.5 message** when `deliver_at`
arrives. A **time capsule** is the same row with `metadata.capsule: true` and
a far-out `deliver_at` — pre-delivery it renders as a sealed envelope in the
author's scheduled list, and the delivered message keeps `metadata.capsule` so
recipients get the sealed-envelope bubble with a first-view reveal
(client-tracked like §1.22 effects, reduced-motion fallback opens instantly).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/scheduled-messages` | `{client_msg_id, type: 'text'\|'image'\|'video'\|'file'\|'audio', body?, attachment_ids?, metadata?: {effect?, capsule?: true}, deliver_at}` | `201 {scheduled}` (`200` idempotent replay on `(author, client_msg_id)`). Active participant only. Window: `now + SCHEDULED_MIN_LEAD_S (60 s) ≤ deliver_at ≤ now + SCHEDULED_MAX_HORIZON_S (366 d)` → else `400 deliver_at_out_of_range`. Attachments must be mine and unbound; they bind to the row via `attachments.scheduled_message_id` (which also shields them from the orphan GC). `409 scheduled_limit` past **50 pending per user** (`SCHEDULED_PENDING_MAX_PER_USER`, counted across conversations). Rate `SCHEDULED_CREATE_RATE_PER_HOUR` (30) → `429`. |
| `GET /api/scheduled-messages` | — | `200 {scheduled: ScheduledMessage[]}` — **mine only**, all conversations, `pending` first then `deliver_at ASC`, non-pending capped at the latest 50. A pending schedule is private: no other participant can see it exists. |
| `DELETE /api/scheduled-messages/:id` | — | `204` — cancel (sets `status='cancelled'`, unbinds + orphans its attachments for GC). Only mine → else `404 not_found`. Already sent → `409 scheduled_sent`; re-cancel is idempotent `204`. |

**Delivery (worker queue `timers`):** a delayed job per row plus a
minute-sweep safety net over `scheduled_due_idx` (the §1.15 afterglow
pattern). The claim is the idempotent guarded update — `UPDATE
scheduled_messages SET status='sent', sent_at=now(), sent_seq=$seq WHERE
id=$1 AND status='pending'` — executed **inside the same transaction** as the
real message insert (seq bump, author-watermark raise, attachment binding), so
job retries and sweep/job races can never double-deliver. Then the normal
fan-out: `msg.new` to participants, push for offline ones, and
`scheduled.updated` to the **author's own** sockets. If delivery is impossible
at claim time — author no longer an active participant, DM frozen by a §1.14
block, conversation deleted, or an audio schedule whose sole recording the
media worker marked `'failed'` (§1.20 duration cap, re-checked inside the
delivery transaction) — the row flips to `'cancelled'` instead (never a
partial send, no error to anyone). Every state change (create/cancel/send)
emits `scheduled.updated` to the author's sockets for cross-device list sync.

### 1.27 Mini-games: tic-tac-toe & the daily puzzle (v0.4 — ADR-010)

#### Tic-tac-toe

A game is a message (`type='game_ttt'`) whose **whole state lives in
`metadata.game`** (`GameTttState`, §0): board, players, turn, winner. Moves
are **server-validated**; the client never computes state. Every accepted move
is an in-place metadata update fanned out as `msg.updated` (full-DTO replace —
the existing §2.3 contract), so the board animates live and reconnects
reconcile from the DTO.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/games/ttt` | `{client_msg_id, opponent_id?}` — DM: opponent implied (must be omitted); group: required, an active participant | `201 {message}` (`200` idempotent replay). Challenger plays `x` and moves first. `400 bad_opponent` (self, non-participant, or supplied in a DM); blocked pair in a group → `404 not_found` (§1.14 404-shape). The §1.5 send transaction applies (seq bump, `msg.new`, push "Tic-tac-toe challenge"). |
| `POST /api/games/:messageId/move` | `{cell: 0..8}` | `200 {message}` — the updated game message. Validation under a row lock (`SELECT … FOR UPDATE` on the message): caller is one of the two players (else `404 not_found` — non-players, including other group members, get the same shape as a bad id), it is their turn (`409 game_not_your_turn`), the cell is empty (`409 game_cell_taken`), no winner yet (`409 game_over`). Server flips `turn`, detects win/draw, bumps `edited_at`, fans out `msg.updated`. |

Spectating group members just watch the bubbles update. Games on a §1.25
tombstoned message are over (`409 game_over` — the state is gone). No
rematch state, no win tallies, no records: a finished board is just a message
in the scrollback (PSYCHOLOGY rule 3 — no scores attached to people).

#### Daily word puzzle

One deterministic 5-letter word per **UTC day**:
`PUZZLE_WORDLIST[sha256("<yyyy-mm-dd>:" + PUZZLE_SECRET) mod wordlist.length]`.
The wordlist is a public
shared constant (append-only — reordering would reshuffle future words); the
secret is server-side env (`PUZZLE_SECRET`), so clients cannot precompute the
word, and the DB never stores it (`puzzle_attempts` holds only guesses +
scores). Guesses are scored **server-side only**.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/puzzle/today` | — | `200 {date, attempts: [{guess, score}], solved, remaining}` — my state for today (empty attempts = not started). `score` is 5 chars of `g`(reen)/`y`(ellow)/`x`(grey), duplicate letters scored Wordle-style (greens claimed first, then yellows left-to-right while supply lasts). Never contains the word. |
| `POST /api/puzzle/guess` | `{guess: /^[a-z]{5}$/}` | `200 {date, attempts, solved, remaining, correct}`. `400 bad_guess` (shape only — any 5 letters are accepted; no dictionary gate in v0.4). `409 puzzle_done` when already solved or 6 attempts used (`PUZZLE_MAX_GUESSES`). The attempt log is one row per (user, UTC day), appended transactionally. |
| `POST /api/conversations/:id/messages` with `type:'puzzle_result'` | ordinary §1.5 send; `body`/`attachment_ids`/client `metadata.puzzle` are ignored | `201 {message}` — the server **builds `metadata.puzzle` from MY stored attempt** for today (date, attempts_used, solved, `grid` of `g/y/x` rows — no letters, no spoiler, unforgeable). Requires a finished puzzle (solved, or 6 used) → else `409 puzzle_unfinished`. Renders as the emoji grid (`PUZZLE_SCORE_EMOJI`). Push snippet: `"Puzzle result"`. |
| `GET /api/puzzle/today/friends` | — | `200 {friends: [{user: UserLite, result: PuzzleResult}]}` — DM partners (active DM with me, minus §1.14 blocks) who **opted in by posting** a `puzzle_result` for today into a conversation I'm an active participant of (their latest such post). **Ordered by username — never by score or speed.** |

**Psychology guardrails (binding):** sharing a grid into a chat is a named,
consensual act and is the ONLY leaderboard-like surface — there is **no
ranking, no ranked table, no points, no solve-time anywhere** (rule 3), **no
streak counter and no "don't break it" copy ever** (never-build list), and no
notification nudges to play. The puzzle entry point is user-pulled only.

### 1.28 Connections (v0.5a — ADR-011)

The social graph edge: one row per **unordered pair**, `pending` until the
addressee accepts. **FRIENDS-OF** — the v0.5a audience primitive — is
`accepted connections ∪ dm-partners, minus §1.14 blocks`, resolved at
read/fan-out time, never stored. It powers stories (§1.34), the feed (§1.36),
and **upgrades the beacons `friends` audience and the
`beacon_default_audience` setting**: both keep the stored enum value
`'friends'` but resolve to friends-of from v0.5a on (a pure semantic widening
— every pre-v0.5a friend, i.e. DM partner, stays in). `show_last_seen` /
`group_add_policy` `'dm_partners'` are untouched: they name DM partners
literally and still mean exactly that.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/users/:id/connect` | — | `201 {connection}` (`direction:'outgoing'`, `status:'pending'`). If the target already has a pending request TO me, this **accepts** it instead → `200 {connection}` (`accepted`). Idempotent re-request of an existing pending/accepted pair → `200` with the current row. `400 connect_self`. Blocked pair or unknown id → `404 not_found` (§1.14 404-shape, identical bodies). Rate **30/hour/user** (`CONNECTION_REQUEST_RATE_PER_HOUR`). |
| `POST /api/connections/:id/accept` | — (addressee only) | `200 {connection}` (`status:'accepted'`, `responded_at` set). `404 not_found` (not mine / not pending / requester blocked meanwhile). |
| `POST /api/connections/:id/decline` | — (addressee only) | `204` — **deletes the row** (re-requests stay possible). **Silent to the requester**: no WS frame, no push, nothing — a decline must never become a rejection ping (PSYCHOLOGY §9, the liking gap). `404 not_found` if not mine/not pending. |
| `DELETE /api/connections/:id` | — (either party) | `204` — removes an accepted connection, or cancels my own pending request. Idempotent. **Silent to the other party** (own-sockets `connection.updated` only; their list reflects it on next read). |
| `GET /api/connections` | — | `200 {connections, incoming, outgoing}` — accepted (ordered by username), pending-to-me, my-pending (both `created_at ASC`). Rows involving blocked users are omitted. |

**Semantics (binding):**

- The unordered pair is DB-unique (`LEAST/GREATEST` index) — concurrent
  cross-requests cannot create two rows; the loser of the race gets the
  winner's row back (`200`).
- **Blocks:** blocking deletes any **pending** request between the pair
  (silently, both directions) and makes an **accepted** connection **dormant**
  — excluded from friends-of and from `GET /api/connections` while the block
  stands, but the row survives (§1.14 "does not delete history"); unblocking
  restores it. Connect attempts between blocked pairs are `404 not_found`.
- **Fan-out (`connection.updated`, §2.3) — to the two parties only, and not
  even both for every transition:** request → addressee + requester's own
  sockets; accept → both parties; decline → addressee's own sockets only;
  remove/cancel → the actor's own sockets only. Push: a **new incoming
  request** and an **accept** push to the affected user (it is an invitation /
  an answer they asked for — §2.9 guards apply); declines and removals never
  push anyone.

### 1.29 Threads / replies (v0.5a)

A reply names an **earlier message in the same conversation** by `seq` — the
message identity reactions (§1.12), polls (§1.17) and reports (§1.14) already
use. The v0.1 `reply_to_id` column is retired (always `null` from v0.5a on).

- **Send:** `POST .../messages` (§1.5) gains `reply_to_seq`. Validation: the
  target must exist within my §1.5 visibility floor → else `404 not_found`;
  it must be an earlier seq (`reply_to_seq < seq` by construction — DB CHECK).
  **Tombstoned targets ARE repliable** (the context renders "message
  deleted"); replying never un-deletes anything. Replies to replies are just
  replies (flat threading — tap the context to jump; no tree UI in v0.5a).
- **DTO:** the reply message carries `reply_to_seq` plus a **server-resolved**
  `reply_context` snippet `{seq, author: UserLite|null, type, excerpt ≤ 80
  (REPLY_EXCERPT_MAX_CHARS), deleted}` — resolved at **serialization time**,
  so edits and tombstones of the target are always current and clients never
  join locally. `excerpt` is `null` for body-less kinds (the "Photo" /
  "Voice note" label is client copy keyed on `type`).
- **UI contract (binding):** the bubble renders the context as a tappable
  quote card above the body — author name + excerpt (or kind label), jumping
  to `reply_to_seq` on tap (scroll + flash; the target is in local history or
  one §1.5 `before_seq` page away). Swipe-to-reply on any bubble; the composer
  shows a cancellable "replying to" chip. `deleted: true` renders the italic
  "message deleted" card, not a blank.

### 1.30 Edit & delete (v0.5a)

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/conversations/:id/messages/:seq` | `{body: 1..8192}` | `200 {message}` — author only (`403 forbidden`), type in `EDITABLE_MESSAGE_TYPES` (`text\|image\|video\|file\|audio`) else `400 not_editable`, within `EDIT_WINDOW_S` = 24 h of `created_at` else `409 edit_window_closed`, not tombstoned else `409 message_deleted`. Sets `edited_at`; fans out `msg.updated`. |
| `DELETE /api/conversations/:id/messages/:seq` | — | `204` — author only (`403 forbidden`; system messages have no author and are undeletable). **Tombstone, never row deletion** (§1.25 semantics, ADR-003): `deleted_at` set, `body` nulled, `metadata` emptied, attachments deleted (rows + MinIO objects, **refcount-guarded** — §1.31), dependent reaction/poll rows removed, any §1.32 pin on it removed (+ `conv.updated`). The seq survives forever. Fans out `msg.updated`. Idempotent re-delete → `204`. |

- The **edited badge** is `edited_at != null` on the DTO — clients render
  "edited" beside the timestamp; no edit history is stored or served.
- Edits **re-parse §1.33 mentions** against current participants (metadata is
  rewritten) but **never re-push** — mention notifications fire at send time
  only, so an edit cannot be used to re-ping anyone.
- Edits never re-run unfurl and keep the existing `link_preview` snapshot
  (a snapshot is send-time truth, §1.5).
- Both routes work in frozen DMs **only as 404-shaped denials consistent with
  §1.14 sends**: a DM frozen by a block refuses PATCH/DELETE with
  `404 not_found` (they are write surfaces).
- In channels (§1.35) the same rules apply to the owner/admins' own messages;
  nobody edits or deletes anyone else's words in v0.5a.
- v1.0a (#96): `DELETE …/messages/:seq?undo=1` works for EVERY sender within
  `UNDO_SEND_WINDOW_S` (5 s) + slack of `created_at` — the drunk-mode undo
  generalized. A live drunk mood keeps the longer `MOOD_DRUNK_UNDO_WINDOW_S`
  window (and its push-hold). Outside the window → `409 undo_window_closed`.
- v0.8a (§1.57): `DELETE …/messages/:seq?undo=1` is the drunk-mode send-undo
  variant — same tombstone machinery, but `metadata` becomes
  `{"undone": true}` and clients render nothing (no "message deleted" stub).
  §1.57 has the window, preconditions and error codes.

### 1.31 Forwarding (v0.5a)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/messages/:seq/forward` | `{client_msg_id, target_conversation_ids: uuid[1..5]}` (`FORWARD_MAX_TARGETS`) | `201 {messages: Message[]}` in target order (`200` when every target was an idempotent replay). **All-or-nothing**: any invalid target fails the whole request with `404 not_found` — byte-identical for unknown ids, non-membership, channels I cannot post to, and block-frozen DMs (§1.14: the 404 confirms nothing). Source must be visible (§1.5 floor), not tombstoned, and type in `FORWARDABLE_MESSAGE_TYPES` (`text\|image\|video\|file\|audio`) else `400 not_forwardable`. |

**Semantics (binding):**

- Each target gets a **new ordinary message**: `sender_id` = **the
  forwarder** — forwarding never spoofs authorship — with
  `metadata.forwarded_from = {username, display_name}`, a **snapshot of the
  original author** at forward time (survives renames and account deletion;
  deliberately not a UserLite — no avatar reach into conversations the
  original author never joined). Forwarding a forward **preserves the original
  `forwarded_from`** — attribution sticks to the source.
- `body` and `link_preview` snapshot are copied; `metadata.doodle` is copied
  (the frame is part of the drawing). **Not copied:** `mentions` (a forward
  must never re-ping or newly ping anyone), `effect`, reply refs, vibe/game/
  capsule riders.
- **Attachments are re-referenced, never re-uploaded:** each forward creates
  new attachment rows pointing at the **same content-hashed MinIO objects**.
  Consequence (binding, repo-wide): every object deletion — tombstones,
  story expiry, orphan GC — first checks no other attachment row references
  the same `original_key`/`thumb_key` (**the refcount guard**, one indexed
  lookup via `attachments_original_key_idx`).
- The shared `client_msg_id` rides each created message; the existing
  per-conversation idempotency index (`conversation_id, sender_id,
  client_msg_id`) makes retries replay-safe **per target**, so a partially
  delivered retry completes the remainder without duplicating.
- Normal §1.5 transaction per target (seq bump, watermark raise, `msg.new`
  fan-out, push with the usual §2.9 guards).

### 1.32 Pins (v0.5a)

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/pins` | `{seq}` | `204` — idempotent re-pin. Permission: DM → any active participant; group → admin; channel → owner/admin (`403 forbidden`). Target must be visible (§1.5 floor) and not tombstoned → `404 not_found`. The 11th pin → `409 pin_limit` (`MAX_PINS` = 10; checked under the conversation row lock). |
| `DELETE /api/conversations/:id/pins/:seq` | — | `204` — idempotent; same permission rule. |

Pins ride the Conversation DTO (`pins: [{seq, pinned_by, created_at}]`,
`created_at ASC` — a stable board, not a feed) and every effective change fans
out `conv.updated`. Tombstoning a pinned message (§1.30 delete or §1.25 sweep)
removes its pin in the same transaction (+ `conv.updated`). Clients render the
pin board from local history by seq (missing ones are one §1.5 page away).

### 1.33 @Mentions (v0.5a)

The **server** parses `@username` tokens in `body` at send time (and §1.30
edit time) against the conversation's **active participants**; matches are
stored as `metadata.mentions: user_id[]` (first `MENTIONS_PER_MESSAGE_MAX` =
20; later tokens stay plain text — never an error). Client-sent `mentions`
values are ignored: the server is the only writer, so a mention always names a
real participant. Non-participants can never be mentioned — their `@token`
stays inert text.

**Push rule (binding):** a mention **overrides `muted_until`** for the
mentioned participant — the §2.9 mute guard is skipped for them (all other
guards hold: online, read-elsewhere, debounce). A mention **NEVER overrides a
block**: blocked pairs are structurally excluded from push (§1.14), and a
mention changes nothing about that. Mentions of users in a shared group across
a block are stored (group function, §1.14) but deliver no push and no special
rendering to the blocked party. Push copy for a mention leads with the sender
(`"maya mentioned you"`), same payload shape otherwise.

**UI autocomplete contract (binding):** typing `@` in the composer opens a
participant picker filtered by username/display-name prefix — sourced from the
participants the client already holds (DMs/groups); in channels (where the
full list is not shipped, §1.35) the composer queries
`GET .../participants?q=` — senders there are owner/admins, who may read the
list. Selecting inserts the literal `@username` token; mention highlighting in
bubbles is keyed on `metadata.mentions` (never re-parsed client-side).

### 1.34 Stories (v0.5a — FEATURES #46, ADR-011)

24-hour ephemera for the **friends-of** audience (§1.28), riding the §1.6
upload pipeline end to end. A story is one attachment + a caption. Audience is
CHECK-pinned to `'friends_of'` (one value today; the column exists so the enum
can widen without a migration of meaning). Blocked pairs are invisible both
directions on every story surface.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/stories` | `{attachment_id, caption? ≤ 140}` | `201 {story}` — attachment must be mine, kind `image\|video`, unbound → `400 bad_attachment`. `expires_at = created_at + 24 h` (`STORY_TTL_S`, fixed). Fans `story.new` **to the audience only** (friends-of minus blocks — never to anyone who cannot view it). **No push** (ambient, user-pulled; PSYCHOLOGY §6). Rate **20/hour/user** (`STORY_CREATE_RATE_PER_HOUR`). |
| `GET /api/stories` | — | `200 {mine: Story[], groups: StoryAuthorGroup[]}` — unexpired stories of my friends-of set (minus blocks), **grouped by author: authors with any unviewed story first, then all-viewed; each bucket ordered by username** — no recency ranking, a finite tray, not a feed. Within an author: `created_at ASC` (watch in order). `viewed` is viewer-specific. **Never auto-advance between authors** (PSYCHOLOGY never-build list: no infinite/auto-advancing stories) — advancing is a tap. |
| `POST /api/stories/:id/view` | — | `204` — idempotent; records `(story_id, me)`. Author's own views are never recorded. `404 story_not_found` (unknown, expired, not in audience, or blocked — identical). |
| `GET /api/stories/:id/views` | — | `200 {viewers: UserLite[]}` — **author only**, else `404 story_not_found` (author-privacy is 404-shaped). Faces ordered **by username — no timestamps anywhere** (the `story_views` table stores none: the DB cannot leak what it does not store; §1.18 seen-by pattern, FEATURES #27). Viewers with me blocked are omitted. There is **no view count** — the list is the information. |
| `DELETE /api/stories/:id` | — | `204` — own stories only (`404` otherwise). Deletes views (cascade) + the attachment (row + objects, refcount-guarded §1.31). |
| `POST /api/stories/recap` | `{conversation_id, seq, attachment_id, caption?}` | `201 {story}` — **afterglow integration**: `seq` must be an afterglow recap system message (§1.15) in a plan conversation I am an active participant of, and `attachment_id` one of its `metadata.afterglow.photo_attachment_ids` → else `404 not_found`. The server **re-references** the photo (new attachment row, same objects — §1.31 rule). Recap photos leave the plan group only through a participant's own deliberate share (PSYCHOLOGY rule 2); the story shows to **my** friends-of like any other. |

**Expiry (worker queue `timers`, repeatable every `STORY_SWEEP_INTERVAL_S`):**
expired stories are **hard-deleted** — story + view rows, attachment rows, and
MinIO objects (refcount-guarded). No fan-out, no "story expired" event:
expired stories simply drop out of the next `GET` (clients also drop them at
`expires_at` locally). Stories never touch the seq log.

There are **no story replies** in v0.5a (a future reply is just a DM — seam,
not scope), no reactions, no resharing, and no "X is watching" signals.

### 1.35 Channels (v0.5a — FEATURES #46, ADR-011)

`conversations.type` gains `'channel'`: broadcast conversations where **only
the owner and admins send** and everyone reads and reacts. The creator is
`role='owner'` (one per channel, never in DMs/groups). Cap: **`CHANNEL_MAX` =
10 000** participants — safe because receipts are **watermark cursors**: one
row per member, O(participants), never O(messages × participants)
(ARCHITECTURE §1, ADR-002: "the one model that survives Phase-2 channels").
Groups keep the 256 cap.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations` | `{type:'channel', title}` | `201 {conversation}` — creator = `owner`; a channel starts with one member. No `user_ids`: **membership arrives through §1.11 invites** (an invite with a channel `conversation_id`; minting is owner/admin-only, mirroring the group rule). Invite accept at the cap → `400 channel_full`. |
| `PUT /api/conversations/:id/participants/:userId/role` | `{role: 'admin'\|'member'}` | `200 {conversation}` + `conv.updated`. Channels: **owner only**; groups: any admin. `'owner'` is never assignable, the owner's own role never changeable → `400 bad_role_target`. |
| `GET /api/conversations/:id/participants?cursor=&limit=&q=` | — | `200 {participants, next_cursor}` ordered by username; `q` = username/display-name prefix filter (powers §1.33 autocomplete). Channels: **owner/admin only** (`403 forbidden`); groups: any active participant. Blocked users are serialized normally here (membership is group function, §1.14) — but presence/typing/last-seen between blocked pairs stay suppressed. |
| `DELETE /api/conversations/:id/participants/:userId` | (§1.4, extended) | self = leave (**anyone leaves freely, including admins**); owner/admins remove members; admins are removable by the owner only. The **owner cannot leave or be removed** → `403 owner_cannot_leave` (transfer is future scope — the channel must never be headless; the owner's way out is `DELETE /api/conversations/:id`, §1.4). |

**Channel rules (binding):**

- **Sends:** `POST .../messages` (and §1.17 polls, §1.31 forwards into the
  channel) require `owner`/`admin` → else `403 channel_read_only`. §1.12/§1.19
  reactions and stamps are open to **every** participant. §1.27 games are not
  startable in channels (`400 bad_opponent` territory — challenges need peers,
  not audiences).
- **History floor:** joiners get the standard `join_seq = last_seq` (§1.4,
  ARCHITECTURE §8) — a channel shows what happened since you joined; the
  invite page carries the pitch.
- **Receipts:** watermarks advance normally and drive `unread_count`, but
  **there is no seen-by exposure in channels**: `GET .../receipts` (§1.18) →
  `403 channel_no_receipts`; no sender ticks are derivable or rendered
  (min-watermark math over 10k members is neither cheap nor wanted). `receipt`
  WS frames for a channel go to the **reader's own sockets only** (cross-device
  unread sync) — never fanned to 10k members per read.
- **Typing:** suppressed entirely — inbound `typing` frames for channels are
  dropped at the gateway (§2.11), whatever the sender's `show_typing`.
- **No member counts, anywhere** — DTO, invite page, UI (PSYCHOLOGY rule 3:
  no follower counts). The Conversation DTO serializes `participants` as the
  viewer's own row + owner + admins only; the full list is the paged read
  above.
- **Push:** normal §2.9 guards per member (mute, read-elsewhere, debounce);
  §1.33 mentions override mute here like anywhere. The 10k fan-out is the
  worker's job, one debounced job per (user, conversation, message) as always.
- **Blocks:** §1.14 group semantics apply (both stay, messages keep working);
  a member with the owner blocked simply never sees presence/typing/§1.18
  surfaces of them — message delivery is channel function.

### 1.36 Feed (v0.5a — FEATURES #46, ADR-011)

Posts by **my friends-of set + me** (§1.28), newest first, **finite**: the
feed pages to a hard end and says so. No ranking, no recommendations, no
resharing, no wraparound — a visit has a bottom (PSYCHOLOGY design rule 5,
Verduyn 2015). Blocked pairs are invisible in both directions on every feed
surface (posts, reactor faces, comments).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/posts` | `{body? ≤ 2000, attachment_ids? ≤ 4}` — at least one of the two → else `400 empty_post`; attachments mine, unbound, any kind but `file` → `400 bad_attachment` | `201 {post}`. Audience is always `friends_of` (CHECK-pinned). Fans `post.new` **to the audience only**; **no push** (the feed is pulled, never pushed). Rate **10/hour/user** (`POST_CREATE_RATE_PER_HOUR`). |
| `DELETE /api/posts/:id` | — | `204` — author only (`404` otherwise). Reactions/comments cascade; attachments deleted (refcount-guarded §1.31). |
| `GET /api/feed?cursor=&limit=` | — | `200 {posts, next_cursor, all_caught_up}` — `created_at DESC`, keyset cursor (opaque `(created_at, id)`). **Terminal page: `next_cursor: null`, `all_caught_up: true`** — the client renders the hard "you're all caught up" end card and STOPS (no refetch-on-scroll past the end, no pull-to-refresh loop — new content arrives via `post.new` or the next visit). |
| `GET /api/posts/:id` | — | `200 {post}` — the single-post refetch (reaction/comment reconcile). `404 not_found` (unknown, not in audience, or blocked — identical). |
| `POST /api/posts/:id/reactions` | `{emoji ≤ 16}` | `204` — idempotent (§1.12 semantics). 9th distinct emoji → `409 reaction_limit` (`REACTIONS_PER_USER_PER_POST_MAX` = 8). Post must be visible → `404`. |
| `DELETE /api/posts/:id/reactions/:emoji` | `:emoji` URL-encoded | `204` — idempotent. |
| `POST /api/posts/:id/comments` | `{body: 1..500}` | `201 {comment}` — any viewer of the post. |
| `DELETE /api/posts/:id/comments/:commentId` | — | `204` — comment author or post author (`404` otherwise). Hard delete (comments are not on the seq log). |
| `GET /api/posts/:id/comments?cursor=&limit=` | — | `200 {comments, next_cursor}` — `created_at ASC` (a conversation reads downward). |

**Faces, never counters (binding):** `Post.reactions` carries, per emoji, the
first `POST_REACTORS_PREVIEW_MAX` (12) reactors as `UserLite` + `has_more` —
**no numeric total exists in any payload** (PSYCHOLOGY rule 3; Sherman 2016).
Comments inline as the latest `POST_COMMENTS_PREVIEW_MAX` (3, ASC) +
`has_more_comments` — **no comment count either**. Reactions and comments do
**not** fan out live frames: viewers reconcile from `GET` when **they** return
(no approval pings, rule 4); the author sees new reactions/comments the same
way — by looking. Every card leads with reply/plan actions (rule 5:
interaction-first).

### 1.37 Rich profiles (v0.5a — FEATURES #47)

Profile depth rides the **profile page**, not the participant DTOs:
`UserPublic` stays lean (it is embedded in every participant list), and
`GET /api/users/:username` grows a `profile` sibling. All §1.14 rules hold:
blocked viewers get `404 not_found` for the whole page, both directions.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/:username` | — | `200 {user: UserPublic, profile: Profile}` (additive change) — `profile = {interests ≤ 10 tags ≤ 24 chars, entries ≤ 12 (order_idx ASC), media ≤ 3 Attachments (the GIF strip, order_idx ASC)}`. |
| `GET /api/users/me/profile` | — | `200 {profile}` (the settings screen's read). |
| `PATCH /api/users/me/profile` | `{interests?, entries?: [{kind:'work'\|'skill', title ≤ 80, detail? ≤ 160}] ≤ 12, media_attachment_ids? ≤ 3}` | `200 {profile}` — **full replace per present field** (one transaction: delete + insert, `order_idx` = array order; omitted fields untouched). Media attachments must be mine, kind `image`, `ready` → `400 bad_attachment`; replaced media unbinds (orphan GC reaps rows; objects refcount-guarded). Fans `user.updated` to conversation peers only when `display_name`-level identity changes — profile edits themselves fan nothing (profiles are pulled). |

**Rendering contract:** the 3-GIF strip renders animated WebP under the §5
motion rules (`prefers-reduced-motion` + the owner's `avatar_motion` does NOT
apply — it is the **viewer's** settings that gate animation, as with every
avatar surface) with static thumbs otherwise; interests are plain chips —
tapping one is a future discovery seam, not a link in v0.5a. Work/skill
entries render as a two-section list in `order_idx` order. No endorsement
counts, no connection counts, no profile view counters — a profile is a page
about a person, not a scoreboard (PSYCHOLOGY rule 3).

### 1.38 Local board — listings (v0.5b — ADR-012, FEATURES #39–#43, #45)

ONE listing system, four card kinds (`gig` / `ride` / `room` /
`place_review`), all area-tagged, all with expiry, all answered with "Message
me" (§1.39). Per-kind payloads live in the `details` jsonb column validated by
the shared Zod discriminated union (§0) — the house metadata pattern. Plan
beacons join the board's "Local" tab **client-side** (FEATURES #43): they keep
their own table, API and FoMO rules; nothing here duplicates them.

**Hard product rules (binding):**

- **No payments.** `price_text` / `monthly_price_text` are display strings —
  never parsed, never summed, never charged; money settles outside the app.
  No payment machinery of any kind exists (FEATURES #45).
- **Safety note.** gig/ride/room detail views render `LISTING_SAFETY_NOTE`
  verbatim (`LISTING_SAFETY_NOTE_KINDS`): meet in public, verify before you
  pay, the app does not vet listings. It rides the card where the money talk
  happens, not a settings page.
- **The board is PULL-BASED — no WS events, no push, deliberately.** A listing
  is a standing offer, not an interruption: pushing "new gig near you" is an
  app-pushed nudge (PSYCHOLOGY design rule 4, user-pulled not app-pushed) and
  advertising cards a viewer may not want manufactures the ambient
  FoMO/obligation rule 2 exists to kill. Clients see new cards when **they**
  open the board. (Contrast: a beacon pushes because it is a live, expiring
  invitation addressed to people who can join.)

**Visibility (resolved at read time, like beacon audiences):** a listing is
visible to viewer V iff `listing.area = V.area` (citext equality; `area` is
the author's snapshot at mint) **or** `is_public`, always **minus §1.14
blocks both ways** (author⊥viewer blocked ⇒ the listing does not exist for V,
and V's listings do not exist for the author). Banned authors' listings are
hidden everywhere (§1.41). Direct `GET` of an invisible listing →
`404 listing_not_found` (blocks confirm nothing).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/listings` | `{kind, title ≤80, body? ≤2000, price_text? ≤40, area?, is_public? (default false), details: <per kind>}` — `area` defaults to my `users.area`; neither → `400 area_required` (the §1.15 rule). `details.attachment_ids` (≤6, **every kind** — v1.0a #91): mine, kind `image`, unbound → else `400 bad_attachment`; they bind via `attachments.listing_id` (orphan-GC shield, the `post_id` pattern). Ride `details.departs_at` must be in the future → `400 departs_at_past`. | `201 {listing}`. `expires_at`: gig/room `created_at + 30d` (`LISTING_TTL_S`); ride = `departs_at` (copied to the column at write time — sweeps and board reads never parse jsonb); place_review `null`. `409 listing_limit` past **10 simultaneously active** per author (`LISTING_ACTIVE_MAX_PER_USER`). Rate **10/hour/user** (`LISTING_CREATE_RATE_PER_HOUR`) → `429`. No fan-out. |
| `GET /api/listings?kind=&area=&q=&cursor=&limit=` | `area` defaults to **mine** (no `area` param and no `users.area` → public listings only); a foreign `area` filter shows only that area's `is_public` cards — the visibility rule binds whatever the filter says. `q` = ILIKE substring over `title` + `details->>'place_name'` (≤80 chars, `LISTING_SEARCH_MAX_CHARS`). | `200 {listings, next_cursor}` — `active` and unexpired only (`expires_at > now()` filtered live), `created_at DESC`, keyset cursor. Blocked pairs excluded both ways. |
| `GET /api/listings/mine` | — | `200 {listings}` — my listings, every status, `created_at DESC` (the management list; capped at 100, no cursor). |
| `GET /api/listings/:id` | — | `200 {listing}`. `404 listing_not_found` (unknown, not visible, or blocked — identical). Closed/expired listings stay readable by their author and by anyone who contacted them (the DM context must stay explicable); invisible to everyone else. |
| `POST /api/listings/:id/close` | — (author only) | `200 {listing}` status `closed` — idempotent re-close `200`. `403 forbidden` (not author). Cards retire silently from the board. |
| `DELETE /api/listings/:id` | — (author only) | `204` — hard delete (contacts cascade; room-photo attachments unbind to orphan GC, objects refcount-guarded §1.31). **Person reviews written through this listing survive** (`listing_id` goes null; `listing_kind` snapshot keeps them rendering — §1.40). `404 not_found` if not mine. |

**Expiry sweep (worker queue `timers`, repeatable every
`LISTING_SWEEP_INTERVAL_S` = 1 h):** `UPDATE listings SET status='expired'
WHERE status='active' AND expires_at <= now()` — bookkeeping only, since reads
filter `expires_at` live; no fan-out, no notification. Expired and closed
cards simply stop appearing (nothing "expired on you" is ever pushed —
unsparked-beacon semantics, §1.15).

### 1.39 Message-the-author & gig team-up (v0.5b — ADR-012)

**Contact — the board's only call to action.** `POST /api/listings/:id/contact`
reuses the §1.4 DM path verbatim (`dm_key` create-or-dedupe) and drops **one**
`system` message in the DM as context: `metadata.system = {event:
'listing_contact', actor_id: <contacter>}`, `metadata.listing_ref =
{listing_id, kind, title}` (a **snapshot**, the `forwarded_from` pattern —
the message keeps rendering after the listing closes, expires or is deleted),
body `asked about: <title>`. The same transaction records the
`listing_contacts (listing_id, user_id, conversation_id)` row — the
idempotency key, the author's team-up pick pool, and **the §1.40 review gate**.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/listings/:id/contact` | — | `201 {conversation_id}` (`200` idempotent re-contact: the existing DM, **no** second system message, no new row). `400 listing_own` (my own listing), `404 listing_not_found` (unknown/invisible/blocked — identical; a frozen DM between blocked parties never gets this far because the listing is already invisible), `410 listing_closed` (closed/expired). Rate **20/hour/user** (`LISTING_CONTACT_RATE_PER_HOUR`). Fan-out: ordinary `conv.new`/`msg.new` of the DM machinery — nothing board-specific. |
| `GET /api/listings/:id/contacts` | — (**author only**) | `200 {contacts: UserLite[]}` — everyone who contacted, username order (the team-up picker read). `404 not_found` if not mine. Contacters blocked w.r.t. the author since contacting are omitted. |
| `POST /api/listings/:id/team-up` | `{user_ids: uuid[1..7]}` (`TEAM_UP_MAX_PICKS`) — **author only, kind `gig` only** | `201 {conversation}` — a `group` conversation named after the listing title, creator `admin`, picked members `member` with `join_seq = 0` (founding members see the whole plan — the §1.15 spark semantics), kickoff `system` message `metadata.system = {event:'team_up', actor_id}` + `metadata.listing_ref`. `400 not_a_gig`, `400 bad_team_pick` (any id not in the contact pool), `403 group_add_denied` (any target's §1.13 `group_add_policy` or a §1.14 block — byte-identical, confirms nothing; all-or-nothing like §1.4), `409 team_up_exists` (one team-up per listing — claimed via the guarded `UPDATE listings SET conversation_id=$c WHERE id=$1 AND conversation_id IS NULL`, the invite/spark pattern). Fan-out: the §1.4 group-create machinery verbatim (`conv.new` to members, push per §2.9). |

`Listing.conversation_id` serializes **only** to the author and picked members
(everyone else always reads `null` — the §1.15 sparked-beacon rule: never show
people a room they are not in).

### 1.40 Person reviews — marketplace trust (v0.5b — ADR-012, FEATURES #44)

Trust stars for **marketplace transactions**: after a listing contact, each
party may review **the other party, once per listing**. This is the one place
in the product a number attaches to a person, and ADR-012 documents why it is
not a PSYCHOLOGY rule-3 violation: the average is **safety information for a
stranger deciding whether to get in your car** — the same class of signal as
the §1.14 safety bundle — not social approval. The structural guardrails:
reviews exist only behind a real contact (no drive-by rating), the average
hides below 3 reviews (`TRUST_AVG_MIN_REVIEWS` — one angry star must not read
as a verdict), it renders **only on the profile trust panel**, and nothing
anywhere ranks, sorts, compares or leaderboards people by rating.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/listings/:id/reviews` | `{subject_id?, rating: 1..5, body? ≤500}` — `subject_id` **required when I am the listing's author** (names which contacter I'm reviewing, must be in the contact pool); otherwise it must be omitted (or equal the author) — the subject is the author → else `400 bad_subject` | `201 {review}`. **Gate:** a `listing_contacts` row must tie me and the subject to this listing — `{reviewer, subject} = {author, contacter}`, one reviewing the OTHER → else `403 review_not_eligible`. `409 review_exists` (once per `(listing, reviewer)` — DB unique). `404 listing_not_found` (unknown/blocked — §1.14 shape; **blocked pairs cannot review**, both directions). Closed/expired listings stay reviewable (transactions finish after cards retire); a deleted listing does not (the gate row is gone). Rate **10/hour/user** (`PERSON_REVIEW_RATE_PER_HOUR`). No fan-out, no push — the subject discovers reviews on their own profile (no approval/disapproval pings, PSYCHOLOGY rule 4). |
| `GET /api/users/:username/reviews?cursor=&limit=` | — | `200 {reviews: PersonReview[], next_cursor}` — reviews **about** that user, `created_at DESC`. `404 not_found` for blocked pairs, both directions (the §1.14 profile rule). Rows by reviewers blocked w.r.t. the **viewer** are omitted from the list (count/avg stay computed over all — serialization-time filtering, §2.11 doctrine). |

**Profile integration:** `GET /api/users/:username` (§1.37) gains a `trust`
sibling: `{review_count, avg_rating, recent}` — `avg_rating` rounded to 1
decimal (`TRUST_AVG_DECIMALS`), null under 3 reviews; `recent` = the newest
≤ 5 (`TRUST_RECENT_REVIEWS_MAX`). `listing_kind` on each review is a snapshot —
reviews survive their listing (ADR-012). The trust panel is part of the
profile page; the §1.14 blocked-pair 404 covers it wholesale.

### 1.41 Admin (v0.5b — ADR-013, FEATURES #54)

The operator surface. **Adminhood** is flipped by `docker compose exec api
node dist/cli.js grant-admin <username>` / `revoke-admin <username>` **or**,
since the ADR-013 amendment (2026-10-18), by an admin from the web
(`grant-admin` / `revoke-admin` below). The CLI stays the root of trust: it is
the only way to revoke yourself or the last admin. All `/api/admin/*` routes
require `is_admin` **and** a non-suspended, non-banned account; for everyone
else they answer `404 not_found` — the admin surface does not exist for
non-admins (the §1.14 shape). **Every admin action appends to the log ring.**
Suspend/ban/password mutations targeting an admin account (including
yourself) → `400 bad_admin_target` — remove the admin role first.

**Binding boundary: admin routes NEVER expose private message content.** A
reported message serializes who/where/when/what-kind — never its body; the
reporter's own `reason` text is where quoted content lives (it is the
reporter's submission, not a counterparty's private words). The user export
excludes message bodies for the same reason (see below; ADR-013).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/admin/users?q=&cursor=&limit=` | `q` = username/display-name prefix ILIKE | `200 {users: AdminUserRow[], next_cursor}` — `created_at DESC`. `last_seen_bucket` is coarse (`LAST_SEEN_BUCKETS`) — the operator needs liveness, not a surveillance feed; `registration_ip`/`last_session.ip` go null as the retention GC ages them out; `storage_bytes` = sum of the user's uploads. |
| `POST /api/admin/users/:id/suspend` | `{note? ≤500}` | `200 {user: AdminUserRow}` — sets `suspended_at`, **revokes all sessions** (rows deleted) and **closes all live sockets `4401`**; login thereafter → `403 account_suspended`. Idempotent re-suspend `200`. `400 bad_admin_target`. |
| `POST /api/admin/users/:id/unsuspend` | `{note? ≤500}` | `200 {user}` — clears `suspended_at`. Idempotent. |
| `POST /api/admin/users/:id/ban` | `{note? ≤500}` | `200 {user}` — everything suspend does (sessions revoked, sockets `4401`, login → `403 account_banned`), **plus public invisibility**: profile `404`, listings/stories/posts hidden, excluded from search, beacon audiences and story/post/feed reads — enforced at serialization/fan-out time like every §1.13/§1.14 rule (nothing stored is rewritten; unban restores instantly). Conversation history and membership survive (messages are group function — the §1.14 principle; the ban stops the account, not the archive). |
| `POST /api/admin/users/:id/unban` | `{note? ≤500}` | `200 {user}` — clears `banned_at` (and the invisibility with it). |
| `POST /api/admin/users/:id/grant-admin` | `{note? ≤500}` | `200 {user}` — sets `is_admin` (ADR-013 amendment). `400 target_disabled` when the target is suspended or banned (lift the flag first). Idempotent. Ring: `admin.grant_admin`. |
| `POST /api/admin/users/:id/revoke-admin` | `{note? ≤500}` | `200 {user}` — clears `is_admin`. `400 self_target` for your own account (the instance cannot decapitate itself from the web; use the CLI). Idempotent. Ring: `admin.revoke_admin`. |
| `POST /api/admin/users/:id/password` | `{new_password ≥ PASSWORD_MIN_LENGTH}` | `200 {user}` — the web counterpart of `cli.js reset-password` with an operator-chosen password: argon2 (register params), **all sessions revoked** (rows deleted, sockets `4401`); the user logs in with the new password at once. `400 bad_admin_target` for admin targets (admins change their own in Settings). Ring: `admin.password_set` — **the password never reaches the ring or any log**. |
| `GET /api/admin/reports?status=&cursor=&limit=` | `status` `open`\|`closed`, omitted = both | `200 {reports: AdminReport[], next_cursor}` — open first, then `created_at DESC`; each row joins reporter + the **metadata-only** target preview (§0 `AdminReport`). Reports outlive their targets (v0.3 design) — previews go null where the target is gone. |
| `POST /api/admin/reports/:id/close` | `{note? ≤500}` | `200 {report}` — sets `closed_at`/`closed_by`/`close_note`. `409 report_closed` on re-close. |
| `GET /api/admin/metrics` | — | `200 {metrics: AdminMetrics}` — 30-day series (`ADMIN_METRICS_WINDOW_DAYS`): registrations/day, **DAU proxy** (distinct users whose sessions were seen that day — sliding sessions make this approximate; documented honesty, not precision), messages/day; plus totals: users, open beacons, active listings, open reports, storage bytes. |
| `GET /api/admin/logs?offset=&limit=` | — | `200 {entries: AdminLogEntry[], next_offset}` — the **log ring**: pino `warn`+`error` entries from api and worker, plus every admin action (`level: 'admin'`, always written), LPUSHed to a capped Redis list (`LPUSH` + `LTRIM`, `LOG_RING_MAX` = 1000). Newest first, offset-paged (a ring has no stable cursors); `next_offset: null` = whole ring read. Telemetry, not product data: it lives in Redis on purpose (ADR-013). |
| `GET /api/admin/settings` | — | `200 {settings: InstanceSettings}` |
| `PATCH /api/admin/settings` | `{invites_enabled?, release_notes?}` (v0.8a §1.61 adds `release_notes` — curation of the what's-new list; migrations remain the normal writer) | `200 {settings}`. `invites_enabled: false` → `POST /api/invites` and `POST /api/invites/:token/accept` answer `403 invites_disabled` (no `use_count` claim); register-with-token degrades to `invite: null` (§1.1); `GET /:token/public` still renders (the join page explains on accept). Ring-logged. |
| `GET /api/admin/users/:id/export` | — | `200 {export: AdminUserExport}` — JSON of the user's **own rows**: the users row (profile + settings columns), sessions **metadata**, listings, posts, reviews received. Secrets stripped (`password_hash`, session `token_hash`, push keys). **NOT their messages**: a member's conversations contain their counterparties' words, and bulk operator access to those is exactly what this product promises not to build — the export is operator tooling (backups, disputes, deletion requests), not a wiretap (ADR-013 documents the line; a user-initiated takeout of their own message history is future user-facing scope, not an admin surface). |

**Sessions & IP capture.** `sessions.ip` + `sessions.user_agent` (columns
since v0.1) are captured at login and register; registration additionally
stamps `users.registration_ip`. **Retention:** the nightly GC job (queue `gc`)
nulls `users.registration_ip` and `sessions.ip` older than
`IP_RETENTION_DAYS` (90, counted from the row's `created_at`) — the window is
documented in the instance's privacy note (FEATURES #54). The admin UI shows
whatever has not yet aged out, never more.

**Suspension semantics, spelled out:** suspend/ban take effect immediately —
session rows deleted (the §1.1 revocation machinery: live sockets close
`4401`), subsequent logins `403 account_suspended` / `403 account_banned`,
password reset via CLI does not lift either flag. Suspended (not banned)
users remain **publicly visible** (profiles, old listings) — suspension stops
the account, not its record; ban hides the public surfaces too (§0 table
above). Neither deletes anything.

### 1.42 Calls (v0.6 — ADR-014, FEATURES #49–#50)

1:1 and group voice/video. **The split is the house rule taken literally:**
REST writes the durable call LOG (the `calls` row — who called whom, when,
how it ended) and mints TURN credentials; everything live is ephemeral —
WebRTC media flows peer-to-peer (mesh), signaling rides the existing WS
gateway as relayed frames that are **never persisted** (§2.12), and the
in-call member set lives in Redis (`call:{id}:members`, deleted on any
terminal status). Group calls are **mesh**, hard-capped at `CALL_MESH_MAX=8`
in-call participants — the LiveKit SFU upgrade seam for bigger rooms is
documented in ADR-014, deliberately not built. Calls exist for `dm` and
`group` conversations only (`channel` → `400 call_bad_conversation`); a
group's conversation may hold up to 256 members — the cap bounds who is *in
the call*, not who may be invited to join it. Every surface respects §1.14
blocks (a frozen DM cannot be called into — `404 not_found`, the §1.14
shape), suspension/ban (no sockets, no push, excluded from fan-out) and the
existing push guards (§2.9).

**Status machine** (every durable transition fans out `call.updated`):
`ringing → ongoing` (first join) · `ringing → rejected` (DM callee reject) ·
`ringing → missed` (ring timeout `CALL_RING_TIMEOUT_S=45` via a delayed
`timers` job + `calls_ringing_idx` safety sweep, or the initiator hanging up
before an answer) · `ongoing → completed` (last member leaves, or an end) ·
`ongoing → failed` (end with `reason:'failed'` — media never (re)connected).
One live call per conversation, enforced by the partial unique index
`calls_live_idx` (the dm_key pattern).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/conversations/:id/calls` | `{kind: 'audio'\|'video'}` | `201 {call, turn}` — inserts the row (`status:'ringing'`, `is_group` snapshotted from the conversation type), adds the initiator to the Redis member set, schedules the ring-timeout job, and returns coturn credentials inline (`turn: null` when no `TURN_SECRET` is configured — local dev connects on host candidates). The initiator then sends the WS `call.invite` frame (§2.12). Must be an active participant; frozen DM (blocked pair) → `404 not_found`; `channel` → `400 call_bad_conversation`; 👻 ghost group (§1.68 — masks never ring) → `400 call_bad_conversation`; a live call already exists → `409 call_active` (join it instead). Rate **20/hour/user** (`CONVERSATION_CREATE_RATE_PER_HOUR` style fixed window). |
| `POST /api/calls/:id/join` | — | `200 {call, turn}` — the DM **accept** and the group **join** are the same durable transition. First join: guarded `UPDATE … SET status='ongoing', answered_at=now() WHERE id=$1 AND status='ringing'`; later group joins require `status='ongoing'`. Adds me to the Redis member set via an atomic check-and-add (Lua): `SCARD ≥ CALL_MESH_MAX` → `409 call_full`, nothing added. `404 not_found` (not a participant of the conversation / blocked-pair DM), `410 call_ended` (terminal status). Idempotent re-join (already a member) → `200`, no event. Fans `call.updated`; the joiner then **offers to every existing member** (§2.12 mesh rule). |
| `POST /api/calls/:id/end` | `{reason?: 'completed'\|'failed'}` (default `completed`) | `200 {call}` — hang up. From `ringing`, initiator only: the call becomes `missed` (cancel-before-answer reads as missed for callees; missed-call machinery below runs). From `ongoing`: removes me from the member set; when ≤ 1 live member remains the call becomes `completed` (or `failed` iff `reason:'failed'` and **no** join other than the initiator ever answered media — client-reported, coherence-checked). Group members who leave without ending just stop being members (the WS `call.leave` frame is the instant signal; this REST call is the durable one). Idempotent on terminal calls → `200`. |
| `POST /api/calls/:id/reject` | — | `200 {call}` — **DM callee only**, while `ringing`: status `rejected`, `ended_at=now()`. No system message is posted (a decline is not an archive entry — the liking-gap rule; the caller's UI just stops). In groups, declining is personal and ephemeral: use the WS `call.reject` frame; the call keeps ringing for others → this endpoint answers `400 call_bad_reject` for group calls. |
| `GET /api/conversations/:id/calls?before=&limit=` | — | `200 {calls: Call[], next_cursor}` — the call log, `started_at DESC` (participants only; the §1.5 visibility floor does not apply — calls are conversation-level facts, but members who joined later still only see the conversation at all once they are participants). |
| `GET /api/turn-credentials?call_id=` | — | `200 {turn: TurnCredentials}` — **participant-gated**: the caller must be an active participant of the named call's conversation and the call must be live (`ringing`/`ongoing`), else `404 not_found`. Mints a fresh time-limited credential (`TURN_CRED_TTL_S=3600`): `username = "<unix now+3600>:<user_id>"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))` — coturn's static-auth-secret verification, no shared DB (ADR-014). `uris`: `stun:<DOMAIN>:3478`, `turn:<DOMAIN>:3478?transport=udp`, `turn:<DOMAIN>:3478?transport=tcp`. Long calls refresh before expiry and call `setConfiguration` on the peer connection. `503 turn_unconfigured` when the instance has no `TURN_SECRET`. |

**Missed-call machinery** (ring timeout and initiator cancel): in one
transaction the call flips to `missed`, and a **system message** is inserted
in the conversation — `metadata.system = {event:'call_missed', actor_id:
<initiator>}`, `metadata.call_ref = {call_id, kind, status:'missed',
duration_s: null}` (server-written snapshot) — so the missed call rides the
seq log, sync and unread counts like any message. Fan-out after commit:
`call.updated` + `msg.new`, and a **missed-call push** to every callee who
never joined, through the existing §2.9 guards unchanged (offline-only,
read-elsewhere suppression, `muted_until`, debounce; blocked pairs
structurally excluded). Push payload: `{title: caller or group title, body:
"Missed <audio|video> call", tag: conversation_id, data: {url: /c/:id}}`.

**v0.7.1 (§1.55, ADR-017)** adds the incoming-call **ring push** with
Answer/Decline actions (payloads in §2.9), the authed
`GET /api/call-selftest`, connection-state reporting (`call.state`, §2.12)
and automatic ICE restart. The `calls` row, status machine and every endpoint
above are unchanged.

### 1.43 Watch together (v0.6 — FEATURES #51)

YouTube co-watching in any conversation. **Ephemeral only — no table, no
REST:** the whole feature is three WS frame types (`watch.start`,
`watch.sync`, `watch.stop`, §2.12) plus one Redis key
`watch:{conversation_id}` holding `{video_id, host_id, position_s, playing}`
with `WATCH_SESSION_TTL_S=60`, refreshed by every host sync. One active
session per conversation (a second `watch.start` while one is live →
`error watch_active`). The **host** is whoever started the session; only host
`watch.sync` frames are honored (`error watch_not_host` otherwise) and
non-host clients follow — seek/pause locally snaps back on the next sync.
The video id is parsed **server-side** from the URL the host pastes
(`extractYoutubeVideoId` in `packages/shared/src/urls.ts`; bad URL →
`error watch_bad_url`). Host keepalive: a sync at least every
`WATCH_KEEPALIVE_S=15` even while paused — a vanished host ends the session
within the TTL, and any participant's `watch.stop` is accepted once the host
has no live socket. Participant-gated like typing; playback itself is the
YouTube IFrame embed client-side (same-origin CSP carve-out is the embed
iframe, no server fetch of YouTube ever happens).

### 1.44 Bored Together — discovery (v0.6 — ADR-015, FEATURES #52)

Opt-in stranger discovery, gated on the v0.3 safety bundle (blocks, reports,
privacy, suspension) being live. **Being discoverable is a moment, not a
setting:** an opt-in lives 60 minutes (`DISCOVERY_OPTIN_TTL_S`) and lapses
silently; there is no ambient "discoverable" state to forget about. This
surface is for **meeting** people: the existing friends-of set (accepted
connections ∪ DM partners, §1.28) is excluded from cards, waves and roulette
— you cannot "discover" someone you already know.

| Method & path | Request | Response |
|---|---|---|
| `PUT /api/discovery/optin` | `{scope: 'area'\|'public', note?≤80}` | `200 {optin}` — upsert; `expires_at = now()+60min` (re-PUT extends/re-scopes). `400 area_required` when `scope:'area'` and my `area` is null. Suspended/banned accounts cannot opt in (session machinery already blocks them). |
| `DELETE /api/discovery/optin` | — | `204` — immediate: my card vanishes, my parked waves die with the opt-in (reads join live opt-ins). Idempotent. |
| `GET /api/discovery/optin` | — | `200 {optin: DiscoveryOptin\|null}` — my own state (null = not opted in / lapsed). |
| `GET /api/discovery/cards` | — | `200 {cards: DiscoveryCard[]}` — requires **my own live opt-in** (`403 discovery_not_opted_in`): visibility is symmetric — you are seen while you see, no lurking. Cards are users U with a live opt-in where **each reaches the other**: U's scope reaches me (`public`, or `area` matching my `area` by citext equality) AND my scope reaches U. Excluded both ways: §1.14 blocks, the friends-of set, suspended/banned, me. Newest opt-in first, ≤ `DISCOVERY_CARDS_MAX=50`, no cursor (the pool is who is bored *now*, not a backlog). Cards carry `UserLite` + note only — no last-seen, no area text; the client renders the **animated** avatar (§5 motion hygiene applies). |
| `POST /api/discovery/wave` | `{user_id}` | `200 {matched, conversation_id}`. Target must currently be a visible card for me (mutual reachability, live opt-ins) else `404 discovery_card_not_found` — unknown, lapsed, blocked and friends-of are all byte-identical. **Single wave: parked silently.** `matched:false`, the row sits in `discovery_waves`, and **nobody is notified** — no FoMO, no rejection surface, ever (ADR-015; the target's card for me shows my own `waved:true`, nothing shows on theirs). **Mutual wave** (the reciprocal row exists, both opt-ins live): in one transaction both wave rows are deleted and a DM is created (`metadata.origin = 'discovery'`) with a rotating **icebreaker system message** (`event:'discovery_matched'`, body = `DISCOVERY_ICEBREAKERS[hash(conversation_id) % len]`); `matched:true` + the id. Fan-out: `discovery.matched` WS to both (each frame stamped with the OTHER party) + ordinary `msg.new`; push to an offline party via §2.9 guards. Idempotent re-wave `200 {matched:false}` (no new row). Rate **30/hour/user** (`DISCOVERY_WAVE_RATE_PER_HOUR`). |
| `GET /api/discovery/encouragement` | — | `200 {sample_size, better_percent}` — the §1.45 aggregate ("N% said better than expected"), instance-wide across both contexts, anonymous by construction. `better_percent: null` under `ENCOURAGEMENT_MIN_SAMPLES=10`. **Client rule (binding):** shown only PRE-opt-in — it exists to calibrate stranger fear for the hesitant (PSYCHOLOGY finding #10), never as a post-hoc scoreboard. |

**Worker:** repeatable `discovery` sweep prunes lapsed opt-ins and waves older
than `DISCOVERY_OPTIN_TTL_S` (reads filter live either way — the sweep is
bookkeeping, the house pattern).

### 1.45 Bored Roulette & expectation feedback (v0.6 — ADR-015, FEATURES #52)

Random 1:1 matching with a built-in escape hatch: the match DM is
**provisional for 5 minutes** and is **hard-deleted** unless both people
choose to keep it — a dead-end chat with a stranger leaves no archive, no
guilt object, no block-management chore.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/roulette/join` | — | `200 {status:'queued'}` — requires a live discovery opt-in (`403 discovery_not_opted_in`). Adds me to the Redis queue (`roulette:queue`, entry TTL `ROULETTE_QUEUE_TTL_S=300` — a stale queue never matches someone who wandered off). Idempotent re-join refreshes the entry. |
| `DELETE /api/roulette/join` | — | `204` — leave the queue. Idempotent. |
| `POST /api/roulette/keep` | `{conversation_id}` | `200 {conversation, permanent}` — guarded UPDATE appending me to `metadata.roulette.kept_by` `WHERE expires_at > now()`. Both kept → in the same transaction `expires_at` is cleared, the roulette rider collapses to `{origin:'roulette'}`, a `roulette_kept` system message lands, and `conv.updated` fans out: `permanent:true`. One keep → `permanent:false`; **the other party's keep state is never serialized** (the DTO's `roulette.kept` is the viewer's own) — waiting carries no pressure surface. `404 not_found` (not mine / already deleted), `410 roulette_expired` (window lapsed; the sweep will delete it). |
| `POST /api/discovery/feedback` | `{context: 'roulette'\|'discovery', conversation_id, verdict: 'better'\|'same'\|'worse'}` | `204` — the **private** one-tap (PSYCHOLOGY finding #10). `conversation_id` is a dedupe key, not an FK (the conversation may already be hard-deleted); the caller must have been a party to it — for live conversations checked directly, for deleted ones against the match record in the Redis tombstone the sweep writes (`roulette:fb:{conversation_id}`, TTL 24 h, holding the two user ids). One row per `(user, conversation)` — repeat taps `204`, first verdict wins. Never notifies anyone; never appears on any profile; feeds only the §1.44 encouragement aggregate. |

**Pairing (worker, queue `discovery`, every `ROULETTE_PAIR_INTERVAL_S=10`):**
pops queued users whose opt-ins are still live and pairs them oldest-first,
skipping pairs that are blocked either way, in each other's friends-of set,
suspended/banned, **or that share any existing DM row** (`dm_key` exists —
also what makes the create below collision-free). For each pair, one
transaction creates a `dm` conversation with `metadata = {origin:'roulette',
roulette:{kept_by:[]}}` and `expires_at = now() + ROULETTE_WINDOW_S (5 min)`,
plus the rotating icebreaker system message (`event:'roulette_matched'`, body
from `DISCOVERY_ICEBREAKERS`). Fan-out: `roulette.matched {conversation}` to
both (viewer-stamped `roulette.kept:false`) — no push: both were in the queue
seconds ago.

**Expiry sweep (same queue, every `ROULETTE_SWEEP_INTERVAL_S=30`):**
conversations with `expires_at <= now()` (partial index
`conversations_expiry_idx`) are **hard-deleted** — messages, participants,
receipts cascade; nothing is tombstoned. Before the delete it writes the
24 h feedback tombstone (above) and fans `roulette.expired
{conversation_id}` to both parties' sockets; offline clients reconcile via
`GET /sync` (the conversation is simply absent, §2.8). The freed `dm_key`
means a future *organic* DM between the two is unaffected.

**Prompt rule (client, binding):** the one-tap feedback sheet shows exactly
once per match — on `roulette.expired`, on `permanent:true`, or when leaving
a `origin:'discovery'` DM for the first time. It is skippable and never
re-surfaces; there is no reminder, badge or nag (PSYCHOLOGY rule 4).

### 1.46 Rescue me (v0.6 — FEATURES #53)

One tap pings up to three friends to call you out of a boring situation.
Deliberately tiny: no new conversation kind, no acknowledgement state, no
"rescued" tracking — a rescue is a message plus an urgent push.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/rescue` | `{user_ids: string[] (1..3, RESCUE_MAX_TARGETS), note?≤80}` | `201 {rescues: [{user_id, conversation_id}]}` — each target must be in my **friends-of** set (§1.28) and not blocked either way; any bad id → `404 not_found` for the whole request (byte-identical whether unknown, stranger or blocked — the §1.14 shape). Per target: create-or-dedupe the DM (`dm_key`), insert a **rescue message** — `sender_id = me`, `type:'text'`, `body` = my note or `RESCUE_DEFAULT_BODY`, `metadata.rescue: true` (server-written; renders as the rescue card with a one-tap call-back that starts a §1.42 call) — ordinary `msg.new` fan-out. Rate: `RESCUE_MAX_PER_DAY=3` per UTC day (Redis fixed window) → `429` + `Retry-After`. |

**Rescue push (the one §2.9 exception, spelled out):** enqueued for **every**
target — even with a live socket (the point is a buzzing phone, not an unread
dot) — with the presence, read-elsewhere and debounce guards **skipped** and
`muted_until` **overridden** (the §1.33 mention precedent: an SOS from a
friend outranks a per-chat mute). Blocks remain structural — a blocked pair
can never reach this code path (the 404 above). Payload: `{title:
"<display_name> needs a rescue call 📞", body: note or '', tag:
conversation_id, data: {url: /c/<conversation_id>}}`.

### 1.47 Beacon editing, custom vibes, early spark & joiner notifications (v0.7 — ADR-016, FEATURES #60–#63)

Plans change; v0.7 lets the creator change the card instead of cancel-and-
repost (which would re-ping the audience and lose the joiner pile). Everything
here notifies **joiners only** — people who committed — never the wider
audience (PSYCHOLOGY rule 2: a change note is information for people in the
plan, an ad for everyone else).

**Custom vibes.** `vibe` gains the value `'custom'` (`BEACON_VIBE_VALUES`),
carried by `custom_vibe_emoji` (≤ 16 UTF-16 units) + `custom_vibe_label`
(≤ 24 chars, `BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS`) — both required together
(DB shape CHECK; `400 bad_custom_vibe` on a partial pair or custom fields on a
preset vibe). Recents are **client-side only** (localStorage, ≤
`BEACON_CUSTOM_VIBE_RECENTS_MAX` = 6) — never synced, never serialized.
`POST /api/beacons` accepts the two fields alongside `vibe: 'custom'`.

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/beacons/:id` | any subset of `{vibe (+custom_vibe_emoji/label), note, starts_at, expires_at, spark_threshold, location}` — omitted = unchanged; `location: null` clears | `200 {beacon}` — **creator only** (`403 forbidden`), **status `open` only** (`409 beacon_not_open` — sparked plans change in their group chat, not on the card). Window fields revalidate under the §1.15 rules (both must be sent together when either changes). A new `spark_threshold` must be `≥ max(BEACON_SPARK_THRESHOLD_MIN, current joiner count)` → else `400 threshold_below_joins`; **threshold = current count sparks the beacon inside the edit transaction** (the §1.15 row-locked spark path — lowering the bar to "whoever's here" is a legitimate way to start). Audience is **immutable** (`400 audience_immutable` — re-aiming a live invite is a new beacon). Every effective edit sets `edited_at`, fans `beacon.updated` with `edited: true` + `changed: [field names]` (§2.3) to the audience, and **pushes to current joiners only** ("<creator> changed the plan", §2.9 guards apply). Rate `BEACON_EDIT_RATE_PER_HOUR` (30) → `429`. |
| `POST /api/beacons/:id/spark-now` | — | `200 {beacon}` — **"start with whoever's here"**: creator only (`403 forbidden`), status `open` (`410 beacon_closed`), **≥ 1 non-creator joiner** (`409 beacon_no_joiners` — a plan needs at least two people). Runs the **existing §1.15 spark transaction verbatim** under the beacon row lock (group create with `join_seq = 0`, icebreaker, auto venue poll, guarded status flip, `beacons_sparked` bump, afterglow job): the threshold is simply not consulted. Fan-out and push are byte-identical to a threshold spark — joiners + creator get the room, the rest of the audience sees the card retire with `conversation_id: null`. |
| `GET /api/beacons/:id/joins` | — | `200 {joiners: UserLite[]}` — the **"Who's in" sheet** (FEATURES #60): the FULL joiner list in join order (the DTO pile caps at `BEACON_JOINERS_PREVIEW_MAX`). **Audience-gated like the beacon itself**: viewer must be the creator, a joiner, or in the audience of a still-visible beacon → else `404 beacon_not_found` (unknown/invisible/blocked identical, §1.14). Joiners blocked w.r.t. the viewer are omitted. Faces only — join timestamps are never serialized (§1.18 rule). Every face links to the §1.37 profile with Connect/Message (client); profile 404s for blocked pairs still apply there. |

**Joiner notifications (FEATURES #63) — push to joiners ONLY, through the
§2.9 guards unchanged (offline-only, read-elsewhere, mute, debounce; blocks
structural).** Four triggers:

- **sparked** — unchanged from §1.15 (joiners + creator get the room).
- **edited** — the PATCH above; payload `{title: beacon vibe/label, body:
  "<creator> changed the plan", tag: beacon:<id>, data: {url: /plans}}`.
- **cancelled** — `POST /api/beacons/:id/cancel` (§1.15) now additionally
  pushes to joiners (`"<creator> called it off"`); the **non-joiner audience
  still gets the silent card-retire**, exactly as before — commitment is what
  earns the notification.
- **starting soon** — the `beacons` worker sweep (every minute, walking
  `beacons_starting_soon_idx`) claims beacons whose `starts_at` is within
  `BEACON_STARTING_SOON_LEAD_S` (30 min) via the guarded `UPDATE beacons SET
  starting_soon_pinged_at = now() WHERE id=$1 AND starting_soon_pinged_at IS
  NULL` (the `repinged_at` pattern — **at most once per beacon, ever**), then
  pushes to joiners (+ the creator of a `sparked` plan): `"starting soon 🎈"`.
  Beacons with zero joiners are skipped (nothing to remind). **Push only — no
  WS frame**: a live client is already rendering the countdown (PSYCHOLOGY §5);
  the §2.9 online guard makes this a phone buzz for absent people, by
  construction. This is the §2 "one-tap personal reminder" cashed in.

### 1.48 Listing editing (v0.7 — FEATURES #61)

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/listings/:id` | `{kind, title?, body?, price_text?, is_public?, location?, details?}` — `kind` is **echoed** to pick the Zod branch and must match the row (`400 kind_immutable`); `details`, when present, is the **complete per-kind payload revalidated exactly like create** (§1.38) | `200 {listing}` — **author only** (`403 forbidden`), **status `active` only** (`410 listing_closed` for closed/expired — retire-and-repost instead). Per-kind consequences: ride `details.departs_at` must be future (`400 departs_at_past`) and is **re-copied to `expires_at`** (sweeps never parse jsonb, §1.38); room `details.attachment_ids` re-binds — new ids must be mine/kind-image/unbound (`400 bad_attachment`), dropped ones unbind to the orphan GC (objects refcount-guarded §1.31). `area` is **immutable** (the mint snapshot is the visibility contract; move = new listing). Every effective edit sets `edited_at` (the card's "edited" marker). **No fan-out, no push — the board stays pull-based** (§1.38 doctrine); contacters' `listing_ref` snapshots are deliberately NOT rewritten (they are contact-time truth, the forwarded_from pattern). Rate `LISTING_EDIT_RATE_PER_HOUR` (30) → `429`. |

### 1.49 Feed lanes — the public Discover lane (v0.7 — ADR-016, FEATURES #64)

`posts.audience` gains `'public'` (`POST_AUDIENCES`); `POST /api/posts`
accepts `audience` (default `'friends_of'`). A public post is visible to
**every non-blocked, non-banned user** — reactions and comments included
(any viewer of a post may react/comment, as always; §1.36 semantics).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/feed?lane=&cursor=&limit=` | `lane: 'friends'` (default) \| `'discover'` | `200 {posts, next_cursor, all_caught_up}` — **friends** = the v0.5a feed verbatim (my friends-of set + me, every audience). **discover** = `audience='public'` posts instance-wide (walked via `posts_discover_idx`), minus §1.14 blocks both ways and §1.41 banned authors, **including my friends' and my own public posts** (one lane is a superset filter, not a dedupe puzzle). Both lanes: `created_at DESC`, keyset cursor, **finite with the hard `all_caught_up` end — no ranking, no recommendations, no wraparound, no pull-to-refresh loop** (PSYCHOLOGY design rule 5 binds the discover lane exactly as hard; the never-build list is why there is no "trending"). |

**Fan-out decision (binding):** `post.new` keeps its v0.5a recipient set —
the author's **friends-of sockets only** — for public posts too. The discover
lane is **pull-only**: strangers see new public posts when **they** open it
(the §1.38 board logic: a feed post is a standing artifact, not an
interruption; fanning every public post to every socket is both unbounded and
an ambient nudge). No push anywhere in the feed, unchanged.

### 1.50 Interactive posts: polls, open challenges, join cards (v0.7 — ADR-016, FEATURES #65)

`posts.kind ∈ {text, poll, game, join_card}` (`POST_KINDS`). Create-shape
rules (route-enforced, `400 bad_post_shape`): `text` = at least one of
body/attachments (the v0.5a `empty_post` rule); `poll` requires `poll`,
forbids attachments; `game` forbids poll/ref/attachments (body = the
trash-talk caption); `join_card` requires `ref`, forbids attachments.
Reactions and comments work on every kind (§1.36/§1.51).

#### Poll posts (song polls = options + links in the body)

- **Create:** `POST /api/posts` with `kind:'poll'`, `poll: {question ≤ 120
  (POST_POLL_QUESTION_MAX_CHARS), options: string[2..6] (each ≤ 80)}` →
  `post_polls` row keyed by the post id. No `closes_at` — a post poll lives
  and dies with its post.
- **Vote:** `POST /api/posts/:id/poll/vote {option_idx}` → `200 {poll:
  PostPoll}` — UPSERT on `(post, me)`: **revoting replaces** (§1.17
  semantics). `400 bad_option` (idx ≥ options length), `400 not_a_poll`,
  `404 not_found` (post invisible — audience/blocks/ban, §1.14 shape).
  `DELETE /api/posts/:id/poll/vote` unvotes, idempotent, same response.
- **Aggregates ride the Post DTO** (`post.poll.counts/total_votes/my_vote`).
  **Counts are allowed here** — a tally on OPTIONS is a group deciding
  something, not approval attached to a person; the §1.36 faces-not-counters
  rule governs reactions, not ballots (ADR-016 records the distinction, with
  the §1.17 chat poll as precedent). No voter lists, no vote timestamps, in
  any payload, ever. **No live fan-out** — feed surfaces reconcile on pull
  (§1.36 doctrine); the voter's own `200` carries their fresh truth.

#### Game posts — open tic-tac-toe challenges

- **Create:** `POST /api/posts` with `kind:'game'`. The card renders an open
  challenge ("first tap plays me").
- **Claim:** `POST /api/posts/:id/claim-game` → `200 {post, conversation_id,
  game_seq}`. **First claimer wins, atomically**: the transaction takes
  `pg_advisory_xact_lock(hashtextextended(post_id, k))` (the TROUBLESHOOTING
  counter-race pattern) and claims via the guarded `UPDATE posts SET
  game_claimed_by = $me WHERE id = $1 AND game_claimed_by IS NULL` — zero rows
  = `409 game_claimed`. In the same transaction: create-or-dedupe the DM with
  the author (`dm_key`, §1.4) and insert an ordinary **§1.27 `game_ttt`
  message** — sender = the claimer, `players: {x: post author, o: claimer}`,
  author moves first (they threw the gauntlet). Moves, spectating and
  finish states are §1.27 verbatim from here on. Errors: `400 not_a_game`,
  `400 game_own` (author self-claim), `404 not_found` (invisible post —
  includes blocked pairs: a blocked pair can never reach the DM-create),
  `409 game_claimed` (someone was faster; the DTO names them).
- **DTO:** `post.game = {state: 'open'|'claimed', claimed_by: UserLite|null}`
  — everyone sees WHO claimed (two named players, not a score); the board
  itself lives in the pair's DM and is visible only there.

#### Join cards — cross-posting a beacon/listing to the feed

- **Create:** `POST /api/posts` with `kind:'join_card'`, `ref: {type:
  'beacon'|'listing', id}` (stored verbatim in `posts.ref`), body = optional
  caption. The ref must be **MINE** (beacon creator / listing author —
  `404 not_found` otherwise, nothing confirmed) and **live** (`open` beacon /
  `active` listing → else `410 ref_closed`).
- **The audience-intersection rule (binding, enforced at create —
  `400 ref_audience_mismatch`):** the post's audience must be
  **narrower-or-equal** to the ref's, so a card can never show a thing to
  someone who cannot act on it (PSYCHOLOGY rule 2, structurally). Audiences
  must NEST; incomparable pairs refuse:

  | ref | post `friends_of` | post `public` |
  |---|---|---|
  | beacon `friends` | ✅ (same set) | ❌ |
  | beacon `area` | ❌ incomparable (friends ≠ area) | ❌ |
  | beacon `public` | ✅ | ✅ |
  | listing `is_public: false` | ❌ incomparable (friends ≠ area) | ❌ |
  | listing `is_public: true` | ✅ | ✅ |

- **DTO:** `post.ref_summary` is **resolved per viewer at serialization
  time** (the §1.29 reply_context pattern): always-current status (sparked /
  expired / cancelled / closed states render honestly), joiner faces (≤ 4) +
  `needs` + viewer `my_state` for beacons, `my_contacted` for listings. A
  viewer the ref is not visible to — audience drift is impossible by the rule
  above, but blocks, bans and deletion are not — gets `ref_summary: null`
  ("no longer available" card). The summary never carries more than the ref's
  own DTO would show that viewer.
- **Join button = the existing routes**: beacon → `POST
  /api/beacons/:id/join` (§1.15), listing → `POST /api/listings/:id/contact`
  (§1.39). No new write surface; every guard those routes have applies
  unchanged. After a successful join the client refetches the post (or the
  beacon) — no new fan-out.

### 1.51 Comment upgrades: attachments + reactions (v0.7 — FEATURES #66)

- **Image/GIF comments:** `POST /api/posts/:id/comments` gains
  `attachment_id?` — mine, kind `image` (a GIF is just an image upload, §1.6
  pipeline verbatim), unbound → `400 bad_attachment`; binds via
  `attachments.comment_id` (the GC-shield pattern). `body` may now be empty;
  at least one of body/attachment → else `400 empty_comment`. Deleting a
  comment (author or post author, §1.36) deletes its attachment (row +
  objects, **refcount-guarded** §1.31). `PostComment.attachment` inlines the
  DTO.
- **Comment reactions:** the §1.19 machinery re-applied to `comment_reactions`
  — `POST /api/posts/:id/comments/:commentId/reactions {kind?: 'emoji'|'stamp',
  emoji?}` (emoji required iff kind `'emoji'`; stamps need **my** avatar
  `ready` → `409 stamp_no_avatar`), `DELETE .../reactions/:emoji` (stamps:
  the URL-encoded `:stamp:` sentinel). Idempotent both ways, `204`. The 9th
  **distinct** emoji by one user on one comment →
  `409 reaction_limit` (`REACTIONS_PER_USER_PER_COMMENT_MAX` = 8; stamps
  never consume a slot — PK-enforced one stamp per user per comment).
  Comment must be on a post visible to me → `404 not_found`.
- **Rendering (binding):** `PostComment.reactions` carries one chip per
  `(emoji, kind)` as `{emoji, kind, reactors: UserLite[≤ 6], has_more, mine}`
  (`COMMENT_REACTORS_PREVIEW_MAX`) — **capped faces lists, never totals**
  (PSYCHOLOGY rule 3). Stamp chips render the reactor avatars themselves
  (§1.19 motion rules).
- **No fan-out, no push** — §1.36 doctrine unchanged: viewers (the comment
  author included) see reactions when they return to the feed. Blocked pairs
  are filtered from reactor faces both ways.

### 1.52 Locations: chips, drops & "on my way" (v0.7 — FEATURES #67–#68)

One shape everywhere (§0 `Location`): `{label ≤ 80, lat?, lng?}` — lat
`[-90, 90]`, lng `[-180, 180]`, **both-or-neither** (`400` from Zod). **lat/lng
are optional and only ever a user-initiated one-tap snapshot** — "attach my
current location" is an explicit action; nothing is captured ambiently, no
live GPS exists anywhere, and a label-only location ("the usual chai spot") is
always enough.

- **Location chips:** `location` is accepted on `POST /api/posts`,
  `POST /api/beacons` (+ §1.47 PATCH) and `POST /api/listings` (+ §1.48
  PATCH; explicit `null` clears on either PATCH) and rides the respective
  DTOs. Visibility is exactly the parent object's — a location never widens
  an audience.
- **Chat drops:** `Message.type` gains `'location'` — `POST .../messages`
  with `type:'location'`, `metadata.location` required (`400
  location_required`), optional `body` note, optional `metadata.join_me:
  true` (the "📍 Join me here" variant; both fields invalid on other types →
  `400 bad_metadata`). Ordinary §1.5 transaction/fan-out; push snippet
  `"📍 Location"`. Editable? No — `location` is not in
  `EDITABLE_MESSAGE_TYPES` (drop a new pin); deletable like any message.
- **On my way (headcount):** a quick action on a `join_me` drop that sends an
  **ordinary text reply** — `{type:'text', body: ON_MY_WAY_BODY ("On my way
  🏃"), reply_to_seq: <the drop's seq>}` — zero new server machinery. The
  drop's bubble renders a headcount strip of the FACES of participants whose
  on-my-way reply references it (client-derived from local history by
  `reply_to_seq`; missing pages are one §1.5 fetch away). Faces, not a
  number badge.
- **Map links (client, binding):** rendering is a LINK, never an embed — no
  tile servers, no map SDKs, no API keys (golden rule 7). With lat/lng:
  `geo:<lat>,<lng>` on mobile plus
  `https://www.openstreetmap.org/?mlat=<lat>&mlon=<lng>#map=17/<lat>/<lng>`
  and `https://www.google.com/maps/search/?api=1&query=<lat>,<lng>` as
  web choices. Label-only: the OSM/Google **search** URLs with the
  URL-encoded label. Opening a map app is the user leaving our origin by
  choice; we never fetch map data server-side.

### 1.53 Invite OG banner (v0.7 — FEATURES #70)

The §1.11 join page gets a real share card: a composed 1200×630 image instead
of the bare avatar.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/invites/:token/og-banner.png` | **UNAUTHENTICATED**; optional `v` cache-buster accepted and ignored | `image/png`, `OG_BANNER_WIDTH_PX × OG_BANNER_HEIGHT_PX` (1200×630), **sharp-composed server-side**: brand gradient background → inviter avatar in a `OG_BANNER_AVATAR_PX` (320) circle (static rendition; **mascot-blob fallback** rendered from an inline SVG when the inviter has no `ready` avatar — the card is good either way) → text overlay "<display_name> invited you to Bored Chat" via an SVG layer (**display_name is XML-escaped** before entering the SVG — it is user input inside markup). **Valid-token-gated exactly like the §1.11 avatar proxy**: any non-`valid` status → `404` (revocation kills the banner within the cache TTL). `Cache-Control: private, max-age=300` (`INVITE_AVATAR_CACHE_TTL_S`) + `ETag: "<avatar_version>"` keyed on the inviter's `avatar_version`, so unfurler re-scrapes revalidate after an avatar change. Rate `INVITE_OG_RATE_PER_HOUR_PER_IP` (120) per IP. Composition is cheap but not free: the handler may memoize the composed PNG in Redis keyed `(token, avatar_version)` with the same TTL. |

**Join page integration (web):** `/join/[token]` SSR metadata switches
`og:image` and `twitter:image` to the banner URL (absolute, via
`publicOrigin()` — the TROUBLESHOOTING `PUBLIC_ORIGIN` entry applies) and
sets `twitter:card: summary_large_image`. The §1.11 avatar proxy keeps
serving the in-page animated avatar; the banner is the unfurl face only.
All media stays self-generated and self-hosted (golden rule 7): gradient,
mascot and text are composed in-process — no fonts, images or services are
fetched at request time.

### 1.54 Web client contracts: scheduled-send feedback & the flipping wordmark (v0.7 — FEATURES #69, #71)

Web-only; no new API surface. Binding the way §1.29's UI contract is binding.

**Scheduled-send confirmation (FEATURES #69).** On a §1.26 `201`:

- a **success toast** — "Scheduled for <human time>" where the time is
  formatted in the user's locale/timezone ("today 18:30", "Fri 09:00") from
  the row's `deliver_at`; visible `SCHEDULED_TOAST_MS` (4 s); rendered
  through `components/Portal.tsx` at the toast layer of the globals.css
  z-scale (TROUBLESHOOTING portal/z-index classes apply).
- a **clock badge on the composer** whenever this conversation has pending
  schedules: clock glyph + pending count, sourced from
  `GET /api/scheduled-messages` and kept live by `scheduled.updated` (§2.3 —
  own-sockets, so the badge is correct cross-device). The count is the
  user's OWN queue (utility state, not a social number — PSYCHOLOGY rule 3
  untouched). Tapping it opens the existing `ScheduledDrawer` filtered to
  the conversation. Badge hidden at zero.

**Flipping wordmark (FEATURES #71).** The auth headline renders "[Bored]
Chat" where the bracketed word cycles `WORDMARK_WORDS`
(Bored → Sad → Excited → Happy → Lonely → Hyped) every
`WORDMARK_FLIP_INTERVAL_MS` (~2.5 s):

- the word sits in a **fixed-width slot** (width of the widest word,
  measured once) so "Chat" never shifts — a vertical roll animates old-out /
  new-in (the odometer pattern).
- the cycle **pauses while the tab is hidden** (`visibilitychange`) and
  resumes on return; when the animation stops (blur to a form field is fine,
  it keeps rolling; stopping = reduced-motion or unmount) it **settles on
  "Bored"** — the product name wins at rest.
- **the mascot reacts per word** (`components/Mascot.tsx` states): Bored =
  idle, Sad = droop, Excited = bounce, Happy = smile, Lonely = look around,
  Hyped = party. State changes ride the same tick as the roll.
- `prefers-reduced-motion` = **static "Bored Chat"**, no roll, mascot idle
  (the §1.22 full-replacement rule, not a slower animation). SSR renders
  "Bored" statically; the cycle starts client-side after mount (the
  TROUBLESHOOTING hydration entry — never clock-dependent text in SSR
  output).

### 1.55 Call reliability: self-test, TURN honesty & the ring push (v0.7.1 — ADR-017, FEATURES #87–#90)

Calls that just work — or say exactly why they don't. No schema change (the
`calls` row is untouched); the additions are one authed GET, one push payload
family (§2.9), one relayed frame (§2.12) and binding client contracts.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/call-selftest` | — | `200 {turn_configured, turn}` (`CallSelftestResponse`) — authed, **participant-free** (no live call required — the point is finding out *before* a call fails) and rate-limited `CALL_SELFTEST_RATE_PER_HOUR=30`/user. `turn_configured` mirrors whether `TURN_SECRET` is set. When configured, `turn` carries **short-lived probe credentials** (`CALL_SELFTEST_CRED_TTL_S=300`, username `"<unix expiry>:selftest:<user_id>"` — same coturn static-auth-secret HMAC as §1.42, the `selftest:` infix only so relay logs distinguish probes from calls; coturn reads the leading expiry and verifies the HMAC identically). When unconfigured, `turn: null` — there is nothing to probe (ADR-014's empty-secret hard stop means no relay service runs at all). |

**This GET is the one authed read of the instance's TURN state.** Three
consumers, one truth:

- **Settings → Call self-test (FEATURES #89):** the client runs, in order:
  secure-context check (`window.isSecureContext` — phones opening a LAN IP
  fail here, with the "open via the HTTPS tunnel URL" fix spelled out),
  mic/cam permission probe (`getUserMedia`, immediately stopped),
  `GET /api/call-selftest`, then — when `turn_configured` — two ICE gathers
  bounded by `CALL_SELFTEST_GATHER_TIMEOUT_MS=8000`: one with
  `iceTransportPolicy: 'relay'` using the probe credentials (**relay
  reachable** iff a `relay` candidate appears) and one default-policy gather
  (the candidate-type inventory: host / srflx / relay). Verdict in plain
  words, worst finding first; reachability is decided **client-side** because
  only the browser can test the UDP path from where the user actually sits.
- **The caller warning (FEATURES #90):** when `turn_configured` is `false`
  (cached per session; `POST …/calls` returning `turn: null` is the same
  fact in-band), the call screen shows the banner **before dialing**: *"This
  server has no call relay — calls only work when you're on the same
  network."* When a past self-test on this device found the relay
  unreachable, the variant says so instead. Never a silent failure.
- **Admin:** the admin panel calls the same GET and surfaces TURN state
  (configured / not) alongside the §1.41 settings; `./bored status` prints
  the same from the host side (compose profile + `TURN_SECRET` presence).
  `InstanceSettings` is untouched — TURN state is *read-only environment
  fact*, not a PATCHable setting.

**Connectivity UX (FEATURES #89, binding client contract):** the call screen
states say the truth — `connecting` (signaling done, ICE in progress) →
`connected` (first successful pair) → `reconnecting` (ICE dropped; automatic
restart running) → `failed` **with the reason** (verdict copy keyed on what
is known: no relay configured, relay unreachable from here, peer gone —
never a bare "call failed"). State transitions are reported to peers via the
relayed `call.state` frame (§2.12) so *their* tiles are honest too. Automatic
ICE restart: `iceConnectionState 'disconnected'` persisting
`CALL_ICE_DISCONNECT_GRACE_MS=3000` (or `'failed'` immediately) → the
**impolite peer** (lower user id — the existing §2.12 perfect-negotiation
rule) refreshes TURN credentials (`GET /api/turn-credentials`, §1.42, +
`setConfiguration`), calls `restartIce()` and re-offers over the existing
`call.offer`/`call.answer` frames — **no new signaling frame exists for
restarts**. At most `CALL_ICE_RESTART_MAX_ATTEMPTS=3` attempts per peer pair,
backed off `CALL_ICE_RESTART_BACKOFF_MS=[2000,4000,8000]`; then that pair is
`failed`. A 1:1 call whose media never connected ends with the existing
`POST /api/calls/:id/end {reason:'failed'}` (§1.42, unchanged).

**Ring push (FEATURES #88) — payloads in §2.9**, machinery here: on call
create, every callee the §2.9 guards allow **who has no live socket** (a live
socket already rings via `call.invite`) gets a `call.ring` push with
Answer/Decline actions; the moment the call is **handled anywhere** (first
join, DM reject, initiator cancel, ring timeout, end) a silent
`call.ring.stop` push closes it by tag. The server tracks who was rung in the
ephemeral Redis set `call:{id}:rang` (user ids; dropped with the member set
on any terminal status) so the stop goes to exactly the subscriptions the
ring went to — no new durable state.

**The floating call pill (FEATURES #87)** is pure client: the connected call
collapses to a draggable pill (avatar, live timer, mute, hang-up) rendered
through `components/Portal.tsx` like every overlay (TROUBLESHOOTING: never a
fixed element inside app chrome), expands on tap, uses browser PiP for video
where supported. No contract surface; listed here so the release is complete.

### 1.56 Web client contracts: shared toasts & notifications-on (v0.7.1 — ADR-017, FEATURES #90a–#90b)

Web-only, but **binding** (the §1.54 precedent): these are product rules the
next client must also satisfy, documented here because no server surface
exists to carry them.

**Shared toast (#90a) — `components/Toast.tsx`, ONE component:**

- Rendered through `components/Portal.tsx` into `<body>`; **bottom-anchored
  above the tab bar** (`z-index` per the `app/globals.css` scale: toast tops
  it; `padding-bottom` includes `env(safe-area-inset-bottom)` + tab-bar
  height).
- Auto-dismiss after `TOAST_DEFAULT_MS=3500` (per-call override allowed —
  the v0.7 scheduled-send toast keeps its `SCHEDULED_TOAST_MS=4000`); at
  most `TOAST_MAX_VISIBLE=1` at once, newest replaces oldest. Dismissible by tap;
  screen-reader surfaced via `role="status"` (`aria-live="polite"`).
- `prefers-reduced-motion`: fade only, no slide (the §1.22 replacement rule).
- **Every action without a visible immediate result confirms itself** through
  it: posted to board, beacon lit, invite copied, settings saved, report
  sent, scheduled-for-&lt;time&gt;, kudos sent. Toasts are **confirmations of
  the user's own actions only** — never incoming-event notifications, never
  social counters (PSYCHOLOGY rule 3 untouched).

**Notifications-on assurance (#90b):**

- **One-time post-login explainer** when `Notification.permission ===
  'default'` and no push subscription exists: what push is for (messages,
  calls, sparked plans, wave nudges) + *Enable now* / *Not now*. *Not now*
  (or a browser deny) writes `PUSH_EXPLAINER_SEEN_KEY` to localStorage —
  **device-local by design** (permission is a per-browser fact; the prompt
  state lives beside it) — and the prompt never shows again on this device.
  No re-nags, no badges, no guilt (PSYCHOLOGY rule 5).
- **Settings row** (Settings → Notifications) always tells the truth: **ON**
  (permission granted + live subscription), **OFF** (`default`, or granted
  with no subscription — offers Enable), **Blocked by browser** (`denied` —
  per-browser unblock steps, keyed on UA, since the page cannot re-ask).
- **Ring-dependent features surface the OFF state instead of failing
  silently:** the call screen notes "you won't be rung when the app is
  closed" (linking the settings row) when permission isn't granted. The note
  is dismissible context, never a gate — calls still work in-app.

### 1.57 Moods & 🍻 drunk mode (v0.8a — ADR-018, FEATURES #72–#73)

A mood is a chip on your identity — `users.mood_*` columns (the ADR-009
one-row-read pattern; migration 0009), **not** a table and **not** history:
when it expires or is cleared, every trace is gone. **Binding product rules:**
moods NEVER appear in any activity/history surface (§1.59's table has no mood
kind, by contract); a mood change NEVER generates push (the drunk banner is a
passive render of an already-visible chip); reads filter
`mood_expires_at > now()` **live** (the §1.44 opt-in pattern) so a stale chip
is impossible regardless of sweep lag.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/me/mood` | — | `200 {mood_state: MoodState}` — my full state (`{mood: null, visibility, expires_at: null, swing_set: null}` when unset). The ONLY payloads carrying `visibility`/`expires_at`/`swing_set` are these owner reads. |
| `PUT /api/users/me/mood` | `{kind:'preset', label, visibility?}` \| `{kind:'custom', emoji, label, visibility?}` \| `{kind:'swing', swing_set: {emoji,label}[2..6], visibility?}` \| `{kind:'drunk', visibility?}` | `200 {mood_state}`. `preset`: `label` must name a `MOOD_PRESETS` entry (server fills the emoji) → else `400 bad_mood_preset`. `swing`: the server materializes the FIRST entry as the current chip and stamps `mood_swing_rotated_at`. `drunk`: emoji/label pinned to `MOOD_DRUNK_EMOJI`/`MOOD_DRUNK_LABEL`. `visibility` omitted = `'everyone'` — **except `drunk`, which defaults `'connections'`** even when the user's other moods were public (the guardrail; still overridable by sending it explicitly). Every PUT (re)sets `mood_expires_at = now() + MOOD_TTL_S` (4 h) — re-setting extends. Rate `MOOD_SET_RATE_PER_HOUR` (30) → `429`. Fans out `user.updated` (below). |
| `DELETE /api/users/me/mood` | — | `204` — clears all `mood_*` columns (idempotent) + `user.updated` fan-out. No trace survives anywhere. |

**Per-viewer resolution (binding, the §1.13 serialization-time machinery).**
`UserLite.mood` / `UserPublic.mood` serialized to viewer V for owner O is the
chip iff ALL of: the mood is live (`mood_expires_at > now()`), AND O's
`mood_visibility` admits V (`everyone`; `connections` = V holds an **accepted
§1.28 connection** with O — literally connections, NOT friends-of: a DM alone
does not qualify; `nobody` = only O), AND O⊥V are not a §1.14 blocked pair —
else `null`, byte-identical to no-mood (visibility is never confirmable).
The owner always sees their own chip. This resolution runs on **every**
surface UserLite rides — participants, joiner piles, seen-by lists, feed
authors, comment authors — there is no unfiltered path.

**Fan-out.** Set/clear/expiry/rotation publishes one `user.updated` envelope;
the gateway resolves recipients (the existing user.updated set: the owner's
own sockets + sockets sharing a conversation with the owner) and stamps
`mood` **per recipient** under the resolution rule above (§2.11) — a
`nobody`-visibility change still reaches others as a frame whose `mood` is
`null` only when something else changed; the api skips the fan-out entirely
for `nobody` mood-only changes. No push, ever.

**🎢 Swing mode (worker, queue `timers`).** Each swinging user rotates to a
random DIFFERENT entry of their `swing_set` every `MOOD_SWING_INTERVAL_S`
(30 min) ± uniform `MOOD_SWING_JITTER_S` (10 min), walked via
`users_mood_swing_idx` on `mood_swing_rotated_at`; each rotation materializes
`mood_emoji`/`mood_label` (kind stays `'swing'` — clients morph-animate the
chip on `user.updated`) and re-stamps `mood_swing_rotated_at`. Rotation never
extends `mood_expires_at`.

**Expiry sweep (worker, queue `timers`, every `MOOD_SWEEP_INTERVAL_S`).**
Clears all `mood_*` columns where `mood_expires_at <= now()` (walked via
`users_mood_expiry_idx`) and fans `user.updated` per user — auto-sober
included: the drunk chip vanishes with the same zero-trace rule (the client's
mascot may look briefly concerned; the server stores nothing).

**🍻 Drunk mode guardrails (FEATURES #73):**

- **Send-undo (server-side).** While the sender's drunk mood is live, every
  §1.5 send is undoable: `DELETE /api/conversations/:id/messages/:seq?undo=1`
  within `MOOD_DRUNK_UNDO_WINDOW_S` (10 s) of the message's `created_at`
  (server allows `MOOD_DRUNK_UNDO_SLACK_S` = 2 s skew) → `204`. It is a §1.30
  tombstone (seq survives forever — golden rule 2; attachments/dependents
  removed identically) with ONE difference: `metadata` is set to
  `{"undone": true}` instead of `{}`, and clients render **nothing at all** —
  the bubble vanishes; no "message deleted" stub exists for an undone
  message (history refetch and §1.3 sync deliver the same vanishing DTO).
  Undo works on **every own message type**, including kinds outside
  `EDITABLE_MESSAGE_TYPES` and §1.35 channel messages — it needs no edit
  permission, only authorship (`system` messages have no author and cannot
  be undone). Preconditions, checked in order: author (`403 forbidden`),
  sender's drunk mood live **at undo time** (`409 not_drunk` — nothing about
  the mood is stamped on the message; no trace), within the window
  (`409 undo_window_closed`). A frozen-DM `404` applies as in §1.30. An undone
  message **never pushes**: while the sender's drunk mood is live, the send
  path enqueues every §2.9 message-push job with a delay of
  `MOOD_DRUNK_UNDO_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S`, so the worker's fresh
  `deleted_at` re-check runs only **after** the undo window has closed (the
  5 s debounce alone does not cover the 10 s window). Nothing about the mood
  is stamped on the job — it is only a delay.
  Fan-out: `msg.updated` with the vanishing DTO.
- **Cold-contact confirm (CLIENT-side, binding UX contract).** While drunk,
  the composer interposes a "you sure?" confirm before sending into a DM
  whose `Conversation.last_message_at` is older than
  `COLD_CONTACT_THRESHOLD_S` (30 d) or into a brand-new DM, and before every
  public write (public post, public beacon, listing). The >1-month fact needs
  no new endpoint: **`Conversation.last_message_at` IS the DTO flag.** Never
  a server rejection — the server neither knows nor records who hesitated.
- **The soft banner (CLIENT-side, binding UX contract).** A participant whose
  view of the drunk user resolves `mood.kind === 'drunk'` (i.e. exactly those
  the visibility already admits) renders a passive banner in that chat —
  "🍻 ‹name› is in drunk mode — take tonight's messages lightly" — with a
  **Check on them 💙** action: one tap sends `DRUNK_CHECK_IN_BODY` as an
  ordinary §1.5 message, or starts an ordinary §1.42 call. A banner, NEVER a
  push blast, never a system message, never stored. It disappears the moment
  the mood does.

### 1.58 Mood-reactive messages & animated names (v0.8a — ADR-018, FEATURES #74–#75)

**Mood-reactive messages (#74) — pure CLIENT rendering** (the §1.54/§1.56
web-contract precedent: binding for any client). The server ships **no**
effect field and stores **no** trace: the driver is the sender's `mood`
already visible on their UserLite in the viewer's participants/DTOs.

- Mapping (`MOOD_MESSAGE_EFFECTS`, keyed on `mood.label`, for kinds
  `preset`/`swing`/`drunk` ONLY — a `custom` label never triggers an effect,
  even on collision): `drunk` → **wobble** (tipsy wobble-in, settle ≤
  `MOOD_WOBBLE_MAX_DEG` = 2° crooked, straighten on tap), `sad` → **rain**
  (soft rain overlay in the chat scroll + text falls into place), `hyped` →
  **bounce** (bounce-in).
- Subtle-first: effects run on ENTRY only, reading is never blocked, no
  sound, no looping overlays except the rain (which sits behind bubbles at
  low opacity and respects the §1.24 theme).
- Applies only while the mood is live and visible to THIS viewer — the §1.57
  resolution decides, so a `nobody`/blocked/expired mood performs nothing.
- Per-viewer toggle: `UserSettings.mood_effects` (§1.13 PATCH; default
  `true`) — a settings column purely for cross-device sync of MY choice to
  not watch others' effects.
- `prefers-reduced-motion` **disables all of it unconditionally** — no
  wobble, no rain, no bounce, no mood-chip morph (the §1.22 replacement
  rule: the chip renders static).

**Animated names (#75).** `users.name_style` (`NAME_STYLES`, CHECK-pinned:
`none`/`glow`/`shimmer`/`rainbow`/`surprise`), set via the existing
`PATCH /api/users/me {name_style}` (identity, not privacy — fans the usual
`user.updated`), serialized on `UserLite`/`UserPublic` so every name render
site has it. Render contract (binding): applies on the **profile page, chat
headers, and group/channel sender names** — never inside message bodies,
never on buttons; pure CSS text effects (no canvas, no timers beyond CSS
animation); `surprise` resolves **client-side and deterministically** to
`NAME_STYLE_SURPRISE_POOL[hash(user_id + UTC date) % 3]` so it rotates daily
and every viewer sees the same style with zero server state; reduced-motion
viewers get a **static tint** (the glow/shimmer/rainbow gradient frozen at
its first frame); legibility always wins — contrast floors per theme are the
client's responsibility and effects never change font size or spacing.

### 1.59 Profile activity strip & per-kind privacy (v0.8a — ADR-018, FEATURES #76)

`activities` rows (migration 0009), written **inside the owning module's
transaction** through the ONE helper (`src/lib/activity.ts
recordActivity(tx, {user_id, kind, ref})` — the `requestUnfurl()` chokepoint
rule: no module inserts directly): beacon create → `beacon_lit`; spark →
`beacon_sparked` (creator only — a joiner's attendance is the plan group's
business, not a strip item); `POST /api/posts` → `post_created`;
`POST /api/listings` → `listing_posted`; a FINISHED puzzle attempt (solved
or out of guesses, once per user per UTC day) → `puzzle_played`; a
server-validated tic-tac-toe win → `game_won` (winner's row, §1.27 and §1.50
boards alike). `ref` stores the minimal pointer only (`{beacon_id}`,
`{post_id}`, `{listing_id}`, `{date, solved, attempts_used}`,
`{conversation_id, seq, opponent_id}`) — **never a denormalized audience**,
so visibility can never go stale. **Moods are NEVER recorded** (no mood kind
exists in the CHECK — PSYCHOLOGY: no trace).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/:username/activity` | — | `200 {activities: Activity[]}` — newest first, ≤ `ACTIVITY_STRIP_MAX` (20) **after** per-viewer filtering (invisible items are silently dropped; no placeholders, no "N hidden" counts — PSYCHOLOGY rule 3). Unknown/blocked/banned owner → `404 not_found`, byte-identical to the §1.14 profile shape. The owner sees all their own items. |
| `PATCH /api/users/me/settings` | `{activity_beacons?, activity_posts?, activity_listings?, activity_games?}` — each `'public'`\|`'connections'`\|`'private'` (default `'connections'`) | `200 {settings}` — the §1.13 route, four new keys. Applies at the next read (serialization-time; nothing stored is rewritten). |

**Per-viewer resolution (the HARD RULE, binding).** An item is serialized to
viewer V iff **(a)** O's per-group setting admits V (`ACTIVITY_KIND_GROUP`
maps kinds → the four settings; `public` = anyone who can read the profile,
`connections` = accepted §1.28 connections of O, `private` = O only), **AND
(b)** V can see the underlying thing itself — the setting can only narrow,
never widen past the object's audience:

| Kind | Underlying-audience check (resolved live at read) |
|---|---|
| `beacon_lit` / `beacon_sparked` | The beacon row exists and V passes its §1.15 audience **as stored**: `friends` → V ∈ friends-of(O); `area` → V's `users.area` equals the beacon's area snapshot (citext); `public` → anyone. A friends-only beacon therefore NEVER shows in public activity regardless of the toggle. The summary carries vibe/note/status only — **no joiner faces** (the pile stays on `GET /api/beacons/:id`, which re-checks §1.14 pile blocks). |
| `post_created` | V can read the post per §1.36/§1.49: `public` → anyone; `friends_of` → V ∈ friends-of(O). Deleted post or banned author → dropped. `excerpt` is the CURRENT body's first 80 chars (the §1.29 rule — edits reflected, never a stale snapshot). |
| `listing_posted` | The listing row exists and V passes §1.38 visibility: `is_public` → anyone; else V's area equals the listing's area snapshot. Closed/expired listings still show, with their status. |
| `puzzle_played` | No underlying object audience — the ref is the player's own no-spoiler facts (date/solved/attempts, the §1.27 `PuzzleResult` floor: no letters, no word). The per-group setting alone governs. |
| `game_won` | V was a participant of the game's conversation at that seq (the §1.5 visibility floor) — in practice the opponent. A win in a DM is visible only to who watched it happen; the opponent's UserLite rides only where V already knows them. `opponent: null` = deleted account. |

Plus always: §1.14 blocks (the profile is already 404 both directions) and
§1.41 bans (banned owners' strips are hidden with their profiles; a banned
*opponent/author* inside a summary resolves like every banned serialization).
Resolution is serialization-time — changing a setting or an object's audience
re-filters instantly; nothing stored is rewritten.

**Retention (worker, queue `gc`, nightly):** hard-DELETE rows with
`created_at < now() − ACTIVITY_RETENTION_DAYS` (30 d, via
`activities_sweep_idx`). The strip is recent activity, not an archive; no
fan-out (pull-based, the §1.38 doctrine — no WS event exists for activity).

### 1.60 GIF/video chat backgrounds (v0.8a — ADR-018, FEATURES #79)

`conversation_prefs.background_attachment_id` (migration 0009) — a §1.24
pref, so everything personal about prefs binds: **my view only**, never
serialized to any other participant, no event about it ever reaches anyone
else, synced across my devices via `prefs.updated` (own sockets only).

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/conversations/:id/prefs` | `{background_attachment_id?: uuid\|null}` (alongside the §1.24 fields; omitted = unchanged, `null` clears) | `200 {prefs}` — `prefs.background` resolves to the full `Attachment` (poster `thumb_url` included). Checks, in order, else `400 bad_background`: the attachment is **MINE** (`uploader_id = me` — own uploads only, ownership-checked), kind `image` (GIFs included, ≤ `MAX_IMAGE_BYTES`) or `video`, `status 'ready'` (a pending video has no probed duration yet — re-PATCH after `attachment.ready`), and for video: `size_bytes ≤ CHAT_BG_VIDEO_MAX_BYTES` (25 MB) **and** `duration_ms ≤ CHAT_BG_VIDEO_MAX_DURATION_S` (30 s). The upload itself rides the existing §1.6 pipeline unchanged (sniffed MIME, EXIF strip, worker poster). One attachment may back several of my chats. |
| `PATCH /api/conversations/:id/background` | `{attachment_id: uuid\|null}` (v1.0a #95 — migration 0012) | `200 {background: Attachment\|null}` — the background **the whole conversation sees** (`conversations.shared_background_attachment_id`). DM/channel: any **active member**; group: admins only → else `403 not_admin`. Validation identical to the §1.60 personal background (`400 bad_background`). Served to everyone through the prefs read as `prefs.shared_background`; **my own `prefs.background` still overrides it for my view**. **Media ACL:** `GET /api/media/:key` (§1.6) serves a shared background to every **active member** of that conversation (`conversation_participants.left_at IS NULL`) — the same audience that receives `conv.background` — on top of the uploader-only rule; this is the ONE background that other users hold a URL for. Fans WS `conv.background {conversation_id, background}` to every ACTIVE member (conversation-level state — deliberately NOT `prefs.updated`, which stays owner-only). GC: the orphan sweep anti-joins `conversations_shared_background_idx`, the 0009 pattern. |
| `PATCH /api/conversations/:id/appearance` | `{theme?: ChatTheme\|null, wallpaper?: ChatWallpaper\|null}` (#95b — migration 0013; omitted = unchanged, null = clear; at least one present) | `200 {theme, wallpaper}` — the theme + wallpaper **the whole conversation sees** (`conversations.shared_theme` / `shared_wallpaper`). Same setter rule as the shared background: DM/channel any **active member**; group **admins only** → else `403 not_admin`. Served to everyone through the prefs read as `prefs.shared_theme` / `prefs.shared_wallpaper`; **my own `prefs.theme` / `prefs.wallpaper` still override for my view** (null there = follow the chat). Fans WS `conv.appearance {conversation_id, theme, wallpaper}` to every ACTIVE member. |

- **GC shield:** a referenced attachment cannot use the binding-column
  pattern (`attachments_orphan_idx`) — the reference points the other way
  and is shared across chats — so the orphan sweep **anti-joins**
  `conversation_prefs_background_idx`: `WHERE NOT EXISTS (SELECT 1 FROM
  conversation_prefs p WHERE p.background_attachment_id = a.id)`. Clearing
  the last reference re-orphans the attachment for the normal 24 h GC.
- **Media ACL:** unchanged for the personal background — it is mine, and
  `GET /api/media/:key` already serves an uploader their own object. No
  other user ever has a reason (or a URL) to fetch it. The v1.0a #95
  **shared** background is the exception: its ACL branch admits every active
  member of the conversation (see the `PATCH …/background` row above).
- **Render contract (binding):** the media paints the chat scroll background
  **behind** the §1.24 wallpaper layer slot (setting a background overrides
  the wallpaper visually; both survive in prefs), auto-dimmed under a scrim
  (`CHAT_BG_OVERLAY_OPACITY` = 0.45, theme-aware) so bubbles stay legible —
  bubbles keep their own opaque surfaces. Video/GIF: **muted**, looped,
  `playsInline`, never audible; **paused when off-screen** (IntersectionObserver
  on the scroll container / document hidden) and when the Battery Status API
  reports saver mode where available. `prefers-reduced-motion`: the **static
  poster** (`thumb_url`) renders instead — no playback, no first loop, ever.

### 1.61 Discoverability: tour, directory & what's-new (v0.8a — ADR-018, FEATURES #80)

Client-heavy (the §1.54/§1.56 binding-web-contract precedent) with one small
server surface for the release markers.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/releases` | — | `200 {releases: ReleaseNote[], last_seen_release: string\|null}` — the instance's shipped releases, newest first, from `instance_settings` key `'release_notes'` (seeded by migration 0009, appended by future release migrations, curable via the §1.41 admin `PATCH {release_notes}` — ring-logged like every admin write); plus MY cursor (`users.last_seen_release`). |
| `POST /api/releases/seen` | `{version ≤ 20}` | `204` — sets `users.last_seen_release` (idempotent; the client sends the newest version it just showed cards for). **Register stamps the newest version at signup** so day-one users never see a card storm. |

- **First-run spotlight tour:** `TOUR_STEPS` (4 steps, ids
  `chats`/`plans`/`local`/`you`, each anchored to a shell tab), shown once
  after first login on a device, **skippable at every step, never repeats** —
  `TOUR_SEEN_KEY` (`bc.tour-seen`) is localStorage, device-local by design
  (the `PUSH_EXPLAINER_SEEN_KEY` rule: orientation is per-device, and a
  declined tour never re-nags). Reduced-motion: no spotlight travel
  animation — plain dismissible cards.
- **"✨ Things you can do" directory:** `FEATURE_DIRECTORY` in
  `packages/shared` — the STATIC typed registry (`{id, title, one_liner,
  href, since}`) every client renders identically: one card per feature, the
  one-liner, a **Try it** deep link (`href`), client-side substring search
  over title + one-liner. `since` drives a "new" badge for entries newer
  than my `last_seen_release`. Adding a feature = appending an entry — a
  contract change like any constant.
- **New-since-last-visit cards:** after login/sync, releases newer than
  `last_seen_release` render as dismissible cards (title + items, linking
  into the directory); dismissing POSTs `/api/releases/seen`. Cards are
  **informational, never engagement bait**: no badges elsewhere, no unread
  dots on tabs, no re-surfacing after dismissal (PSYCHOLOGY rules 4/5 —
  the user pulls, the app never guilts).

### 1.62 Anonymous reveal game (v0.8b — ADR-019, FEATURES #77)

A guessing game, not a mask for abuse: the sender is anonymous **to the
recipient only, never to the server** — `anon_threads.sender_id` is an
ordinary FK, anonymity is pure serialization, and reporting an anonymous
message attaches the sender's real identity to the report. Text only (no
attachments, no reactions, no receipts, no typing — the game is deliberately
smaller than a chat and lives OFF the seq log). Recipient opt-in:
`UserSettings.anon_messages` (`nobody`/`connections`/`everyone`, DEFAULT
`connections` — §1.13 has the enforcement row).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/anon/threads` | `{user_id, body ≤ 500}` | `201 {thread: AnonThread}` — opens my open thread to that user (or `200` appending to it: ONE open thread per direction, the partial unique; migration 0010). **Refusals are invisible and byte-identical** — `404 anon_unavailable` for: unknown user, `anon_messages:'nobody'`, `'connections'` unmet, §1.14 blocked either way, banned target, self. Rates: `ANON_SEND_RATE_PER_HOUR` (20) on messages, `ANON_NEW_THREAD_RATE_PER_DAY` (5) on distinct new recipients → `429`. |
| `GET /api/anon/threads` | — | `200 {threads: AnonThread[]}` — mine (both roles), newest activity first. VIEWER-STAMPED: the recipient's `counterpart` is `null` until revealed. |
| `GET /api/anon/threads/:id/messages?cursor=&limit=` | — | `200 {messages: AnonMessage[], next_cursor}` — `created_at ASC`. Party-only, else `404 not_found`. |
| `POST /api/anon/threads/:id/messages` | `{body ≤ 500}` | `201 {message}` — either party; the recipient's replies ride the same thread (their identity was never hidden from the sender). Fan-out + push below. |
| `POST /api/anon/threads/:id/request-reveal` | — | `200 {thread}` — RECIPIENT only; stamps `reveal_requested_at` (idempotent). The sender sees `reveal_requested: true` and picks a game (or ignores it — no nag, no timer on the request). |
| `POST /api/anon/threads/:id/set-reveal` | `{mode:'timer', timer_s: 3600\|21600\|86400}` \| `{mode:'riddle', riddle_q ≤ 200}` | `200 {thread}` — SENDER only. Timer: `reveal_at = now() + timer_s`. Riddle: the question serializes to both. Re-setting replaces (a riddle may become a timer); `409 already_revealed` after reveal. |
| `POST /api/anon/threads/:id/answer-riddle` | `{answer ≤ 200}` | `201 {message}` — RECIPIENT, `reveal_mode:'riddle'` only (`400 not_a_riddle`). The answer lands as an ordinary `AnonMessage` with `is_riddle_answer: true` — the sender's client renders "that's right ✓" on it, which calls reveal below. Satisfying is the SENDER's call, by design. |
| `POST /api/anon/threads/:id/reveal` | — | `200 {thread}` — SENDER only, anytime (the riddle confirm AND the reveal-anytime button are the same endpoint): stamps `revealed_at`; the recipient's next frame carries the full `counterpart` UserLite. Idempotent. |
| `DELETE /api/anon/threads/:id` | — | `204` — either party; HARD-deletes the thread + messages (no archive of a game nobody wants). Frees the open-thread slot; `ANON_NEW_THREAD_RATE_PER_DAY` blunts delete-and-retry. |
| `GET /api/anon/threads/:id/avatar?v=static` | party-only (authed) | The **blurred-avatar proxy** (the §1.11 token-gated pattern, thread-gated): streams a server-rendered image, Gaussian blur sigma = `ANON_BLUR_SIGMA_MAX` (24) × factor, factor = 1 under `reveal_mode` none/riddle, `clamp((reveal_at − now)/reveal_timer_s, 0, 1)` under a timer, 0 (clear) once revealed. **Pre-consent (reveal_mode none/riddle) the source is the MASCOT blob, never real pixels** — even a max-blurred real avatar is reversible to identity by replaying the resize→blur→encode pipeline over candidates' public avatars and matching bytes; the sender's real avatar enters the pipeline only once a timer is RUNNING (the sender picked the mechanism) or the thread is revealed. **The real avatar URL/pixels never reach the recipient early** — client-side blur would ship the answer. Static only (an animated avatar is identifiable by motion). `Cache-Control: private, max-age=60` (`ANON_AVATAR_CACHE_TTL_S` — the blur must keep moving). Sender/avatar-less → the mascot-blob fallback at every stage. |

**Timer reveal (worker, queue `timers`, every `ANON_SWEEP_INTERVAL_S`):**
stamps `revealed_at` where `reveal_at <= now()` (via `anon_threads_reveal_idx`)
and fans `anon.updated`; reads ALSO resolve `reveal_at <= now()` as revealed
live (the §1.44 pattern — sweep lag never shows a stale mask). The recipient
watches the avatar un-blur progressively as the factor falls: the client
re-fetches the proxy on a gentle cadence and animates between frames.

**Fan-out & push.** Every mutation fans `anon.updated` (§2.3) to the two
parties, viewer-stamped. New messages push through the §2.9 guards (offline,
unread by the ANON read model, debounce) with **identity-free copy both
ways**: `ANON_PUSH_BODY_RECIPIENT` ("Someone sent you an anonymous message
🎭") / `ANON_PUSH_BODY_SENDER`. Blocks are structural: a block created
mid-thread freezes it exactly like a §1.14 DM (`404` on further sends, both
directions, no reason stated).

**Reports (binding, FEATURES #77).** `POST /api/reports {kind:'anon_message',
thread_id, message_id, reason?}` — reporter must be a party, the message the
OTHER party's. The server stamps `target_user_id` = the reported message's
author (migration 0010's shape CHECK makes an identity-less anon report
unrepresentable) and copies the message body into the admin preview
(`AdminReport.target_anon_message` — the reported words are what is being
reported; the recipient was always allowed to show them). Anonymity never
survives a report, and the UI says so in the report sheet.

### 1.63 Wave nudges (v0.8b — ADR-019, FEATURES #78a)

The §1.44 single-wave rule stands: a wave parks silently and **names nobody,
ever**. The nudge adds exactly one anonymous fact — "someone in the pool
waved at you" — and only when anonymity is arithmetically safe.

- **Trigger:** on each parked (non-matching) wave insert, if the target's
  `wave_nudges` setting is on and their opt-in's `wave_nudged_at` is null,
  the api enqueues a nudge job (queue `discovery`).
- **Worker, in order (binding):** (1) re-check the target's opt-in is live
  and un-nudged; (2) compute the target's **visible pool** — the §1.44
  mutual-reachability card set, minus blocks/friends-of/banned — and require
  `≥ NUDGE_MIN_POOL` (4): below it the job drops silently and the claim stays
  open (a later wave in the same hour retries); (3) claim atomically:
  `UPDATE discovery_optins SET wave_nudged_at = now() WHERE user_id = $1 AND
  expires_at > now() AND wave_nudged_at IS NULL` — zero rows = another job
  won; (4) deliver: `discovery.nudge {}` to live sockets, else one §2.9 push
  `{title: NUDGE_PUSH_BODY}` ("Someone in the pool waved at you 👀") with no
  identity, no count, no per-card deep link (tap opens the discovery pool).
- **Batching is the claim:** N waves in one opt-in hour = at most ONE nudge
  (`wave_nudged_at` is cleared only by a fresh `PUT /api/discovery/optin`).
  A nudge is never retroactive praise and never a rejection surface: it fires
  at most once, says nothing about who or how many, and stops with the
  setting (§1.13 row) or the opt-in.

### 1.64 Suggestions & find-your-people (v0.8b — ADR-019, FEATURES #78)

People-you-may-know for Feed-Discover and the connections page. Pull-only
(no WS, no push — the §1.38 doctrine); dismissals are permanent and silent.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/suggestions` | `?mutuals=&groups=&area=&interests=` (v1.0 #78c — each flag NARROWS the pool, the §1.65 doctrine: mutuals → `mutual_count > 0`; groups → shared non-ghost group; area → my `users.area` match (no area of mine → honest empty); interests → PUBLIC §1.37 interest-tag overlap (no public tags of mine → honest empty)) | `200 {suggestions: Suggestion[]}` — ≤ `SUGGESTIONS_MAX` (20), best evidence first (`mutual_count` DESC, then `shared_groups`, then `same_area`, then newest account). Each card also carries `shared_interests` (≤ `DISCOVERY_SHARED_INTERESTS_MAX`, the §1.65 overlap rule — already-public data). Candidates: connections-of-my-connections ∪ same-`area` users ∪ co-members of my **non-ghost** groups. **Excluded entirely:** me, §1.14 blocked pairs (both ways), the friends-of set, pending connection requests either direction, dismissed, banned, and anyone reachable ONLY through a 👻 ghost group (unlisted everywhere, §1.68). Signals per card: `mutuals` (≤ `SUGGESTION_MUTUALS_PREVIEW_MAX` faces — people I already know, so no new exposure) + `mutual_count`; `same_area` as a **boolean** (the area TEXT stays owner-private, FEATURES #30); `shared_groups` count. |
| `POST /api/suggestions/:userId/dismiss` | — | `204` — idempotent, permanent (`suggestion_dismissals`, migration 0010). The dismissed user is NEVER told, and nothing re-surfaces them (PSYCHOLOGY rule 4). |

**Find-your-people (client flow, binding):** one post-signup step — set your
`area` (§1.13 PATCH, optional) → render `GET /api/suggestions` as dismissible
cards with the §1.28 connect action → skippable, never re-shown
(device-local seen key, the `TOUR_SEEN_KEY` pattern). **NEVER user cards on
the login page** — unauthenticated member enumeration stays forbidden (the
standing decision).

### 1.65 Discovery filters & vibes (v0.8b — FEATURES #78b)

`PUT /api/discovery/optin` gains `vibe?: DiscoveryVibe|null`
(`DISCOVERY_VIBES` — the beacon chip vocabulary; migration 0010) — an
optional what-for chip on my card ("looking to: 🚶 walk"). `DiscoveryCard`
gains `vibe` and `shared_interests` (the overlap of the two **public** §1.37
interest lists, ≤ `DISCOVERY_SHARED_INTERESTS_MAX` — already-public data,
intersected, nothing new revealed).

`GET /api/discovery/cards?vibe=&interests=&area=` — each filter only ever
**narrows** the §1.44 mutual-reachability pool (never widens, never re-ranks):
`vibe=<chip>` keeps cards wearing that chip; `interests=1` keeps cards
sharing ≥ 1 public interest tag with me; `area=1` keeps cards whose owner's
`area` equals mine (citext — the MATCH is computed server-side, the text
never serialized). Filters are honest about their data: a card without a
vibe simply never matches a vibe filter, and **no age/gender filters exist
because no such fields exist** (FEATURES #78b). The §1.44 rules are otherwise
verbatim (own live opt-in required, `DISCOVERY_CARDS_MAX`, no cursor).

### 1.66 Canvas stories (v0.8b — ADR-020, FEATURES #79a)

A story becomes a collaborative canvas **only by its author's invitation**:
`stories.canvas_mode` (`off` DEFAULT / `open` / `approve`, migration 0010).
Viewer contributions are **separate attributed vector overlay layers**
(`story_overlays`) — never burned into the image: every overlay wears a
username chip, is tappable → "drawn by @x" → profile, survives in its own
row, and dies with the story (cascade under the §1.34 hard-delete sweep).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/stories` | (§1.34) + `canvas_mode?` (default `'off'`) | unchanged otherwise. |
| `PATCH /api/stories/:id` | `{canvas_mode}` | `200 {story}` — author only (`404` otherwise). Switching to `'off'` keeps existing overlays visible (they were invited); it stops NEW ones. Fans `story.updated`. |
| `POST /api/stories/:id/overlays` | `{payload}` — the per-kind vector union (§0 `StoryOverlay`; Zod shape authority) | `201 {overlay}` — viewer must be in the story's audience (else the §1.34 `404`). `403 canvas_closed` when `canvas_mode:'off'` **and, byte-identically, when the viewer is canvas-banned** (`story_canvas_bans` — a ban is never confirmable). Status: `'live'` under `open` (and always for the story author), `'pending'` under `approve`. Cap `OVERLAYS_PER_USER` (5) live+pending per (story, contributor), counted under the story row lock (the TROUBLESHOOTING counter-race pattern) → `409 overlay_limit`. Rate `OVERLAY_RATE_PER_HOUR` (60). |
| `DELETE /api/stories/:id/overlays/:overlayId` | — | `204` — the STORY AUTHOR (any overlay — one-tap remove) or the OVERLAY AUTHOR (their own). Sets `status:'removed'` (tombstone: reports must outlive moderation; serializes to nobody, frees the cap). Idempotent. |
| `POST /api/stories/:id/overlays/:overlayId/approve` | — | `200 {overlay}` — story author only; `pending` → `live`. `409 overlay_not_pending` otherwise. |
| `PUT /api/users/:id/canvas-ban` / `DELETE` | — | `204` — ban/unban `:id` from ALL my canvases, present and future (idempotent; `400 block_self` shape for self). Existing overlays by the banned user stay until removed (the author already has one-tap remove). |
| `GET /api/users/me/canvas-bans` | — | `200 {users: UserLite[]}` — my list (the §1.14 blocks-list pattern; no timestamps). |

**Serialization (binding).** `Story.overlays` carries `live` overlays in
`created_at ASC` (paint order), PLUS `pending` ones **only** to their author
and the story author. Blocked pairs are invisible both ways: an overlay whose
author is blocked w.r.t. the viewer is dropped from that viewer's DTO (and a
blocked viewer never saw the story at all, §1.34). The contributor strip
("🎨 maya, arjun +3") derives client-side from overlay FACES — no contributor
counter is ever serialized alone (PSYCHOLOGY rule 3). Live updates ride
`story.updated` (§2.3) to the story's audience; **no push, ever** (stories
stay ambient, §1.34).

**Reports:** `POST /api/reports {kind:'story_overlay', story_id, overlay_id,
reason?}` — any viewer of the story; the server stamps the overlay author as
`target_user_id` (identity attached — migration 0010's shape CHECK) and the
admin preview carries the vector payload (`AdminReport.target_overlay`).
Removed overlays stay reportable while the story lives.

**Render contract (binding):** overlays draw above the media in normalized
0..1 coordinates; tapping one highlights it + shows the chip; reduced-motion
disables entrance animations (layers simply appear); the §1.21 doodle brush
is the stroke tool. The client never rasterizes overlays into saved/shared
media.

### 1.67 Public share pages (v0.8b — ADR-020, FEATURES #79c)

Every **PUBLIC-audience** post, beacon and listing can have ONE stable,
revocable share token (`share_tokens`, migration 0010 — the ADR-007
invite-token doctrine); stories only by the author's explicit mint, dying
with the story; groups per §1.68. The web app serves SSR pages `/p/<token>`
(`/s/<token>` for stories) with full OG/twitter tags; **`PUBLIC_ORIGIN`
governs every absolute URL** (the §1.53 `publicOrigin()` rule + the
TROUBLESHOOTING entry), and the SSR fetch re-sends `x-forwarded-for` (the
house SSR-hop rule). **Friends-only content never gets a token** — and a
token outlives nothing: every public read re-checks the object LIVE.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/share-links` | `{type: 'post'\|'beacon'\|'listing'\|'story'\|'group', id}` | `200 {share_link: ShareLink}` — mint-or-return the object's ONE open token. Authorization: post/beacon/listing → the object is PUBLIC (`audience:'public'` / `is_public`) AND visible to me → else `400 not_public` (invisible object → `404 not_found`, §1.14 shape); story → **author only** (`404` otherwise — "Create share link" is the author's act); group → owner/admin of a `public`\|`invite_only` group (`400 not_public` for private/ghost). |
| `DELETE /api/share-links/:token` | — | `204` — revoke (idempotent): object author, or the group's owner/admins, or a §1.41 admin. The page and every gated media URL die instantly. Deleting the object, narrowing its audience, cancelling the beacon, or a group leaving `public`/`invite_only` revokes route-side in the same transaction. |
| `GET /api/share/:token/public` | **UNAUTHENTICATED** | `200 {page: SharePage}` \| `404 share_not_found` — byte-identical for unknown, revoked, deleted, no-longer-public, expired-story, banned-author (no enumeration, no oracle). Live checks every read. Rate `SHARE_PUBLIC_RATE_PER_HOUR_PER_IP` (120). |
| `GET /api/share/:token/media/:attachmentId?v=` | **UNAUTHENTICATED** | Streaming proxy (the §1.11 invite-avatar pattern) — serves the attachment **iff** the valid token's object owns it: post attachments, listing photos, the story attachment, or a public-group message attachment with `seq > public_since_seq`. Anything else `404`. `Cache-Control: private, max-age=300` (`SHARE_MEDIA_CACHE_TTL_S`). Rate `SHARE_MEDIA_RATE_PER_HOUR_PER_IP` (240). **No open media routes exist** — `/api/media/:key` stays authed. |
| `GET /api/share/:token/avatar/:userId?v=static\|animated` | **UNAUTHENTICATED** | The author/sender avatar proxy, token-gated the same way (`:userId` must be the page's author or a rendered public message's sender — else `404`). |
| `POST /api/share/:token/report` | **UNAUTHENTICATED** `{reason: 1..500}` | `204` — the non-user report: stored as a reports row with `reporter_id NULL`, `reporter_ip` (aged by the retention GC), kind `'share_page'`, and the resolved `{target_object_type, target_object_id}` + author snapshot → the §1.41 admin queue. Reason REQUIRED. **Hard rate limit** `SHARE_REPORT_RATE_PER_DAY_PER_IP` (5) → `429`. Unknown/revoked token → `404` (same shape as the page). |

**Page contracts (binding).** Shapes in §0 `SharePage`. Author chips carry
username + display_name + the token-gated avatar path — **no ids, no
UserLite, no last-seen, no mood**. Beacon pages show `needs` (the §1.15
utility number) and **no joiner faces or identities**; location renders the
LABEL only (lat/lng never ship to strangers); poll options+counts render
read-only (§1.50's counts-on-options rule). Viewing is free; **ANY
interaction** (react, comment, join, wave, profile, "see more") routes to
`/register?next=<deep-link>` — after signup/login the client completes the
deep link back to the object in-app. OG tags: og:title/description from the
content (author display name + excerpt), og:image = the first gated media /
avatar proxy URL (absolute via `PUBLIC_ORIGIN` — unfurlers get exactly what
any stranger gets).

**GC (worker, queue `gc`, nightly):** prune tokens whose object is gone
(dead uuid) or whose story expired — bookkeeping only; reads already 404
live.

### 1.68 Group visibility modes (v0.8b — ADR-020, FEATURES #79d)

`conversations.visibility` (`private` DEFAULT / `invite_only` / `public` /
`ghost`, **groups only** — DB CHECK; DMs and channels are untouched), plus
`description` (≤ `GROUP_DESCRIPTION_MAX_CHARS`) and `public_since_seq`
(migration 0010).

| Method & path | Request | Response |
|---|---|---|
| `PATCH /api/conversations/:id/visibility` | `{visibility?, description?, confirm?}` | `200 {conversation}` — **group admins only** (`403 forbidden`; non-groups `400 bad_conversation_type`). Switching **to `public`** requires `confirm: true` (`400 confirm_required` — the admin-confirmed switch) and, in ONE transaction: stamps `public_since_seq = last_seq`, drops a `system` message (`event:'visibility_changed'`, `metadata.system.visibility:'public'` — every member's timeline says it plainly), fans `conv.updated`. Switching **away from `public`**: clears `public_since_seq` + revokes the group's share token (a later re-publicize stamps a FRESH floor — history never retro-exposed). Switching **to `ghost`**: `confirm: true` required; auto-assigns masks to every current member (GHOST_MASK pools) in the transaction + the system message. **A ghost group never switches away** → `400 ghost_is_forever` (members spoke under masks; no admin toggle may unmask them — ADR-020). |
| `POST /api/conversations/:id/join` | — | visibility `public` → `200 {status:'joined', conversation}` — any non-banned user; participant inserted with `join_seq = last_seq` (§1.4 floor; the §1.14 group-coexistence rule applies to blocks), `400 group_too_large` at 256. `invite_only` → `202 {status:'requested'}` — parks a `group_join_requests` row (idempotent re-request `202`). `private`/`ghost` → `404 not_found`, **byte-identical to an unknown id** (unlisted means unlisted). Rate `GROUP_JOIN_RATE_PER_HOUR` (20). |
| `GET /api/conversations/:id/join-requests` | — | `200 {requests: GroupJoinRequestRow[]}` — admins only, oldest first (a queue, not a ranking). |
| `POST /api/conversations/:id/join-requests/:userId/approve` | — | `200 {conversation}` — admin; one transaction: insert participant (§1.4 floor + `participant_added`-style system message), delete the request, `conv.new` to the joiner. Gone request → `404`. |
| `DELETE /api/conversations/:id/join-requests/:userId` | — | `204` — deny: deletes the row, **silently** — no event, no notice, nothing for the requester to refresh against (the no-rejection-surface rule; their button simply stays "requested" until they ask again). |
| `PUT /api/conversations/:id/mask` | `{mask_name ≤ 32, mask_emoji ≤ 16}` | `200 {conversation}` — MY mask in a GHOST group I'm a member of (`400 not_ghost` otherwise); the returned conversation's `my_mask` carries the mask now worn. Unique per group → `409 mask_taken` (the previous mask — often the auto-assigned one — stays on, still readable via `my_mask`). Fans `conv.updated` (members see the mask change; nothing links old to new name for non-admins beyond the event itself). |

**Share pages (ties into §1.67).** `invite_only` → the `group_card` page:
name, avatar (token-gated), `description`, `member_count` — **never
messages**; the join CTA deep-links to the in-app request flow.
`member_count` here is join-decision utility (how alive is this group), the
ADR-012 trust-information argument re-made in ADR-020 — it never ranks,
compares or rewards, and stays OFF every in-app surface (§1.35's rule
stands). `public` → the `group_live` page: the card + a **read-only** tail of
messages with `seq > public_since_seq` ONLY (≤ `SHARE_GROUP_PAGE_MESSAGES_MAX`
per page, older pages by cursor, floored at `public_since_seq` ALWAYS);
senders render with real identity — the switch was admin-confirmed, the
system message announced it, and the DTO's `public_since_seq` keeps a
**persistent member banner** on screen ("messages here are publicly
readable"). Tombstones, undone messages and system noise never render.
`ghost` → **no share page exists**, and no token can be minted.

**👻 Ghost semantics (binding).** Unlisted EVERYWHERE: no discovery/search
listing, never a `shared_groups` signal in §1.64, `recordActivity` skips
ghost conversations entirely (no `game_won` leak), no share token, invites
are the only door (§1.11, minted by admins). **Masks at serialization:** to a
non-admin member, every OTHER member identity inside the group's payloads
(participants, senders, §1.18 surfaces, reactions, stamps, system
actor/target ids, `metadata.game` player ids — every DTO path, REST and WS
alike) serializes as the MASK UserLite — `id` = a derived pseudo-id (HMAC of
(conversation_id, user_id) with a server secret: stable within the group,
linkable to nothing outside it), `username: ''`, `display_name` = mask name,
empty avatar shell, `mood: null`, `name_style: 'none'`, `mask_emoji` set
(§0). The viewer's OWN rows serialize with their REAL identity (a client must
find itself — bubble alignment, "my role", my-turn detection); the pseudonym
the OTHERS see them as is the explicit own-mask field
`Conversation.my_mask: {name, emoji}` (§0) — the ghost banner and the mask
editor read it, and it is how a member learns the auto-mask a
`409 mask_taken` left them wearing. A §1.27 game challenge in a ghost group
may name its opponent by the pseudo-id the client sees; the server resolves
it back to the real participant (the mapping never leaves the server).
**Calls are refused in ghost groups** (`POST …/calls` →
`400 call_bad_conversation`): call DTOs and §2.12 signaling frames carry real
user ids before anyone accepts — masks never ring. A live call straddling the
switch-to-ghost is ended in the same breath, and the §1.42 call LOG
(pre-switch history) serializes pseudo-id-masked to non-admin members.
**Group admins see real identities** (abuse handling needs a responsible
adult — the #77 precedent), plus each member's mask. Presence, typing, last-seen and §1.18
seen-by are **suppressed entirely** in ghost groups (they are identity side
channels; receipts still advance watermarks for MY unread counts, serialized
as the §1.13 receipts-off shape). @mentions are not parsed (a mention is an
identity assertion). Push for ghost messages uses the group title only, never
a sender name. **Reports attach real identity**: a `kind:'message'` report
from inside a ghost group resolves the true sender in `AdminReport` — the
server was never anonymous.

### 1.69 Admin: content tab, support inbox, report context & update banner (v0.8b — ADR-020, FEATURES #81)

All §1.41 framing holds: admin-only (404-shaped to everyone else), every
action ring-logged, **no private-message reader exists**. The one bounded
exception (the consented context viewer) is spelled out below.

#### Content moderation tab (#81a)

| Method & path | Request | Response |
|---|---|---|
| `GET /api/admin/content?type=&q=&cursor=&limit=` | `type` `post`\|`beacon`\|`listing` (omitted = all); `q` ILIKE over title/body | `200 {items: AdminContentRow[], next_cursor}` — **PUBLIC surfaces only**: `audience:'public'` posts, `audience:'public'` beacons, ALL board listings (the board is instance-readable by design). These are things any member can already read — excerpts here cross no privacy line. `created_at DESC`. Private chats, friends-only posts and `friends` beacons are **not representable** in this endpoint, structurally. |
| `POST /api/admin/content/:type/:id/takedown` | `{reason: 1..500}` — REQUIRED | `200` — removes via the owning module's own semantics (post → the §1.36 delete cascade; beacon → `cancelled` + its §1.15 fan-out; listing → the author-delete path, share token revoked either way), **neutrally notifies the author** — one §1.69 Support-conversation message, `"A moderator removed your <post/beacon/listing>. Reason: <reason>"`, sender_id NULL (never a named admin, never a public mark on the author) — and ring-logs `{type, id, author_id, reason}`. `400 bad_admin_target` for an admin's own content (demote first, the §1.41 rule). |

#### Support inbox (#81b)

The user-facing intake is Settings → Help & feedback; the dialogue is an
ordinary conversation, so delivery, push, unread and receipts come free.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/support/tickets` | `{category: 'bug'\|'question'\|'idea'\|'safety', body: 1..2000, attachment_id?}` — attachment mine, kind `image`, `ready` (the optional screenshot) → `400 bad_attachment` | `201 {ticket}`. Rate `SUPPORT_TICKET_RATE_PER_DAY` (10). No fan-out (the inbox is pull for admins). |
| `GET /api/support/tickets` | — | `200 {tickets}` — mine, `created_at DESC`. |
| `GET /api/admin/support?status=&cursor=&limit=` | `status` filter, omitted = all | `200 {tickets: AdminSupportTicket[], next_cursor}` — open first, then `created_at DESC`. |
| `GET /api/admin/support/:id` | — | `200 {ticket, messages}` — the ticket + the user's **Support-conversation** dialogue (`Message[]`, `seq ASC`). This is NOT private-chat reading: the Support conversation exists to talk to the operator — consent is structural (ADR-020). |
| `POST /api/admin/support/:id/reply` | `{body: 1..2000}` | `200 {ticket}` — in one transaction: **lazily create the user's Support conversation** (type `group`, title `SUPPORT_CONVERSATION_TITLE` = "Bored Chat Support", `created_by NULL`, `metadata.support: true`, the user as sole `member` — no dm_key, no second human), insert the reply as an ordinary §1.5 message with `sender_id NULL` + `metadata.support = {ticket_id}` (clients render the Support brand, §0), set the ticket `answered`. Normal `msg.new` fan-out + §2.9 push — a support answer is a message like any other. |
| `POST /api/admin/support/:id/close` | `{note? ≤ 500}` | `200 {ticket}` — status `closed`; ring-logged. Idempotent. |

The user may reply **in the Support conversation** (they are a participant;
ordinary §1.5 send): a user message there re-opens their most recent
non-closed ticket (or the latest `closed` one) to `open` — route-side, no new
endpoint. Admins never appear as participants; they read via the ticket
viewer and speak via replies. The conversation is excluded from §1.64
`shared_groups`, §1.67/§1.68 sharing and §1.41 user-export counterparty rules
by construction (one member). The ticket's optional screenshot is the user's
**consented submission to the operator**: its `url`/`thumb_url` resolve for
active §1.41 admins through the `GET /api/media/:key` ACL (a dedicated
support-ticket-attachment branch) as well as for the ticket owner.

#### Report-context viewer (#81c)

The moderation path for private content remains **reports, with reporter
consent**. v0.8b makes the consent explicit and bounded: the §1.14 message
report gains `include_context: boolean` (default **false**), rendered in the
report sheet beside the EXACT copy `REPORT_CONTEXT_CONSENT_COPY` — "Also
share the 10 messages around this one with the moderators, so they can see
the context. Only this slice is shared, and only because you chose to."
(binding UX contract; the checkbox is unchecked by default and the report
sends fine without it).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/admin/reports/:id/context` | — | `200 {context: {conversation_id, messages: AdminContextMessage[]}}` — ONLY for `kind:'message'` reports with `context_consent: true`, else `404 report_context_unavailable` (byte-identical for wrong-kind/no-consent/unknown — consent is never probeable). The slice: the reported seq ± `REPORT_CONTEXT_RADIUS` (5) — **the reported message + 10 surrounding** — resolved LIVE (tombstones render `deleted: true`, edits show current text — the viewer shows what exists, not a snapshot). `body` is included — **the one admin surface with message bodies, and the reporter opened it**. Attachments are `{kind, mime}` metadata only (no admin media URLs exist). Ghost masks do NOT apply (the server was never anonymous, §1.68). **Every call is ring-logged** (`level:'admin'`, report id + admin). |

#### Update banner (#81d)

| Method & path | Request | Response |
|---|---|---|
| `GET /api/admin/update` | — | `200 {update: AdminUpdateStatus}` — `running_commit` = the `GIT_COMMIT` **build arg** baked into both images at `docker build` (null in dev — the banner then says "dev build"); `running_version` = the newest §1.61 `release_notes` version; `latest_commit` + `checked_at` from the worker's cached check; `update_available` = commits differ, **null when unknown** (no commit baked, or remote unreachable — documented honesty, never a guess). |

**The check (worker, queue `gc`, repeatable every `UPDATE_CHECK_INTERVAL_S`
= 6 h):** one GET of `<UPDATE_CHECK_REMOTE>/info/refs?service=git-upload-pack`
(env, default: the project's public repo URL) — the git HTTPS smart protocol's
advertisement, first-party git, **no API, no key, no SaaS** (golden rule 7
intact); parse HEAD's sha, cache `{latest_commit, checked_at}` in Redis
(`update:check`). Budget `UPDATE_CHECK_TIMEOUT_MS`, SSRF posture as §1.7
(fixed host from env, no redirect following beyond the unfurl rules). The
banner renders the §1.61 release-notes delta as its changelog plus the
instruction: **run `./bored update` on the host** — the container never gets
docker.sock and never updates itself (ADR-013's trust line, restated in
ADR-020).

### 1.70 Passkeys (v0.9 — ADR-021, FEATURES #82)

WebAuthn login (platform authenticators first; security keys work too), with
the password retained as fallback. **The ADR-001 session layer is untouched**:
a verified passkey assertion mints the exact same opaque-token `sid` session a
password login mints — passkeys (like everything in v0.9) only change how a
session **starts**. Server-side verification is `@simplewebauthn/server`
(version-pinned; the ONE sanctioned dependency exception — ADR-021 records
why and the pins); the browser side uses `@simplewebauthn/browser`. The
WebAuthn options/response JSON bodies are the W3C wire shapes owned by the
library — `packages/shared` validates them only as opaque JSON objects
(`WebAuthnJson`) and pins everything around them.

**rpID & origin:** rpID = `WEBAUTHN_RP_ID` env when set, else the hostname of
`PUBLIC_ORIGIN`, else `DOMAIN`. Expected origin = `PUBLIC_ORIGIN` when set,
else `https://<DOMAIN>` (plus the localhost dev origins outside production).
**Tunnel caveat (binding, tell the operator):** passkeys cryptographically
bind to the rpID domain — on a quick tunnel (`*.trycloudflare.com`) every new
tunnel is a new domain, orphaning every registered credential. The settings
page surfaces the active rpID and warns on known quick-tunnel suffixes;
recommend a stable domain before enrolling passkeys (ADR-021).

**Challenges are Redis TTL state, never rows** (`WEBAUTHN_CHALLENGE_TTL_S` =
300 s, one-shot: consumed by the verify, hit or miss).

| Method & path | Request | Response |
|---|---|---|
| `POST /api/auth/passkeys/options` | — (authed) | `200 {options}` — registration options: challenge stored at `webauthn:reg:{user_id}` (one pending registration per user; a new call replaces it), `excludeCredentials` = my registered ids (no dupes), platform-friendly `authenticatorSelection` (`residentKey:'preferred'`, `userVerification:'preferred'`). |
| `POST /api/auth/passkeys` | `{response, nickname? 1..32}` (authed) | `201 {passkey: PasskeyInfo}` — verifies against the stored challenge + rpID/origin, inserts the credential row. Cap `PASSKEYS_MAX` (10) → `409 passkeys_cap`, enforced under `pg_advisory_xact_lock` (the counter-race rule). Duplicate credential id → `409 passkey_exists`. Bad/expired challenge or failed verification → `400 bad_passkey`. |
| `GET /api/auth/passkeys` | — (authed) | `200 {passkeys: PasskeyInfo[]}` — `created_at ASC`. `PasskeyInfo` never carries the public key or counter — settings UI material only (nickname, transports, `device_type`, `backed_up`, created/last-used). |
| `PATCH /api/auth/passkeys/:id` | `{nickname: 1..32}` | `200 {passkey}`. `404` if not mine (the §1.14 shape). |
| `DELETE /api/auth/passkeys/:id` | — | `204`. `404` if not mine. Deleting the last passkey is fine — the password always remains. |
| `POST /api/auth/passkey-login/options` | `{username?}` — **unauthenticated**; username LOOSE (≤ 254 chars) | `200 {challenge_ref, options}`. With `username`: `allowCredentials` = that user's credential ids — but an **unknown username answers the same 200 with empty `allowCredentials` as a user who has no passkeys** (never an enumeration oracle; §1.44 doctrine). Without: discoverable-credential flow (`allowCredentials` empty by design). Challenge at `webauthn:auth:{challenge_ref}` (`challenge_ref` = 16 random bytes base64url). Rate `PASSKEY_LOGIN_RATE_PER_MIN` (10/min/IP). |
| `POST /api/auth/passkey-login` | `{challenge_ref, response}` | `200` **LoginOutcome**: `{user}` + `Set-Cookie: sid` (standard §1.1 session; `sessions.user_agent`/`ip` captured as at any login), or the §1.73 `{totp_required: true, totp_token}` when the account is TOTP-armed (SPECS #85: passkey login is gated like password login). On success: `counter` updated, `last_used_at` stamped. **A counter LOWER than stored = cloned-credential signal → `401 bad_credentials` + ring-log** (`level:'warn'`). Any verification failure, unknown credential, consumed/expired challenge_ref → the same `401 bad_credentials`. Suspended/banned → `403` as §1.1. Rate as options. |

### 1.71 QR cross-device login (v0.9 — ADR-021, FEATURES #83)

WhatsApp-Web style, **pure first-party, built on the sessions table**. The
logged-out laptop mints a short-lived link; the logged-in phone approves it;
the laptop's next poll mints a standard §1.1 session **on the laptop's own
request** — no token ever transits the phone, a QR relay service, or a DB row.

**Two codes, one row** (`login_links`, both stored sha256): the **full code**
(32 random bytes base64url) rides the QR as the URL `<origin>/link/<code>`
and is the laptop's poll/redeem capability; the **display code** (6 chars
from `LOGIN_LINK_DISPLAY_ALPHABET` — no 0/O/1/I/L) is the human fallback
typed into the phone's approve page, and can ONLY approve — its small
keyspace never polls or redeems, so the worst a lucky guesser achieves is
logging a stranger's laptop into the *guesser's own* account, rate-limited to
irrelevance. The QR itself renders client-side via the hand-rolled SVG
encoder in `apps/web/lib/qr.ts` (no dependency — ADR-021); the display code
is ALWAYS shown beneath it.

Status is a one-way `pending → approved → consumed` walk; every transition is
an atomic `UPDATE … WHERE status='<prev>' RETURNING` (the race rule). TTL
`LOGIN_LINK_TTL_S` (120 s), single-use; the login page simply mints a fresh
link when one expires. The `gc` job deletes rows an hour past expiry.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/auth/link` | — (**unauthenticated**, the laptop) | `201 {code, display_code, url, expires_at}` — `code` returned ONCE; `url` is the app-origin PATH `/link/<code>`. Captures the laptop's `user_agent` + ip (so the phone sees what it approves). Rate `LOGIN_LINK_CREATE_RATE_PER_HOUR` (30/h/IP). |
| `POST /api/auth/link/poll` | `{code}` (the laptop; loose ≤ 64) | `200 {status:'pending', expires_at}` until approved (client re-polls every `LOGIN_LINK_POLL_INTERVAL_MS` = 2 s — plain polling, no WS/SSE: the laptop has no session to upgrade with). First poll after approval: **atomically flips `approved → consumed`, mints the session for `approved_by` (standard §1.1 row + `Set-Cookie: sid`), stamps `new_session_id`** → `200 {status:'consumed', user}`. Unknown/expired/already-consumed code → `410 link_gone`, **byte-identical** in every case. |
| `POST /api/auth/link/lookup` | `{code}` (**authed** — the phone; full OR display code) | `200 {link: {created_at, expires_at, user_agent, ip_hint}}` — the approve sheet's facts about the laptop (`ip_hint` is coarse, e.g. the /24 or just "this network"/"elsewhere"). Unknown/expired → `410 link_gone`. Rate `LOGIN_LINK_APPROVE_RATE_PER_MIN` (5/min/user). |
| `POST /api/auth/link/approve` | `{code}` (**authed** — the phone) | `204` — atomic `pending → approved`, stamps `approved_by` = me. The phone's session is the factor; the sheet it just read is the informed consent. Expired/raced/unknown → `410 link_gone`. Suspended/banned approvers → `403` (their session is already dead per §1.41, defensive). Rate as lookup. |

**Web pages:** the login page gains a "Log in with your phone" panel (QR +
display code + countdown, re-mint on expiry); `/link/<code>` in the phone's
PWA opens the approve sheet (Portal, §1.56 toast on approve); a logged-OUT
phone opening `/link/<code>` sees login-first, then returns to the sheet.
After approval, the new session appears in `GET /api/auth/sessions` like any
other and is revocable from the phone (the §1.1 machinery — that is the
remote-logout story too).

### 1.72 Recovery codes (v0.9 — ADR-021, FEATURES #84)

Email-free account recovery. `RECOVERY_CODES_COUNT` (6) one-time codes,
generated **at registration** and shown ONCE (copyable + downloadable as a
.txt client-side); only sha256 rows persist. Display form `xxxxx-xxxxx`
(`RECOVERY_CODE_LEN` = 10 chars of `RECOVERY_CODE_ALPHABET`, ~49 bits);
inputs are normalized route-side (lowercase, strip `-`/spaces) and arrive
loose at the schema (the §1.1 invite_token doctrine).

**§1.1 changes:** `POST /api/auth/register` response gains
`recovery_codes: string[]` (the once-only reveal). The §1.1 note "Password
reset is CLI-only" is superseded: recovery codes are the user-facing path;
the CLI reset remains the operator's.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/auth/recovery-codes` | — (authed) | `200 {total, remaining, generated_at}` — status only, NEVER the codes (they are unrecoverable by design; `generated_at: null` for pre-v0.9 accounts, which the settings row turns into "generate yours now"). |
| `POST /api/auth/recovery-codes` | `{password}` (authed — re-proof, so a borrowed unlocked phone can't silently re-mint) | `200 {recovery_codes}` — **deletes the old set, inserts 6 fresh, one tx**; shown once. `401 bad_credentials` on wrong password. Ring-logged (`level:'warn'`, no codes in the log). Rate 5/h/user. |
| `POST /api/auth/recover` | `{username_or_email, code}` (**unauthenticated**) | `200 {reset_token}` — consumes the code **atomically** (`UPDATE … WHERE used_at IS NULL RETURNING`), **revokes ALL sessions (rows deleted, sockets closed 4401)**, and notifies: one §1.69 Support-conversation message ("A recovery code was just used on your account. If this wasn't you, your other codes may be compromised — regenerate them after you're back in.") + its ordinary push. NO session is minted — recovery **forces a new password** first. `reset_token` = one-shot Redis ref, `RESET_TOKEN_TTL_S` (15 min). Wrong code / unknown user / already-used → the same `401 bad_recovery`, byte-identical (no enumeration). Rate `RECOVERY_LOGIN_RATE_PER_HOUR` (5/h/IP — scorched-earth path, deliberately slow). |
| `POST /api/auth/password` | `{current_password, new_password ≥ 8}` (authed) | `200 {ok: true}` — change password while signed in. Re-proves the current password (`401 bad_credentials`), refuses the unchanged one (`400 same_password`), stores the new argon2id hash and **revokes every OTHER session** (their sockets close 4401) — the calling session stays. Ring-logged (`level:'warn'`). Rate 5/h/user. Settings → Devices & security → Password. |
| `POST /api/auth/reset-password` | `{reset_token, new_password ≥ 8}` | `200 {user}` + `Set-Cookie: sid` — sets the argon2id hash, consumes the token, mints the fresh session. Recovery **bypasses TOTP** by design (SPECS #85: it's the lost-authenticator path) — TOTP stays armed afterward. Expired/bogus token → `401 bad_reset_token`. |

### 1.73 TOTP 2FA (v0.9 — ADR-021, FEATURES #85)

Optional authenticator-app second factor. **RFC 6238 implemented by hand**
(HMAC-SHA1 via `node:crypto`; `TOTP_DIGITS` 6, `TOTP_PERIOD_S` 30, drift
±`TOTP_DRIFT_STEPS` step) — no dependency (ADR-021). The secret
(`TOTP_SECRET_BYTES` = 20) lives in `users.totp_secret`,
**AES-256-GCM-encrypted at rest** with a key HKDF-derived from
`SESSION_SECRET` (info `'totp:'`; stored `v1:<iv>:<ct>:<tag>` base64url).
Consequence, documented honestly: **rotating `SESSION_SECRET` orphans every
enrolled TOTP** — affected logins fall back to recovery codes and users
re-enroll (ADR-021 weighs this against plaintext and likes the trade).
A verified step is burned in Redis (`totp:used:{user_id}:{step}`, TTL one
window) so one code never authenticates twice.

**DTO change:** `UserPrivate += {totp_enabled: boolean}`.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/auth/totp/setup` | — (authed; `409 totp_enabled` if already armed) | `200 {otpauth_uri, manual_key, expires_at}` — a PENDING secret in Redis (`totp:pending:{user_id}`, `TOTP_SETUP_TTL_S` 10 min); **nothing touches the users row until a valid code proves the authenticator holds it**. `otpauth_uri` = `otpauth://totp/Bored%20Chat:<username>?secret=<b32>&issuer=Bored+Chat&algorithm=SHA1&digits=6&period=30` (`TOTP_ISSUER`), rendered client-side as a QR (the §1.71 hand-rolled encoder); `manual_key` = the base32 secret in groups of 4, ALWAYS shown + copyable. Re-call = fresh secret (replaces pending). |
| `POST /api/auth/totp/enable` | `{code: 6 digits}` | `200 {user}` — verifies against the PENDING secret, then writes `totp_secret` (encrypted) + `totp_enabled_at` in one tx, clears the pending key, fans `user.updated` (owner frame carries `totp_enabled`). Wrong code → `400 bad_totp_code` (pending survives until TTL); throttled per user (`TOTP_VERIFY_RATE_PER_MIN`/min) → `429`. The response is a natural moment for the client to re-surface recovery-code status (§1.72) — "these are your way back in". |
| `POST /api/auth/totp` | `{totp_token, code}` (**unauthenticated** — the second half of a login) | `200 {user}` + `Set-Cookie: sid`. `totp_token` is the one-shot ref a correct password (§1.1) or passkey (§1.70) earned; wrong code decrements its attempt budget (`TOTP_VERIFY_RATE_PER_MIN`, also per-IP) → `401 bad_totp_code`; token expiry/consumption → `401 bad_totp_token` (start the login over). |
| `POST /api/auth/totp/disable` | `{code}` XOR `{recovery_code}` (authed) | `200 {user}` — proof required: the current code, or one recovery code (**consumed**, the §1.72 atomic claim). Nulls both columns, fans `user.updated`, ring-logged. `400 bad_totp_code` / `401 bad_recovery`; throttled per user (`TOTP_VERIFY_RATE_PER_MIN`/min, both proof kinds share the budget — a hijacked session can't brute-force 2FA off) → `429`. |

**Login gating (§1.1/§1.70/§1.71 semantics):** with TOTP armed, a correct
password or verified passkey answers `200 {totp_required: true, totp_token}`
— **no session, no cookie** — and the client shows the 6-digit prompt. The
§1.71 QR login is NOT re-gated: the approving phone session already cleared
TOTP at its own login, and approval is an authed, informed action (ADR-021).
Recovery (§1.72) bypasses by design. `totp_token` reveals nothing and expires
in `TOTP_TOKEN_TTL_S` (5 min).

### 1.74 Admin: Authentication settings, OTP-ready (v0.9 — ADR-021, FEATURES #86)

Config-not-code readiness. All §1.41 framing holds (admin-only 404-shape,
ring-logged writes). The instance stores a full SMTP block + per-feature
toggles **today**; every email-dependent flow is specified to flag off
`instance_settings` at runtime — so when a mailer lands (a FUTURE release:
golden rule 10 means **no SMTP client ships in v0.9**, and ADR-021 says so
honestly rather than half-shipping one), enabling email verification / email
OTP / magic links / password-reset mail is **configuration, not code**. The
SMS-gateway slot stays a documented placeholder (no column, no key) until a
gateway design exists — SPECS #86 names the slot, not a schema.

**DTO changes:** `InstanceSettings += {auth: AuthSettings}` where
`AuthSettings = {smtp: {host, port, secure, username, from, password_set},
features: {email_verification, email_otp, magic_links, password_reset},
mailer_available}`. The §1.41 `PATCH /api/admin/settings` accepts
`auth: AuthSettingsPatch` (deep-partial; `smtp.password` is **write-only** —
set a string to store, `null` to clear, it never reads back:
`password_set: boolean` is all that serializes). `mailer_available` is
server-computed — `false` in v0.9, always.

**SMTP password storage:** its own `instance_settings` key
(`auth_smtp_password`), AES-256-GCM-encrypted with the SESSION_SECRET-derived
key (HKDF info `'smtp:'` — the §1.73 machinery, different domain separation).
The `SMTP_PASSWORD` env, when set, **takes precedence** over the stored value
(the env-reference option in SPECS #86) and the settings page then shows
"set via environment" with the field disabled.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/admin/settings` | — | `200 {settings}` — now includes `auth` (per §1.41; `password_set`, never the password). |
| `PATCH /api/admin/settings` | `{…, auth?: AuthSettingsPatch}` | `200 {settings}` — merges deep; ring-logged **without** the password value. Feature toggles persist even while inert (that is the point). |
| `POST /api/admin/settings/auth/test-send` | `{to: email}` | **v0.9: always `503 mailer_unavailable`** — the endpoint exists so the UI contract is stable, and answers honestly until a mailer ships. The admin page renders the Test send button disabled with "needs SMTP support in a future update" (binding UX copy class, §1.56), EXCEPT the config fields themselves, which save fine. |

**Admin → Authentication page (web):** SMTP block (host/port/secure/username/
from/password with `password_set` indicator), the four feature toggles —
each rendered with an inline "needs SMTP support in a future update" note and
disabled interaction while `mailer_available` is false (visible but inert,
SPECS #86's exact ask) — the Test send button (disabled, same note), the
SMS-gateway slot as a labeled "coming later" placeholder, and the §1.70 rpID
readout with the quick-tunnel warning.

### 2.1 Connection & handshake

- `GET wss://<host>/ws` — same-origin, the `sid` cookie rides the upgrade. No tickets, no
  tokens in URLs. Invalid/expired session → close `4401`.
- On success the server immediately sends:
  `{"t":"hello","d":{"user_id","session_id","server_time","heartbeat_ms":25000}}`
- Heartbeat: server sends protocol-level ping every 25 s; terminates after 60 s of silence
  (close `1001`). Browsers auto-pong; no app-level ping event.
- **Session binding:** registry is `Map<sessionId, Set<socket>>`. Logout, session revocation,
  or expiry closes all of that session's sockets with `4401`. Client reaction to `4401`:
  attempt one `GET /api/users/me`; on 401 route to login, otherwise reconnect (cookie was
  refreshed elsewhere).
- Reconnect policy (client): exponential backoff 1 s → 30 s with jitter; on every (re)connect
  run the catch-up procedure (§2.8).

### 2.2 Framing

JSON text frames: `{"t": "<event>", "d": { ... }}`. Unknown `t` values MUST be ignored by both
sides (forward compatibility). Malformed client frames → `{"t":"error"}` reply; three strikes →
close `1008`.

### 2.3 Server → client events

| `t` | `d` payload | Notes |
|---|---|---|
| `hello` | `{user_id, session_id, server_time, heartbeat_ms}` | first frame |
| `msg.new` | `{conversation_id, message: Message}` | fan-out to all active participants' sockets |
| `msg.updated` | `{conversation_id, message: Message}` | **full fresh DTO, replace by `(conversation_id, seq)`** — late link-preview cards, video poster/thumb/blurhash hydration after the worker finishes, Phase-2 edits/tombstones. v0.4 reuses it verbatim for: audio waveform/duration hydration (§1.20), the vibe message's growing reply collage (§1.23), disappearing-message tombstones (§1.25), tic-tac-toe moves (§1.27). |
| `attachment.ready` | `{attachment: Attachment}` | to the **uploader only**, when processing finishes before the attachment is bound to a message (composer still open) |
| `receipt` | `{conversation_id, user_id, last_delivered_seq, last_read_seq}` | **coalesced server-side: at most one per (conversation, user) per 1000 ms** (trailing flush, nothing lost — watermarks are monotonic state) |
| `typing` | `{conversation_id, user_id, expires_at}` | client clears the indicator at `expires_at` (~6 s); there is no stop event |
| `presence` | `{user_id, online: boolean, last_seen_at?: string}` | only for users the socket subscribed to |
| `conv.new` | `{conversation: Conversation}` | you were added / created it on another device |
| `conv.updated` | `{conversation: Conversation}` | title, membership, group-avatar flip |
| `user.updated` | `{user: UserPublic}` | profile/avatar change of any conversation peer — fires when the avatar transcode lands (`avatar.version` bumped → swap the image). v0.8a (§1.57/§1.58): also fired on mood set/clear/expiry/swing-rotation and `name_style` changes; the `mood` field is stamped **per recipient** at the gateway under the §1.57 visibility+blocks resolution (§2.11), so one envelope never ships one viewer's view to another. Zod defaults (`mood: null`, `name_style: 'none'`) keep pre-v0.8 frames parsing clean. |
| `reaction.updated` | `{conversation_id, seq, kind, emoji, count, user_id, removed}` | v0.2 (§1.12): one frame per effective reaction add/remove, to all active participants. `count` is the NEW total for that `(message, emoji)`; `count: 0` removes the chip; `mine` is derived client-side (`user_id === me`). Reconnect truth is the DTO aggregate, not frame replay. v0.4 (§1.19): `kind` (`'emoji'`\|`'stamp'`, default `'emoji'` so v0.2 frames parse clean); stamp frames carry the `:stamp:` sentinel as `emoji`, recipients resolve the stamper's avatar from participants they hold, and reconnect truth is `Message.stamps`. |
| `preview.ready` | `{url_hash, status: 'ok'\|'failed', preview?: LinkPreview}` | to the user who requested the unfurl (composer card) |
| `beacon.new` | `{beacon: Beacon}` | v0.3 (§1.15): **only to sockets of users in the beacon's audience** (minus blocks) — never to anyone who cannot join (PSYCHOLOGY rule 2). The DTO is viewer-specific: the gateway stamps `my_state`/`conversation_id` per recipient (§2.11). |
| `beacon.updated` | `{beacon: Beacon, reping: boolean, edited: boolean, changed: string[]}` | v0.3: joins/leaves/spark/expiry/cancel, to the audience. On spark, non-joiners receive `conversation_id: null` (their card retires; spark details reach joiners + creator only). `reping: true` marks the single "needs 1 more" re-notification (§1.15). v0.7 (§1.47): `edited: true` marks a creator edit and `changed` names the edited fields (⊆ `BEACON_EDITABLE_FIELDS`) so cards can flash the right chips — the DTO carries the full new state either way; Zod defaults (`false`, `[]`) keep pre-v0.7 frames parsing clean. |
| `beacon.kudos` | `{beacon_id, kind, from: UserLite}` | v0.3 (§1.15): **to the recipient's sockets only.** Private by construction — never fanned to the group, never counted publicly. |
| `plan.updated` | `{beacon_id, conversation_id, roles: BeaconRole[]}` | v0.3 (§1.16): full roles list on every role mutation, to the plan conversation's active participants. Idempotent replace; reconcile from `GET /api/beacons/:id/roles`, never frame replay. |
| `poll.updated` | `{poll_id, conversation_id, seq, counts: number[], total_votes, user_id?, option_idx?: number\|null}` | v0.3 (§1.17): one delta per effective vote/unvote (`option_idx: null` = unvoted), to active participants — the `reaction.updated` pattern. `user_id`/`option_idx` ride **only the voter's own frame** (their other devices reconcile `my_vote`); frames to everyone else carry aggregates only (no per-voter lists, §1.17). Reconnect truth is `message.poll`. |
| `conv.background` | `{conversation_id, background: Attachment\|null}` | v1.0a (#95): the SHARED chat background changed — to **all active members'** sockets (conversation-level state, unlike `prefs.updated`). Full replace; reconnects reconcile from the prefs GET. |
| `conv.appearance` | `{conversation_id, theme: ChatTheme\|null, wallpaper: ChatWallpaper\|null}` | #95b: the SHARED theme/wallpaper changed — to **all active members'** sockets (conversation-level state, like `conv.background`). Full replace of both; reconnects reconcile from the prefs GET. |
| `prefs.updated` | `{conversation_id, prefs: ConversationPrefs}` | v0.4 (§1.24): **to the owner's own sockets ONLY** — prefs are personal, my-view-only state; no other participant ever receives a frame about them. Full-prefs replace (idempotent, reorder-safe); reconnects reconcile from `GET /api/conversations/:id/prefs`. v0.8a (§1.60): `prefs.background` rides along, same owner-only rule — nobody else ever learns a background exists. |
| `scheduled.updated` | `{scheduled: ScheduledMessage}` | v0.4 (§1.26): **to the author's own sockets ONLY** (a pending schedule is private until delivery), on every create/cancel/send — cross-device sync of the scheduled list. The delivery itself reaches everyone as an ordinary `msg.new`. |
| `connection.updated` | `{connection: Connection, removed: boolean}` | v0.5a (§1.28): **to the two parties only** — and not even both for every transition: request → addressee + requester's own sockets; accept → both; decline → addressee's own sockets only (the requester is never pinged about a rejection); remove → the actor's own sockets only. The DTO is viewer-specific (`user`/`direction` stamped per recipient at the gateway, the `beacon.*` pattern). `removed: true` means the row is gone (decline/remove) and the DTO is its last state. |
| `story.new` | `{story: Story}` | v0.5a (§1.34): **only to sockets of the author's friends-of audience minus blocks** — never to anyone who cannot view it. `viewed` stamped `false` per recipient. No push. Expiry fans nothing — expired stories drop out of the next `GET`. |
| `post.new` | `{post: Post}` | v0.5a (§1.36): **only to sockets of the author's friends-of audience minus blocks.** No push. Reactions/comments deliberately fan out NOTHING — viewers reconcile from `GET /api/feed` / `GET /api/posts/:id` when they return (no approval pings, PSYCHOLOGY rules 3/4). v0.7 (§1.50): `join_card` frames carry **`ref_summary: null`** — the summary is viewer-specific (joiner faces minus the viewer's blocks, §1.14 visibility, `my_state`), so the broadcast never ships one user's view to another; each client resolves its own via `GET /api/posts/:id` before rendering the card. |
| `call.updated` | `{call: Call}` | v0.6 (§1.42): SERVER-emitted on every durable call transition (create, first join, member join/leave, reject, end, ring timeout), to the conversation's active participants. Full-DTO replace by `call.id`; reconnect truth is `GET /api/conversations/:id/calls`, never frame replay. |
| `call.invite` / `call.ringing` / `call.accept` / `call.reject` / `call.offer` / `call.answer` / `call.ice` / `call.leave` / `call.end` | relayed (§2.12) | v0.6: RELAYED ephemeral signaling — client frames validated, authorized and forwarded per recipient with `from_user` stamped server-side; **never persisted, never replayed**. Full shapes + recipient sets in §2.12. |
| `call.state` | `{call_id, from_user, state}` | v0.7.1 (§1.55/§2.12, ADR-017): relayed connection-state report (`connecting`/`connected`/`reconnecting`/`failed`) to all live call members — peers' tiles say the truth. Ephemeral like all §2.12 frames. |
| `watch.start` / `watch.sync` / `watch.stop` | relayed (§2.12) | v0.6 (§1.43): relayed watch-together state. start/sync carry the FULL state (`conversation_id, video_id, host, position_s, playing`) so mid-session joiners lock on from the next sync; stop carries `{conversation_id}`. |
| `discovery.matched` | `{conversation_id, user: UserLite}` | v0.6 (§1.44): to BOTH parties of a mutual wave, each frame stamped with the OTHER party (the `connection.updated` pattern). A single wave fans out NOTHING to anyone, ever. |
| `roulette.matched` | `{conversation: Conversation}` | v0.6 (§1.45): to both matched users — the provisional DM (viewer-stamped `roulette.kept`). The icebreaker arrives as ordinary `msg.new`. |
| `roulette.expired` | `{conversation_id}` | v0.6 (§1.45): the keep window lapsed — the conversation is hard-deleted server-side; clients drop local state. Carries no "who didn't keep" (no rejection surface). Offline clients reconcile via §2.8 (absent from the snapshot). |
| `anon.updated` | `{thread: AnonThread, message: AnonMessage\|null}` | v0.8b (§1.62): **to the thread's TWO parties only**, each frame VIEWER-STAMPED (the `connection.updated` pattern — `role`/`counterpart` resolve per recipient, so the recipient's frame carries `counterpart: null` until reveal while the sender's names the recipient; one envelope never ships one party's view to the other). Fired on new messages (`message` non-null), reveal-mode set, reveal request, and the reveal itself (sender tap or timer sweep). Reconnect truth is `GET /api/anon/threads`, never frame replay. |
| `story.updated` | `{story: Story}` | v0.8b (§1.66): full-story replace on canvas changes (overlay add/remove/approve, `canvas_mode` switch) — to the story's **audience sockets only** (the `story.new` set), viewer-stamped (`viewed`; `pending` overlays serialize only to their author and the story author, so a pending-only change fans only to those two). Reconnect truth is `GET /api/stories`. |
| `discovery.nudge` | `{}` | v0.8b (§1.63): the in-app wave nudge — to the recipient's own sockets, at most once per opt-in (worker-claimed), ONLY when the visible pool ≥ `NUDGE_MIN_POOL` and `wave_nudges` is on. Deliberately EMPTY: no identity, no count, no per-card deep link (the no-rejection rule). The offline counterpart is the §2.9 nudge push, same guards. |
| `error` | `{code, message}` | validation/permission errors on client frames |

### 2.4 Client → server events

| `t` | `d` payload | Semantics |
|---|---|---|
| `delivered` | `{conversation_id, seq}` | "I have **durably stored** (IndexedDB-committed) everything up to `seq`." Server: `last_delivered_seq = GREATEST(stored, seq)`; broadcast coalesced `receipt`. **Push acceptance never triggers this** — only a running client after local persist (receipt honesty). Inbound `delivered`/`read` frames are themselves coalesced server-side to at most one watermark apply per (socket, conversation) per 1000 ms — lossless (max seq wins, read implies delivered) — and a frame that advances nothing is dropped without fan-out, so frame floods cannot amplify into DB/receipt load. |
| `read` | `{conversation_id, seq}` | same monotonic update for `last_read_seq`; server also raises `last_delivered_seq` to at least `seq` (read implies delivered). Sent when the conversation is visible/scrolled. |
| `typing` | `{conversation_id}` | server stamps `expires_at = now()+6s` and rebroadcasts to other participants. Client re-sends every ~4 s while typing; **no `typing.stop`** — expiry handles death mid-keystroke. |
| `presence.sub` | `{user_ids: string[]}` | subscribe to presence for on-screen users only. Cap 100 per socket; each must share a conversation with you, else silently dropped. Server replies with one immediate `presence` per id. |
| `presence.unsub` | `{user_ids: string[]}` | stop receiving |

| `call.invite`, `call.ringing`, `call.accept`, `call.reject`, `call.offer {sdp, to_user}`, `call.answer {sdp, to_user}`, `call.ice {candidate, to_user}`, `call.leave`, `call.end` | all carry `call_id` | v0.6 ephemeral call signaling — validated by Zod, authorized per frame, relayed to the recipients in §2.12, dropped. Never persisted. Durable call transitions stay REST (§1.42): these frames never write the `calls` row. |
| `call.state` | `{call_id, state}` | v0.7.1 (§1.55/§2.12): self-reported aggregate connection state, one frame per transition (a healthy call sends two, ever). Live-member-gated like `call.leave`; relayed with `from_user` stamped. ICE restarts ride the existing `call.offer`/`call.answer` — no restart frame exists. |
| `watch.start {conversation_id, url}` / `watch.sync {conversation_id, position_s, playing}` / `watch.stop {conversation_id}` | — | v0.6 watch together (§1.43): participant-gated; `sync` is host-only; the video id is parsed server-side from `url`. §2.12 has the rules. |

Durable writes (messages, conversation ops, watermark-affecting sends) are **not** accepted
over WS — REST only (§1.5). The v0.6 `call.*`/`watch.*` frames are upstream **ephemeral
signals** (the typing precedent), not writes: losing one loses a moment of UX, never state.

### 2.5 Send → delivered → read, end to end

1. Sender POSTs the message (§1.5). **sent** = the `201` response (it carries `id` + `seq`).
2. Server fans `msg.new` to every active participant's sockets; for participants with no live
   socket it enqueues a debounced push job (guards in §2.9).
3. Each receiving client persists to IndexedDB, then sends `delivered {conversation_id, seq}`
   (clients send their max contiguous stored seq — one frame covers a burst).
4. Opening/viewing the conversation sends `read {conversation_id, seq}`.
5. Server updates watermarks monotonically and broadcasts coalesced `receipt` events.
6. Sender UI derives ticks locally, no extra queries:
   - DM: delivered/read when the peer's watermark ≥ message.seq.
   - Group: delivered/read-by-all when `min(watermark over active participants) ≥ seq`
     (group size ≤ 256 keeps this O(participants) math trivial).

Out-of-order or duplicated events are harmless by construction: messages apply idempotently by
`(conversation_id, seq)`, watermarks are monotonic maxima.

### 2.6 Typing flow

keypress → client throttles to one `typing` per 4 s → server rebroadcasts with `expires_at` →
receivers show "typing…" until `expires_at` or that user's `msg.new` arrives. No stuck state:
a dead client simply stops refreshing.

### 2.7 Presence flow

- First socket for a user: api sets Redis `SET presence:{user_id} 1 EX 60`, refreshed every
  heartbeat; publishes `online` on the `events` channel → `presence` to subscribers.
- Last socket closed: after a **15 s grace** (debounces refresh/navigation), if no new socket,
  delete the key, flush `users.last_seen_at`, broadcast `offline` with it.
- Presence lives in Redis (not process memory) so the worker's push guards read the same truth.
- No global broadcasts ever — only `presence.sub` subscribers receive updates.

### 2.8 Reconnection / offline catch-up (deterministic, stateless)

No WS resume tokens, no server-side per-device mailbox — `seq` cursors make sync exact:

1. Client state (IndexedDB): all message bodies + per-conversation `max_seq_stored`, plus an
   outbound queue of unsent messages (keyed by `client_msg_id`) and pending read positions.
2. On (re)connect, **first open the socket, then** call `GET /api/sync`. Events arriving while
   the snapshot loads are applied idempotently — duplicates harmless, gaps impossible.
3. Diff the snapshot: for each conversation where `last_seq > max_seq_stored`, page the gap
   with `GET /api/conversations/:id/messages?after_seq=<max_seq_stored>&limit=100` until caught
   up (open conversation first, others lazily). New conversations in the snapshot are adopted
   wholesale; conversations missing from it were left/deleted.
4. Watermarks need **no replay**: the snapshot carries every participant's current cursors
   (monotonic state beats event streams).
5. Flush the outbound queue via the idempotent REST send; flush pending `read` positions; send
   one `delivered` per caught-up conversation.

A client offline for a month syncs exactly as correctly as one that blinked for a second.

### 2.9 Push interplay (guards, spelled out)

Push job per (user, conversation, message), enqueued only when the user has no live socket at
send time. At execution the worker **skips** when any of:
- Redis presence shows the user online now;
- fresh DB read: `last_read_seq >= message.seq` (read on another device);
- `muted_until > now()`;
- a per-`(user_id, conversation_id)` debounce key (5 s) exists — bursts collapse to one push.

**v0.5a mention override (§1.33):** when `metadata.mentions` names the target
user, the `muted_until` guard is **skipped for that user** (all other guards
hold). A mention NEVER overrides a block — blocked pairs are structurally
excluded from push fan-out (§1.14) and stay that way. Mention pushes fire at
send time only; §1.30 edits never (re-)push.

**v0.7 joiner notifications (§1.47):** beacon edited / cancelled /
starting-soon pushes go to **current joiners only** (starting-soon also to
the creator of a sparked plan), through every guard above unchanged — no
overrides, no new exceptions. The wider audience is never pushed about a
plan changing shape (PSYCHOLOGY rule 2); blocks stay structural.

**v0.7.1 ring push (§1.55, ADR-017, FEATURES #88):** on call create, every
callee passing the guards above **who has no live socket** (the online-now
guard, doing its usual job — a live socket rings via `call.invite`) gets a
`call.ring` push. Copy (v1.0): DM — title is the caller's display name, body
`Incoming <kind> call`; group — title is the group title, body
`<Caller> — incoming <kind> call` (the caller is always resolved, so a rung
member knows WHO is calling before opening the app).
Differences from message push, and ONLY these: the
5 s debounce key is per **call** (one ring push per call per user, never
collapsed with message pushes); the read-elsewhere guard does not apply (no
seq); the web-push `TTL` header is `CALL_RING_PUSH_TTL_S=45` with
`Urgency: high` — a ring that cannot be delivered within the ring window must
never arrive late. `muted_until` suppresses it (no mention-style override —
a call is not a mention) and blocked pairs stay structurally excluded. The
notification shows **Answer / Decline** actions (`PUSH_ACTION_ANSWER`/
`PUSH_ACTION_DECLINE`) where the platform supports them (iOS Safari does
not — a plain tap behaves as Answer): **Answer** (and plain tap) deep-links
to `data.url` (the call screen, which runs the normal §1.42 join); **Decline**
on a DM has the worker POST `/api/calls/:id/reject` itself (the `sid` cookie
rides the worker's same-origin fetch; it sets `X-Requested-With: fetch`), on
a group (`data.is_group`) it just closes the notification — a group decline
is personal and ephemeral (§1.42) and there is nothing durable to write. The
moment the call is handled anywhere, a **silent `call.ring.stop` push**
(same `tag: call:<call_id>`) reaches the same subscriptions and the worker
closes the notification, showing nothing (§1.55 has the `call:{id}:rang`
machinery). Payload shapes: `CallRingPushPayload` / `CallRingStopPushPayload`
in `packages/shared` — the first push payloads with a `kind` discriminator;
kind-less payloads stay plain notifications exactly as before.

Payload: `{title, body (snippet | "Photo" | "Video" | "File"), tag: conversation_id,
data: {url: "/c/<conversation_id>"}}`. The service worker shows the notification and deep-links
on click. It never sends `delivered` (§2.4). 404/410 or 5 consecutive failures prune the
subscription.

### 2.10 Close codes

| Code | Meaning | Client action |
|---|---|---|
| `4401` | unauthenticated / session revoked or expired | probe `GET /api/users/me`; 401 → login, else reconnect |
| `1001` | server going away / heartbeat timeout | reconnect with backoff |
| `1008` | protocol violation (repeated malformed frames) | reconnect once; report |
| `1013` | overloaded, try later | reconnect with backoff, min 10 s |

### 2.11 Privacy filtering at the gateway (v0.3 — ADR-009)

The Redis `events` channel stays a trusted, unfiltered firehose between api
and worker; **all privacy filtering happens at the per-socket edge** (the WS
gateway and REST serializers), where the recipient is known. Binding rules:

- `typing`: dropped at ingest when the sender's `show_typing` is off; never
  rebroadcast between blocked pairs.
- `receipt`: `last_read_seq` clamped to `0` both when the **reader** has
  `read_receipts` off (frames to others) and when the **recipient viewer**
  has it off (reciprocity) — own-session frames always carry true values.
  `last_delivered_seq` is never clamped.
- `presence`: `last_seen_at` omitted unless the subscriber qualifies under the
  target's `show_last_seen`; subscriptions between blocked pairs are silently
  dropped at `presence.sub` time (indistinguishable from the existing
  not-shared-a-conversation drop).
- `beacon.*`: the api publishes one envelope naming the beacon + audience;
  the gateway resolves recipients (friends/area/public minus blocks) and
  stamps the viewer-specific fields (`my_state`, `conversation_id`, filtered
  `joiners`) per socket before sending.
- v0.5a (§1.35): `typing` frames for **channel** conversations are dropped at
  ingest unconditionally (whatever `show_typing` says); `receipt` frames for
  channels are delivered to the **reader's own sockets only** (cross-device
  unread sync — never a 10k fan-out per read).
- v0.5a (§1.28/§1.34/§1.36): `connection.updated` recipients are the
  per-transition sets in §2.3 (declines/removals never reach the other party);
  `story.new` / `post.new` envelopes name the author — the gateway resolves
  the friends-of audience minus blocks and stamps viewer-specific fields
  (`viewed`, reaction `mine`) per socket, exactly like `beacon.*`.
- v0.6 (§2.12): `call.*` and `watch.*` frames are authorized per frame at the
  gateway (active participant; live call member past the invite stage) and
  never relayed between blocked pairs — in a group call a blocked pair simply
  never exchanges offers, so no media path forms between them (ADR-014
  documents the consequence honestly: they can still see each other's tiles
  via common peers' presence in the member list, exactly as they can see each
  other's messages in a shared group, §1.14). `discovery.matched` /
  `roulette.*` recipients are the two parties only.
- v0.8a (§1.57): `user.updated` envelopes name the owner; the gateway stamps
  `mood` per recipient under the §1.57 resolution (visibility
  everyone/connections/nobody ∩ not-blocked; expired ⇒ `null`) before
  sending — the same per-socket stamping as `beacon.*`/`post.new`. A hidden
  mood serializes exactly like no mood, so visibility settings are never
  confirmable from frames. The same resolution runs in every REST serializer
  that emits a UserLite/UserPublic — there is no unfiltered path.

### 2.12 Ephemeral call & watch signaling (v0.6 — ADR-014, §1.42/§1.43)

The v0.3 design sentence "signaling = more ephemeral WS event types over the
existing gateway" (ARCHITECTURE §8), cashed in. **Contract:** every frame in
this section is validated by Zod (`packages/shared/src/ws.ts`), authorized
per frame, **relayed to specific recipients, and dropped** — never written to
Postgres or Redis, never replayed on reconnect. The durable truth is the
`calls` row (REST, §1.42); a client that reconnects mid-call re-learns the
world from `call.updated`/`GET …/calls` and re-negotiates peers (below). SDP
and ICE payloads are **opaque bounded strings** to the server (≤ 64 KiB /
≤ 2 KiB): relayed verbatim, never parsed, never logged.

**Gateway rules (binding):**

- **Authorization per frame:** sender must be an active participant of the
  call's conversation; for every frame except `call.invite`/`call.ringing`/
  `call.accept`/`call.reject`, also a live member of the call (Redis set).
  Violations → `{"t":"error","d":{code:'call_not_member'|'not_found'}}`
  (404-shaped codes where a block could otherwise be confirmed).
- **Addressing:** `to_user` (on `offer`/`answer`/`ice`) is consumed by the
  gateway — the frame goes to that user's sockets only, and only if they are
  a live call member (else silently dropped — they just left; the
  `call.updated` catching the sender up is already in flight). All other
  call frames fan to the per-frame recipient sets below. `from_user` is
  **stamped server-side** on every relayed frame; sender claims are ignored.
- **Blocked pairs** never exchange relayed frames (§2.11). Suspended/banned
  accounts have no sockets (4401 machinery) and are skipped in fan-out.
- **Flood guards (every relayed frame):** per-socket fixed 10 s windows, keyed
  by (kind, call) — `call.ice` ≤ 50, `call.offer`+`call.answer` ≤ 30 (each can
  carry 64 KiB of SDP), `call.invite` ≤ 2 (it fans to every participant),
  `call.ringing`/`accept`/`reject`/`leave`/`end` ≤ 20 combined, `call.state`
  ≤ 20 on its own (v0.7.1 — a flapping network must not starve the hang-up
  budget),
  `watch.start` ≤ 5, `watch.sync` ≤ 40, `watch.stop` ≤ 5 — the `watch.*`
  gates keyed per (socket, conversation); `watch.sync` additionally honors at
  most one frame per `WATCH_SYNC_MIN_INTERVAL_MS=250` (40 = 10 s window /
  250 ms, so a host obeying the interval exactly fills the budget). Budgets
  are sized so no real client ever hits them. Excess is dropped without error
  (signaling degrades, nothing breaks), and the check runs BEFORE
  authorization, so over-budget frames cost no DB/Redis work and the strike
  system stays reserved for malformed frames. The per-socket gate map is
  capped at 64 live windows (made-up ids cannot grow it); the `watch.sync`
  min-interval stamp is recorded only when a sync is authorized and relayed,
  so it too is bounded by real state, never by spam.

**Relayed call frames and their recipients** (`d` shapes in `ws.ts`):

| `t` | sender | relayed to |
|---|---|---|
| `call.invite {call_id}` | initiator, right after the `201` | every OTHER active participant's sockets (minus blocks/suspension); gateway enriches to `{call_id, conversation_id, kind, from_user}` so callees ring with zero fetches |
| `call.ringing {call_id}` | a callee device that is ringing | initiator's sockets (caller UI: "Ringing…") |
| `call.accept {call_id}` | the accepting callee (right before/with REST join) | initiator's sockets + the sender's OWN other sockets (which stop ringing) |
| `call.reject {call_id}` | a declining callee | initiator's sockets + sender's own other sockets. In a DM the durable flip is REST §1.42; in a group this frame is ALL a decline is — personal, ephemeral, the call keeps ringing for others |
| `call.offer {call_id, to_user, sdp}` | the JOINING peer | `to_user`'s sockets, as `{call_id, from_user, sdp}` |
| `call.answer {call_id, to_user, sdp}` | the answering existing peer | `to_user`'s sockets |
| `call.ice {call_id, to_user, candidate}` | either peer, trickled | `to_user`'s sockets |
| `call.leave {call_id}` | a member hanging up (group) | all live call members (tiles drop instantly; REST end is the durable record) |
| `call.end {call_id}` | the member whose REST end terminates the call | all live call members + all ringing callees (stop ringing everywhere) |
| `call.state {call_id, state}` (v0.7.1 — §1.55, ADR-017) | any live member, once per transition of its aggregate connection state (`connecting`/`connected`/`reconnecting`/`failed`) | all live call members, as `{call_id, from_user, state}` — peers render honest tiles ("reconnecting…"). Advisory UI truth only: no server state changes, no persistence; a stale `reconnecting` is corrected by the next frame or the member's `call.leave`/`call.updated` |

**Offer direction — one rule everywhere:** *the joining peer offers.* In a DM
the callee joins, so the callee offers to the initiator; on every group join
the joiner offers to **each existing member** (≤ `CALL_MESH_MAX−1 = 7`
offers), who each answer. Deterministic roles kill glare: an existing member
never offers to a joiner. For mid-call renegotiation (track changes, ICE
restart) the **lower user id is the impolite peer** (perfect-negotiation
pattern, applied per pair).

**ICE restart (v0.7.1 — §1.55, ADR-017) adds no frame.** On
`iceConnectionState 'disconnected'` persisting
`CALL_ICE_DISCONNECT_GRACE_MS=3000` (or `'failed'` at once), the impolite
peer of the pair refreshes TURN credentials (§1.42
`GET /api/turn-credentials` + `setConfiguration`), calls `restartIce()` and
re-offers over the ordinary `call.offer`/`call.answer` pair — the gateway
cannot tell a restart from any other renegotiation and must not try. Bounded:
`CALL_ICE_RESTART_MAX_ATTEMPTS=3` per pair with
`CALL_ICE_RESTART_BACKOFF_MS=[2000,4000,8000]`; the attempting client reports
`reconnecting` / `failed` via `call.state` either side of the window.

**1:1 handshake, end to end:**

```
caller                          server                          callee
POST /conversations/:id/calls ─▶ calls row (ringing), timer,
  ◀─ 201 {call, turn}            member set = {caller}
ws call.invite ────────────────▶ relay (enriched) ─────────────▶ all callee devices ring
  ◀────────────────────────────  relay ◀──────────────────────── ws call.ringing
                                 ...callee taps accept...
  ◀────────────────────────────  relay ◀──────────────────────── ws call.accept
                                 POST /calls/:id/join ◀───────── (durable: ringing→ongoing)
  ◀─ call.updated (ongoing) ───  fan-out ──────────────────────▶ other devices stop ringing
  ◀────────────────────────────  relay ◀──────────────────────── ws call.offer {to_user: caller}
ws call.answer {to: callee} ───▶ relay ────────────────────────▶
ws call.ice ⇄ ─────────────────▶ relay (both directions) ⇄ ────▶ ws call.ice ⇄
         ...media flows peer-to-peer (host candidates, else TURN relay)...
either: POST /calls/:id/end ───▶ completed; call.updated + relay of ws call.end
```

No answer within `CALL_RING_TIMEOUT_S=45` → the `timers` job flips it to
`missed` (§1.42 missed-call machinery). Reject (DM): callee POSTs reject →
`rejected`, `call.updated`; the `call.reject` frame already stopped the UIs.

**Group mesh join:** `POST /api/calls/:id/join` → `200 {call, turn}` with
`participant_ids` = current members → joiner sends `call.offer` to **every**
member, answers and ICE trickle back per pair → full mesh. `CALL_MESH_MAX=8`
is enforced in the join's atomic Redis check-and-add (`409 call_full`) — by
the time anyone can offer, the cap already held. Leave = `call.leave` frame
(instant) + REST end (durable membership/row); peers close that
`RTCPeerConnection` and keep the rest of the mesh. A reconnecting member
re-joins (idempotent REST) and re-offers to everyone — the one rule again.

**Watch together frames** (§1.43 has the semantics):

| `t` | sender | relayed to |
|---|---|---|
| `watch.start {conversation_id, url}` | any active participant (becomes host) | all active participants, as the full state `{conversation_id, video_id, host, position_s: 0, playing: false}`. Errors: `watch_bad_url`, `watch_active`. |
| `watch.sync {conversation_id, position_s, playing}` | HOST only (`watch_not_host` otherwise) | all active participants, enriched with `video_id` + `host`; refreshes the Redis TTL. Clients >2 s off the relayed position seek to it. |
| `watch.stop {conversation_id}` | host — or anyone once the host has no live socket | all active participants; deletes the Redis key. TTL expiry behaves as a stop without the frame (clients also end on keepalive silence > TTL). |

### 1.75 My gallery (v1.0a — #94, migration 0012)

A PRIVATE view over MY OWN media: attachments I uploaded that are bound
anywhere (messages, posts, listings, comments, stories, profile media, chat
backgrounds) or kept alive by a `gallery_saves` row. The one save source
today is the **story auto-saver**: the expiry sweep moves the author's story
media into their gallery (insert + skip the attachment hard-delete) instead
of destroying it; an author's explicit `DELETE /api/stories/:id` remains a
full delete. Nothing here changes who can SEE anything — it is the uploader
reading their own uploads through the §1.6 auth-checked proxy.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/users/me/gallery` | `?kind=image\|video&saved=&cursor=&limit=` (≤100, default 50) | `200 {items: GalleryItem[], next_cursor}` — newest first, keyset `(created_at, id)`. `GalleryItem = {attachment, saved, source}`; `saved=true` rows are kept by a save (deletable here), others live where they are bound. `saved=1` narrows to saves only. |
| `DELETE /api/users/me/gallery/:attachmentId` | — | `204` idempotent — removes MY save row; the attachment re-orphans into the ordinary 24 h GC unless something else still binds it. Never deletes bound media. |

- **GC:** the orphan sweep anti-joins `gallery_saves_attachment_idx` —
  deleting the save re-orphans; the sweep stays the only destroyer.
