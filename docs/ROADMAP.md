# SocialChat — Roadmap

Phase 1 is sequenced so every milestone ends demoable and nothing is built on an unproven
layer. References: `ARCHITECTURE.md` (§ numbers), `SCHEMA.sql`, `API.md`.

---

## Phase 1 — MVP

### M0 — Skeleton & deploy rail (everything else rides this)
- pnpm workspace: `packages/shared`, `apps/web`, `apps/server` (two entrypoints + cli).
- `docker-compose.yml`: caddy, web, api, worker, **migrate (run-once: Drizzle migrations +
  MinIO bucket init; api/worker `depends_on: service_completed_successfully`)**, postgres,
  redis (AOF), minio. `.env.example`. Caddyfile routes.
- Drizzle schema = `SCHEMA.sql`; first migration generated and applied by the migrate service.
- `GET /healthz`; lint + typecheck + vitest in CI; `docs/adr/` seeded with ADR-001
  (cookie sessions, no JWT), ADR-002 (watermark receipts), ADR-003 (REST-only durable sends),
  ADR-004 (proxied uploads).
- **Demo:** `docker compose up -d` on a clean VM serves a hello page over real TLS.

### M1 — Accounts & profiles
- `auth` module: register/login/logout, argon2id, opaque sessions (hash-stored), sliding
  expiry, session list/revoke, Redis rate limits, `X-Requested-With` CSRF guard.
- `users` module: me/patch (display_name, bio, `avatar_motion`), public profile, search.
- `cli.ts reset-password`. Next.js auth pages + session-aware SSR shell.
- **Demo:** two accounts register, log in on two browsers, revoke a session from the other.

### M2 — Conversations & messages over REST (the correctness core)
- `conversations`: DM create with `dm_key` dedupe, groups (creator admin), membership add/
  remove/leave with `system` messages, **256 cap**, `join_seq` stamped at add time.
- `messages`: transactional seq assignment (`UPDATE … RETURNING last_seq` + insert),
  idempotent send via `client_msg_id`, history paging (`after_seq`/`before_seq`),
  **join_seq visibility floor enforced in the history query from day one**.
- `GET /api/sync` snapshot + `GET /api/conversations` list with unread counts.
- Integration tests: idempotent replay, seq gaplessness under concurrent sends, dm_key race.
- **Demo:** full two-user + group chat via curl; kill -9 the api mid-send and retry cleanly.

### M3 — Realtime
- `ws` gateway: cookie-on-upgrade auth, registry keyed by session id (logout/revoke closes
  sockets, 4401), heartbeats, Redis `events` channel consumed for worker-originated events.
- `msg.new` fan-out; `delivered`/`read` watermarks with GREATEST semantics + **1 s coalesced
  `receipt` broadcasts**; single `typing` event with 6 s server expiry; Redis presence with
  15 s offline grace + `presence.sub` caps.
- Client: IndexedDB message store, outbound queue, tick derivation, reconnect backoff, and the
  full catch-up procedure (socket first, `/sync`, gap-fill, flush queue) — `API.md` §2.8.
- **Demo:** two browsers chat live with sent/delivered/read ticks, typing, presence; one goes
  offline for an hour, reconnects, converges exactly.

### M4 — Media messages
- `uploads` module: streaming multipart proxy, **magic-byte sniffing (client MIME advisory)**,
  per-kind limits; images inline via sharp (EXIF strip, 512px WebP thumb, **blurhash**);
  files verbatim (attachment disposition + nosniff).
- Worker queue `media` for video: ffprobe, poster via `-vf thumbnail`, **faststart remux**,
  dims/duration; hydration via `msg.updated` (bound) / `attachment.ready` (unbound) — no
  stale placeholders.
- `GET /api/media/:key` auth-checked immutable proxy; nightly orphan GC job.
- **Demo:** send photo (instant blurhash → thumb), video (poster pops in live), and a PDF.

### M5 — Animated avatars (signature feature)
- Worker queue `avatar`: ffprobe validation, animated WebP (512px, ≤10 s, fps≤24, 2 MB budget
  with quality step-down), static JPEG poster via **representative frame (`-vf thumbnail`)**,
  content-hash keys, `avatar_version++`, raw cleanup, failure keeps previous avatar.
- Same job handles **group avatars** (`POST /conversations/:id/avatar`).
- Live flip via `user.updated` / `conv.updated`.
- Client rendering contract: static in all lists/bubbles/member sheets; animated on profile +
  chat header only, gated by `prefers-reduced-motion` AND `avatar_motion`, with
  IntersectionObserver pausing off-screen loops.
