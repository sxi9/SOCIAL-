# ADR-013: Admin — CLI-rooted operator surface, metadata-only, with bounded retention

Status: accepted · Date: 2026-10-17 · Amended 2026-10-18 (web adminhood + password set — see the end)

## Context

v0.5b ships FEATURES #54: the operator dashboard — user list with IPs and
sessions, a reports queue with actions, a log viewer, metrics, the invite
switch, and data export. The feature's own spec draws the hard line
("metadata only — no private message contents in the UI; IP retention window
documented"), and the v0.3 reports table was written append-only precisely
for this consumer. The design questions were about power and trust: who gets
to be admin, what an admin can see, how long the server remembers IPs, and
where operational logs live. This is a self-hosted product — the operator
already has root on the box and `psql` access, so the admin surface cannot
*create* power the operator lacks; what it can do is normalize and audit the
power they have, or quietly expand what a *compromised admin cookie* reaches.
That last framing decided most of the calls below.

## Decision

- **Adminhood is CLI-only.** `node dist/cli.js grant-admin <username>` /
  `revoke-admin <username>` flip `users.is_admin`; no REST path mints or
  revokes admins, ever. Shell access to the box is the root of trust — the
  same model as `reset-password` (ADR-001's ops stance). Consequence: a
  stolen admin session can suspend users but cannot replicate itself, and
  "who is admin" is answerable from the shell without trusting the app. Admin
  routes require `is_admin` plus a non-suspended, non-banned account, and
  answer `404 not_found` to everyone else — the §1.14 shape: the surface does
  not exist for non-admins. Admin mutations cannot target admin accounts
  (`400 bad_admin_target`); demote via CLI first, so two admins cannot
  lock-war each other from the web and a compromised cookie cannot decapitate
  the instance.
- **Suspend and ban are two flags with serializer-edge teeth.**
  `suspended_at`: login → `403 account_suspended`, all session rows deleted,
  live sockets closed `4401` — entirely the §1.1 revocation machinery that
  already guarantees "a revoked user never keeps a live socket". `banned_at`:
  the same, plus public invisibility (profile 404, listings/stories/posts/
  search/beacon audiences) enforced at read/fan-out time like every
  §1.13/§1.14 rule — **nothing stored is rewritten**, so unban restores
  instantly and a mistaken ban destroys nothing. Conversation history and
  membership survive both: moderation stops an account, never the archive
  (the §1.14 "blocks don't delete history" principle). Suspension leaves
  public surfaces up; ban takes them down — two levers, not one.
- **The reports queue consumes the v0.3 table, adding only resolution
  columns.** `closed_by` / `closed_at` / `close_note` (+ a shape CHECK with a
  backfill for hand-closed rows). Target previews are **metadata-only**: a
  reported message serializes conversation/seq/sender/type/created_at/
  tombstone-state — never its body. The reporter's `reason` is where quoted
  content lives, and that is the reporter's own submission, not a
  counterparty's private words lifted from the DB. Reports keep outliving
  their targets (the v0.3 no-FK design); previews just go null.
- **Admin never reads private message content — including in the export.**
  `GET /api/admin/users/:id/export` returns the user's own rows (users row,
  sessions metadata, listings, posts, reviews received; secrets stripped:
  `password_hash`, session `token_hash`, push keys) and **excludes message
  bodies**. The argument, as promised in the spec: a member's conversations
  are co-authored — exporting them hands the operator their counterparties'
  words in bulk, which is a wiretap with a JSON content-type, and the one
  capability this product must be able to truthfully deny having a button
  for. The export serves operator needs (disputes, deletion requests,
  migration); a user-initiated takeout of their *own* history is future
  user-facing scope with its own consent story, not an admin route. Operator
  root access to `psql` cannot be designed away — but the app's job is to
  make the audited path the easy path, not to pave the other one.
- **IP capture is bounded by a retention sweep, not policy prose.**
  Registration stamps `users.registration_ip`; login/register already stamp
  `sessions.ip`/`user_agent` (v0.1 columns). The nightly GC job **nulls both
  past `IP_RETENTION_DAYS` (90)** — enforcement is a `WHERE created_at <
  now() - 90d` update, so the documented privacy-note window is true by
  construction, and the admin UI can only ever show what has not aged out.
  The user list serializes `last_seen` as a coarse bucket
  (today/this-week/this-month/older/never): the operator needs liveness,
  not a surveillance feed — the same instinct as the §1.18 no-timestamps
  rule, applied to the operator's own view.
- **The log ring lives in Redis, capped, and admin actions always enter it.**
  Pino `warn`+`error` from api and worker, plus every admin mutation
  (`level: 'admin'`, actor attached), `LPUSH`ed to one list and `LTRIM`med to
  `LOG_RING_MAX` (1000). Redis, not Postgres, on purpose: logs are
  operational telemetry, not product data — they need no migrations, no
  backup discipline, and bounded memory; AOF makes them durable enough, and
  losing the ring in a Redis wipe loses nothing users own. The ring is also
  the admin **audit trail**: suspensions, bans, report closures and settings
  flips are visible to every other admin by construction, which is most of
  the accountability a small instance needs.
- **Instance settings are a key/value jsonb table.** `instance_settings (key
  PK, value jsonb)` seeded with `invites_enabled = true`; adding a setting is
  an INSERT, not a migration. The switch is enforced at invite **mint and
  accept** (`403 invites_disabled`, no `use_count` claim) — both ends,
  because minted links outlive the flip; register-with-token degrades to
  `invite: null` exactly like every other bad invite (§1.1's "registration
  never fails on a bad invite" survives the feature).
- **Metrics are honest proxies, read-only, computed on demand.** 30-day
  series (registrations, messages, DAU) plus totals. DAU = distinct users
  whose sessions were seen that day — sliding sessions make it approximate,
  and the API doc says so rather than dressing it up. No counters are
  materialized; an operator dashboard read can afford five aggregate queries.

## Consequences

- **Zero new dependencies, zero new WS events** (suspension reuses the `4401`
  close), one new table (`instance_settings`), four `users` columns, three
  `reports` columns. The log ring is a pino stream target plus `LPUSH` —
  no logging stack.
- Admin REST is ~10 read-heavy routes whose writes all funnel through
  existing machinery (session revocation, serializer flags, the reports
  table), so the implementation surface is thin and the blast radius of an
  admin-route bug is bounded.
- Ban enforcement touches every public read path (profile, search, listings,
  stories, posts, beacon audiences) as one more serializer predicate — the
  same seam blocks already pass through, so each surface is a one-line
  `banned_at IS NULL` added to an existing filter, verified per-surface in
  review rather than by a central mechanism. Suspended-but-not-banned users
  remaining publicly visible is deliberate (suspension disputes should not
  vanish a person).
- The 90-day IP null-out is destructive by design: an operator who needs
  longer retention for abuse forensics must change the constant and their
  privacy note together. Documented, not configurable per-request.
- The ring is capped at 1000 entries — a noisy error loop can wash out audit
  entries. Accepted at this scale; admin actions are also pino-logged to
  stdout (compose logs) as a second copy.
- `list_sessions`-style admin visibility stops at metadata; nothing in the
  admin build creates a body-reading code path, which keeps "the operator
  UI cannot read your messages" a reviewable claim about routes and
  serializers, not a policy promise.

## Amendment — 2026-10-18: adminhood and password reset from the web

The owner asked for the two CLI-only operations to be reachable from the
admin panel. Decision: `POST /api/admin/users/:id/grant-admin` /
`revoke-admin` and `POST /api/admin/users/:id/password` exist (API.md §1.41),
wired to the Users tab. What this costs, stated plainly: a stolen admin
session can now **replicate itself** (grant another account) and take over
any non-admin account by setting its password — the two things the original
decision was built to prevent. What is kept to bound that: `revoke-admin`
refuses your own account (`self_target`), so an instance cannot be
decapitated from the web and the CLI remains the root of trust for "who is
admin"; `password` refuses admin targets (`bad_admin_target`), so one admin
cookie cannot absorb another admin; granting requires a non-suspended,
non-banned target; every call is ring-logged with actor and target (never the
password). Operators who want the original posture back can treat the three
routes as a one-line removal — nothing else depends on them.
