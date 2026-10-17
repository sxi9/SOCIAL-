# ADR-016: Interactive posts — post kinds on one table, the vote-tally/approval line, nesting audiences, and plans that change without re-pinging

Status: accepted · Date: 2026-10-17

## Context

v0.7 ships the interactivity pack (FEATURES #60–#71; API.md §1.47–§1.54): the
feed stops being read-only (poll posts, open game challenges, "Join my…"
cards, a public Discover lane, comment attachments + reactions), beacons and
listings become editable live, joiners get notified about the plans they
committed to, and locations/OG-banner/web-polish ride along. The binding
constraints walking in: PSYCHOLOGY rule 3 (no public numeric scores on
people), rule 2 (never show or notify anyone about something they cannot
join), design rule 5 (finite feeds), the §1.14 block shapes, the REST-write/
WS-fan-out split, and the pull-based-feed doctrine from §1.36/§1.38. The
design questions: where does interactive-post state live; is a poll tally a
forbidden "count"; how does a cross-posted beacon avoid becoming a FoMO ad;
who may be notified when a plan changes; and how does "first tap joins" stay
race-free.

## Decision

- **One posts table, per-kind riders — not new feed surfaces.** `posts.kind ∈
  {text, poll, game, join_card}` with state where it structurally belongs:
  poll question/options in `post_polls` (post_id PK) + ballots in
  `post_poll_votes` (UPSERT on `(post, user)` — revote replaces, the §1.17
  semantics), the game claim as two columns on the post itself
  (`game_claimed_by`), and the join-card target as `posts.ref` jsonb
  validated by the shared Zod contract (the house metadata pattern). The
  alternative — a generic "interactions" table or per-kind post tables — was
  rejected: the feed read stays one keyset walk, reactions/comments work on
  every kind for free, and each rider is exactly as big as its feature.

- **Poll-option counts ARE serialized, and that is not a rule-3 breach.**
  PSYCHOLOGY rule 3 bans numeric *approval attached to people* — like
  tallies, follower counts, view counters — because they turn people into
  scoreboards (Sherman 2016). A poll count is a **vote tally on options**: it
  answers "what are we choosing", not "how liked is this person"; no voter
  lists and no vote timestamps exist in any payload, so a ballot can never be
  reconstructed into per-person approval. The §1.17 chat polls drew this line
  in v0.3; §1.50 inherits it unchanged. Post REACTIONS, by contrast, stay
  faces-only (§1.36), and the new comment reactions follow suit
  (`CommentReactionAggregate` carries capped reactor faces + `has_more`, no
  count field exists — the §1.19/§1.36 machinery re-applied, stamp sentinel
  and all).

- **The game claim is an advisory-locked guarded UPDATE.** "First tap joins"
  is the reactions-cap/spark/invite race in new clothes, so it gets the
  TROUBLESHOOTING pattern: `pg_advisory_xact_lock` on the post id, then
  `UPDATE posts SET game_claimed_by = $me WHERE id = $1 AND game_claimed_by
  IS NULL` — zero rows means someone was faster (`409 game_claimed`, loser
  sees a named winner, not an error mystery). The same transaction mints the
  DM (`dm_key` create-or-dedupe) and the ordinary §1.27 `game_ttt` message —
  the board lives where boards already live, visible only to its two
  players; the post shows *who* is playing (two named faces), never a score.
  Blocked pairs never get here: the post is already §1.14-invisible.

- **Join cards may only NARROW the audience — nesting enforced at create,
  re-resolved per viewer at read.** The rule-2 failure mode of cross-posting
  is advertising a hangout to people who cannot join it. Two structural
  guards: (1) at create, the post's audience must nest inside the ref's
  (`public` post ⇒ `public` beacon / `is_public` listing; `friends_of` post ⇒
  `friends`-or-`public` beacon; **incomparable sets refuse** — an `area`
  beacon or area-only listing is not shareable to friends_of, because
  friends-of is not a subset of an area; `400 ref_audience_mismatch`), and
  the ref must be the poster's own, so "my friends-of" and the beacon's
  `friends` audience are the same set by construction. (2) at read,
  `ref_summary` is resolved per viewer like §1.29 reply_context — live
  status, capped joiner faces, viewer-specific `my_state`/`my_contacted` —
  and collapses to `null` wherever blocks/bans/deletion hide the ref. The
  Join button is the EXISTING join/contact route with every existing guard;
  a join card adds zero new write surface.

- **The Discover lane is a filter, not a firehose.** `posts.audience` gains
  `'public'`; `GET /api/feed?lane=discover` walks a partial index over
  public posts minus blocks and banned authors, `created_at DESC`, finite
  with the same hard `all_caught_up` end — no ranking, no trending, no
  wraparound (design rule 5 binds strangers' content hardest, since envy
  scales with distance). `post.new` keeps its friends-of recipient set even
  for public posts: fanning every public post to every live socket is
  unbounded AND an ambient nudge, so the discover lane is pull-only — the
  §1.38 board logic applied to the feed.

- **Beacons edit in place; only the committed are notified.** Cancel-and-
  repost was the v0.3 way to change a plan — it re-pinged the whole audience
  and orphaned the joiner pile. PATCH keeps the pile and the beacon id;
  `edited_at` + the `beacon.updated {edited, changed}` frame give cards an
  honest "edited" marker (no edit history stored, the §1.30 precedent);
  audience is immutable (re-aiming a live invite is a new beacon). Pushes for
  edited/cancelled/starting-soon go to **joiners only** (starting-soon also
  to a sparked plan's creator), through the §2.9 guards unchanged: commitment
  is what earns a notification, the audience that merely *could* join keeps
  the silent card-retire (rule 2). Threshold edits must clear the current
  join count, and lowering to exactly that count sparks inside the edit
  transaction — which also makes `spark-now` honest: "start with whoever's
  here" is the same §1.15 row-locked spark path with the threshold not
  consulted, requiring ≥ 1 real joiner so a "plan" of one person cannot mint
  a group. Custom vibes are a value (`'custom'` + emoji/label columns, shape
  CHECK), not a free-text vibe column — the chip set stays a type, recents
  stay client-side.

- **Locations are snapshots and links, never tracking and never tiles.** One
  `Location` shape (`label` required, lat/lng optional both-or-neither)
  rides posts/beacons/listings and the new `location` message type; lat/lng
  only ever enter a payload by a one-tap user action. Rendering is a map
  LINK (`geo:`/OSM/Google URLs built client-side) — no tile embeds, no map
  SDK, no API key, keeping golden rule 7 intact and the CSP unchanged. The
  "on my way" headcount is deliberately zero machinery: an ordinary text
  reply (`ON_MY_WAY_BODY`, `reply_to_seq` = the drop) whose faces the client
  derives from replies it already has.

- **The OG banner is composed in-process, behind the token gate.** sharp
  (already a dependency) composites gradient + avatar circle (or the
  inline-SVG mascot blob) + an XML-escaped display-name overlay at request
  time, gated and rate-limited exactly like the §1.11 avatar proxy and
  cache-keyed on `avatar_version`. No font/image/service is fetched — a
  share card from a self-hosted box stays self-hosted.

## Consequences

- Poll ballots are irrecoverable as per-voter data by design: moderation or
  "who voted what" tooling can never exist without a schema change, which is
  the point (the §1.17 argument, restated for the feed).
- A claimed game post whose claimer deletes their account shows
  `claimed_by: null` while staying `state:'claimed'` (SET NULL) — the
  challenge does not silently reopen; accepted, a reopened challenge would
  surprise the author with a second stranger.
- The audience-nesting table refuses legitimate-feeling shares (an `area`
  beacon to your friends lane). Accepted: the alternative leaks area-gated
  plans to out-of-area friends, and rule 2 outranks convenience. The share
  sheet should simply not offer the feed for those.
- Public posts fan `post.new` to friends-of only, so a discover lane open on
  screen does not grow live; it refreshes on pull. Accepted — matching the
  board's behavior, and the lane's finiteness matters more than its
  liveness.
- Listing edits do not rewrite contacters' `listing_ref` snapshots, so a DM
  context message can name a stale title after an edit. Accepted (it is
  contact-time truth, the forwarded_from argument); the live card is one tap
  away.
- Beacon edits can shift a plan under existing joiners (time, place, vibe).
  The change note push + the `changed` field list is the mitigation; a
  joiner who dislikes the new shape leaves with the existing un-join. No
  consent-to-edit flow was added — a beacon is the creator's invitation,
  not a contract.
- The starting-soon ping is push-only and once-per-beacon: a beacon edited
  to a later `starts_at` after its ping has fired pings no second time
  (accepted — one reminder is a feature, two is a nag; the countdown card
  remains the live truth).
