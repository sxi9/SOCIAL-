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
| FULL designs for queued releases + standing decisions from the owner | `docs/SPECS.md` (the conversation memory — build from here, not from the one-line roadmap items) |
| A bug/symptom to fix — where to look, cause, fix pattern | `docs/TROUBLESHOOTING.md` (symptom-indexed; check here BEFORE searching code) |
| Why a decision was made | `docs/adr/ADR-001 … ADR-015` |
| Capacity numbers + scaling runbook | `docs/SCALING.md` |
| Hands-on dev setup (hot reload, file map, ship-to-server) | `docs/DEVELOPING.md` |
| Where production runs, how it is deployed, the box's quirks and past incidents | `docs/CLAUDE-MEMORY.md` (mirror of the owner's Claude memory) |
| Where the last session stopped and what to do first | `docs/HANDOFF.md` |
| What to build next, in order, with file:line pointers (from the 2026-10-18 product audit) | `docs/AUDIT-PLAN.md` (§0 already-done, §1 owner decisions, §1b share-everything, Waves 0–7) |

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
9. **Migrations are append-only** (`0000`…`0021` so far; the next one is
   `0022` — `0014` holds the share-everything plumbing, `0015`
   `conversation_participants.accepted_at`, `0016` `conversation_bans`,
   `0017` the `profile` share-token type, `0018` the Wave 1 floor
   (consent/age stamps, deletion grace, report categories + kinds),
   `0019` the `call` share-token type, `0020` the Wave 1 leftovers
   (deactivated_at, appear_offline, push session binding, report outcome),
   `0021` the design-handoff layouts (`post_comments.parent_id`,
   `story_activity`);
   `docs/AUDIT-PLAN.md` §10 lists the remaining Wave 1 columns). New
   schema = new numbered file + matching `schema.ts` change. The `migrate` compose service
   runs them and creates the MinIO bucket.
10. **Zero new dependencies by default.** Pin exact versions. New native/
    postinstall deps must be added to `pnpm.onlyBuiltDependencies` in the
    root `package.json` (pnpm 10 skips postinstall otherwise). The single
    approved exception so far: `@simplewebauthn/server`/`browser` for
    passkeys (v0.9, ADR-021) — don't take it as precedent.

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

`docs/FEATURES.md` is the always-current source of truth for shipped vs
queued (release commits in `git log`). Queued releases build from the full
designs in `docs/SPECS.md`, which also records the owner's standing
decisions (no private-chat monitor, no payments, no login-page user cards,
invisible single waves, mesh-call cap, no undo-send pill, share pages per
AUDIT-PLAN decision 11). Backlog: LiveKit SFU, listen-together, E2EE,
native wrappers, make-it-yours kit, federation.

Since 2026-10-27 the sequenced work list is `docs/AUDIT-PLAN.md` (derived
from a 17-benchmark product audit, every item re-verified against the
tree). Start from its Wave 0/1 unless `docs/HANDOFF.md` says otherwise;
ask the owner before building anything that hangs on one of its §1
decisions.
