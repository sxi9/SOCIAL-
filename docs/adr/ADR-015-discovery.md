# ADR-015: Discovery — momentary opt-ins, mutual-only waves, self-destructing roulette, and the encouragement loop

Status: accepted · Date: 2026-10-17

## Context

v0.6 ships FEATURES #52–#53: Bored Together (opt-in stranger discovery),
Bored Roulette (random 1:1 matching), and Rescue Me — the first surfaces
where strangers reach each other on purpose. FEATURES gates this explicitly
on the v0.3 safety bundle (blocks, reports, privacy enforcement, suspension),
and PSYCHOLOGY.md binds two findings hard: #10 (people wrongly predict
talking to strangers will be unpleasant — collect the app's own
better/worse-than-expected data privately and show hesitant users the true
aggregate) and the never-build list (no FoMO manufacture, no rejection
surfaces, no counters). The design questions: what does "discoverable" mean
in time; how does interest get expressed without creating a rejection; what
happens to the awkward dead-end chat with a stranger; and how much of this
needs tables at all.

## Decision

- **Opt-in is a moment, not a setting.** `discovery_optins` is one row per
  user with `expires_at = now()+60min` (`DISCOVERY_OPTIN_TTL_S`), upserted on
  every opt-in, filtered live on every read (the sweep is bookkeeping). There
  is no persistent "discoverable" flag to forget about and be ambushed by
  three weeks later — you are findable while you are actually bored, then it
  lapses silently. Visibility is **symmetric and mutual**: cards require your
  own live opt-in (no lurking), and user U appears to viewer V only when each
  one's scope reaches the other (`public`, or `area` equality on the citext
  snapshot machinery from beacons). The friends-of set (accepted connections
  ∪ DM partners, §1.28) is excluded both ways — this surface is for MEETING
  people; people you already know have beacons. Blocks are excluded both
  ways and 404-shaped (§1.14); suspended/banned never appear. The card is
  `UserLite` + note: no last-seen, no area text ever serialized (FEATURES
  #30 — the match is computed server-side, the string stays private).

- **Waves are mutual-or-nothing — a single wave notifies NOBODY.** The
  Boothby liking-gap logic (PSYCHOLOGY §9) and the never-build list both
  point the same way: an unreciprocated "hey" must not become a rejection
  the waver can watch not being answered, nor a social debt the target has
  to clear. So `discovery_waves` rows are write-only parking: no endpoint,
  event, badge or count ever exposes who waved at you; the only reader is
  the wave transaction itself, which checks for the reciprocal row (a PK
  lookup) and, on mutuality, deletes both rows and mints the DM with a
  rotating icebreaker system message + `discovery.matched` to both. The
  waver sees their own `waved: true` chip and nothing else, ever. Waves die
  with the opt-in that made them (reads join live opt-ins; the sweep prunes)
  — interest expressed in a moment cannot ambush a later one.

- **Roulette DMs self-destruct unless both people keep them.** The worker
  pairs queued users (blocks, friends-of, suspension, and any existing
  `dm_key` excluded — the last one both keeps "meeting people" honest and
  makes the DM create collision-free), minting a real `dm` conversation with
  `metadata.origin='roulette'` and **`expires_at = +5min`** — a new
  conversations column walked by a partial index. Both parties POST keep
  within the window → the guarded UPDATE clears `expires_at` + the rider:
  permanent, history kept (consensual both ways, the wave rule again — and
  the other party's pending keep state is never serialized, so waiting
  carries no pressure). Anything else → the sweep **hard-deletes** the
  conversation, messages cascading. Tombstoning was rejected deliberately:
  a pile of dead stranger-chats is a guilt object, a block-management chore,
  and a data-retention liability; "it never happened" is the feature. The
  freed `dm_key` leaves a future organic DM between the two unaffected.
  Queue state is Redis-only (`roulette:queue`, entry TTL 5 min) — a queue
  is the canonical thing that must NOT survive a restart.

- **Expectation feedback is private-in, aggregate-out** (PSYCHOLOGY finding
  #10, the one this feature exists for). After a roulette/discovery DM ends
  or persists, the client shows a one-tap better/same/worse-than-expected
  sheet exactly once (skippable, never re-surfaced). Rows land in
  `expectation_feedback` keyed by a **plain-uuid** conversation id (no FK —
  the roulette DM is often already hard-deleted when the tap arrives; a
  24 h Redis tombstone written by the sweep authorizes the late tap). The
  ONLY read is `GET /api/discovery/encouragement`: an anonymous
  instance-wide percentage, null under `ENCOURAGEMENT_MIN_SAMPLES=10`, shown
  **only pre-opt-in** — it exists to calibrate stranger fear with the app's
  own true data ("87% said better than expected"), not to score anyone. No
  per-person verdict is ever serialized to anyone, the subject included:
  this is survey data about an experience, structurally incapable of
  becoming a rating on a human (the line ADR-012 drew for person reviews is
  not even approached here).

- **Rescue Me is deliberately almost nothing** (FEATURES #53): no table, no
  acknowledgement state, no "rescued" outcome tracking — a rescue is an
  ordinary message (`metadata.rescue: true`, server-written) in up to three
  friends-of DMs plus the one push that bypasses the §2.9 guards (presence,
  read-elsewhere, debounce skipped; mute overridden — the §1.33 mention
  precedent; blocks remain structural). Capped `RESCUE_MAX_PER_DAY=3` in a
  Redis window so the SOS keeps meaning something. Tracking outcomes was
  rejected: a rescue that didn't come shouldn't be a recorded failure
  between friends.

## Consequences

- Hard deletion is real deletion: an expired roulette chat is unrecoverable,
  including for moderation. Reports must therefore be filed while the
  conversation lives (the §1.14 report machinery works on it like any DM);
  accepted — a 5-minute window with a stranger you can block and report in
  situ is the safety model, not forensic archaeology.
- The feedback dedupe key referencing a deleted conversation means the
  aggregate cannot be audited back to conversations. That is the point
  (privacy by structure), and the cost is accepted: the number is product
  encouragement, not research data.
- Mutual-visibility card rules mean an `area`-scoped user and a `public`
  user in different areas never see each other even though one of them
  "reaches everyone" — correct: nobody can be waved at by someone they
  cannot see and evaluate.
- Discovery honesty depends on the friends-of exclusion staying cheap; if
  connections grow a heavier graph later, the exclusion join is the first
  thing to index, not the first thing to cut.
- A momentary opt-in means quiet instances show an empty discovery tab most
  of the time. Accepted (and softened by the §1.44 encouragement line and
  the roulette queue): faking liveliness is on the never-build list in
  spirit.
