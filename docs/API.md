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

Message = { id, conversation_id, seq, sender_id: string|null,  // null = system
  type: 'text'|'image'|'video'|'file'|'system', body: string|null,
  metadata: { link_preview?: LinkPreview, system?: { event: string, actor_id?: string, target_id?: string } },
  reply_to_id: string|null, attachments: Attachment[],
  created_at, edited_at: string|null, deleted_at: string|null }

Participant = { user: UserPublic, role: 'member'|'admin', joined_at, join_seq,
  left_at: string|null, last_delivered_seq, last_read_seq, muted_until: string|null }

Conversation = { id, type: 'dm'|'group', title: string|null,
  avatar: { status, version, static_url: string|null, animated_url: string|null },
  created_by: string|null, last_seq, last_message_at: string|null,
  participants: Participant[], created_at }

ConversationListItem = Conversation & { unread_count: number,   // last_seq - my last_read_seq
  last_message: Message|null }
```

Avatar URLs are content-hashed media-proxy URLs (`/api/media/:key`), immutable-cacheable;
`avatar.version` tells clients when to swap.

---

## 1. REST endpoints

### 1.1 Auth

| Method & path | Request | Response |
|---|---|---|
| `POST /api/auth/register` | `{username, email, password, display_name}` (username `^[a-z0-9_]{3,24}$`, password ≥ 8) | `201 {user: UserPrivate}` + `Set-Cookie: sid`. `409 username_taken \| email_taken`. Rate 3/hour/IP. |
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
| `POST /api/conversations/:id/messages` | `{client_msg_id, type: 'text'\|'image'\|'video'\|'file', body?, attachment_ids?: string[], metadata?: {link_preview?: LinkPreview}}` | `201 {message}` (`200` on idempotent replay). Must be an active participant. `attachment_ids` must be yours and unbound (binds them, clears `share_import_id`). `metadata.link_preview` is validated against the `link_previews` cache row for the same URL, then **snapshotted into the message**. Server extracts the first URL from `body` when no snapshot was supplied and enqueues an unfurl → recipients get the card via `msg.updated`. Transaction: bump `last_seq` → insert → raise sender's own watermarks to the new seq → commit → fan out `msg.new` → enqueue push for offline participants. |

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
| `msg.updated` | `{conversation_id, message: Message}` | **full fresh DTO, replace by `(conversation_id, seq)`** — late link-preview cards, video poster/thumb/blurhash hydration after the worker finishes, Phase-2 edits/tombstones |
| `attachment.ready` | `{attachment: Attachment}` | to the **uploader only**, when processing finishes before the attachment is bound to a message (composer still open) |
| `receipt` | `{conversation_id, user_id, last_delivered_seq, last_read_seq}` | **coalesced server-side: at most one per (conversation, user) per 1000 ms** (trailing flush, nothing lost — watermarks are monotonic state) |
| `typing` | `{conversation_id, user_id, expires_at}` | client clears the indicator at `expires_at` (~6 s); there is no stop event |
| `presence` | `{user_id, online: boolean, last_seen_at?: string}` | only for users the socket subscribed to |
| `conv.new` | `{conversation: Conversation}` | you were added / created it on another device |
| `conv.updated` | `{conversation: Conversation}` | title, membership, group-avatar flip |
| `user.updated` | `{user: UserPublic}` | profile/avatar change of any conversation peer — fires when the avatar transcode lands (`avatar.version` bumped → swap the image) |
| `preview.ready` | `{url_hash, status: 'ok'\|'failed', preview?: LinkPreview}` | to the user who requested the unfurl (composer card) |
| `error` | `{code, message}` | validation/permission errors on client frames |

### 2.4 Client → server events

| `t` | `d` payload | Semantics |
|---|---|---|
| `delivered` | `{conversation_id, seq}` | "I have **durably stored** (IndexedDB-committed) everything up to `seq`." Server: `last_delivered_seq = GREATEST(stored, seq)`; broadcast coalesced `receipt`. **Push acceptance never triggers this** — only a running client after local persist (receipt honesty). |
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
