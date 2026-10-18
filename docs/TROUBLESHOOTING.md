# Bored Chat — Troubleshooting Knowledge Base

Symptom-indexed. Every entry: SYMPTOM → LOOK AT (exact files) → CAUSE → FIX
(the pattern we applied — repeat it, don't reinvent it). Entries marked
[hit] actually happened in this project and were fixed; [known] are failure
modes the design guards against. Read `CLAUDE.md` first; map: `docs/SYSTEM-MAP.md`.

## Deploy & ops

**"pull access denied for minio/minio"** [hit]
→ `docker-compose.yml` minio service. MinIO left Docker Hub (2025); image is
`bitnamilegacy/minio` with `MINIO_DATA_DIR=/data`, run.sh command, `user: "0"`.

**"failed to bind host port ... address already in use" on 80/443/8443** [hit]
→ `.env` (`HTTP_PORT`/`HTTPS_PORT`), `docker-compose.yml` caddy ports.
Something on the host owns the port. Set the env ports (compose interpolates
them) — never edit the Caddyfile for this; find free ports with `ss -ltn`.

**"I updated but see no changes"** [hit — twice]
→ Checks in order: `git log --oneline -1` (did the pull land? local edits
block merges — `git stash`, or `./bored update` which auto-stashes);
`docker compose ps` ("Up N hours" + "Built 0.0s" = containers were NOT
recreated — an interrupted build keeps old ones; rerun `up -d --build` and
DON'T Ctrl+C); `curl -s localhost:PORT/login | grep -c "Bored Chat"`
(0 = server old, ≥1 = server new → browser cache: hard refresh; installed
PWA: close fully and reopen twice).

**Web image build fails: TS5083 / "Cannot find name 'Map'" storms** [hit]
→ `apps/web/Dockerfile`, `apps/server/Dockerfile`. A tsconfig that extends
`../../tsconfig.base.json` compiled in an image that didn't COPY it — tsc
falls back to ES5 defaults. Every Dockerfile build stage must COPY
`tsconfig.base.json`. CI builds both images to catch this class.

**`migrate` exits non-zero but tables exist** [known/expected]
→ `apps/server/src/db/migrate.ts`. The MinIO bucket-init step fails when
MinIO is absent (local dev/tests). Migrations are already applied by then.
In compose (MinIO present) it exits 0. Not a bug — do not "fix".

**argon2/sharp "could not load native module" at runtime** [hit]
→ root `package.json` → `pnpm.onlyBuiltDependencies`. pnpm 10 skips
postinstall scripts by default; native deps must be listed there.

**`docker` → "permission denied ... docker.sock"** [hit]
→ host setup, not the repo: `sudo usermod -aG docker $USER && newgrp docker`.

**Link pasted in Telegram/WhatsApp shows NO preview card** [hit]
→ `apps/web/app/join/[token]/page.tsx` (`publicOrigin()`), `.env`
`PUBLIC_ORIGIN`, `Caddyfile` (`header_up X-Forwarded-Host`). Tags rendered
`http://localhost/...` because tunnels (cloudflared/ngrok) rewrite Host.
Fix: set `PUBLIC_ORIGIN` (./bored tunnel does it automatically). Verify:
`curl -A TelegramBot <url> | grep og:` — og:image must be an absolute PUBLIC
url. Telegram caches previews per-URL: always test with a FRESH link.
**Shared links die after every reboot (new random *.trycloudflare.com host)** [hit]
→ `cloudflared tunnel --url` (the quick tunnel `./bored tunnel` starts) gets a
NEW random hostname on every start, so a reboot orphans every invite link, OG
preview and enrolled passkey. Fix: publish Caddy through Tailscale Funnel —
the node's `*.ts.net` name never changes and the Funnel config survives
reboots: `tailscale funnel --bg --https=10000 http://127.0.0.1:$HTTP_PORT`
(Funnel reaches the internet ONLY on 443, 8443 and 10000 — the CLI accepts
other ports but the ingress never answers on them). Then set
`PUBLIC_ORIGIN=https://<node>.ts.net:10000` in `.env` and run
`docker compose up -d web api worker` (web = OG previews, api = WebAuthn
origin/rpID). Needs the `:80` catch-all site in `Caddyfile`: Funnel keeps the
public Host header (no `--http-host-header` equivalent) and a `localhost:80`-
only Caddyfile answered it with a 308 redirect loop. Verify from a phone on
mobile data: `/login` loads and a FRESH invite link previews; then
`systemctl --user disable --now cloudflared-socialchat` / `./bored tunnel-stop`.

## Server correctness patterns (each was a real audit finding)

**Any counter/cap that can race (reactions cap, spark threshold, invite
use_count, mutual wave)** [hit ×4]
→ `modules/reactions/routes.ts`, `modules/beacons/service.ts`,
`modules/invites/service.ts`, `modules/discovery/routes.ts`. Pattern:
serialize with `pg_advisory_xact_lock(hashtextextended(key, n))` inside the
transaction, or atomic `UPDATE ... WHERE <precondition> RETURNING`. Never
check-then-insert under READ COMMITTED.

**Date objects into raw SQL → postgres-js cannot serialize** [hit]
→ anywhere using `db.execute(sql\`...\`)`. Bind ISO strings with
`::timestamptz` casts, never `new Date()` instances.

**Drizzle column refs interpolated into aliased raw SQL render
fully-qualified and miss the alias** [hit]
→ e.g. `modules/discovery/routes.ts` visibleCards. In raw SQL with table
aliases write raw `o.user_id`-style identifiers.

**Rate limit shared by all users behind the web container** [hit ×2]
→ `apps/web/app/share/route.ts`, `app/join/[token]/page.tsx`. EVERY
server-side web→api fetch must re-send the incoming `x-forwarded-for`
(api has trustProxy). New SSR/route-handler hops: copy that pattern.

**Status-gate ordering on idempotent accepts** [hit]
→ `modules/invites/service.ts` acceptInvite. Membership/dedupe check FIRST
(already-in → 200, no use consumed), then status-gate genuinely-new joins
(revoked/expired → 410). A departed DM party re-joining is a NEW join and
must be status-gated; re-join resets `left_at` exactly like the group path.

**Push delivered to someone who was reading / never delivered at all** [hit]
→ `modules/messages/service.ts` fanOutNewMessage + `lib/pushGuard.ts` +
`jobs/push.ts`. "Offline" is decided by the in-process WS registry (truth),
not the Redis presence key (grace-period lag); just-dropped users get the
job delayed past OFFLINE_GRACE_S. Worker guards re-check: offline, unread
(`last_read_seq`), not muted (mention overrides mute, NEVER blocks),
debounce.

**One semantic event emitted N times (system messages, fan-out)** [hit]
→ `modules/conversations/routes.ts` add-participants. One operation = ONE
system message / seq bump, payload carries the list.

**Unfurl/budget bypass via alternate entry points** [hit]
→ `modules/previews/service.ts`. `requestUnfurl()` is the ONLY path that
enqueues (previews POST, message-send URL extraction, share imports). A new
URL-bearing feature must call it, never `enqueueUnfurl` directly. Over
budget on a message send: send succeeds, unfurl silently skipped.

**Public endpoint leaks existence/data** [known — audited each release]
→ `modules/invites` public lookup (status enum only, token-gated avatar,
rate-limited), `modules/discovery` (single waves invisible; unknown/blocked/
friends-of all return byte-identical 404). New public endpoints: identical
responses for "doesn't exist" vs "you may not see it".

**Blocked pair reaches each other through a NEW surface** [known — the #1
audit check every release]
→ `lib/blocks.ts` has the SQL conditions; `lib/friends.ts` the audience
helper. Every new feature must consult them: visibility, join/contact,
notifications, profile 404 (blocked viewer), kudos/stamps/waves/reviews.

**WS event reaches someone outside the audience** [known]
→ `ws/events.ts` fan-out is per-user-targeted (beacon.new to audience only,
spark details to joiners only, call signaling participants-only with
per-frame membership validation + size/rate caps in `ws/gateway.ts`).

## Web/UI patterns (the v0.6.1 class)

**A sheet/overlay renders top-left / clipped / off-screen** [hit ×2]
→ `components/Portal.tsx` is the law: every sheet/overlay renders through it
into `<body>`. Root cause class: `position: fixed` inside an ancestor with
transform, filter, OR `backdrop-filter` (the `.topbar` blur made the topbar
the containing block — sheets opened from it laid out against a 50px box and
rose off-screen). Never mount a fixed overlay inline inside app chrome.

**Whole app or one sheet "unclickable", buttons dead** [hit ×2]
→ Two causes seen: (a) an invisible mounted overlay — `opacity: 0` still
intercepts clicks; closed overlays need `display:none`/`visibility:hidden`/
`pointer-events:none`; (b) `pointer-events` is INHERITED — a wrapper with
`pointer-events:none` (e.g. a FAB shell) kills every descendant, including a
sheet mounted inside it. Fix: Portal the sheet out; `.sheetBackdrop` sets
`pointer-events:auto` explicitly as defense. Debug either case in DevTools:
`document.elementFromPoint(x,y)`.

**A sheet paints UNDER the tab bar / its button is covered** [hit]
→ z-index scale documented in `app/globals.css`: tab bar < FAB < sheet
backdrop < sheet < toast. A sheet mounted inside a lower stacking context
(sticky/z-indexed wrapper) cannot win regardless of its own z-index —
Portal to body puts it on the root context where the scale applies.

**Bottom sheet's submit button off-screen on phones** [hit]
→ sheet CSS. Sheets: `max-height` (prefer `100dvh`-based) + internal
`overflow-y:auto` + `padding-bottom: calc(env(safe-area-inset-bottom) +
tab-bar height)`.

**Page pans/jumps when focusing an input on mobile** [hit]
→ `components/auth.module.css` pattern: a clipped (`overflow:hidden`)
container with scrollable overflow scrolls on focus. Use `overflow:clip`,
and keep decorative absolutes from creating overflow.

**iOS zooms in on input focus and sticks** [hit]
→ `app/globals.css`: every input/textarea ≥ 16px font. Never fix via
maximum-scale (breaks accessibility pinch-zoom).

**Header action (SOS etc.) pushed off-screen** [hit]
→ header flex rows need `min-width: 0` on the growing child so trailing
actions never overflow.

**Hydration mismatch warnings on auth pages** [known]
→ time-of-day greetings/taglines compute client-side after mount
(`components/AuthScene.tsx` pattern) — never render clock-dependent text in
SSR output.

**Store desync after reconnect / missed events** [known]
→ `apps/web/lib/connection.ts`: EVERY (re)connect runs the `/api/sync`
reconcile; new WS event types must be handled there AND in `lib/store.ts`,
and anything seq-less reconciles via the refresh path. presence.sub frames
chunk at PRESENCE_SUB_MAX; close code 1008 = reconnect once then surface the
error state.

**Delivered receipts from the service worker** [known — forbidden]
→ `public/sw.js` only shows notifications. Only a running client that
committed the message to IndexedDB sends `delivered` (receipt-honesty rule).

## Tests & verification

- Integration tests expect local Postgres (`/var/tmp/socialchat-pg`, port
  5432, user/db `socialchat`) + Redis 6379 and SKIP cleanly when absent.
  Suites: `apps/server/test/*.integration.test.ts` per release.
- Playwright: preinstalled Chromium via `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`;
  install the npm pkg OUTSIDE the repo; WebRTC tests need
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
- The verification bar for any change is in `CLAUDE.md` ("Verification bar").

## “Can’t add photos” from a phone (board listing, post, chat, story)

**Symptom:** picking a photo on an iPhone appears to do nothing, or the
uploaded photo renders broken/blank for everyone.
**Cause:** iPhones shoot HEIC; sharp’s prebuilt libvips has no HEVC codec, so
the server used to store the file VERBATIM — no thumb, no dimensions, and most
browsers can’t render HEIC (fixed v1.0a #91).
**Fix pattern (updated 2026-10-18):** the SERVER now converts HEIC→JPEG too (`modules/uploads/pipeline.ts` `heicToJpeg` via `heif-convert`, apt `libheif-examples` in `apps/server/Dockerfile`) — every browser can upload HEIC; a 415 now means heif-convert is missing from the image or the file is not an image at all. The web client still converts HEIC→JPEG before upload
(`apps/web/lib/imageUpload.ts`, `maybeConvertImage` — wrap EVERY new image
upload call site with it); the server now rejects undecodable images with
`415 image_undecodable` (`modules/uploads/pipeline.ts`) instead of storing a
broken row. If a user reports it again: check the browser (non-Safari cannot
decode HEIC — the error message tells them to convert), and check the
attachment row for `width IS NULL` leftovers from before the fix.
