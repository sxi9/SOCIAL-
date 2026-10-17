# ADR-019: The anonymous reveal game — anonymity as a serialization rule, invisible refusals, and nudges that cannot out anyone

Status: accepted · Date: 2026-10-17

## Context

v0.8b ships the meeting-people cluster of v0.8 (FEATURES #77, #78, #78a,
#78b; API.md §1.62–§1.65): the anonymous reveal game, wave nudges,
people-you-may-know suggestions, and discovery filters. Anonymity features
are where social products usually rot — anonymous inboxes become harassment
chutes, "someone likes you" nudges become rejection engines, and suggestion
cards become enumeration surfaces. The binding constraints walking in:
blocks/privacy are enforced server-side at every surface (golden rule 5),
refusals must never confirm what they refuse (the §1.14 404-shape doctrine),
single waves are invisible and nobody is ever notified of a rejection
(ADR-015), no user cards on the login page (standing decision), and
PSYCHOLOGY rules 3/4 (faces not counters; user-pulled, never app-pushed).

## Decision

- **Anonymous to the recipient, never to the server.** `anon_threads.sender_id`
  is an ordinary FK; anonymity lives entirely in serialization (the
  recipient's `counterpart` is null until revealed) — the §1.13/§1.57
  machinery re-applied to a new field. This is the whole abuse story in one
  line: *the server always knows*, so a report attaches the sender's real
  identity (the migration's CHECK makes an identity-less anon report
  unrepresentable), bans and blocks bind structurally, and rate limits are
  per-real-user. An actually-anonymous design (hashed senders, burner rows)
  was rejected without much grief: it is strictly worse for safety and buys
  nothing the game needs — the recipient's experience is identical.

- **The game is deliberately smaller than a chat.** Text only (≤500 chars,
  no attachments — media is identifying and unmoderatable at this trust
  level), OFF the seq log, no receipts, no typing, no reactions, ONE open
  thread per (sender, recipient). Every omission is load-bearing: receipts
  and typing are identity side channels ("typing… at 2am" narrows a guess),
  and the seq log would entangle gapless-seq guarantees (golden rule 2) with
  rows designed to be hard-deleted. A thread is its own tiny table pair, and
  `DELETE` hard-deletes it — an unwanted game leaves no archive.

- **The avatar un-blur is rendered server-side.** The timer reveal's charm is
  watching the sender's avatar sharpen; the obvious implementation (ship the
  avatar URL, blur client-side) ships the answer to anyone who opens
  DevTools. So the §1.11 invite-avatar pattern returns: a thread-gated proxy
  serves the sender's avatar with sharp-applied Gaussian blur, sigma derived
  from the stored preset (`reveal_timer_s` exists exactly so the factor is
  derivable: remaining/total), static only (motion identifies), short
  private cache. The real pixels cross the wire only at factor 0. Timer
  expiry resolves live at read (the §1.44 pattern); the sweep is bookkeeping
  plus the fan-out.

- **Riddles end on the sender's word, not string equality.** The recipient's
  answer is an ordinary message flagged `is_riddle_answer`; the sender taps
  "that's right" (the same `POST …/reveal` as reveal-anytime). Server-side
  answer matching was rejected: a riddle between humans has a human judge,
  and a normalized-string comparator would turn a flirt into a quiz API with
  an oracle attack ("try answers until 200").

- **Refusals are invisible and byte-identical.** `404 anon_unavailable` for
  unknown user, `nobody`, unmet `connections`, blocks both ways, banned,
  self. The opt-in setting doubles as plausible cover for a block — exactly
  the §1.13 group_add_denied argument. Default opt-in is `connections`
  (accepted §1.28 connections literally, not friends-of): anonymous notes are
  a game for people who already chose each other; `everyone` is a deliberate
  opt-up.

- **Wave nudges fire only when arithmetic protects the waver.** The ADR-015
  rule (a single wave notifies NOBODY) gets one carefully-bounded exception:
  an identity-free, count-free line, at most once per opt-in (claimed by a
  guarded UPDATE on the opt-in row — the repinged_at pattern), and ONLY when
  the recipient's visible pool holds ≥ `NUDGE_MIN_POOL` people. Order
  matters: pool check BEFORE the claim, so a too-small pool leaves the
  hour's claim open instead of burning it. Below the floor, "someone waved"
  is a guessable someone, and the no-rejection rule dies — so below the
  floor, silence. The toggle (`wave_nudges`) kills both the push and the WS
  frame; the payload carries no deep link to any card (a link would be a
  pointer).

- **Suggestions rank on evidence the viewer already owns.** Mutual
  connections (faces first, count second — the count is evidence about MY
  network, not public approval; the §1.36 faces rule bends here the way
  ADR-012's star averages did, and for the same reason: it informs a
  decision, it never scores a person publicly), same-area as a BOOLEAN (the
  area text stays owner-private, FEATURES #30), shared non-ghost groups as a
  count. Excluded: blocked pairs, friends-of, pending requests, dismissed
  (permanent, silent, filter-only), banned, ghost-group-only acquaintances
  (§1.68: unlisted everywhere). No collaborative filtering, no "because you
  viewed" — enumeration of strangers is what discovery opt-in is for, with
  consent. And never, structurally, on the login page.

- **Discovery filters narrow, never rank.** The opt-in gains one optional
  vibe chip; cards gain the PUBLIC-interest overlap; filters subset the
  §1.44 mutual-reachability pool. No new data is collected (no age/gender
  fields exist to filter on — FEATURES #78b), no filter re-orders the pool,
  and an unfiltered read is unchanged — v0.6 clients keep working against
  the same endpoint.

## Consequences

- Reports gain three columns and two kinds; `reports.target_user_id` now
  doubles as "the attached identity" on anon rows — intake stamps it
  server-side, and the admin queue renders the reported anon body in the
  preview (it is the thing being reported, disclosed by its recipient).
- The blurred-avatar proxy is a new sharp code path on the api (not the
  worker): blur-on-request with a 60 s private cache is fine at this scale;
  if it ever hurts, pre-rendering factor buckets is the obvious seam.
- `anon.updated` is viewer-stamped at the gateway like `connection.updated`;
  the gateway's per-recipient stamping table grows one entry. Reconnect truth
  is the REST list — frames are never replayed.
- The nudge claim lives on `discovery_optins`, so nudge state dies with the
  opt-in row and sweep — no new table, no retention question.
- Deferred, explicitly: anonymous media, multiple concurrent games per pair,
  recipient-side "guess who" picker UI hints, and any nudge aggregation
  ("3 people waved") — the last is a counter about hidden people and will
  stay unbuilt (PSYCHOLOGY rule 3).
