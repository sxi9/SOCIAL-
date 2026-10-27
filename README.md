# Bored Chat

Self-hosted chat for when the group chat is dead — your conversations on your
own box. One VPS, one `docker compose up -d`, real TLS. (Formerly SocialChat;
the rename is user-visible branding only — package names, compose project and
service names are unchanged, so existing deployments keep their volumes.)

- **Realtime messaging** — 1:1 and group chats (up to 256 members) with typing
  indicators, presence, and honest sent/delivered/read ticks. Offline for a
  month? You sync back exactly; a dropped connection can never lose a message.
- **Invite links** — mint a `/join/<token>` link and send it anywhere; the
  landing page shows your animated avatar (pasted links unfurl with your face),
  and whoever clicks it registers straight into a DM with you or into your
  group. Links expire after 7 days or 50 joins, and revoke instantly.
- **Reactions** — long-press (or hover) any bubble for a quick-react row; chips
  update live for everyone over the same event channel as receipts.
- **Animated GIF avatars** — upload a GIF, WebP, APNG, or short MP4; it becomes
  a looping avatar (animated on profiles and chat headers, static everywhere
  else, with reduced-motion respected). Groups get them too.
- **PWA share target** — install it on your phone and Bored Chat appears in the
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

Want to edit the code yourself? Start at
[`docs/DEVELOPING.md`](docs/DEVELOPING.md) — dev setup with hot reload,
where every file lives, and how to ship a change to your server.

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
#      TURN_SECRET=$(openssl rand -hex 32)      # voice/video calls (v0.6)
#      COMPOSE_PROFILES=turn                    # starts coturn alongside the rest

# 4. Up
docker compose up -d --build
```

That's it. The `migrate` service runs the database migrations and creates the
MinIO bucket, then `api` and `worker` start; Caddy answers on 80/443 with
automatic HTTPS. Open `https://your-domain`, register the first account, and
install the PWA from the browser menu.

Only Caddy publishes host ports — Postgres, Redis, and MinIO are reachable
solely on the internal compose network — with **one documented exception**
(ADR-014): the `turn` service (coturn, for v0.6 voice/video calls) publishes
`3478/udp+tcp` and the media relay range `49160-49200/udp` itself, because
TURN is UDP-first media relay and cannot ride an HTTP reverse proxy. If the
box runs a host firewall (ufw, cloud security groups), open those ports too:

```bash
ufw allow 3478/tcp && ufw allow 3478/udp && ufw allow 49160:49200/udp
```

Calls work without TURN between peers on the same network (host candidates)
— `TURN_SECRET` left empty just disables the relay, nothing else — but two
phones on different carrier NATs need it. The api mints time-limited HMAC
credentials from `TURN_SECRET` (coturn static-auth-secret mode; API.md
§1.42); api and coturn share only that env var. The `turn` service sits
behind the `turn` compose profile (`COMPOSE_PROFILES=turn` in `.env`, set it
together with `TURN_SECRET`) and refuses to start when `TURN_SECRET` is
empty — coturn authenticating against an empty secret on public ports would
be an open relay, so neither lock is optional. A box behind NAT (home server
rather than VPS) additionally needs `--external-ip=<public-ip>` added to the
`turn` service command in `docker-compose.yml`.

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

### Signing in (v0.9 auth pack)

Password login is the baseline; on top of it (all first-party, no external
services — API.md §1.70–1.74, ADR-021):

- **Passkeys** (fingerprint/face/WebAuthn) — enroll in Settings → Security.
  Passkeys bind to the domain (`WEBAUTHN_RP_ID`, derived from
  `PUBLIC_ORIGIN`/`DOMAIN` when unset): enroll them on a stable domain only —
  a quick-tunnel URL changes every run and orphans them.
- **QR cross-device login** — the login page shows a code; a logged-in phone
  scans and approves it (WhatsApp-Web style; short-lived, single-use).
- **Recovery codes** — 6 one-time codes offered at signup and regenerable in
  Settings → Security; using one revokes all sessions and forces a new
  password. This is the self-service account recovery (no email needed).
- **TOTP 2FA** — optional authenticator-app second factor; recovery codes
  bypass it.
- **admin → Authentication** — OTP-ready settings (SMTP/SMS slots,
  per-feature toggles). The toggles stay disabled with "needs SMTP" notes
  until a mailer release configures delivery; enabling OTP later is
  configuration, not code.

### Password reset (operator fallback)

```bash
docker compose exec api node dist/cli.js reset-password <username>
```

Prints a one-time temporary password and revokes all of the user's sessions
(closing their live sockets). Users who saved recovery codes don't need
this — the login page's "Use a recovery code" path self-serves.

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

> **This cut line is historical** (the v0.1 MVP). Most of the "out" list has
> since shipped — reactions, feed/posts, calls, blocking & moderation, the
> admin panel, stories and more. [`docs/FEATURES.md`](docs/FEATURES.md) is
> the always-current shipped-vs-planned list, and
> [`docs/AUDIT-PLAN.md`](docs/AUDIT-PLAN.md) is the sequenced list of what
> is being added or updated next (from the 2026-10-18 product audit).

---

## License

MIT — see [LICENSE](LICENSE).
