# SocialChat — Final Architecture (v1.0)

Synthesis base: Proposal 0 (ship-fast chassis — one origin, cookie sessions, proxied uploads,
single server package). Grafted: Proposal 1's correctness machinery (seq log as PK, `GET /sync`
snapshot, receipt coalescing, receipt-honesty rule, `join_seq`, migrate service, magic-byte
sniffing, 256-member cap, ADRs) and Proposal 2's product machinery (server-side share inbox,
eager unfurl, `msg.updated` hydration, blurhash, avatar motion hygiene, representative poster
frame, faststart remux). Every weakness the judges penalized in P0 is fixed and marked **[fix]**.

Companion docs: `SCHEMA.sql` (DDL), `API.md` (REST + WS protocol), `ROADMAP.md` (build order).

---

## 1. Stack — every major decision, one-line rationale

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere (strict) | one language, shared Zod types across web/api/worker kill protocol drift |
| Frontend | Next.js 15, App Router, standalone output, PWA | SSR + share-target route + manifest/SW in one app |
| API framework | Fastify 5 + `fastify-type-provider-zod` | NestJS DI is team scaffolding; Fastify plugin-folders give the same structure with ~40% less code |
| WebSockets | raw `ws` library | Socket.IO's replay/rooms duplicate what the seq-based sync already guarantees; one delivery mechanism, not two |
| ORM / migrations | Drizzle ORM + drizzle-kit SQL migrations | typed SQL-first queries; partial indexes and the seq transaction need real SQL control |
| DB | PostgreSQL 17 | single total-order machine; per-conversation seq is a row-lock transaction |
| Queue | BullMQ on Redis 7 (`--appendonly yes`) | boring, durable-enough jobs; Redis also holds presence + pub/sub events channel |
| Object storage | MinIO (private bucket, compose-network only) | S3 API without S3; never exposed through the proxy |
| Media processing | FFmpeg via `execa` + sharp | no wrapper libs; sharp inline for images, ffmpeg in the worker for video/avatars |
| Proxy / TLS | Caddy 2 | automatic HTTPS is the one-command-deploy cheat code |
| Auth | opaque DB sessions in httpOnly cookie — **no JWT** | one origin means cookies work for REST, SSR, *and the WS upgrade*; JWTs would still need a revocation store (= the sessions table) so they are strictly extra parts |
| WS auth | session cookie on the upgrade request | removes the entire ticket/refresh choreography; registry keyed by session id so logout/revocation closes live sockets instantly |
| Receipts | watermark cursors on `conversation_participants` | O(participants), not O(messages × participants); the one model that survives Phase-2 channels |
| Message ordering | gapless per-conversation `seq`, `PRIMARY KEY (conversation_id, seq)` | assigned transactionally; ordering, receipts, unread, sync, push-dedup all reduce to integer compares |
| Durable sends | REST only; WS is a downstream event pipe + ephemeral upstream signals | free idempotent retries; a dropped socket can never lose a message; share composer works before a socket exists |
| Offline sync | `GET /sync` full snapshot + `after_seq` gap-fill *(graft P1)* | O(conversations), unconditionally correct, no missed-event class, no per-device mailbox |
| Uploads | proxied streaming multipart through the API | presigned URLs need MinIO exposure + CORS + confirm callbacks; double-hop is free on one box; swapping later touches only the `uploads` module |
| Monorepo | pnpm workspaces; `packages/shared` + one server package with two entrypoints | worker reuses schema/MinIO/config verbatim; no Turborepo needed at this size |
| IDs | UUIDv7, generated app-side | time-ordered, index-friendly, safe to expose |
| Enums | `text + CHECK`, never PG enums | adding a value later is a one-line migration |
| Migrations | dedicated run-once `migrate` compose service *(graft P1)* | **[fix]** removes the worker-races-api-boot-migrations hole; also creates MinIO buckets |
| Decision log | `docs/adr/` one-pagers *(graft P1)* | highest-leverage memory aid a solo dev can keep |

