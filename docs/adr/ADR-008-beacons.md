# ADR-008: Beacons — audience-scoped intent cards, atomic spark, count-up rituals

Status: accepted · Date: 2026-10-16

## Context

v0.3's signature feature: a bored user posts a Beacon (vibe chip + note + time
window + audience + spark threshold); when enough people tap "I'm in", it
sparks into a real plan group. `docs/PSYCHOLOGY.md` binds the design: the
bored user never waits, faces over counters, visibility only while joinable
(FoMO-safe), re-ping at "one more needed", forgiving count-up rituals,
peak-and-end recaps, private kudos. Tensions:

1. The spark must be exactly-once under concurrent joins (two sockets tapping
   "I'm in" at count = threshold − 1).
2. "Audience" (friends / area / public) must be cheap to resolve at fan-out
   AND must never leak a beacon to someone who cannot join it.
3. Rituals need recurrence without becoming streaks, and recaps need a
   re-create token without a new capability surface.
4. The server is timezone-blind but the presets ("tonight", "weekend") are
   local-time concepts.

## Decision

- **Beacons are rows, plans are ordinary conversations.** A sparked beacon
  creates a normal `group` conversation (creator admin, joiners members,
  `join_seq = 0`) carrying an icebreaker system message and an auto venue poll
  (§1.17 poll message). Everything downstream — sync, receipts, push, history
  floors, afterglow recap delivery — is the existing machinery untouched.
- **Atomic spark = the ADR-007 trick again.** The join transaction takes
  `SELECT … FOR UPDATE` on the beacon row, inserts the join idempotently,
  recounts, and flips with the guarded
  `UPDATE beacons SET status='sparked', conversation_id=$c WHERE id=$1 AND
  status='open'`. The row lock serializes racing joins; the guard makes a
  double-spark structurally impossible. `spark_threshold` counts joiners
  (creator excluded): default 2 ⇒ groups of 3+, the PSYCHOLOGY §3 sweet spot.
- **Audience is resolved at read/fan-out time, never materialized.**
  `friends` = shares a DM with the creator (one indexed participants probe);
  `area` = `users.area` citext-equals the beacon's `area` **snapshot** (taken
  at mint so a creator moving cities cannot silently retarget a live beacon);
  `public` = everyone; always minus blocks. No audience rows to backfill, no
  stale membership. The DTO is viewer-specific (`my_state`,
  `conversation_id`, filtered joiner pile), stamped at the gateway edge
  (ADR-009 pattern). Non-joiners never receive spark details and sparked
  beacons leave their lists — visibility ⇔ joinability (PSYCHOLOGY rule 2).
- **Presets are client-computed.** The API takes concrete
  `starts_at`/`expires_at` and validates windows (≥ 30 min, ≤ 7 days out);
  now/tonight/weekend are documented client mappings. Keeps the server
  timezone-free and the contract honest.
- **Re-ping is a column, not a job.** `repinged_at` + guarded one-shot UPDATE
  inside the join path when count hits threshold − 1: at most one
  re-notification per beacon, enforced by data, not by worker memory.
- **Rituals are chained rows, counting UP.** Each weekly run is a new beacon
  linked by `ritual_parent_id` (partial unique index ⇒ one child max, so the
  hourly worker sweep is idempotent). `ritual_count` increments on spark
  ("12 chai nights") — never a streak, never decremented; `ritual_skips`
  tracks consecutive unsparked runs and at 2 the worker simply stops creating
  runs: no notification, no guilt copy (never-build list). Resume is explicit
  (`ritualize` the latest run).
- **Run-it-back needs no token.** The afterglow recap carries the source
  beacon id; `POST /api/beacons/:id/run-it-back` authorizes by spark-group
  membership. The id is already the capability for members — a separate secret
  would add surface for nothing. The re-creation belongs to the tapper
  (creator = caller), not the original creator.
- **Kudos are private rows.** PK `(beacon_id, from, to)` makes re-taps
  idempotent; delivery is a recipient-only WS frame + push. No aggregate is
  ever serialized to anyone but the recipient's own event stream — approval
  names people, never scores (PSYCHOLOGY §9 + rule 3). Karma counters
  (`beacons_created/sparked` on users) are profile facts, never ranked.

## Consequences

- Zero new delivery machinery: five new WS event types over the existing
  `events` channel, one new worker queue (`beacons`), REST for every durable
  write. The 256-participant cap bounds spark fan-out exactly like §1.4 adds.
- Audience-at-read means `GET /api/beacons` costs a few indexed probes per
  request rather than fan-out writes per beacon; at v0.3 scale (friends-first
  graph) that is the right trade. If `public` beacons ever dominate, a
  materialized audience table is an additive migration.
- The area model is deliberately crude (self-declared citext equality, private
  to its owner): no GPS, no geo-index, nothing to leak (FEATURES #30). Typos
  fragment areas — acceptable; a curated area list is a later product fix.
- A cancelled/expired beacon keeps its joins (worker + recap reads), but is
  invisible to everyone — nobody is ever notified about a hangout they can no
  longer join.
- `beacon_kudos` and ritual chains are append-mostly and tiny; GC is not
  needed in v0.3 (rows cascade with beacons/users).
