# ADR-010: Expression pack — stamps, voice, doodles, effects, vibes, prefs, timers, games

Status: accepted · Date: 2026-10-16

## Context

v0.4 ships FEATURES #31–#38: avatar stamps, voice notes, doodles, message
effects, vibe checks, chat themes/wallpapers/nicknames, disappearing +
scheduled messages (time capsules), and in-chat mini-games with a daily
puzzle. Nine features that could each invent machinery; the job is to make
them ride what exists. Constraints that shaped every call:

1. **Self-hosted, user-generated only.** No Giphy/Tenor/third-party sticker
   APIs — the only "stickers" are the user's own avatar (stamps), their camera
   (images), and their finger (doodles).
2. **The seq log is sacred (ADR-003).** Disappearing messages, scheduled
   deliveries and game updates must never create gaps, reuse seqs, or add a
   second delivery mechanism.
3. **PSYCHOLOGY.md is binding.** Faces not counters (stamps), no auto-fired
   animations (effects consent), no leaderboards/rankings/streaks (puzzle),
   anticipation as a feature (time capsules).
4. **v0.3's safety bundle applies to every new surface**: blocks stay
   404-shaped, privacy filtering stays at the serialization edge.

## Decision

- **Stamps are reaction rows, not a new table.** `message_reactions.kind
  ('emoji'|'stamp')` + the `':stamp:'` sentinel in the emoji column: the
  existing PK `(conversation_id, seq, user_id, emoji)` enforces the
  one-stamp-per-user-per-message cap by construction, the same routes gain one
  field, and `reaction.updated` gains `kind` (default `'emoji'` keeps old
  frames parsing). The DTO carries stampers as `Message.stamps: UserLite[]` —
  faces rendered from the avatars clients already hold (version-busted via
  `avatar.version`), never a count badge. The 8-distinct-emoji cap counts
  `kind='emoji'` rows only.
- **Voice notes reuse the §5/§6 pipeline verbatim.** New sniffed-MIME audio
  allowlist (ogg/opus, webm/opus, m4a/aac, mp3; ≤ 10 MB, ≤ 5 min), kind
  `'audio'`, worker `media` job (ffprobe duration gate; 48-bucket peak array
  via ffmpeg `astats` per equal segment, normalized 0..100 ints) stored as
  `attachments.waveform` jsonb and **inlined in the DTO** — the blurhash
  philosophy: ship the placeholder/scrubber data with the message, zero extra
  fetches. Hydration is the existing `attachment.ready` / `msg.updated` fork.
- **Doodles are a flag, not a feature.** `metadata.doodle: true` on an
  ordinary PNG image message; the image pipeline is untouched. The sketchy
  frame is client rendering. Accepting one boolean beats a parallel
  "sticker" subsystem.
- **Effects are metadata with a consent gate.** `metadata.effect` CHECK-pinned
  to 4 values. Trigger phrases only ever *suggest* (composer chip); the sender
  confirms — never auto-attached, never server-injected (PSYCHOLOGY:
  user-pulled). Plays once per viewer per message, client-tracked; under
  `prefers-reduced-motion` the animation is *replaced* by a static badge, not
  slowed. No sound, no push changes — the blast radius of a mis-fire is zero.
- **Vibe checks are messages aggregating messages.** The prompt is a
  `type='vibe_check'` message body (24-prompt shared deck or custom ≤ 120);
  replies are ordinary image/doodle/stamp-tile messages carrying
  `metadata.vibe_reply_seq`. The vibe DTO inlines reply refs (first 12 +
  count + `my_reply_seq`), and each accepted reply re-ships the vibe message
  via the existing `msg.updated` full-DTO contract — the collage strip is pure
  hydration reuse. One reply per user keeps the collage one face each.
- **Prefs are personal, and the protocol proves it.** `conversation_prefs` +
  `member_nicknames` are per-(conversation, user) rows serialized to their
  owner only; the one new event (`prefs.updated`) goes to the **owner's own
  sockets** exclusively. Themes (8) and wallpapers (6, CSS patterns — no
  uploads) are text + CHECK sets. Documented loudly because it is the
  opposite default from everything else in a chat: *my theme changes my view
  only.* Nicknames included (self allowed), same ownership rule.
