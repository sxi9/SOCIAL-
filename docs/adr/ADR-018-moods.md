# ADR-018: Moods — ephemeral identity columns, drunk-mode guardrails, trace-free expiry, and activity that cannot out-leak its objects

Status: accepted · Date: 2026-10-17

## Context

v0.8a ships the identity & moods slice of v0.8 (FEATURES #72–#76, #79, #80;
API.md §1.57–§1.61): mood chips with 🎢 swing mode, 🍻 drunk mode with real
guardrails, mood-reactive message rendering, animated display names, the
profile activity strip with per-kind privacy, GIF/video chat backgrounds, and
the discoverability pack (tour, feature directory, what's-new cards). The
binding constraints walking in: PSYCHOLOGY's never-build list (no seen-at
timestamps, no guilt mechanics, no public numeric counters), design rule 4
(user-pulled, never app-pushed), the §1.13/§1.14 serialization-time
privacy/block machinery, the REST-write/WS-fan-out split, gapless seq
(golden rule 2), and the §1.24 prefs-are-personal doctrine. The design
questions: where does a mood live so it can ride every UserLite without a
new hot-path read; how does "no trace afterward" survive a system built on
append-only history; what, exactly, does drunk-mode undo do to a message in
a schema where seq is forever; and how does an activity strip avoid becoming
a side channel around every audience rule already enforced elsewhere.

## Decision

- **Moods are `users.mood_*` columns, not a table — and never history.** The
  chip rides EVERY UserLite serialization (participants, piles, seen-by,
  authors), so it must come from the one row the serializers already read —
  the ADR-009 settings-as-columns argument, re-applied. A `user_moods` table
  was rejected twice over: it would add a join to the hottest serialization
  path, and a table with rows is a table with history — the product promise
  is the opposite ("auto-expire, never stale, no trace"). Clearing a mood is
  `UPDATE users SET mood_* = NULL`; after that the mood never existed
  anywhere: not in `activities` (no mood kind is even representable in its
  CHECK), not in message metadata (the undo flag deliberately says nothing
  about *why*), not in push (moods never push, full stop). Expiry is
  enforced **live at read** (`mood_expires_at > now()`, the §1.44 opt-in
  pattern) with the sweep as bookkeeping + the `user.updated` goodbye — a
  lagging worker can never show a stale chip.

- **Visibility is per-viewer serialization, like everything else.** A new
  surface gets the old machinery: `mood` on UserLite/UserPublic is stamped
  per viewer (everyone / accepted-connections / nobody, ∩ not-blocked),
  REST-side in the serializers and WS-side at the gateway edge (§2.11), with
  hidden == absent — `null` is byte-identical to "no mood", so a visibility
  setting is never confirmable from outside. 'connections' means accepted
  §1.28 connections **literally**, not friends-of: showing a feeling to
  "people I said yes to" is the point, and a DM with a marketplace stranger
  is not that. Others never see `expires_at` (a countdown on someone's mood
  is a seen-at timestamp in disguise — Mai 2015 applies to feelings more
  than to reads) or the swing set (the set is the owner's deck, the current
  chip is the show).