- **Demo:** upload a GIF and an MP4 clip; avatar animates on the profile, stays static in the
  list, flips live on the other browser; toggle reduced motion.

### M6 — PWA & web push
- Manifest, installability pass, service worker (offline app shell; no share handling yet).
- `push` module + worker queue: VAPID, subscribe/unsubscribe, **guarded sends** (presence,
  read watermark re-check, mute, 5 s debounce), tag collapsing, subscription pruning,
  deep-link on click. SW never sends `delivered` (receipt honesty).
- **Demo:** installed on Android; message arrives as a notification with the app closed; no
  notification when the recipient is actively reading or already read elsewhere.

### M7 — Share target & link unfurl
- Manifest `share_target`; `app/share/route.ts`; **`share_imports` inbox persisted on POST
  arrival**; logged-out **share-stash + claim** flow; `/compose` picker + composer.
- Worker queue `unfurl`: the SSRF-guarded fetcher (private-range + IPv4-mapped rejection,
  ports 80/443, pinned-IP connect, per-hop re-validation, budgets, og:image re-encode),
  **eager enqueue at import time**, 30/hour/user rate limit, negative cache (1 h),
  `preview.ready` push, 7-day TTL.
- Send path snapshots the card into `metadata.link_preview`; typed-URL unfurl in the chat
  composer (debounced) and server-side extraction fallback via `msg.updated`.
- **Demo:** share a news URL from Android — card is ready before picking a recipient; share a
  photo while logged out, log in, nothing lost; `http://169.254.169.254/` and a DNS-rebinding
  hostname both refuse cleanly.

### M8 — Hardening & ship
- Rate-limit sweep (uploads, previews, conversation creation), payload caps, security headers
  (CSP, HSTS via Caddy), dependency audit.
- Load smoke test: 500 concurrent sockets, 50 msg/s mixed sends on one VPS-sized VM.
- Lighthouse PWA + a11y pass; empty/error/loading states; GC jobs verified (orphans, expired
  stashes/imports/previews/sessions).
- README: fresh-VPS deploy, `.env` reference, backup runbook (`pg_dump` + MinIO rsync),
  password-reset CLI. ADR folder current.
- **Demo:** `git clone && cp .env.example .env && docker compose up -d` on a fresh VPS =
  the whole product. **← Phase-1 cut line.**

---

## Phase 2 — Message richness & broadcast
- **Reactions** (`message_reactions` table + `reaction` WS event), **replies UI**
  (`reply_to_id` already shipped), **edit/delete** (tombstones via existing `msg.updated`
  full-DTO replacement; seqs never reused), **forwarding** (`metadata.forwarded_from`).
- **Stories:** `stories` table consuming the existing attachments/upload/blurhash pipeline;
  24 h expiry GC; story rings use static avatars (rule already in place).
- **Broadcast channels:** add `'channel'` to `conversations.type`; one-writer/many-reader on
  the same seq/watermark model (the reason watermarks were chosen); `join_seq` history floor
  already enforced; revisit the 256 cap and move receipt aggregation server-side.
- Email verification + password-reset flows (SMTP optional service); full-text search
  (Postgres FTS on messages); user blocking.

## Phase 3 — Social layer
- **Feed:** `posts`/`post_likes`/`post_comments` tables reusing attachments, link_previews,
  push; fan-out-on-read (it's one VPS, not Twitter).
- **Rich profiles & connections:** `profile_sections`, `connections(a, b, status)`; profile
  stays additive to the `users` identity nucleus.
- Media model promotion **if needed**: introduce `media_renditions` registry when rendition
  variants multiply (feed sizes, story overlays); current typed columns migrate 1:1.
- Admin/moderation tooling, report flows.

## Phase 4 — Calls, E2EE, scale-out
- **WebRTC 1:1 calls:** signaling as new ephemeral WS events in `packages/shared`; `coturn`
  (or LiveKit for group calls) as additional compose services.
- **Optional E2EE:** `devices` + `device_keys` tables anchored to `sessions`; Signal-style
  sessions; `body` already opaque to the server and receipts seq-based, so ciphertext rides
  the existing protocol; media encrypted client-side before upload.
- **Multi-node:** route all WS fan-out through the Redis `events` channel (the seam the worker
  already uses), N api replicas behind Caddy, then Postgres read replicas; partition `messages`
  on the existing `(conversation_id, seq)` composite key only if ever needed. None of these
  steps revisit the message log, receipt model, or sync protocol.
