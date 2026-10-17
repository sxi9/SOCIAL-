# Session Handoff — continue from here

Updated 2026-10-17 ~14:55 UTC. A new session continues this project by
reading `CLAUDE.md` first (it auto-loads), then this file.

## State at handoff

- **v0.9 (auth pack) IS SHIPPED on `main`** — passkeys, QR cross-device
  login, recovery codes, TOTP 2FA, admin Authentication settings
  (FEATURES.md items 82-86; design: `docs/SPECS.md` §"v0.9 — Auth pack";
  contract: `docs/API.md` §1.70-1.74, ADR-021, migration 0011).
- Verification that PASSED before the ship commit: `pnpm -r build` clean
  twice, full test suite on live Postgres/Redis, curl smoke, real passkey
  register+login via Chromium's CDP virtual authenticator, real QR
  cross-device login between two browser contexts, TOTP enable/login and
  recovery-code flows walked with screenshots.
- The `wip/v0.9` and `backup/*` branches are now historical only — ignore
  them (main supersedes).

## FIRST TASK for the next session: 3 remaining audit minors

v0.9.1 (on `main`) fixed the audit's MAJOR finding (TOTP verify/disable
rate limit, with test + API.md §1.73 429 docs) plus two UI minors. Three
audit MINORS remain unfixed — small, well-scoped, defense-in-depth. Fix
them, hold the CLAUDE.md verification bar, ship as v0.9.2 (or fold into
the next release):

1. **`auth/passkeys.ts` (~line 288)**: login counter update is an
   unconditional `SET counter = $new`; concurrent assertions can regress
   it. Make it conditional: `SET counter = GREATEST(counter, $new) WHERE
   ... AND counter = $read` (or `AND counter <= $new`).
2. **`auth/recovery.ts` (~line 135)**: `POST /api/auth/recover` timing
   side-channel on account existence (unknown user skips the consume
   UPDATE). Run an equal-cost dummy consume for unknown users.
3. **`auth/recovery.ts` (~line 146)**: recovery consumes the code +
   revokes all sessions BEFORE the support-message insert and reset-token
   mint; a throw there burns the code and locks the user out. Mint/store
   the reset token first; wrap the notify in try/catch (best-effort, like
   the register invite-accept pattern).

## After v0.9.1 — the agreed backlog (owner schedules, do not auto-start)

LiveKit SFU for >8-person calls · listen-together · E2EE · native wrappers
· make-it-yours kit · federation · a real SMTP mailer (turns on the stored
OTP/email toggles in admin→Authentication).

## Owner's operational setup (context the new session needs)

- Owner runs the app on a laptop via `./bored` (update/tunnel/status/
  backup/export-import; autoupdate cron optional). Public exposure via
  cloudflared quick tunnels; `PUBLIC_ORIGIN` in `.env` (auto-set by
  `./bored tunnel`). Cross-network calls need a VPS or port-forwarding
  (ADR-017). Admin is CLI-granted (`./bored admin <user>`).
- Passkeys bind to the domain (WEBAUTHN_RP_ID, ADR-021) — on quick
  tunnels every run is a new domain, so tell the owner to enroll passkeys
  only on a stable domain.
- Standing decisions are in `docs/SPECS.md` (bottom section) — honor them.