- **Drunk mode is a mood kind plus guardrails, each at its right layer.**
  The *default* (connections-only even when other moods are public) is
  route-side at PUT — defaults are policy, and policy lives server-side.
  The *undo* is server-side because it destroys data: a §1.30 tombstone
  (seq survives — golden rule 2 is not negotiable, and watermarks/unread/
  sync stay untouched by construction) whose `metadata` is `{"undone":
  true}` instead of `{}`, which clients render as **nothing** — no
  "message deleted" stub, because the stub is itself a trace ("what did
  they delete at 1am?"). It requires authorship only, not edit permission,
  works on every own message kind, and is gated on the mood being live *at
  undo time* rather than stamping anything on the message at send time —
  stamping would store the mood into history through the back door. The
  *cold-contact confirm* is client-side because it is a question, not a
  rule: the server neither blocks the send nor learns the user hesitated,
  and the ">1 month" fact was already in the client's hands as
  `Conversation.last_message_at` — shipping a dedicated "is this contact
  cold" endpoint would have built a server-side record of exactly the
  judgment the feature promises to keep soft. The *banner* is a pure client
  render of a chip the viewer could already see — no new data moves, so no
  new leak is possible; the "Check on them 💙" button is an ordinary
  message/call. NEVER a push: being drunk must not become a broadcast event
  (PSYCHOLOGY rule 4; also the no-rejection-surface instinct from v0.6 —
  concern is offered where the relationship already is, in the chat).

- **Mood-reactive bubbles and animated names are rendering, not protocol.**
  The server ships state (the mood, the name style); clients perform it.
  No effect field exists on messages — deriving wobble/rain/bounce from the
  visible mood means the effect can never outlive or out-leak the mood, and
  turning effects off (`mood_effects`, a per-viewer setting synced like any
  other) or `prefers-reduced-motion` kills everything with zero server
  involvement. 'surprise' name rotation is client-deterministic
  (hash(user_id + UTC date)) — every viewer agrees without a worker, a
  column, or a midnight fan-out. Custom mood labels never trigger effects:
  an effect keyed on free text is an injection surface for someone else's
  screen.

- **Activity is an intersection, never a source of truth.** `activities`
  rows store minimal pointers written by the owning module's transaction
  through one helper (the `requestUnfurl()` chokepoint rule — a second
  writer is how "never leaks" dies). Visibility is resolved per viewer at
  read time as **(per-kind setting) ∩ (the underlying object's own
  audience, re-checked live against the object's row)** — nothing about
  audiences is denormalized, so a beacon edited, a post deleted, an author
  banned or a connection severed re-filters the strip instantly. The
  per-kind toggles default 'connections' (calm default; the strip is for
  people you know until you say otherwise) and can only narrow: a
  friends-only beacon in a 'public' strip still serializes only to
  friends-of, because the object check runs regardless. Dropped items drop
  silently — placeholders or "3 hidden" counts would be a counter about
  hidden things (rule 3). 30-day hard-delete retention keeps the strip
  "recent", not an archive someone can scroll a life out of. And moods are
  structurally absent: the kind CHECK has no mood value, so even a buggy
  caller cannot record one.

- **Backgrounds are §1.24 prefs, with the GC inverted.** Per-user-per-chat,
  owner-only, `prefs.updated` to own sockets — the theme/wallpaper doctrine
  verbatim, so nobody learns your chat looks like a GIF. Own uploads only
  through the existing pipeline (ownership-checked at PATCH; video capped
  25 MB/30 s — a chat background is ambiance, not a video host). The orphan
  GC cannot use the binding-column pattern (the reference points
  prefs→attachment and one upload may back several chats), so the sweep
  anti-joins the partial index on `background_attachment_id` instead —
  documented as the one deliberate exception to the binding-column rule.

- **What's-new is instance truth + a per-user cursor, not telemetry.** The
  release list lives in `instance_settings` (seeded/appended by migrations:
  the instance describes what it actually runs, not what repo HEAD says),
  the cursor is one `users` column, and register stamps the newest version
  so new accounts start caught-up. The tour and directory are shared-package
  constants — a typed registry every client renders identically, searchable
  offline, with no server call and no engagement loop: cards dismiss once,
  nothing re-surfaces, no tab badges (PSYCHOLOGY rules 4/5).

## Consequences

- UserLite grows two fields with Zod defaults; every cached pre-v0.8 payload
  parses clean, and every serializer gains one per-viewer mood resolution —
  batched alongside the §1.13 filtering it already does. The connections
  check is the strip's and the mood's shared cost; implementations should
  resolve it once per (viewer, owners-batch) read.
- An undone message is a tombstone that renders as nothing: clients must
  treat `deleted_at + metadata.undone` as "remove the bubble", and tests
  must assert seq continuity across undos. Receipts and unread counts count
  undone seqs — by design, the §1.25 argument.
- The activity strip adds no WS event and no push — pull-only, like the
  board. If profiles ever get live updates, activity must inherit the §1.59
  intersection at the gateway, not shortcut it.
- The release-notes list is operator-visible product copy in a jsonb blob;
  migrations appending to it must prepend (newest first) and respect the Zod
  bounds or the admin read will refuse to parse — the build verifies the
  seeded entry against `ReleaseNoteSchema` in tests.
- Deferred, explicitly: the rest of v0.8 (anonymous reveal game #77, wave
  nudges #78a, suggestions #78, discovery filters #78b, canvas stories #79a,
  public share pages #79c, group visibility modes #79d, admin pack #81)
  ships separately on this same foundation; none of it is built here.
