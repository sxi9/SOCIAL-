# ADR-011: Social layer — connections, replies, edit/delete, forward, pins, mentions, stories, channels, feed, profiles

Status: accepted · Date: 2026-10-16

## Context

v0.5a ships FEATURES #46–#48: the connections graph, threads/replies, message
edit/delete, forwarding, pins, @mentions, 24-hour stories, broadcast channels,
a posts/reactions/comments feed, and rich profiles. Ten surfaces that, built
naively, recreate every pathology the product exists to avoid. Constraints
that shaped every call:

1. **PSYCHOLOGY.md is binding, hardest here.** Broadcast surfaces are where
   infinite scroll, like tallies, view counts and seen-at deadlines usually
   live; design rules 2/3/5 and the never-build list are load-bearing in this
   slice, not decoration.
2. **The seq log is sacred (ADR-003).** Edits, deletes, replies, forwards and
   pins must never create gaps, reuse seqs, or add a second delivery
   mechanism. Stories, posts and connections live OFF the seq log entirely.
3. **The v0.3 safety bundle applies to every new surface (ADR-009).** Blocks
   stay 404-shaped; privacy filtering stays at the serialization edge; nothing
   a user cannot act on is ever fanned to them.
4. **Reuse over invention**: the upload pipeline, invites, watermark receipts
   and the Redis `events` channel already solve the hard halves of stories,
   channel joining, channel receipts and all fan-out.

## Decision

- **Connections are one unordered row; FRIENDS-OF is a view, not a table.**
  `connections (requester, addressee, status pending|accepted)` with a
  `LEAST/GREATEST` unique index — concurrent cross-requests collapse into one
  row, and a request meeting a counter-request auto-accepts. **FRIENDS-OF =
  accepted connections ∪ dm-partners, minus blocks**, resolved at
  read/fan-out time (the beacon-audience pattern) and never materialized. The
  beacons `friends` audience and `beacon_default_audience` keep the stored
  value `'friends'` but resolve to friends-of — a pure widening (every DM
  partner stays in), so no data migrates and old clients keep working.
  `show_last_seen`/`group_add_policy` `'dm_partners'` stay literal.
  **Declines delete the row and tell the requester nothing** — a decline must
  never become a rejection ping (the liking gap, PSYCHOLOGY §9); removals are
  equally silent. Blocks delete pending rows and make accepted ones dormant
  (excluded at read time, row survives — §1.14 "does not delete history").
- **Replies are seqs, not ids.** `messages.reply_to_seq` + a composite self-FK
  to `(conversation_id, seq)` — the identity reactions, polls and reports
  already use; the v0.1 `reply_to_id` seam is retired unused. The DTO carries
  a **server-resolved** `reply_context` (author, kind, 80-char excerpt,
  `deleted` flag) computed at serialization time, so edits/tombstones of the
  target are always current and clients never join locally. Tombstoned
  targets stay repliable (`deleted: true` renders "message deleted"); the FK
  is safe because individual messages are never row-deleted (ADR-003) — it
  only cascades with whole conversations.
- **Edit/delete ride the tombstone machinery that already exists.** PATCH
  (author, `EDITABLE_MESSAGE_TYPES`, 24 h `EDIT_WINDOW_S`) sets `edited_at`
  — the badge is the timestamp, no history table. DELETE is the §1.25 sweep's
  tombstone verbatim (body nulled, metadata emptied, attachments + dependent
  rows gone, **seq survives forever**), plus pin removal in the same
  transaction. Both fan `msg.updated`, the full-DTO replace contract that has
  carried every hydration since v0.1 — zero new events. Edits re-parse
  mentions but never re-push: an edit must not be a re-ping machine.
- **Forwarding copies rows, not bytes — and buys a repo-wide rule.** A forward
  is ≤ 5 ordinary sends by the forwarder (`sender_id` is never spoofed) with
  `metadata.forwarded_from = {username, display_name}` — a snapshot, not an
  FK, not a UserLite (no avatar reach into foreign conversations); forwarding
  a forward preserves the original attribution. Attachments are
  **re-referenced**: new rows over the same content-hashed MinIO objects.
  That makes object deletion everywhere **refcount-guarded** (no other row
  shares `original_key`/`thumb_key`; one indexed lookup) — the price of
  never re-uploading, paid once, documented as binding. Mentions are never
  copied. One shared `client_msg_id` + the existing per-conversation
  idempotency index makes retries complete partial fan-outs without
  duplicating. All-or-nothing targets, 404-shaped — a failed forward confirms
  no block.
- **Pins are ten rows and a conv.updated.** `conversation_pins` keyed by the
  message identity, `MAX_PINS=10` under the conversation row lock, permission
  mirrors the title rule (DM participant / group admin / channel owner-admin).
  Pins ride the Conversation DTO ordered by pin time ASC — a stable board,
  not a feed.
- **Mentions are server-parsed, and mute-piercing stops at blocks.** The
  server matches `@username` tokens against active participants at send time
  and writes `metadata.mentions` (client values ignored — a mention always
  names a real participant; non-participants stay inert text). The one power
  a mention has: skipping the `muted_until` push guard for the mentioned user.
  The one power it can never have: crossing a block — §1.14 exclusion is
  structural, upstream of every guard. Autocomplete sources the participants
  the client holds; channels use the paged member read their senders
  (owner/admins) can access anyway.