Shared constants (`packages/shared/src/constants.ts`) — the invariants, one place:
`MAX_GROUP_PARTICIPANTS=256` *(graft P1: the cap that keeps O(participants) fan-out and receipt
math safe until channel work)*, `TYPING_TTL_S=6`, `PRESENCE_TTL_S=60`, `OFFLINE_GRACE_S=15`,
`RECEIPT_COALESCE_MS=1000`, `PUSH_DEBOUNCE_S=5`, `WS_PING_S=25`, `WS_IDLE_CLOSE_S=60`,
`PAGE_SIZE_DEFAULT=50`, `PAGE_SIZE_MAX=100`, size limits in §5, unfurl limits in §6.

---

## 2. Repo layout

```
socialchat/
├── pnpm-workspace.yaml
├── package.json                  # root scripts: dev, build, migrate, lint, test
├── .env.example                  # ONE env file for compose + local dev
├── docker-compose.yml
├── Caddyfile
├── docs/
│   ├── ARCHITECTURE.md  SCHEMA.sql  API.md  ROADMAP.md
│   └── adr/                      # ADR-001-cookie-sessions.md, ADR-002-watermark-receipts.md, ...
├── packages/
│   └── shared/                   # THE contract: zod schemas for every REST DTO + WS event,
│       └── src/{api.ts, ws.ts, constants.ts}          # shared limits/constants
└── apps/
    ├── web/                      # Next.js PWA
    │   ├── app/                  # routes incl. app/share/route.ts (share-target receiver)
    │   ├── public/{manifest.json, sw.js}
    │   └── Dockerfile
    └── server/                   # ONE package, TWO entrypoints, ONE image
        ├── src/
        │   ├── api.ts            # entrypoint: HTTP + WS process
        │   ├── worker.ts         # entrypoint: BullMQ consumers (avatar, media, unfurl, push, gc)
        │   ├── cli.ts            # entrypoint: ops commands (reset-password)
        │   ├── db/{schema.ts, migrate.ts, migrations/}
        │   ├── ws/{gateway.ts, registry.ts, events.ts}
        │   └── modules/{auth, users, conversations, messages, uploads, previews, share, push}/
        └── Dockerfile            # node:22-bookworm-slim + ffmpeg; used by api, worker, migrate
```

---

## 3. Services (docker compose, single VPS)

```
                         ┌──────────────────────────────── VPS ───────────────────────────────┐
  Internet ──443──▶ caddy ──┬── /api/*, /ws ──▶ api (Fastify + ws)  ◀─── Redis pub/sub "events"
                            └── /*           ──▶ web (Next.js SSR/PWA)            ▲
                                                   │                              │
                            api ──▶ postgres:5432 (truth: users/msgs/seq/cursors) │
                            api ──▶ redis:6379    (presence, BullMQ, pub/sub) ────┤
                            api ──▶ minio:9000    (private bucket "media")        │
                                                                                  │
                            worker (same image, node dist/worker.js) ─────────────┘
                              queues: avatar | media | unfurl | push | gc
                              talks to: postgres, redis, minio; runs ffmpeg/sharp

                            migrate (same image, run-once: drizzle migrations + bucket init)
                              api and worker: depends_on migrate service_completed_successfully
```

Eight services: `caddy`, `web`, `api`, `worker`, `migrate` (run-once), `postgres`, `redis`,
`minio`. Only caddy publishes host ports. One `.env` (DOMAIN, POSTGRES_*, MINIO_*, REDIS_URL,
SESSION_SECRET, VAPID keypair). Redis AOF on so queued jobs survive restarts.
`docker compose up -d` on a fresh VPS with DNS pointed = running product with TLS.

