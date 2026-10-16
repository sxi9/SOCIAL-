# SocialChat

Self-hosted chat for people who want their conversations on their own box.
One VPS, one `docker compose up -d`, real TLS.

- **Realtime messaging** — 1:1 and group chats (up to 256 members) with typing
  indicators, presence, and honest sent/delivered/read ticks. Offline for a
  month? You sync back exactly; a dropped connection can never lose a message.
- **Animated GIF avatars** — upload a GIF, WebP, APNG, or short MP4; it becomes
  a looping avatar (animated on profiles and chat headers, static everywhere
  else, with reduced-motion respected). Groups get them too.
- **PWA share target** — install it on your phone and SocialChat appears in the
  OS share sheet. Share a photo, video, or link from any app straight into a
  conversation — even while logged out; nothing is dropped.
- **Link previews** — shared and typed URLs unfurl into cards server-side
  (SSRF-guarded; preview images are re-hosted, so readers never leak their IP
  to third-party sites).
- **Web push** — notifications when the app is closed, debounced and suppressed
  if you already read the message on another device.

Stack: TypeScript everywhere, Next.js 15, Fastify 5 + raw `ws`, PostgreSQL 17,
Redis 7 (BullMQ), MinIO, FFmpeg/sharp, Caddy 2. Design docs live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/API.md`](docs/API.md),
[`docs/SCHEMA.sql`](docs/SCHEMA.sql); decisions in [`docs/adr/`](docs/adr/).

---

## Deploy to a VPS in 5 minutes

You need: a VPS (2 GB RAM is plenty to start), Docker Engine with the compose
plugin, and a domain.

```bash
# 1. Point DNS at the box (A/AAAA record for your domain) — do this first,
#    Caddy gets its TLS certificate automatically as soon as DNS resolves.

# 2. Get the code
git clone <this-repo> socialchat && cd socialchat

# 3. Configure — ONE env file drives everything
cp .env.example .env
#    Edit .env:
#      DOMAIN=chat.example.com
#      POSTGRES_PASSWORD=<something random>
#      MINIO_ACCESS_KEY / MINIO_SECRET_KEY=<something random>
#      SESSION_SECRET=$(openssl rand -base64 32)
#      VAPID keys (for web push):  npx web-push generate-vapid-keys

# 4. Up
docker compose up -d --build
```

That's it. The `migrate` service runs the database migrations and creates the
MinIO bucket, then `api` and `worker` start; Caddy answers on 80/443 with
automatic HTTPS. Open `https://your-domain`, register the first account, and
install the PWA from the browser menu.

Only Caddy publishes host ports — Postgres, Redis, and MinIO are reachable
solely on the internal compose network.

---

## Local development

```bash
pnpm install
cp .env.example .env         # defaults already point at localhost

# backing stores only, published on 127.0.0.1 via the dev override
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis minio

pnpm migrate                 # apply migrations + create the bucket
pnpm dev                     # web (Next.js) + api + worker, all watch-mode
```

The web app runs on its Next.js dev port and talks to the api directly. To test
the full proxy path (or the PWA share target, which needs a real origin), run
the whole stack instead: `docker compose up -d --build` and use
`http://localhost` (plain-HTTP fallback is built into the Caddyfile).

---

## Ops runbook

### Password reset (CLI-only in MVP — there is no email flow)

```bash
docker compose exec api node dist/cli.js reset-password <username>
```

Prints a one-time temporary password and revokes all of the user's sessions
(closing their live sockets).

### Backups

Two things hold all state: the Postgres volume (users, messages, cursors) and
the MinIO volume (media). Redis is rebuildable (presence, queues). Nightly
crontab (adjust paths; assumes the repo lives in `/opt/socialchat`):

```cron
# nightly logical dump of Postgres (3:00) — % must stay escaped in crontab
0 3 * * * cd /opt/socialchat && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > /var/backups/socialchat/pg-$(date +\%F).sql.gz

# nightly rsync of the MinIO data volume (3:30)
30 3 * * * rsync -a /var/lib/docker/volumes/socialchat_minio_data/_data/ /var/backups/socialchat/minio/

# prune dumps older than 14 days (4:00)
0 4 * * * find /var/backups/socialchat -name 'pg-*.sql.gz' -mtime +14 -delete
```

Create the target once: `mkdir -p /var/backups/socialchat/minio` — and ship
`/var/backups/socialchat` off the box with the tool of your choice.

Restore: `gunzip -c pg-<date>.sql.gz | docker compose exec -T postgres sh -c
'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'` into a fresh database, rsync the
MinIO directory back, `docker compose up -d`.

### Logs

```bash
docker compose logs -f               # everything
docker compose logs -f api worker    # the interesting ones
docker compose logs migrate          # last migration run
```

### Upgrade

```bash
cd /opt/socialchat
git pull
docker compose build
docker compose up -d        # re-runs migrate (idempotent), then rolls api/worker/web
```

Migrations are applied by the run-once `migrate` service before `api`/`worker`
start — there is no boot race. Roll back by checking out the previous tag and
repeating; take a backup before upgrading across many versions.

### Health

Postgres/Redis/MinIO have compose healthchecks — `docker compose ps` shows
them. The api serves `GET /healthz` (compose-network only; Caddy routes just
`/api/*` and `/ws`):

```bash
docker compose exec api node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

---

## What's in, what's out (Phase-1 cut line)

MVP ships exactly: accounts & sessions, DMs + groups, realtime with receipts,
media messages (images/video/files), animated avatars, PWA + web push, share
target, link previews.

Deliberately **out** of the MVP (no code, no UI): reactions, replies/threads UI,
forwarding, message edit/delete UI, stories, broadcast channels, feed/posts,
calls, E2EE, full-text search, @mentions, email verification / password-reset
flows (CLI only), blocking & moderation tooling, admin panel, native apps,
multi-node deployment, video transcoding (originals served as-is).

Most of these have seams already cut (schema columns, event shapes, queue
topology). The build order and Phase 2–4 plans live in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## License

MIT — see [LICENSE](LICENSE).