- **Disappearing = tombstones, never deletion.** `conversations.
  disappear_ttl_s` (nullable, CHECK-pinned to 1h/24h/7d/30d; DM participants
  or group admins set it; a system message announces every change). The worker
  sweep (new queue `timers`, 1-min repeatable) sets `deleted_at`, nulls
  `body`/`metadata`, deletes attachments (rows + MinIO objects) and dependent
  reaction/poll rows — but the message row and its **seq survive forever**, so
  cursors, watermarks, unread math and pagination are untouched (ADR-003
  holds). System messages are exempt. Sync and history serve tombstones as
  ordinary DTOs.
- **Scheduled sends claim-then-insert, in one transaction.** `scheduled_
  messages` rows (payload mirroring a §1.5 send; 50 pending/user; 60 s–366 d
  window) are delivered by the `timers` queue (delayed job + minute safety
  sweep — the afterglow pattern) through the guarded `UPDATE … SET
  status='sent' … WHERE status='pending'` in the same transaction as the real
  message insert: retries and sweep/job races cannot double-deliver (the
  ADR-007 guarded-update trick, third outing). Undeliverable at claim time
  (author left, DM block-frozen) flips to `'cancelled'` — never a partial
  send. Attachments bind via `attachments.scheduled_message_id`, which also
  exempts them from the orphan GC. A time capsule is the same row +
  `metadata.capsule` (sealed-envelope rendering — anticipation as a feature,
  PSYCHOLOGY §5). Pending schedules are private; `scheduled.updated` syncs
  the author's own devices only.
- **Games live in message metadata; the server is the referee.** Tic-tac-toe
  state (`board/players/turn/winner`) is `metadata.game` on a `game_ttt`
  message; moves are a REST route validated under a row lock (players only,
  turn order, cell empty) and fanned out as `msg.updated` — no game service,
  no new event type, spectators watch the bubble update. The daily puzzle is
  one word per UTC day: `wordlist[sha256(date + ':' + PUZZLE_SECRET) % len]`
  — the wordlist ships publicly in `packages/shared` (append-only), the env
  secret keeps the pick unpredictable, the DB stores only attempts, and
  scoring is server-side. Sharing posts a server-built `puzzle_result` grid
  (g/y/x rows, no letters — unforgeable, spoiler-free).
- **Puzzle sociality is opt-in-by-posting.** `GET /api/puzzle/today/friends`
  returns DM partners who *posted* a result today into a conversation the
  viewer participates in, ordered by username. No ranked table, no points, no
  solve times, **no streaks** — the PSYCHOLOGY never-build list rules out
  Wordle's own retention mechanics on purpose; sharing a grid is a named,
  consensual act and that is the whole social layer.

## Consequences

- **One new worker queue (`timers`)** carries both sweeps + scheduled
  delivery; everything else reuses queues (`media`) and events (`msg.new`,
  `msg.updated`, `attachment.ready`, `reaction.updated`) that already exist.
  Two new WS event types (`prefs.updated`, `scheduled.updated`), both
  own-sockets-only — the participant-facing protocol grows by zero events.
- **Zero new dependencies.** ffmpeg (astats/ffprobe) and sharp already ship;
  sha256 is node crypto; doodles/effects/themes are CSS + canvas client work.
- Migration 0004 is additive: new tables (`scheduled_messages`,
  `conversation_prefs`, `member_nicknames`, `puzzle_attempts`), new columns
  (`message_reactions.kind`, `attachments.waveform/scheduled_message_id`,
  `conversations.disappear_ttl_s`), widened CHECKs (message types, attachment
  kinds), and the rebuilt orphan-GC partial index. All DTO additions default
  (`stamps: []`, `vibe/waveform/disappear_ttl_s: null`, `kind: 'emoji'`) so
  pre-v0.4 clients and stored payloads parse clean.
- The disappearing sweep makes `msg.updated` volume proportional to expiring
  messages; the per-run batch bound and the partial indexes
  (`conversations_disappearing_idx`, `messages_disappear_sweep_idx`) keep it
  O(expiring), and offline clients cost nothing (sync serves tombstones).
- Tombstoning interacts correctly with v0.4 itself: vibe collages drop
  tombstoned replies on the same `msg.updated`; a tombstoned game is simply
  over; scheduled deliveries start their TTL clock at delivery.
- Known accepted costs: the current-TTL sweep applies a newly enabled TTL to
  old messages (documented in the system-message copy); puzzle guesses accept
  any 5 letters (no dictionary gate yet — additive later); the wordlist is
  public by design, which is why the secret, not obscurity, guards the day's
  word.
