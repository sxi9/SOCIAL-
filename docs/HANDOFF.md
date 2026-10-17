# Session Handoff — continue from here

Written 2026-10-17 ~14:35 UTC, as the owner switches Claude accounts.
A new session continues this project by reading `CLAUDE.md` first (it
auto-loads), then this file for "where exactly were we".

## State at handoff

- `main` = `51853e3` (v0.8b) — last fully verified release. Everything on
  `main` is shipped, audited, and deployable (`docker compose up -d --build`).
- **v0.9 (auth pack) was IN FLIGHT**: items 82-86 of `docs/FEATURES.md`,
  full design in `docs/SPECS.md` §"v0.9 — Auth pack".
  - DONE at snapshot time: the v0.9 contract (migration 0011, shared
    schemas, API.md §1.70-1.74, ADR-021) and the COMPLETE web build
    (passkey login UI, hand-rolled SVG QR encoder in `apps/web/lib/qr.ts`,
    QR login panel + `/link/[code]` approve sheet, TOTP flow, recovery-codes
    reveal, Settings→Security, admin Authentication page — typechecked).
  - IN PROGRESS: `apps/server` implementation (passkeys, QR login links,
    recovery codes, TOTP, admin auth settings) + its tests.
  - Snapshot of all of it: branch `wip/v0.9` (= `backup/v0.9-wip-20261017`,
    commit `270a806`). IT IS UNVERIFIED — never merge it to main as-is.
- If `main` already contains a commit titled "v0.9: auth pack" when you read
  this, the chain finished after this note was written: ignore the wip
  branch, this section is obsolete, and only the wrap-up below may remain.

## To finish v0.9 (the next session's job)

1. Start from `main`; cherry-pick or diff-apply the GOOD parts of
   `wip/v0.9` (contract + web are complete; the server module is partial —
   finish it against `docs/API.md` §1.70-1.74 and the ADR-021 decisions).
2. Verification bar (CLAUDE.md): builds green twice, full test suite
   (local PG convention in CLAUDE.md), REAL passkey register+login via
   Chromium's virtual authenticator (CDP WebAuthn domain), REAL QR
   cross-device login between two browser contexts, adversarial auth audit
   (challenge replay, counter regression, QR approve direction,
   recovery-code races, TOTP window), fix/recheck rounds.
3. Push v0.9 to main; then wrap up: mark FEATURES.md items 82-86 shipped,
   README auth section, delete/ignore wip branches, summary to the owner.

## After v0.9 — the agreed backlog (owner schedules, do not auto-start)

LiveKit SFU for >8-person calls · listen-together · E2EE · native wrappers
· make-it-yours kit · federation · a real SMTP mailer (turns on the stored
OTP/email toggles in admin→Authentication).

## Owner's operational setup (context the new session needs)

- Owner runs the app on a laptop via `./bored` (update/tunnel/status/
  backup/export-import; autoupdate cron optional). Public exposure via
  cloudflared quick tunnels; `PUBLIC_ORIGIN` in `.env` (auto-set by
  `./bored tunnel`). Cross-network calls need a VPS or port-forwarding
  (ADR-017). Admin is CLI-granted (`./bored admin <user>`).
- Standing decisions are in `docs/SPECS.md` (bottom section) — honor them.
