# ADR-009: Privacy enforcement — settings as columns, filtering at the edge, 404-shaped blocks

Status: accepted · Date: 2026-10-16

## Context

v0.3 ships privacy settings (reciprocal read receipts, last-seen visibility,
typing toggle, invite pause, beacon default audience, group-add policy),
seen-by lists, and blocks + reports — together with the first public-facing
surface (public beacons), per the standing rule that safety ships *with*
reach, never after (FEATURES #29). Tensions:

1. Where do settings live — a `user_settings` table or columns on `users`?
2. Where is privacy enforced — in stored state, on the `events` channel, or at
   the recipient edge?
3. Read receipts power unread counts and push suppression; turning them "off"
   must not break either.
4. A block that answers `403` *confirms* the block to the blocked person —
   itself a harm vector.
5. Reports must survive deletion of whatever they report.

## Decision

- **Settings are columns on `users`** (`read_receipts`, `show_last_seen`,
  `show_typing`, `invites_paused`, `beacon_default_audience`,
  `group_add_policy`), not a settings table. Precedent: `avatar_motion`
  already lives there. The presence/typing/receipt hot paths read one user row
  they already have; a 1:1 table would add a join to every gateway decision to
  normalize nothing (text + CHECK, like every enum here). `area` rides along
  as owner-private identity (citext for case-insensitive beacon matching).
- **Enforcement is server-side at the recipient edge, serialization-only.**
  The Redis `events` channel stays a trusted, unfiltered api↔worker firehose;
  the WS gateway (per socket) and REST serializers (per viewer) apply the
  rules in API.md §1.13/§2.11, because only the edge knows the recipient. No
  stored watermark, presence key, or row is rewritten by a settings change —
  toggles apply and un-apply instantly, with nothing to backfill or repair.
- **Reciprocal read receipts filter display, never state.** Watermarks always
  advance (unread counts, §2.9 push guards, sync — all untouched). With
  receipts off, *your* `last_read_seq` serializes as `0` to others AND others'
  serialize as `0` to you; `GET …/receipts` answers you `403
  read_receipts_off`; you appear at most in `delivered`. Delivered state is
  never filtered — it is plumbing, not social pressure. And per the PSYCHOLOGY
  never-build list, **no receipt payload anywhere carries a timestamp**; the
  §1.18 lists order by username so even ordering leaks no recency.
- **Blocks are 404-shaped.** Everywhere a refusal would confirm the block
  (DM create, frozen DM sends, profile, beacon join/kudos, invite accept) the
  answer is byte-identical to "never existed". The single 403 surface shared
  with `group_add_policy` (`group_add_denied`) is deliberately identical for
  "policy" and "blocked", so it confirms nothing. Mutual invisibility both
  directions; the blocker's own `GET /api/users/me/blocks` is the management
  surface. Shared groups keep functioning (messages, group receipts) — leaving
  is a visible choice we won't make for the user — but presence/typing/
  last-seen between the pair are suppressed and no new DM can be created.
- **Reports are an FK-less audit log.** Targets are stored as bare ids
  (`kind` + CHECK-enforced shape); only `reporter_id` has an FK. A report must
  outlive the reported message/beacon/user-content, or moderation evidence
  self-destructs. Rows are write-once (`status` open→closed) for the future
  admin dashboard (FEATURES #54); rate-limited 10/hour/user; no notification
  to anyone at file time.

## Consequences

- One user-row read per edge decision; no new hot-path queries. The gateway
  caches the sender's own settings per socket and re-reads on `user.updated`.
- Serialization-time filtering means historical data is retained (e.g. old
  read watermarks reappear if receipts are re-enabled). Documented behavior:
  settings govern *visibility*, not *recording*. True no-record semantics
  would break unread counts and are explicitly out of scope.
- 404-shaping costs honesty in error codes (a blocked DM attempt looks like a
  deleted account) — accepted: ambiguity is the protection. Support queries
  can consult the `blocks` table.
- The blocked pair can still see each other's messages in pre-existing shared
  groups. Accepted and documented: the alternative (hiding members' messages
  from each other) corrupts group conversations; the escape hatch is leaving
  the group or reporting.
- Adding a future setting is one `users` column + one enforcement row in the
  §1.13 table; the pattern scales until settings become numerous enough to
  justify a table (revisit at ~15 columns).
