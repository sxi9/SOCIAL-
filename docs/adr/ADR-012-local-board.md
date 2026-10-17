# ADR-012: Local board — one listing table, pull-based, with a gated trust layer

Status: accepted · Date: 2026-10-17

## Context

v0.5b ships FEATURES #39–#45: gig posts and team-ups, ride offers, room/space
sharing, place reviews, a filterable Local tab, a person-review trust layer,
and the no-payments rule. A classifieds board bolted onto a chat app can go
wrong in three distinct ways — as marketplace scope creep (payments, escrow,
disputes), as an engagement surface (push on every new card, ranked feeds),
and as a reputation system (scores on people). The constraints:

1. **PSYCHOLOGY.md is binding.** Design rule 3 bans scores on people; rule 4
   bans app-pushed nudges; rule 2 bans manufacturing FoMO. A marketplace wants
   all three. The trust layer especially needed an explicit argument, not a
   quiet exception.
2. **The product connects people; money settles outside** (FEATURES #45).
   Payments would import PCI/KYC/fraud/chargeback scope a self-hosted chat app
   must never carry.
3. **Reuse over invention** (the ADR-011 doctrine): uploads, `users.area`
   (v0.3), blocks + privacy, the DM dedupe path, group creation, and the
   serializer-edge enforcement model already solve the hard halves.

## Decision

- **One `listings` table, four kinds, jsonb details.** `kind` is the usual
  text+CHECK enum; per-kind payloads (`gig`/`ride`/`room`/`place_review`)
  live in a `details` jsonb column validated by a shared Zod discriminated
  union — the metadata pattern messages have used since v0.4. Four kind
  tables would mean four copies of author/area/status/expiry plumbing and a
  UNION-heavy board query; one table keeps the board read one index walk.
  The one denormalization: a ride's `departs_at` is **copied into
  `expires_at`** at write time, so the sweep and every board read work on a
  real column, never jsonb. Room photos ride the existing upload pipeline,
  bound via `attachments.listing_id` (the `post_id` GC-shield pattern);
  `details.attachment_ids` keeps the author's ordering, exactly like posts.
- **Visibility is the beacon-audience model, reused.** `area` is a citext
  snapshot of the author's `users.area` at mint (audiences cannot drift);
  visible = same area OR `is_public`, resolved at read time, always minus
  §1.14 blocks both ways, 404-shaped on direct fetch. The viewer's own `area`
  stays owner-private (FEATURES #30) — a listing publishes the *author's*
  chosen area string, never the reader's.
- **The board is pull-based: no WS events, no push — a deliberate cut.** A
  listing is a standing offer, not a live invitation. Pushing "new gig near
  you" is exactly the app-pushed nudge PSYCHOLOGY rule 4 bans, and ambient
  "things are happening on the board" signals manufacture the FoMO rule 2
  exists to kill. Beacons push because they are expiring invitations
  addressed to people who can still join; cards just wait. Consequence:
  zero new WS event types, zero new gateway filtering, and expiry needs no
  fan-out at all (reads filter `expires_at > now()` live; the hourly sweep is
  bookkeeping).
- **"Message me" is the §1.4 DM path plus one snapshot row.** Contact
  creates/dedupes the DM via `dm_key`, drops one `listing_contact` system
  message carrying `metadata.listing_ref = {listing_id, kind, title}` (a
  snapshot, the `forwarded_from` pattern — context outlives the listing), and
  records `listing_contacts (listing_id, user_id, conversation_id)`. That one
  row is load-bearing three ways: contact idempotency, the team-up pick pool,
  and the review gate. Blocks need no new rules — a blocked pair never sees
  the listing, and the DM path already 404s.
- **Team-up is group creation, reused, claimed like a spark.** Author picks
  ≤ 7 contacters (+ author = 8, the same human-scale bound as ride seats;
  PSYCHOLOGY §3 favors small crews); the route is the §1.4 group-create
  machinery verbatim — `group_add_policy` and block denials stay the
  byte-identical `403 group_add_denied` — with `join_seq = 0` founding
  members and a `team_up` kickoff system message. One team-up per listing,
  claimed by the guarded `UPDATE … SET conversation_id=$c WHERE
  conversation_id IS NULL` (the invite/spark concurrency trick), and
  `Listing.conversation_id` serializes only to the people in the room (the
  sparked-beacon rule).
- **Person reviews are gated, bounded, and survive their listing.** A review
  requires a `listing_contacts` row tying reviewer↔subject to that listing —
  {reviewer, subject} must be {author, contacter}, each reviewing the OTHER;
  no contact, no review, so drive-by rating of strangers is structurally
  impossible. One review per `(listing, reviewer)` (DB unique). Blocked
  pairs cannot review (404-shaped). `listing_id` is `ON DELETE SET NULL`
  with `listing_kind` snapshotted — the reports-table precedent: trust data
  must survive its subject matter, or deleting the listing becomes a
  purge-my-bad-reviews button. The uniqueness index is partial
  (`WHERE listing_id IS NOT NULL`); it binds at creation time, when the
  listing necessarily exists.
- **Why star averages do not violate the no-scores rule (the required
  argument).** PSYCHOLOGY rule 3 bans *social approval metrics* — follower
  counts, like tallies, leaderboards: numbers that quantify how much people
  like you and recruit the audience into performing for them (Sherman 2016).
  A marketplace trust average is a different object: **safety information**
  for a stranger deciding whether to get into your car or wire you a
  deposit — the same bundle as blocks and reports (FEATURES #29: public-
  facing features ship with their safety controls), where the cost of
  omitting the signal lands on the vulnerable party. The guardrails that
  keep it safety and not status are structural, not tonal: a review exists
  only behind a real transaction contact (never on expressive surfaces —
  posts, stories, beacons and chat remain score-free); the average hides
  below `TRUST_AVG_MIN_REVIEWS = 3` so one angry star cannot read as a
  verdict; it renders only on the profile trust panel; and **nothing
  anywhere ranks, sorts, filters or compares people by rating** — there is
  no "top rated" anything, so the number cannot become a leaderboard even by
  client accident. Place-review stars need no argument at all: rule 3 is
  about people, and a chai stall has no feelings.
- **No payments, structurally.** Price fields are bounded display text
  (`price_text ≤ 40`), never parsed; there is no price column with a numeric
  type anywhere, so payment features have nothing to grow on. The
  bulletin-board terms (`LISTING_SAFETY_NOTE`, a shared constant so web and
  any future client render the same words) sit on gig/ride/room detail
  views — on the card where the money talk happens, not buried in settings.

## Consequences

- **Zero new WS events, zero new queues, zero new dependencies.** Listing
  expiry joins the `timers` sweeps; contact/team-up fan out only the existing
  DM/group machinery. Migration 0006's board half is additive: `listings`,
  `listing_contacts`, `person_reviews`, `attachments.listing_id`, the rebuilt
  orphan-GC partial index.
- The board read is two partial indexes (`(area, created_at DESC)` and the
  `is_public` arm) merged per request — fine at area scale; a trigram index
  on `title` is the known upgrade path if `q` search ever needs it.
- The author's review slot is single-use per listing (`UNIQUE (listing_id,
  reviewer_id)` per the spec): an author who teams up with five contacters
  reviews one of them through that listing. Accepted — per-counterparty
  review slots would need a different key and invite review farming; the
  contact gate plus one-per-listing keeps volume honest.
- A deleted listing ends new reviews (the gate rows cascade) while existing
  reviews persist authorless-context (`listing_kind` snapshot). Accepted
  asymmetry: the gate is about proving a transaction happened; the review is
  about the person.
- `my_contacted` and `photos` make the Listing DTO viewer-specific and one
  join heavier — bounded (contact row PK lookup; ≤ 6 photo rows) and worth
  it: the card renders with zero follow-up fetches.
- Trust averages are recomputed per profile read (`COUNT`/`AVG` over an
  indexed `subject_id` walk) — no materialized counters to drift; revisit
  only if profiles ever get hot enough to care.
