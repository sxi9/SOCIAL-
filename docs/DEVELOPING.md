# Developing — working directly on the code

How to edit Bored Chat yourself: set up a dev environment with hot reload,
find the file you need, verify your change, and ship it to your server.

## 1. One-time setup

Tools: **Node 22**, **pnpm 10**, git.

```bash
git clone https://github.com/sxi9/SOCIAL-.git boredchat
cd boredchat
pnpm install
```

Read before touching code, in this order:

1. `CLAUDE.md` — the rules of the repo (the 10 golden rules at the top)
2. `docs/SYSTEM-MAP.md` — where every feature/file lives (your main map)
3. `docs/API.md` — every endpoint + WS event. The contract: when code and
   API.md disagree, API.md wins.

## 2. The dev loop (hot reload)

You need Postgres 16, Redis and MinIO running. Easiest is to reuse the
compose file for just the infrastructure:

```bash
docker compose up -d postgres redis minio
```

Then run the apps in watch mode — four terminals, or `pnpm dev` at the
root to run them all in parallel:

```bash
# Terminal 1 — shared contract (rebuilds types on change)
cd packages/shared && pnpm dev

# Terminal 2 — API with hot reload (tsx watch)
cd apps/server
DATABASE_URL=postgres://socialchat:<POSTGRES_PASSWORD>@127.0.0.1:5432/socialchat \
REDIS_URL=redis://127.0.0.1:6379 \
MINIO_ENDPOINT=http://127.0.0.1:9000 \
MINIO_ROOT_USER=<MINIO_ACCESS_KEY> MINIO_ROOT_PASSWORD=<MINIO_SECRET_KEY> \
MINIO_BUCKET=socialchat \
PORT=3001 pnpm dev

# Terminal 3 — background worker (media thumbs, push, unfurls, GC)
cd apps/server && <same env vars as terminal 2> pnpm dev:worker

# Terminal 4 — web with hot reload
cd apps/web && API_ORIGIN=http://127.0.0.1:3001 pnpm dev
```

Values in `<...>` come from your `.env`. First run: `pnpm migrate` to
apply migrations (it exits non-zero at the MinIO bucket step when MinIO is
absent — tables are already applied by then; inside compose the `migrate`
service handles this).

Open **http://localhost:3000** — every save hot-reloads. Test at phone
width first (390×844 in devtools); that is the primary layout.

> Gotcha: never run `pnpm -r build` while `next dev` is running — the
> build clobbers `.next` and the dev server starts 404ing its own static
> chunks. Stop the dev server, build, restart.

## 3. Where things live

| You want to change | Go to |
|---|---|
| A screen / page | `apps/web/app/<route>/page.tsx` |
| A UI component + its styles | `apps/web/components/*.tsx` + matching `*.module.css` |
| Colors, fonts, spacing tokens | `apps/web/app/globals.css` (`:root` variables) |
| An API endpoint | `apps/server/src/modules/<feature>/routes.ts` (+ `service.ts`) |
| A background job | `apps/server/src/jobs/` |
| DB schema | **append-only**: new numbered file in `apps/server/src/db/migrations/` + matching `schema.ts` edit, then `pnpm migrate` |
| Shared types/constants (DTOs, WS events) | `packages/shared/src/` — never duplicate these in server or web |

Anything else: `docs/SYSTEM-MAP.md` indexes every feature to its files,
and `docs/TROUBLESHOOTING.md` is symptom-indexed — check it before
debugging from scratch.

## 4. Before you commit — the verification bar

```bash
pnpm -r build     # must pass clean
pnpm -r lint      # = tsc --noEmit everywhere
pnpm -r test      # server integration tests need live Postgres/Redis
                  # (they skip cleanly when infra is absent)
```

And hold the golden rules (`CLAUDE.md`): REST for durable writes / WS only
for fan-out, never reuse a message `seq`, blocks & privacy enforced
server-side at every surface, PSYCHOLOGY.md is law (no public numeric
counts, no seen-at timestamps, finite feeds), self-hosted ethos (no
third-party SaaS APIs), migrations append-only, zero new dependencies by
default.

## 5. Shipping to your server

```bash
git add -A
git commit -m "what you changed"
git push origin main

# then on the server:
./bored update        # pulls main + docker compose up -d --build
```

Useful server commands: `./bored status`, `./bored logs api`,
`./bored up` / `./bored down`, `./bored backup`.
