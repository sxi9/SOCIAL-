# ADR-001: Opaque DB sessions in an httpOnly cookie — no JWT

Status: accepted · Date: 2026-10-16

## Context

SocialChat is a single-origin product behind one Caddy proxy: the same host serves
the Next.js app, `/api/*`, and the `/ws` WebSocket upgrade. Auth must cover REST,
SSR, and the WS handshake. JWTs would still require a revocation store to kill
stolen or logged-out tokens — which is exactly a sessions table — plus refresh
rotation and a WS ticket/refresh choreography. They are strictly extra parts here.

## Decision

- Session token: 32 random bytes (base64url) in cookie `sid` =
  `HttpOnly; Secure; SameSite=Lax; Path=/`. The DB stores only
  `sha256(token)` (`sessions.token_hash`).
- Expiry: 30-day sliding — `expires_at` pushed forward on use (a sliding server
  session *is* the refresh mechanism); `last_seen_at` written at most hourly.
- Passwords: argon2id (`m=64MiB, t=3, p=1`), min length 8.
- CSRF: `SameSite=Lax` plus a required `X-Requested-With: fetch` header on every
  mutating `/api` route (the custom header forces a CORS preflight cross-origin
  forms cannot pass). The share-target POST is same-origin by construction, so
  the cookie rides it with no token minting.
- WS auth: the `sid` cookie rides the `GET /ws` upgrade. The socket registry is
  keyed `Map<sessionId, Set<socket>>`, so logout / session revocation / expiry
  closes that session's live sockets immediately (close code `4401`).

## Consequences

- A revoked user never keeps a live socket; sessions double as the device
  registry (`GET /auth/sessions`, `DELETE /auth/sessions/:id`). No separate
  `devices` table until native apps / E2EE (Phase 4).
- Every authenticated request costs one indexed session lookup — fine at this
  scale, and the table is also the future E2EE device anchor.
- `Secure` cookies require TLS; Caddy's automatic HTTPS provides it, and the
  `localhost:80` fallback is for local testing only.
- No email-verification or password-reset flows in MVP; ops reset is the CLI
  (`node dist/cli.js reset-password <username>`), which revokes all sessions.
