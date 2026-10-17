# Bored Chat — Agent Operating Manual

Self-hosted social chat PWA ("WhatsApp + Instagram + a local community board"),
built 100% from scratch. TypeScript everywhere. This file is the entry point
for any AI agent or developer: read it first, then the doc it points you to.

## Read in this order

| When you need | Read |
|---|---|
| Where ANY feature/file lives | `docs/SYSTEM-MAP.md` (the complete map) |
| The founding design + rationale | `docs/ARCHITECTURE.md` |
| Every REST endpoint + the full WS protocol | `docs/API.md` (authoritative contract) |
| The database schema | `apps/server/src/db/schema.ts` + `src/db/migrations/` (append-only) |
| Product rules that BIND all UX decisions | `docs/PSYCHOLOGY.md` (incl. the never-build list) |
| What is shipped vs planned | `docs/FEATURES.md` |
| A bug/symptom to fix — where to look, cause, fix pattern | `docs/TROUBLESHOOTING.md` (symptom-indexed; check here BEFORE searching code) |
| Why a decision was made | `docs/adr/ADR-001 … ADR-015` |
| Capacity numbers + scaling runbook | `docs/SCALING.md` |

## Golden rules (violating these breaks the product)

1. **REST for durable writes, WS for fan-out.** A message is created by POST;
   the WebSocket only delivers events (via the Redis `events` channel) and
   carries ephemeral signals (typing, presence, call signaling). Never make
   the socket a durable write path.
2. **Gapless per-conversation `seq`.** Messages are keyed
   `(conversation_id, seq)`; seq is assigned in a row-locked transaction and
   NEVER reused (tombstones keep theirs). Receipts, unread counts, sync and
   push-dedup are all integer comparisons on it.
3. **Offline sync = `GET /api/sync`** snapshot + `after_seq` gap-fill. Clients
   reconcile on every (re)connect. Don't invent per-device mailboxes.
4. **The contract lives in `packages/shared`** (Zod schemas for every DTO and
   WS event + all constants). Server and web import it; never duplicate a
   schema or constant. When code and `docs/API.md` disagree, API.md wins.
5. **Blocks and privacy settings are enforced SERVER-side at every surface.**
   Any new feature must answer: what do blocked pairs see? what does each
   privacy toggle hide? (Enforcement helpers: `apps/server/src/lib/blocks.ts`,
   `lib/friends.ts`, `lib/pushGuard.ts`.)
6. **Psychology rules are law** (`docs/PSYCHOLOGY.md`): no public numeric
   scores/like-counts (named faces instead), no seen-at timestamps, never
   notify someone about something they cannot join, finite feeds with a hard
   end, no guilt streaks / variable-reward mechanics, mentions may override
   mute but never blocks.
7. **Self-hosted ethos:** no third-party SaaS APIs (no Giphy, no payment
   processing, no map tile keys). All media is user-generated and stored in
   MinIO, always served through the auth-checked proxy. Money never moves
   through the app.
8. **Auth:** opaque session token (sha256-stored) in an httpOnly `sid` cookie;
   the same cookie authenticates the WS upgrade; logout/revocation closes
   live sockets (code 4401). Mutating routes require the
   `X-Requested-With: fetch` header (CSRF). No JWTs.
9. **Migrations are append-only** (`0000`…`0007` so far). New schema = new
   numbered file + matching `schema.ts` change. The `migrate` compose service
   runs them and creates the MinIO bucket.
10. **Zero new dependencies by default.** Pin exact versions. New native/
    postinstall deps must be added to `pnpm.onlyBuiltDependencies` in the
    root `package.json` (pnpm 10 skips postinstall otherwise).

## Build / test / run

```bash
pnpm install                 # root; Node 22, pnpm 10
pnpm -r build                # shared → server (tsc) → web (next build)
pnpm -r test                 # vitest; server integration suites need infra:
# local test infra convention (used by all integration tests):
#   Postgres 16 data dir /var/tmp/socialchat-pg on port 5432 (user/db socialchat)
#   Redis on 6379 — tests SKIP cleanly when infra is absent
pnpm migrate                 # applies migrations; EXITS NON-ZERO at the MinIO
                             # bucket step when MinIO is absent — tables are
                             # already applied at that point; this is expected
                             # outside docker compose.
docker compose up -d --build # the real deployment (see README)
```

Dev servers for manual/Playwright verification: api on a chosen port
(`PORT`, dummy `MINIO_*` works for non-media paths), web via `next dev` with
the rewrite env var in `apps/web/next.config.ts` pointing at the api.
Playwright uses the preinstalled Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`);
install the playwright npm package OUTSIDE the repo. For WebRTC tests launch
with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.

## Verification bar for any change

Every shipped stage so far passed: `pnpm -r build` clean twice from scratch,
the full test suite against live Postgres/Redis, a curl smoke of the feature
journey, Playwright screenshots reviewed at phone (390x844, 360x740) AND
desktop widths, and a read-only security audit (authz, blocks/privacy
enforcement, race conditions) with fix/recheck rounds. Hold that bar.

## Known gotchas

- `uuid@10` needs `@types/uuid` under NodeNext ESM.
- Raw SQL with table aliases: never interpolate Drizzle column refs (they
  render fully qualified and miss the alias) — write `o.user_id` style raw.
- `position: fixed` inside any transformed/filtered ancestor breaks — sheets
  and overlays must portal to body; hidden overlays need `display:none` or
  `pointer-events:none`, never just `opacity:0`.
- Bottom sheets: `max-height` + internal scroll + safe-area/tab-bar padding;
  prefer `100dvh`; inputs ≥16px font (iOS zoom-stick).
- Web push requires VAPID keys in env; server skips push when unset.
- The web container reaches the api server-side via `API_ORIGIN`
  (share-target forward, join-page SSR) and must re-send `x-forwarded-for`
  on those hops (api rate-limits by client IP, `trustProxy: true`).
- MinIO image is `bitnamilegacy/minio` (upstream left Docker Hub, 2025);
  Caddy host ports come from `HTTP_PORT`/`HTTPS_PORT` in `.env`.

## Current state

Shipped through v0.6 (see `docs/FEATURES.md` for the item-level list and
`git log` for the release commits). In flight / next: v0.6.1 overlay &
placement fixes; v0.7 interactivity pack (clickable beacon joiners →
profiles with connect/message, beacon & listing editing with joiner
notifications, early spark "start with whoever joined", public feed posts,
GIF comments + stamp reactions on comments, location chips with map links).
Backlog: LiveKit SFU for >8-person calls, listen-together, E2EE, native
wrappers, make-it-yours kit, federation.