**Scaling honesty:** the WS socket registry is in-process → `api` stays at 1 replica. The worker
already consumes the Redis `events` channel, so "publish ALL fan-out through Redis channels"
is the designed ~50-line seam to multi-node; nothing in the protocol changes (no gateway holds
state that isn't reconstructible from Postgres + Redis).

Backups: documented, not automated — nightly `pg_dump` cron + MinIO volume rsync.

---

## 4. Auth design

**Opaque DB sessions in an httpOnly cookie. No JWT, no refresh rotation, no WS tickets.**

- Token: 32 random bytes base64url; cookie `sid` = `HttpOnly; Secure; SameSite=Lax; Path=/`.
  DB stores only `sha256(token)` (`sessions.token_hash`).
- Expiry: 30-day sliding — `expires_at` pushed forward on use; `last_seen_at` written at most
  hourly to avoid write churn. A sliding server session *is* the refresh mechanism, so P2's
  rotation grace-window machinery is unnecessary by construction.
- Passwords: **argon2id** (`m=64MiB, t=3, p=1`), min length 8.
- Rate limits (Redis fixed-window): login 10/min/IP, register 3/hour/IP.
- CSRF: `SameSite=Lax` + every mutating `/api` route requires header `X-Requested-With: fetch`
  (custom header forces CORS preflight, which cross-origin forms can't pass). The share-target
  POST is same-origin by construction (manifest `action` is on our origin) so it just works —
  this is also what dissolves P2's service-worker credential gap: the cookie rides the share
  POST, no token minting needed.
- **WS auth:** the `sid` cookie rides the `GET /ws` upgrade. Socket registry is keyed
  `Map<sessionId, Set<socket>>` (+ a `userId → sessionIds` index): `POST /auth/logout` and
  `DELETE /auth/sessions/:id` close that session's sockets immediately (code 4401); session
  expiry mid-socket also closes 4401 → client hits `/api/auth/*`, gets 401, routes to login.
  This keeps P0's judge-praised property: a revoked user never keeps a live socket.
- Sessions double as the device registry: `GET /auth/sessions` lists them, `DELETE` revokes.
  No separate `devices` table until native apps/E2EE (Phase 4 seam).
- Email verification + password reset flows: **cut**. `email_verified_at` column exists. Ops
  reset: `docker compose exec api node dist/cli.js reset-password <username>` prints a one-time
  temporary password and revokes all sessions. Documented in README.

---

## 5. Media & avatar pipeline

**Uploads are proxied** (streaming multipart → MinIO via busboy + S3 streams). The API sniffs
**magic bytes** on the first chunk; the client-declared MIME is advisory only *(graft P1)*.
Sniffed type decides `kind`; mismatch with per-kind allowlist → 415. Generic files are stored
with the sniffed MIME and always served `Content-Disposition: attachment` +
`X-Content-Type-Options: nosniff`.

Limits (shared constants, enforced during stream): avatar source ≤ 15 MB / ≤ 10 s used;
images ≤ 25 MB (`jpeg|png|webp|gif|heic`); video ≤ 100 MB (`mp4|webm` — served as uploaded,
**no full transcode in MVP**); files ≤ 100 MB (anything).

Object keys are content-hashed (`media/<sha256>.<ext>`) → `GET /api/media/:key` is an
auth-checked streaming proxy with `Cache-Control: private, max-age=31536000, immutable`.
MinIO is never reachable from outside the compose network.

**Avatar job (signature feature), BullMQ queue `avatar`** — same job serves users *and* group
conversations (a `target: {user_id} | {conversation_id}` discriminator; groups get animated
avatars nearly free):
1. `POST /users/me/avatar` (or `POST /conversations/:id/avatar`, admin) streams the original
   (GIF/WebP/APNG/MP4) to `raw/`, sets `avatar_status='processing'`, enqueues.
2. Worker downloads to tmpdir, ffprobe-validates (decodes OK, ≤ 4096 px, sane frame count),
   then runs ffmpeg via `execa`:
   - **animated WebP**: `-t 10 -vf "crop=min(iw\,ih):min(iw\,ih),scale=512:512,fps=min(24\,source_fps)" -c:v libwebp -q:v 75 -loop 0 -an`;
     if output > 2 MB, step down once (`-q:v 55`, 384 px) and retry *(graft P1 size budget)*.
   - **static JPEG fallback**: poster via `-vf "thumbnail=90,crop=...,scale=512:512" -frames:v 1`
     (representative frame — **[fix]** frame 0 of animated sources is often blank), q82, EXIF-free.
3. Upload both under content-hash keys; update target row: `avatar_status='ready'`, both keys,
   `avatar_version = avatar_version + 1` (the integer cache-buster — DTOs carry it, clients
   refetch on change); delete `raw/` original; publish `user.updated` (or `conv.updated`) on
   Redis `events` → api fans out over WS so the avatar pops in live. Failure → `'failed'`,
   previous avatar kept.
4. **Rendering contract** (client-enforced, specced here so it ships): conversation lists,
   message bubbles, member sheets, search results render the **static JPEG**; profile pages and
   the open-chat header render the **animated WebP** — gated by `prefers-reduced-motion` AND the
   user's `avatar_motion` setting (`auto|reduced|off`), with `IntersectionObserver` pausing
   off-screen animations *(graft P2 motion hygiene)*.

**Message media:**
- Images: processed inline in the API request with sharp (~50 ms, no queue hop): EXIF strip +
  auto-rotate, 512 px WebP thumb, dimensions, and a **blurhash** (computed on a 32 px downscale,
  stored on the attachment, inlined into message DTOs for instant placeholders) *(graft P2)*.
  Attachment is `ready` in the upload response.
- Video: attachment usable immediately (`status='pending'` for derived fields). Worker queue
  `media`: ffprobe dims/duration → poster via `-vf thumbnail` + 512 px WebP thumb + blurhash →
  **faststart remux** (`-c copy -movflags +faststart`) when the moov atom trails, so MP4s stream
  progressively without re-encoding *(graft P2)* → status `ready`, publish on `events`.
  **[fix]** Hydration is pushed, not punted: if the attachment is already bound to a message,
  participants get `msg.updated` (full fresh DTO); if not yet bound (composer still open), the
  uploader gets `attachment.ready`. No "placeholder until next fetch".
- Files: stored verbatim, icon by sniffed MIME, download-only disposition.

**Orphan GC:** nightly repeatable job (queue `gc`) deletes attachments where
`message_id IS NULL AND share_import_id IS NULL AND created_at < now()-24h`, expired
`share_imports` (and their attachments) after 7 days, expired `link_previews` rows + images,
and sessions past `expires_at`.

---

## 6. Share target + link unfurl (end to end)

**Manifest** (`apps/web/public/manifest.json`):
```json
{
  "name": "SocialChat", "display": "standalone", "start_url": "/",
  "share_target": {
    "action": "/share", "method": "POST", "enctype": "multipart/form-data",
    "params": { "title": "share_title", "text": "share_text", "url": "share_url",
                "files": [{ "name": "media", "accept": ["image/*", "video/*"] }] }
  }
}
```

**Flow (logged in):**
1. Installed PWA appears in the OS share sheet; OS POSTs multipart to Next route
   `app/share/route.ts` — session cookie included (same-origin POST).
2. The route immediately forwards the form to `POST /api/share-imports`: files are uploaded
   through the normal §5 pipeline and a **`share_imports` row is persisted the moment the POST
   lands** *(graft P2 server-side inbox — **[fix]** replaces P0's 5-min Redis stash: Android
   killing the page mid-share loses nothing, and the compose can resume on any device)*. If a
   URL is present, the unfurl job is **enqueued eagerly right here** *(graft P2)* — the card is
   usually ready before the user picks a recipient.
3. Responds `303 See Other → /compose?import=<id>` (POST-redirect-GET: snappy, refresh-safe).
4. `/compose` hydrates from `GET /api/share-imports/:id`: conversation picker + prefilled
   composer; preview card arrives via `preview.ready` WS event or the GET's embedded state.
5. Send = ordinary `POST /conversations/:id/messages` with `attachment_ids` and/or
   `metadata.link_preview` = the **card snapshot** (snapshotted into the message row at send
   time, not an FK — messages still render after the 7-day cache row is pruned or refreshed).
   Composer then marks the import consumed (`DELETE /api/share-imports/:id`).
6. Typed-in-chat URLs reuse the same `POST /api/previews` from the composer (debounced 800 ms).

**Flow (logged out) — [fix] shares are no longer dropped:** the share route detects no session
and POSTs the form to `POST /api/share-stash` (unauthenticated, hard-limited: ≤ 30 MB total,
≤ 3 pending stashes per IP, 30-min Redis TTL, objects under `stash/`), then redirects to
`/login?next=/share/claim/<stash_id>`. After login, `POST /api/share-imports/claim` promotes the
stash to a real `share_imports` row (rows + objects adopted, unfurl enqueued) and the normal
flow resumes.

**Unfurl pipeline:** `POST /api/previews {url}` → normalize URL (lowercase host, strip fragment
+ known tracking params) → `link_previews` lookup by `url_hash`. Hit (`ok`, unexpired) → cached
card. Miss → insert `pending`, enqueue `unfurl` job, return `{status:'pending'}` — **[fix] the
fetch runs in the worker, never the API process**, and is rate-limited **30/hour/user** (checked
at POST). On completion the worker updates the row and publishes `preview.ready` to the
requesting user. Failures are negative-cached `status='failed'` with `expires_at = now()+1h`
to stop retry storms. OK rows expire after 7 days (refetch on next request).

**SSRF protection (non-negotiable, all in the worker):**
- Schemes `http`/`https` only; **ports 80/443 only** **[fix]**.
- Resolve DNS ourselves; reject if ANY A/AAAA answer is private/reserved: `0.0.0.0/8`, `10/8`,
  `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.0.0.0/24`,
  `192.168/16`, `198.18/15`, `::`, `::1`, `fc00::/7`, `fe80::/10` — and **IPv4-mapped IPv6
  (`::ffff:a.b.c.d`) is unwrapped and re-checked against the v4 list** **[fix]**.
- Connect to the **pinned resolved IP** (undici `connect.lookup` override) with Host/SNI set to
  the original hostname — closes the DNS-rebinding TOCTOU.
- Redirects: max 3, every hop re-runs the full checklist; budget 5 s total; HTML read ≤ 1 MB;
  `Content-Type: text/html` required for parsing; no cookies, no auth forwarding; fixed honest
  `User-Agent: SocialChatBot/1.0 (+https://<domain>)`.
- Parse `og:title/description/site_name/image` → Twitter Card → `<title>` fallback (cheerio).
- `og:image`: fetched through the same guarded client, ≤ 5 MB, **re-encoded with sharp** to
  600 px WebP (re-encoding discards decompression-bomb/polyglot tricks) and stored in MinIO —
  preview images are always served from our origin, never hotlinked (readers leak no IPs).

---

## 7. Web push

- VAPID via `web-push`; subscriptions in `push_subscriptions` (unique endpoint, pruned after 5
  consecutive failures or 404/410).
- Enqueue on send for every participant without a live socket. Worker **guard conditions**
  (spelled out, all must pass): (a) Redis presence still shows user offline; (b) re-read
  `last_read_seq < message.seq` (they haven't read it on another device); (c) `muted_until`
  not in the future; (d) per-`(user, conversation)` debounce key, 5 s.
- Payload: `{title: sender or group title, body: snippet | "Photo" | "Video" | "File",
  tag: conversation_id, data: {url: /c/:id}}` — `tag` collapses stacked notifications.
- **Receipt honesty rule *(graft P1)*:** push acceptance by the service worker NEVER advances
  `last_delivered_seq`. Only a running client that has durably stored the message (IndexedDB
  write committed) sends `delivered`. The SW handler only shows the notification.

---

## 8. Phase-1 cut line

**OUT of the MVP (no code, no UI):** reactions, replies/threads UI, forwarding, message
edit/delete UI, starred/pinned messages, stories, broadcast channels, feed/posts/likes/comments,
rich professional profiles & connections, WebRTC calls, E2EE, full-text search, @mentions,
email verification / password-reset flows (CLI only), blocking & moderation tooling, admin
panel, contact import, native apps, multi-node deployment, video transcoding (originals served
as-is), disappearing messages, i18n.

**Phase-2 headroom (seams already cut, not promised):**
- **Replies/edits/deletes:** `reply_to_id`, `edited_at`, `deleted_at` exist; `msg.updated`
  already carries full-DTO replacement, so edits/tombstones are UI + one server branch; seqs
  are never reused, so no cursor arithmetic breaks.
- **Reactions / forwarding:** additive `message_reactions(message_id, user_id, emoji)` table +
  one WS event; forwarding is `metadata.forwarded_from` — zero migrations.
- **Channels:** one-line CHECK migration adds `'channel'` to `conversations.type`; watermark
  receipts are the entire reason a 50k-follower channel costs one cursor row per member;
  `join_seq` already enforces the history floor late joiners need; lift the 256 cap only here.
- **Stories / feed:** new `stories` / `posts` tables consume `attachments` (already decoupled
  from messages via nullable `message_id`), the upload proxy, blurhash, `link_previews`, and
  push untouched. If renditions multiply, promote to a `media_renditions` registry then — the
  current typed columns (`thumb_key`, `blurhash`, dims) migrate 1:1.
- **Rich profiles/connections:** new `profile_sections` / `connections` tables join `users`;
  the users row stays an identity nucleus.
- **Calls:** signaling = more ephemeral WS event types over the existing gateway; coturn or
  LiveKit arrive as additional compose services.
- **E2EE (hardest, deferred with eyes open):** `body` is opaque text to the server and receipts
  are seq-based, not content-based, so ciphertext rides the existing protocol; a future
  `devices`/`device_keys` registry hangs off `sessions`.
- **Multi-node:** publish all WS fan-out through the already-used Redis `events` channel and
  run N api replicas; `migrate` service already removed the deploy race.

---

## 9. v0.2 — Invite links (signature feature) & reactions

§8's Phase-1 cut line excluded reactions; v0.2 promotes them through exactly the
seam §8 sketched, and adds the growth feature: shareable invite links. Branding
note: the product is user-facing **"Bored Chat"** (web manifest, titles, OG
tags, `/join` page copy). Package names (`@socialchat/*`), the compose project
and Docker service names are **unchanged** — deployments have volumes bound to
them; the rename is user-visible only.

**Invite links (API.md §1.11, ADR-007).** Any user mints tokens
(`POST /api/invites`); the link is `https://<domain>/join/<token>` (a web-app
route). A `conversation_id`-scoped invite joins that group (minting it is
admin-only, matching §1.4 participant adds); an unscoped invite creates/dedupes
a DM with the inviter. Tokens: 32 random bytes base64url (43 chars), stored
**plaintext** with a unique index — unlike session tokens, because the owner
list must re-display the URL and the token is a revocable, expiring, use-capped
capability, not a credential. `status` is derived
(`revoked > expired > exhausted > valid`); accepts go through one atomic
guarded `UPDATE … use_count + 1 … WHERE use_count < max_uses RETURNING *`, so
concurrency can never over-redeem. Joins reuse the existing machinery verbatim:
`dm_key` dedupe, `join_seq = last_seq` history floor, a `system` message
(`invite_joined`), `conv.new`/`conv.updated` fan-out over the Redis `events`
channel. Registration with `invite_token` never fails on a bad invite — account
first, `invite: null` in the response.

**Why the avatar proxy is public-but-token-gated.** The join page's whole pitch
is the inviter's ANIMATED avatar ("join Bored Chat — here's who's waiting"),
rendered for people who by definition have no session, and for OG unfurlers
(Slack/WhatsApp/iMessage bots) fetching `og:image`. `/api/media/:key` is
auth-checked and must stay that way, so invites get a dedicated streaming proxy
`GET /api/invites/:token/avatar?v=static|animated`: the token itself is the
capability. It never exposes MinIO keys (no enumeration surface), serves only
while the invite is `valid` — revoking an invite instantly kills its proxy —
returns 404 unless the inviter's avatar is `ready`, is rate-limited per IP
(`INVITE_AVATAR_RATE_PER_HOUR_PER_IP`), and sends `Cache-Control: private,
max-age=300` (short TTL because `avatar_version` can move while the token
lives; `private` keeps shared caches out of it). Default variant is `static`
(JPEG — what unfurlers reliably render); the join page itself requests
`v=animated`, gated by `prefers-reduced-motion` per §5's motion hygiene.

**Reactions (API.md §1.12).** Additive `message_reactions` table keyed by the
messages PK `(conversation_id, seq)` — the §8 sketch named `message_id`, but
the composite key is the message identity everything else already uses, and the
reactions PK `(conversation_id, seq, user_id, emoji)` serves the per-message
`GROUP BY emoji` aggregate as a PK-prefix scan. Writes are REST
(idempotent POST/DELETE, 204), fan-out is one small `reaction.updated` delta
frame via the `events` channel — deliberately not a `msg.updated` DTO re-ship.
Message DTOs carry `reactions: [{emoji, reactors: UserLite[], has_more, mine}]`
(named faces, never a count — PSYCHOLOGY rule 3); reconnects reconcile
from DTOs, never frame replay, so the §2.8 sync story is untouched.

Shared constants added (v0.2): `INVITE_TTL_S=604800`, `INVITE_MAX_USES=50`,
`INVITE_TOKEN_BYTES=32`, `INVITE_CREATE_RATE_PER_HOUR=30`,
`INVITE_PUBLIC_RATE_PER_HOUR_PER_IP=60`, `INVITE_AVATAR_RATE_PER_HOUR_PER_IP=120`,
`INVITE_AVATAR_CACHE_TTL_S=300`, `REACTION_EMOJI_MAX_LEN=16`,
`REACTIONS_PER_USER_PER_MESSAGE_MAX=8`.

---

## 10. v0.3 — Beacons, privacy, trust (ADR-008, ADR-009)

v0.3 ships the "I'm bored — let's plan" loop plus the safety bundle that
FEATURES #29 requires to ship *with* it, not after. `docs/PSYCHOLOGY.md` is
**binding** here: no waiting states, faces-not-counters, no seen-at timestamps,
count-up rituals that auto-pause guilt-free, FoMO-safe visibility (a beacon is
visible only to people who can still join it), countdowns as a feature.

**New tables** (migration `0003_beacons_privacy`): `beacons`, `beacon_joins`,
`beacon_roles`, `beacon_kudos`, `polls`, `poll_votes`, `blocks`, `reports`;
`users` gains `area` (citext, owner-private), plan-karma counters, and the
privacy settings as columns (the `avatar_motion` pattern — one row read on the
presence/typing/receipt hot paths, no join, no settings table). `messages.type`
gains `'poll'`; a poll is keyed by `(conversation_id, seq)` like reactions.

**Everything rides the existing machinery.** Durable writes stay REST; all
v0.3 fan-out (`beacon.new/updated`, `beacon.kudos`, `plan.updated`,
`poll.updated`) goes through the Redis `events` channel; the spark creates an
ordinary group conversation (icebreaker system message = seq 1, auto venue
poll = seq 2) so sync, receipts, push, and history floors apply unchanged. The
spark itself is the invites trick again: a row lock + guarded
`UPDATE … WHERE status='open'` makes threshold races unexploitable.

**Worker:** one new BullMQ queue `beacons` with three jobs — `beacon-expire`
(repeatable, 1 min sweep over `beacons_open_expiry_idx`), `beacon-ritual`
(repeatable, hourly: re-creates due weekly runs; chain pauses silently at 2
consecutive unsparked runs), `beacon-afterglow` (delayed per spark to
`expires_at + 2 h`, plus a safety sweep over `beacons_afterglow_idx`; posts
the recap system message with `metadata.afterglow` + the run-it-back id).

**Privacy enforcement is edge-side (ADR-009).** The `events` channel stays an
unfiltered api↔worker firehose; filtering happens where the recipient is known
— the WS gateway per socket and the REST serializers per viewer (API.md §2.11
+ the §1.13 enforcement table). Reciprocal read receipts filter only
*serialization* (watermarks keep advancing, so unread counts and §2.9 push
guards are untouched). Blocks are 404-shaped wherever a 403 would confirm
them, and the one shared 403 (`group_add_denied`) is byte-identical between
"policy" and "blocked" so it confirms nothing.

Shared constants added (v0.3): `BEACON_*` (vibes, note/threshold/window
bounds, open cap + create rate, joiner preview, roles cap, icebreakers, venue
poll copy, afterglow delay/photo cap, kudos window), `RITUAL_*` (weekly rrule,
interval, auto-pause skips), `KUDOS_KINDS`, `POLL_*` (option/question bounds),
`AREA_MAX_CHARS`, `REPORT_*` (reason cap, rate). One place, as always: §1.
