# Bored Chat — System Map

The complete "where to look" guide. Pair with `CLAUDE.md` (rules) and
`docs/API.md` (contract). Paths are repo-relative.

## Monorepo shape

```
pnpm-workspace.yaml / package.json      root workspace (scripts: dev/build/migrate/lint/test)
tsconfig.base.json                      strict TS base (NodeNext for node pkgs)
.env.example                            ONE env file documenting every variable
docker-compose.yml                      9 services: caddy web api worker migrate postgres redis minio coturn
docker-compose.dev.yml                  loopback port overrides for `pnpm dev`
Caddyfile                               single origin: /api/* + /ws → api, else → web; CSP/HSTS
.github/workflows/ci.yml                build + lint + tests (PG/Redis services) + both Docker images
packages/shared/                        THE CONTRACT (see below)
apps/server/                            Fastify 5 api + BullMQ worker + ops CLI (one package, one image)
apps/web/                               Next.js 15 App Router PWA
docs/                                   ARCHITECTURE, API, SCHEMA.sql (founding DDL), PSYCHOLOGY,
                                        FEATURES, SPECS (designs + owner decisions), ROADMAP,
                                        AUDIT-PLAN (sequenced work list, 2026-10-27), HANDOFF,
                                        TROUBLESHOOTING, DEVELOPING, SCALING, CLAUDE-MEMORY,
                                        DESIGN-HANDOFF, DESIGN-PROMPT-V2, SYSTEM-MAP (this),
                                        adr/ADR-001..021
```

## packages/shared — the contract

| File | Holds |
|---|---|
| `src/api.ts` | Zod schema + inferred type for every REST request/response DTO |
| `src/ws.ts` | Zod schema for every WS event, discriminated on `t` |
| `src/constants.ts` | every shared limit/knob (group cap, TTLs, page sizes, call mesh cap…) |
| `src/urls.ts` | canonical `extractFirstUrl` (server + web both import it) |
| `src/util.ts` | small shared helpers (e.g. `chunk`) |

Change protocol here + `docs/API.md` first; then server; then web.

## apps/server

Entrypoints: `src/api.ts` (HTTP+WS), `src/worker.ts` (BullMQ consumers),
`src/cli.ts` (`reset-password`, `grant-admin`, `revoke-admin`).
App wiring/plugins: `src/app.ts`. Config (zod-parsed env): `src/config.ts`.

### Cross-cutting libs (`src/lib/`)
| File | Purpose |
|---|---|
| `dto.ts` | row → DTO assembly (messages incl. reactions/reply context, conversations, view context) |
| `friends.ts` | friends-of = connections ∪ active DM partners (audience primitive) |
| `blocks.ts` | block-pair SQL conditions used by every surface |
| `pushGuard.ts` | push send guards (offline re-check, read re-check, mute, mention override) |
| `errors.ts` | typed HTTP errors / machine codes |
| `ratelimit.ts` | Redis fixed-window limiter |
| `sniff.ts` / `multipart.ts` / `media.ts` | magic-byte sniffing, streaming uploads, media helpers |
| `urls.ts` | re-export of shared extractFirstUrl |
| `turn.ts` | coturn HMAC time-limited credential minting |
| `logring.ts` | capped Redis ring of warn/error/admin-action logs (admin viewer) |

### Realtime (`src/ws/`)
`gateway.ts` cookie-authed upgrade, ping/idle, per-socket rate limits,
ephemeral inbound events (typing, presence subs, receipts, call signaling,
watch-together). `registry.ts` sessionId→sockets map (+userId index;
revocation closes 4401). `events.ts` Redis `events` channel → per-user
fan-out of every server→client event (the multi-replica seam).

### Modules (`src/modules/<name>/`) — REST surface
| Module | Owns |
|---|---|
| `auth` | register/login/logout/sessions; argon2id; sliding sessions; invite_token on register |
| `users` | me, profile patch, public profile (404 to blocked), avatar upload |
| `profiles` | interests, work/skill entries, 3-GIF profile media |
| `connections` | request/accept/decline/remove; feeds friends-of |
| `conversations` (+`channels.ts`) | DMs (dm_key dedupe), groups (≤256), channels (admin-post, 10k), participants, mute, disappear TTL |
| `messages` | send (seq transaction, idempotent client_msg_id), history, sync, edit/delete, forward, mention parsing |
| `reactions` | emoji + avatar-stamp reactions (advisory-locked cap) |
| `pins` | pinned messages (cap 10) |
| `uploads` | streaming proxied uploads, per-kind allowlists/limits, auth-checked `GET /api/media/:key` |
| `previews` | link unfurl request/cache; `requestUnfurl()` is the ONE budget chokepoint |
| `share` | share-target imports + logged-out stash (per-IP open-stash ZSET) |
| `invites` | GIF invite links: mint/list/revoke, public lookup + token-gated public avatar, accept |
| `push` | web-push subscription CRUD |
| `settings` | privacy settings GET/PATCH (reciprocal receipts, last-seen, typing, invites, group-add, beacon visibility) |
| `blocks` / `reports` | block CRUD; report intake (admin queue consumes) |
| `beacons` | plan broadcasts: audiences, atomic spark→group (+icebreaker+venue poll), roles, rituals, kudos, radar |
| `polls` | poll messages + votes |
| `scheduled` | scheduled messages / time capsules (idempotent delivery) |
| `games` | tic-tac-toe (server-validated moves in message metadata) |
| `puzzle` | daily word (server-salted), guesses, shareable result kind |
| `prefs` | per-user-per-conversation themes/wallpapers + member nicknames |
| `listings` (+`reviews.ts`) | Local board: gig/ride/room/place_review kinds, contact→DM, team-up, person trust reviews |
| `feed` | posts/comments/face-reactions; finite cursor pagination (`all_caught_up`) |
| `stories` | 24h stories, view lists (author-only), recap sharing |
| `calls` | call rows, start/join/end, TURN creds, mesh cap |
| `discovery` | opt-ins, cards (excludes friends-of/blocks), waves (silent singles), roulette, expectation feedback |
| `rescue` | rescue-me pings (connections-only, daily cap) |
| `admin` | guard, users+IPs/sessions/storage, suspend/ban, reports queue, metrics, log ring, instance settings, user export |

