# ADR-021: The auth pack — new ways to mint the same old session, one sanctioned dependency, and an SMTP page that stores config it cannot yet use

Status: accepted · Date: 2026-10-17

## Context

v0.9 (FEATURES #82–#86; API.md §1.70–§1.74): passkeys, QR cross-device login,
recovery codes, optional TOTP 2FA, and an OTP-ready admin Authentication page.
The temptation in an "auth pack" is to grow a second auth system. The binding
constraint is the opposite: ADR-001's session layer (opaque 32-byte token,
sha256 stored, httpOnly `sid` cookie, sliding 30-day expiry, cookie on the WS
upgrade, revocation closes sockets `4401`, `X-Requested-With` CSRF) stays the
ONLY session layer. Every v0.9 feature is a new way to **mint** a sessions
row, or to gate the minting — nothing else moves. The second constraint is
golden rule 10 (zero new dependencies by default), which this release tests
twice: WebAuthn verification and QR rendering.

## Decision

- **One dependency exception, taken deliberately: `@simplewebauthn`.**
  Verifying a WebAuthn registration means parsing CBOR attestation objects,
  decoding COSE keys across EC2/RSA/OKP algorithms, validating authenticator
  data flags, rpIdHash, and signatures over `authenticatorData ||
  sha256(clientDataJSON)` — hundreds of lines of binary-format security code
  where one silent mistake is an authentication bypass. Hand-rolling it is
  exactly the "impractical to do correctly" case the owner carved out. Pinned
  exact (rule 10's pinning half still applies): **`@simplewebauthn/server`
  `13.1.1`** (apps/server) and **`@simplewebauthn/browser` `13.1.0`**
  (apps/web). Both are pure TypeScript with **no install scripts**, so
  `pnpm.onlyBuiltDependencies` does not change; verify that remains true at
  install (`pnpm why` + a clean install log) and if an exact pin is
  unpublishable at integration time, pin the nearest 13.x patch and update
  this line. The shared contract treats the W3C options/response JSON as
  opaque (`WebAuthnJson`) — the library owns those shapes; re-declaring them
  in Zod would just rot.

- **TOTP is hand-rolled; QR rendering is hand-rolled; neither is a
  dependency.** RFC 6238 over `node:crypto` HMAC-SHA1 is ~40 lines with
  published test vectors (RFC 6238 appendix B — the unit suite encodes them):
  SHA1 / 6 digits / 30 s period / ±1 step drift, 20-byte secrets, and a Redis
  burn of the matched step so a code never authenticates twice. QR codes (the
  §1.71 login link and the §1.73 otpauth URI) render client-side from a
  minimal hand-rolled byte-mode QR encoder emitting inline SVG
  (`apps/web/lib/qr.ts`; versions sized for ≤ ~120-char payloads, ECC M —
  well within spec tables we can embed). Both QR surfaces keep a no-QR
  fallback **permanently visible**, not just on failure: the 6-char display
  code under the login QR, and the copyable `manual_key` + otpauth URI under
  the TOTP QR. If the encoder slips the integration schedule, the fallbacks
  ARE the feature and the QRs follow — the contract already allows it.

- **rpID and origins are explicit env, derived sensibly, with the tunnel
  caveat in writing.** rpID = `WEBAUTHN_RP_ID` → else hostname of
  `PUBLIC_ORIGIN` → else `DOMAIN`. Expected origin = `PUBLIC_ORIGIN` → else
  `https://<DOMAIN>` (dev additionally allows the localhost origins). The
  caveat that WILL bite self-hosters: **passkeys bind to the rpID domain**.
  A quick tunnel (`*.trycloudflare.com`) gets a fresh domain per run, so
  every credential enrolled against it is orphaned on the next tunnel —
  silently, from the user's point of view. Decision: don't block it (same-
  machine testing is legitimate), but the passkeys settings page shows the
  active rpID and warns on known quick-tunnel suffixes, and the docs say
  plainly: enroll passkeys only on a stable domain (the §1.55 TURN-honesty
  posture, applied to auth).

- **QR login mints the session on the laptop's own request.** Two codes, both
  sha256 rows (the ADR-001 token doctrine): the 32-byte full code is the QR
  payload and the only poll/redeem capability; the 6-char display code can
  only *approve*. Approval (phone, authed, shown the laptop's UA + coarse IP)
  flips `pending → approved`; the laptop's next poll flips `approved →
  consumed` and mints the cookie — so the session token never transits the
  phone or persists anywhere, and `new_session_id` is a plain audit FK. All
  transitions are atomic `UPDATE … WHERE status='<prev>' RETURNING`
  (TROUBLESHOOTING's race rule); all failures are one byte-identical
  `410 link_gone`. The 6-char keyspace (~31^6) is safe **because of what the
  code can do**: a guesser can only approve a stranger's laptop into the
  guesser's *own* account, at 5/min — not read, not redeem, not join anything.
  The phone's session is not re-gated by TOTP at approval: it already cleared
  TOTP at its own login, and re-prompting would train users to type codes
  into sheets reflexively.

- **Recovery is scorched earth, and that's the feature.** A consumed code
  (atomic claim) revokes every session (sockets `4401`), notifies through the
  §1.69 Support conversation + push, and hands back only a 15-minute
  `reset_token` — a new password is mandatory before any session exists,
  because the common case for recovery is "credentials compromised", not
  "forgot". Recovery bypasses TOTP by design (it IS the lost-authenticator
  path); that makes the 6 codes the real second factor of last resort, which
  is why regeneration re-proves the password and why codes are shown exactly
  once, stored hashed, with a status endpoint that can only count them.

- **TOTP secret: encrypted at rest, with the tradeoff named.** Unlike every
  other v0.9 secret, verification must *read back* the TOTP seed, so hashing
  is out. Options: plaintext column (simple, and a DB dump walks away with
  every second factor) vs AES-256-GCM under a key HKDF-derived from
  `SESSION_SECRET` (info `'totp:'`; `v1:` version prefix for future rotation).
  Chosen: encryption. Cost, documented honestly: **rotating `SESSION_SECRET`
  orphans all TOTP enrollments** — those logins fall back to recovery codes
  and users re-enroll. Acceptable because session-secret rotation is already
  a disruptive, deliberate act here, and the failure mode is a recoverable
  lockout, not a breach. The same machinery (info `'smtp:'`) encrypts the
  stored SMTP password. TOTP gates password AND passkey logins (SPECS #85's
  words) via a half-login `totp_token` in Redis — the gate lives at minting,
  the session layer never learns about factors.

- **The Authentication page stores what it cannot send, and says so.** Golden
  rule 10 means no SMTP client ships in v0.9 (a hand-rolled SMTP/TLS dialogue
  is a dependency-shaped liability, not a feature), so: the full SMTP block
  and all four feature toggles persist in `instance_settings` today; every
  email-dependent flow is specified to flag off them at runtime; the
  test-send endpoint exists and answers `503 mailer_unavailable`; and the UI
  renders the toggles and Test send visible-but-disabled behind "needs SMTP
  support in a future update". When a mailer lands, enabling email OTP is
  flipping stored booleans — configuration, not code (SPECS #86's exact
  point). The SMTP password is write-only in the PATCH, lives encrypted in
  its own settings key, serializes only as `password_set`, and is overridden
  by the `SMTP_PASSWORD` env when set (the env-reference option). The
  SMS-gateway slot stays a documented placeholder — naming a schema for an
  unchosen gateway would be pretend-readiness.

## Consequences

- The sessions table quietly becomes the product's device list: §1.1 session
  management now covers passkey-, QR- and reset-minted sessions with zero new
  code, and "log out that laptop from my phone" already works (`DELETE
  /api/auth/sessions/:id`, sockets close `4401`).
- Two new Redis state families (WebAuthn challenges, TOTP pending/half-login
  tokens + burned steps) and one new GC duty (expired `login_links`) — all
  TTL-bounded, none of it rows, none of it syncs.
- `@simplewebauthn` is the repo's first rule-10 exception; this ADR is the
  precedent-setter: an exception needs a security argument, exact pins, and
  an install-script check, or it doesn't happen.
- A future mailer release re-reads §1.74 and wires `mailer_available`,
  test-send, and the four flows to the toggles that have been waiting — the
  admin who configured SMTP in v0.9 upgrades into working email with no
  settings to re-enter.
- Anti-enumeration surfaces grew: passkey login options for unknown
  usernames, `410 link_gone`, `401 bad_recovery` — each byte-identical across
  its failure causes, each on the §1.44 list the security audit re-checks
  every release.