- **Stories = §1.18 receipts + the upload pipeline + a sweep.** One
  attachment + caption, fixed 24 h, audience CHECK-pinned `'friends_of'`.
  **`story_views` stores no timestamp column at all** — the DB cannot leak
  what it does not store; the author-private view list is faces ordered by
  username (the seen-by pattern FEATURES #27 promised stories would reuse).
  No view counts, no story replies, no auto-advance, no push — `story.new`
  reaches only people who can view it. Expiry hard-deletes rows + attachments
  (refcount-guarded); stories never touch the seq log, so nothing about sync
  changes. Share-recap-to-story re-references an afterglow photo — a
  participant's own deliberate act, the only way a recap leaves the plan
  group (PSYCHOLOGY rule 2).
- **Channels are a CHECK widening, because ADR-002 already paid for them.**
  `type='channel'`, creator `role='owner'`, owner/admins send, everyone reads
  and reacts. The 10 000 cap is safe for exactly the reason ADR-002 named:
  receipts are one cursor row per member. What channels refuse: seen-by
  (`403 channel_no_receipts` — and receipt frames go to the reader's own
  sockets only, never a 10k fan-out per read), typing (gateway-dropped),
  sender ticks, and **member counts anywhere** (a member count is a follower
  count — PSYCHOLOGY rule 3). The Conversation DTO ships only owner + admins
  + the viewer's row; the full list is a paged owner/admin read. Joining is
  the §1.11 invite system verbatim (`kind='channel'`); the history floor
  stays `join_seq = last_seq` (ARCHITECTURE §8). The owner cannot leave —
  a channel is never headless.
- **The feed is finite by construction, and approval has no numbers.** Posts
  (body ≤ 2000, ≤ 4 attachments, audience `friends_of`) off the seq log;
  keyset pagination to a terminal `all_caught_up: true` — a hard bottom, no
  wraparound, no ranking, and **no share/repost mechanic exists** (first-party
  content only, the feed cannot compound). Reactions serialize as **faces**:
  first 12 reactors as UserLite + `has_more` — no total field exists in any
  payload, so a counter cannot be rendered even by accident; comments inline
  latest-3 + `has_more_comments`, no count either. Reactions/comments fan out
  **nothing** live: viewers (authors included) reconcile when they return —
  no approval pings (rules 3/4). `post.new` reaches the audience only.
- **Profiles deepen the page, not the DTOs.** `users.interests` (≤ 10 tags),
  `profile_entries` (work/skill rows), `profile_media` (the 3-GIF strip) ride
  `GET /api/users/:username` as a `profile` sibling — `UserPublic` stays lean
  in every participant list. PATCH full-replaces each present set in one
  transaction (order = array order; no per-row endpoints). Blocked viewers
  keep getting the §1.14 404 for the whole page. No endorsement counts, no
  connection counts, no profile view counters.

## Consequences

- **Three new WS events** (`connection.updated`, `story.new`, `post.new`),
  all edge-filtered at the gateway like `beacon.*`; everything else reuses
  `msg.new`/`msg.updated`/`conv.updated`. **Zero new queues**: story expiry
  joins the `timers` sweeps; **zero new dependencies**.
- Migration 0005 is additive: six new tables (`connections`,
  `conversation_pins`, `stories`, `story_views`, `posts` + reactions/comments,
  `profile_entries`/`profile_media`), new columns (`messages.reply_to_seq`,
  `attachments.post_id`, `users.interests`), widened CHECKs (conversation
  type, participant role), the rebuilt orphan-GC partial index and the
  `original_key` refcount index. All DTO additions default (`pins: []`,
  `reply_to_seq`/`reply_context: null`) so pre-v0.5a clients and stored
  payloads parse clean.
- **The refcount guard is now load-bearing** for every MinIO object deletion
  (tombstones, story expiry, post/story deletes, orphan GC). It was always
  implied by content-hashed keys (two uploads of the same bytes already
  shared an object); forwarding just makes collisions common instead of
  coincidental. The orphan-GC partial index demotes to a candidate list — the
  worker adds indexed `NOT EXISTS` guards over `stories.attachment_id` and
  `profile_media.attachment_id` (both tiny and indexed).
- Channel sends fan `msg.new` to up to 10k sockets and one push job per
  offline member — the existing per-(user, conversation) debounce and the
  single-replica honesty note (ARCHITECTURE §3) still hold; channels are the
  first surface that will push on the multi-node seam if instances grow.
- Known accepted costs: reply excerpts are recomputed per serialization
  (bounded: one PK lookup per reply row in a page); the feed query unions
  per-author index walks over the friends-of set (fine at friend-list scale,
  revisit with a materialized timeline only if ever needed); declined
  connection requests are unrecorded, so a serial re-requester is bounded by
  the 30/hour mint rate rather than history (blocking is the real tool);
  `reply_to_id` stays as a dead column (dropping columns is not worth a
  rewrite on the hot table).
