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
temporary password, revokes all sessions).

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
| `POST /api/uploads` | streaming multipart, field `file` (+ optional `share_import_id`) | `201 {attachment: Attachment}`. MIME **sniffed from magic bytes** (client claim advisory); images: EXIF-stripped, 512px WebP thumb + blurhash computed inline → `status:'ready'`; video: stored + `media` job enqueued (ffprobe, poster via `-vf thumbnail`, faststart remux) → `status:'pending'`, hydrates via WS; files: stored verbatim → `ready`. Limits: image 25 MB, video 100 MB, file 100 MB → `413`. |
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
| `DELETE /api/conversations/:id/participants/:userId` | (§1.4, extended) | self = leave (**anyone leaves freely, including admins**); owner/admins remove members; admins are removable by the owner only. The **owner cannot leave or be removed** → `403 owner_cannot_leave` (transfer/deletion is future scope — the channel must never be headless). |

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

---

## 2. WebSocket protocol

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
| `user.updated` | `{user: UserPublic}` | profile/avatar change of any conversation peer — fires when the avatar transcode lands (`avatar.version` bumped → swap the image) |
| `reaction.updated` | `{conversation_id, seq, kind, emoji, count, user_id, removed}` | v0.2 (§1.12): one frame per effective reaction add/remove, to all active participants. `count` is the NEW total for that `(message, emoji)`; `count: 0` removes the chip; `mine` is derived client-side (`user_id === me`). Reconnect truth is the DTO aggregate, not frame replay. v0.4 (§1.19): `kind` (`'emoji'`\|`'stamp'`, default `'emoji'` so v0.2 frames parse clean); stamp frames carry the `:stamp:` sentinel as `emoji`, recipients resolve the stamper's avatar from participants they hold, and reconnect truth is `Message.stamps`. |
| `preview.ready` | `{url_hash, status: 'ok'\|'failed', preview?: LinkPreview}` | to the user who requested the unfurl (composer card) |
| `beacon.new` | `{beacon: Beacon}` | v0.3 (§1.15): **only to sockets of users in the beacon's audience** (minus blocks) — never to anyone who cannot join (PSYCHOLOGY rule 2). The DTO is viewer-specific: the gateway stamps `my_state`/`conversation_id` per recipient (§2.11). |
| `beacon.updated` | `{beacon: Beacon, reping: boolean}` | v0.3: joins/leaves/spark/expiry/cancel, to the audience. On spark, non-joiners receive `conversation_id: null` (their card retires; spark details reach joiners + creator only). `reping: true` marks the single "needs 1 more" re-notification (§1.15). |
| `beacon.kudos` | `{beacon_id, kind, from: UserLite}` | v0.3 (§1.15): **to the recipient's sockets only.** Private by construction — never fanned to the group, never counted publicly. |
| `plan.updated` | `{beacon_id, conversation_id, roles: BeaconRole[]}` | v0.3 (§1.16): full roles list on every role mutation, to the plan conversation's active participants. Idempotent replace; reconcile from `GET /api/beacons/:id/roles`, never frame replay. |
| `poll.updated` | `{poll_id, conversation_id, seq, counts: number[], total_votes, user_id?, option_idx?: number\|null}` | v0.3 (§1.17): one delta per effective vote/unvote (`option_idx: null` = unvoted), to active participants — the `reaction.updated` pattern. `user_id`/`option_idx` ride **only the voter's own frame** (their other devices reconcile `my_vote`); frames to everyone else carry aggregates only (no per-voter lists, §1.17). Reconnect truth is `message.poll`. |
| `prefs.updated` | `{conversation_id, prefs: ConversationPrefs}` | v0.4 (§1.24): **to the owner's own sockets ONLY** — prefs are personal, my-view-only state; no other participant ever receives a frame about them. Full-prefs replace (idempotent, reorder-safe); reconnects reconcile from `GET /api/conversations/:id/prefs`. |
| `scheduled.updated` | `{scheduled: ScheduledMessage}` | v0.4 (§1.26): **to the author's own sockets ONLY** (a pending schedule is private until delivery), on every create/cancel/send — cross-device sync of the scheduled list. The delivery itself reaches everyone as an ordinary `msg.new`. |
| `connection.updated` | `{connection: Connection, removed: boolean}` | v0.5a (§1.28): **to the two parties only** — and not even both for every transition: request → addressee + requester's own sockets; accept → both; decline → addressee's own sockets only (the requester is never pinged about a rejection); remove → the actor's own sockets only. The DTO is viewer-specific (`user`/`direction` stamped per recipient at the gateway, the `beacon.*` pattern). `removed: true` means the row is gone (decline/remove) and the DTO is its last state. |
| `story.new` | `{story: Story}` | v0.5a (§1.34): **only to sockets of the author's friends-of audience minus blocks** — never to anyone who cannot view it. `viewed` stamped `false` per recipient. No push. Expiry fans nothing — expired stories drop out of the next `GET`. |
| `post.new` | `{post: Post}` | v0.5a (§1.36): **only to sockets of the author's friends-of audience minus blocks.** No push. Reactions/comments deliberately fan out NOTHING — viewers reconcile from `GET /api/feed` / `GET /api/posts/:id` when they return (no approval pings, PSYCHOLOGY rules 3/4). |
| `error` | `{code, message}` | validation/permission errors on client frames |

### 2.4 Client → server events

| `t` | `d` payload | Semantics |
|---|---|---|
| `delivered` | `{conversation_id, seq}` | "I have **durably stored** (IndexedDB-committed) everything up to `seq`." Server: `last_delivered_seq = GREATEST(stored, seq)`; broadcast coalesced `receipt`. **Push acceptance never triggers this** — only a running client after local persist (receipt honesty). Inbound `delivered`/`read` frames are themselves coalesced server-side to at most one watermark apply per (socket, conversation) per 1000 ms — lossless (max seq wins, read implies delivered) — and a frame that advances nothing is dropped without fan-out, so frame floods cannot amplify into DB/receipt load. |
| `read` | `{conversation_id, seq}` | same monotonic update for `last_read_seq`; server also raises `last_delivered_seq` to at least `seq` (read implies delivered). Sent when the conversation is visible/scrolled. |
| `typing` | `{conversation_id}` | server stamps `expires_at = now()+6s` and rebroadcasts to other participants. Client re-sends every ~4 s while typing; **no `typing.stop`** — expiry handles death mid-keystroke. |
| `presence.sub` | `{user_ids: string[]}` | subscribe to presence for on-screen users only. Cap 100 per socket; each must share a conversation with you, else silently dropped. Server replies with one immediate `presence` per id. |
| `presence.unsub` | `{user_ids: string[]}` | stop receiving |

Durable writes (messages, conversation ops, watermark-affecting sends) are **not** accepted
over WS — REST only (§1.5).

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
- Filtering is serialization-only: no stored watermark, presence key, or
  beacon row is ever rewritten by a settings change, so toggles apply (and
  un-apply) instantly and retroactively.