### Worker jobs (`src/jobs/`)
`avatar` (GIF→animated WebP + poster, users & groups) · `media` (video
poster/thumb/blurhash/faststart; hydration via msg.updated/attachment.ready)
· `unfurl` (SSRF-guarded fetch, og:image re-encode, negative cache) · `push`
(guarded web-push) · `gc` (orphans, expired shares/previews/sessions, IP
retention nulling) · `beacons` (expiry, rituals, afterglow, re-ping) ·
`timers` (scheduled delivery, disappearing sweep) · `discovery` (roulette
pairing + purge, opt-in sweep).

### Database
`src/db/schema.ts` (Drizzle, mirrors migrations) · `src/db/migrations/0000_init
… 0007_calls_discovery.sql` (append-only) · `src/db/migrate.ts` (journal-based
runner + MinIO bucket init; non-zero exit at bucket step without MinIO is expected).

### Tests (`apps/server/test/`)
Infra-gated vitest integration suites per release (`m2`, `v02`…`v06`,
`edge-cases`, `minor-fixes`, `pipeline-race`) + unit tests. They skip cleanly
without local PG/Redis (convention in CLAUDE.md).

## apps/web

App Router pages (`app/`): auth (`login`, `register`), shell tabs (`/` chats,
`local`, `feed`, `plans`, `puzzle`, profile under `settings/*` +
`u/[username]`), chat `c/[id]`, invites `join/[token]` (+ SSR OG metadata),
share flow (`share/route.ts`, `share/claim/[id]`, `compose`), `connections`,
admin suite `admin/*` (desktop-oriented). PWA: `public/manifest.json`
(share_target), `public/sw.js` (push only — NEVER sends delivered receipts).

Client state/libs (`lib/`): `connection.ts` (WS client: reconnect+sync,
presence chunking, 1008 handling, event routing) · `store.ts`/`useStore.ts`
(in-memory + IndexedDB via `db.ts`; delivered receipts only after durable
store) · `api.ts` (fetch wrapper adding X-Requested-With) · `webrtc.ts`
(per-peer RTCPeerConnection mesh, signaling via `signals.ts`) · `sounds.ts`
(#103: synthesized ringtone/ringback/text tone, store-driven ringer,
device-local prefs + per-chat override) · `theme.ts` (app-wide
light/dark/system + accent, data-theme/data-accent on <html>, inline
first-paint script in app/layout.tsx) · feature libs
(`beacons`, `feed`, `stories`, `listings`, `connections`, `discovery`,
`scheduled`, `prefs`, `push`, `reactions`, `effects`, `watch`, `emoji`,
`blurhash`, `format`, `ids`, `useNow`, `useReducedMotion`, `admin`).

Components (`components/`): chat (`ChatView`, `Composer`, `AttachmentView`,
`AudioBubble`, `Ticks`, `TypingIndicator`, `PinnedBar`, `SeenBySheet`,
`ForwardSheet`, `ReactionPicker`, `EffectOverlay`, `DoodleSheet`,
`ScheduleSheet`/`ScheduledDrawer`, `GameTttView`/`TttChallengeSheet`,
`VibeCheck*`, `PollView`, `PreviewCard`, `ChatInfoSheet`) · beacons/local
(`BeaconStrip`, `BeaconCreateSheet`, `PlanHeader`, `AfterglowCard`,
`BoardView`, `Listing*`, `TeamUpSheet`, `ReviewSheet`/`TrustPanel`/`Stars`,
`DiscoverySection`, `RouletteBanner`, `RescueSheet`) · social (`FeedView`,
`StoriesStrip`/`StoryViewer`, `ProfileEditor`, `ConnectionRequestsSheet`) ·
calls (`CallOverlay`, `GlobalOverlays`, `WatchTogetherSheet`) · shell
(`AppShell`, `Tabs`/`TabPage`, `TwoPane`, `Avatar`, `Mascot`, `AuthScene`,
`InviteSheet`, `ReportSheet`, `UserSearch`, `BlurhashCanvas`,
`ServiceWorkerRegister`). Styling: CSS modules per domain + `app/globals.css`
(tokens, inputs ≥16px, reduced-motion guards).

## Event flow cheat-sheet

```
client REST write → api (tx, seq) → Redis `events` publish → api WS fan-out → clients patch stores
                                   ↘ BullMQ job (push / media / unfurl / beacons / timers) → worker
client ephemeral (typing, receipts, call sdp/ice, watch sync) → WS gateway → relay/coalesce
reconnect → GET /api/sync snapshot → store reconcile → live events resume
```

## Infrastructure notes

Only caddy publishes 80/443 (overridable via HTTP_PORT/HTTPS_PORT) except
coturn (3478 + relay range, documented in compose). api is single-replica
(in-process socket registry); the Redis events channel is the designed seam
to N replicas (`docs/SCALING.md` has measured capacity and the runbook).
