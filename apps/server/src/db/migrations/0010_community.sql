-- 0010_community — v0.8b: the community slice of v0.8 (ADR-019 / ADR-020;
-- API.md §1.62–§1.69; FEATURES #77, #78/#78a/#78b, #79a, #79c, #79d, #81).
-- Anonymous reveal game, wave nudges, suggestions + discovery filters, canvas
-- stories, public share pages, group visibility modes (incl. 👻 ghost masks),
-- and the admin pack (content tab, support inbox, report-context consent,
-- update banner). Mirrors nothing new in docs/SCHEMA.sql (frozen at v0.4);
-- Drizzle twin in src/db/schema.ts.
--
-- HARD RULES carried by this schema: the anonymous sender is hidden from the
-- RECIPIENT only, never from the server — sender_id is a plain FK and reports
-- attach it (ADR-019); refusals to open a thread are byte-identical for
-- opt-out and blocks (nothing here stores "who refused whom"); a single wave
-- still notifies nobody — the nudge claim lives on the OPT-IN row
-- (wave_nudged_at), names no waver, and is only claimable when the visible
-- pool is big enough (NUDGE_MIN_POOL, worker-checked BEFORE the claim);
-- canvas overlays are attributed VECTOR layers (payload jsonb, Zod shape
-- authority) that cascade away with their story; share tokens exist only for
-- PUBLIC objects and are revocable capabilities (the ADR-007 invite-token
-- doctrine: plaintext + unique index); a PUBLIC group exposes only
-- seq > public_since_seq (stamped at the admin-confirmed switch — history is
-- never retro-exposed) and a GHOST group is a one-way door (route-enforced:
-- no switch away — members spoke under masks); reports gain reporter-less
-- rows (share pages) and an explicit context_consent bit — the report-context
-- viewer exists ONLY where that bit is true (ADR-020).

-- ==================== users: anon opt-in + nudge toggle ======================
-- Settings columns (the ADR-009 pattern — same one-row read as every other
-- setting). anon_messages: who may open an anonymous thread to me, DEFAULT
-- 'connections' (accepted §1.28 connections literally, NOT friends-of — the
-- §1.57 mood rule). wave_nudges: may the worker send me the batched anonymous
-- "someone waved" line (§1.63).

ALTER TABLE users
  ADD COLUMN anon_messages text NOT NULL DEFAULT 'connections'
    CONSTRAINT users_anon_messages_check
      CHECK (anon_messages IN ('nobody','connections','everyone')),
  ADD COLUMN wave_nudges boolean NOT NULL DEFAULT true;

-- ================== anonymous reveal game (§1.62, #77) =======================
-- One OPEN thread per (sender, recipient) direction — the partial unique
-- below; a revealed thread keeps living (identity now serialized) and frees
-- the slot for a future new game. sender_id/recipient_id are ordinary FKs:
-- anonymity is a SERIALIZATION rule (DTOs strip the sender until revealed),
-- never a storage rule. reveal_timer_s keeps the chosen preset so the
-- progressive un-blur factor is derivable forever (ADR-019):
--   factor = clamp((reveal_at - now()) / reveal_timer_s, 0, 1).
-- Timer reveals resolve LIVE at read (reveal_at <= now() ⇒ revealed); the
-- `timers` worker sweep only stamps revealed_at + fans anon.updated.

CREATE TABLE anon_threads (
  id                  uuid PRIMARY KEY,
  sender_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reveal_mode         text NOT NULL DEFAULT 'none'
                        CHECK (reveal_mode IN ('none','timer','riddle')),
  reveal_timer_s      integer
                        CHECK (reveal_timer_s IN (3600, 21600, 86400)), -- ANON_TIMER_PRESETS_S
  reveal_at           timestamptz,
  riddle_q            text CHECK (char_length(riddle_q) <= 200),        -- ANON_RIDDLE_MAX_CHARS
  reveal_requested_at timestamptz,
  revealed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anon_threads_not_self_check CHECK (sender_id <> recipient_id),
  -- Mode shape: timer carries BOTH timer fields, riddle carries the question.
  CONSTRAINT anon_threads_timer_shape_check
    CHECK (((reveal_mode = 'timer') = (reveal_at IS NOT NULL))
       AND ((reveal_mode = 'timer') = (reveal_timer_s IS NOT NULL))),
  CONSTRAINT anon_threads_riddle_shape_check
    CHECK ((reveal_mode = 'riddle') = (riddle_q IS NOT NULL))
);

-- ONE open thread per direction (UNIQUE sender+recipient while unrevealed).
CREATE UNIQUE INDEX anon_threads_open_unique
  ON anon_threads (sender_id, recipient_id)
  WHERE revealed_at IS NULL;
-- Both parties' thread lists.
CREATE INDEX anon_threads_by_recipient_idx ON anon_threads (recipient_id, created_at DESC);
CREATE INDEX anon_threads_by_sender_idx ON anon_threads (sender_id, created_at DESC);
-- Timer-reveal sweep walk (partial: almost all threads have no timer).
CREATE INDEX anon_threads_reveal_idx ON anon_threads (reveal_at)
  WHERE revealed_at IS NULL AND reveal_at IS NOT NULL;

-- TEXT ONLY by design (no attachment column exists — ADR-019). NOT on the
-- conversations/seq log: no receipts, no typing, no reactions — the game is
-- deliberately smaller than a chat. is_riddle_answer marks the recipient's
-- formal POST .../answer-riddle entries (the sender's "that's right ✓" target).
CREATE TABLE anon_messages (
  id               uuid PRIMARY KEY,
  thread_id        uuid NOT NULL REFERENCES anon_threads(id) ON DELETE CASCADE,
  from_sender      boolean NOT NULL,
  body             text NOT NULL
                     CHECK (char_length(body) BETWEEN 1 AND 500),       -- ANON_BODY_MAX_CHARS
  is_riddle_answer boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX anon_messages_by_thread_idx ON anon_messages (thread_id, created_at);

-- =============== discovery: vibe chip + nudge claim (§1.63/§1.65) ============
-- vibe: the optional what-for chip on an opt-in (#78b) — DISCOVERY_VIBES,
-- data the owner chose to share; card filters only ever NARROW on it.
-- wave_nudged_at: the §1.63 once-per-opt-in nudge claim. The worker claims
-- via the guarded UPDATE (… WHERE wave_nudged_at IS NULL AND expires_at >
-- now()) AFTER the NUDGE_MIN_POOL check, so a too-small pool leaves the claim
-- open for a later wave in the same hour. A re-PUT opt-in clears it (a fresh
-- hour may nudge once more).

ALTER TABLE discovery_optins
  ADD COLUMN vibe text
    CONSTRAINT discovery_optins_vibe_check
      CHECK (vibe IN ('food','chai','walk','game','movie','study','sport','chill')),
  ADD COLUMN wave_nudged_at timestamptz;

-- ================= suggestion dismissals (§1.64, #78) ========================
-- "Not interested" is permanent and silent: the dismissed user is never told,
-- and the row only ever FILTERS (nothing is recommended harder elsewhere).
-- No status column — presence IS the dismissal.

CREATE TABLE suggestion_dismissals (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggested_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, suggested_user_id),
  CONSTRAINT suggestion_dismissals_not_self_check CHECK (user_id <> suggested_user_id)
);

-- ==================== canvas stories (§1.66, #79a) ===========================
-- canvas_mode: the author's invitation — DEFAULT 'off' (being drawable is
-- never ambient); 'approve' holds viewer overlays as 'pending'.

ALTER TABLE stories
  ADD COLUMN canvas_mode text NOT NULL DEFAULT 'off'
    CONSTRAINT stories_canvas_mode_check
      CHECK (canvas_mode IN ('off','open','approve'));

-- One VECTOR layer per row, keyed to its contributor — never burned into the
-- image, so removal is total and the username chip always knows its owner.
-- payload shape authority is the shared Zod union (stroke/emoji/text; the DB
-- pins only jsonb_typeof — the house metadata pattern). status 'removed' is a
-- tombstone kept ONLY so reports resolve (§1.14's "reports outlive their
-- targets"); it serializes to nobody and frees the per-user cap. Everything
-- cascades away with the story (the §1.34 hard-delete sweep).

CREATE TABLE story_overlays (
  id         uuid PRIMARY KEY,
  story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('stroke','emoji','text')),
  payload    jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status     text NOT NULL DEFAULT 'live'
               CHECK (status IN ('live','pending','removed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Layer paint order + the per-(story, contributor) OVERLAYS_PER_USER=5 cap
-- count (live+pending only; the route counts under the story row lock).
CREATE INDEX story_overlays_by_story_idx ON story_overlays (story_id, created_at);
CREATE INDEX story_overlays_cap_idx ON story_overlays (story_id, author_id)
  WHERE status IN ('live','pending');

-- "Ban from my canvases": owner-scoped, forever until lifted. Enforced
-- INVISIBLY at overlay create — a banned contributor gets the same
-- 403 canvas_closed a closed canvas answers (never confirmable).
CREATE TABLE story_canvas_bans (
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, banned_user_id),
  CONSTRAINT story_canvas_bans_not_self_check CHECK (owner_id <> banned_user_id)
);

-- ===================== public share tokens (§1.67, #79c) =====================
-- The ADR-007 invite-token doctrine re-applied: 32 random bytes base64url,
-- stored PLAINTEXT with a unique index — a revocable CAPABILITY, not a
-- credential (the mint endpoint must re-display it). ONE open token per
-- object (partial unique below): "stable per object, revocable with it".
-- Tokens exist ONLY for PUBLIC things (route-enforced at mint: post
-- audience='public', beacon audience='public', listing is_public, group
-- visibility public|invite_only, story = author's own explicit link) and
-- every public read ALSO re-checks the object's publicness LIVE — narrowing
-- an audience kills the page mid-flight even before the revoke lands.
-- object_id is a plain uuid, NOT an FK: posts hard-delete, stories sweep —
-- the read resolves or 404s, and the gc sweep prunes dead tokens.

CREATE TABLE share_tokens (
  id          uuid PRIMARY KEY,
  object_type text NOT NULL
                CHECK (object_type IN ('post','beacon','listing','story','group')),
  object_id   uuid NOT NULL,
  token       text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE UNIQUE INDEX share_tokens_token_unique ON share_tokens (token);
-- One OPEN token per object; a revoke frees the slot (stories may re-mint).
CREATE UNIQUE INDEX share_tokens_object_unique
  ON share_tokens (object_type, object_id)
  WHERE revoked_at IS NULL;

-- ================= group visibility modes (§1.68, #79d) ======================
-- Groups only: DMs and channels stay 'private' (the CHECK). 'public' ⇄
-- public_since_seq travel together — stamped with last_seq inside the
-- admin-confirmed switch transaction; ONLY seq > public_since_seq ever
-- renders publicly. Leaving 'public' clears it (and revokes the group's
-- share token route-side); a LATER re-publicize stamps a fresh floor.
-- 'ghost' is route-enforced as a ONE-WAY door (400 ghost_is_forever):
-- members spoke under masks and no admin toggle may unmask them (ADR-020).

ALTER TABLE conversations
  ADD COLUMN visibility text NOT NULL DEFAULT 'private'
    CONSTRAINT conversations_visibility_check
      CHECK (visibility IN ('private','invite_only','public','ghost')),
  ADD COLUMN description text NOT NULL DEFAULT ''
    CONSTRAINT conversations_description_check
      CHECK (char_length(description) <= 300),                -- GROUP_DESCRIPTION_MAX_CHARS
  ADD COLUMN public_since_seq bigint;

ALTER TABLE conversations ADD CONSTRAINT conversations_visibility_group_check
  CHECK (visibility = 'private' OR type = 'group');
ALTER TABLE conversations ADD CONSTRAINT conversations_public_since_shape_check
  CHECK ((visibility = 'public') = (public_since_seq IS NOT NULL));

-- Discovery/search listing walk for PUBLIC groups (ghost groups are excluded
-- from every listing by the visibility value itself — unlisted everywhere).
CREATE INDEX conversations_public_idx ON conversations (created_at DESC)
  WHERE visibility = 'public';

-- invite_only join queue. Presence = pending; approve inserts the participant
-- (join_seq = last_seq, the §1.4 floor) and deletes the row in one
-- transaction; deny just deletes it — SILENTLY (no event, no notice: the
-- no-rejection-surface rule, ADR-015 precedent).
CREATE TABLE group_join_requests (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- 👻 ghost masks: chosen pseudonym + emoji avatar per (group, member) —
-- auto-assigned from the GHOST_MASK_* pools at join/switch, re-pickable via
-- PUT …/mask. Anonymity is a SERIALIZATION rule (non-admin members get the
-- masked UserLite with a derived pseudo-id; admins and reports see real
-- identity) — the server always knows who is who, by contract (#77 precedent).
CREATE TABLE conversation_masks (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mask_name       text NOT NULL
                    CHECK (char_length(mask_name) BETWEEN 1 AND 32),    -- MASK_NAME_MAX_CHARS
  mask_emoji      text NOT NULL
                    CHECK (char_length(mask_emoji) BETWEEN 1 AND 16),   -- MASK_EMOJI_MAX_LEN
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- mask_taken: names are unique per group (citext-less: exact match is fine
-- for pseudonyms; the route lowercases before compare).
CREATE UNIQUE INDEX conversation_masks_name_unique
  ON conversation_masks (conversation_id, mask_name);

-- ================= reports: new kinds + consent (§1.62/§1.66/§1.67/§1.69) ====
-- reporter_id becomes NULLABLE: non-user share-page reports store NULL +
-- reporter_ip (aged out by the IP_RETENTION_DAYS gc sweep like every IP).
-- context_consent is the REPORTER's explicit include-context choice on
-- message reports — the ONLY key that opens the §1.69 context viewer.
-- New target columns follow the 0003 doctrine: no FKs, reports outlive
-- their targets; target_user_id doubles as the ATTACHED identity for
-- anon_message (the thread's reported-party) and story_overlay (the overlay
-- author) — stamped SERVER-side at intake, never client-supplied.

ALTER TABLE reports
  ALTER COLUMN reporter_id DROP NOT NULL,
  ADD COLUMN target_object_type text
    CONSTRAINT reports_target_object_type_check
      CHECK (target_object_type IN ('post','beacon','listing','story','group')),
  ADD COLUMN target_object_id uuid,
  ADD COLUMN target_overlay_id uuid,
  ADD COLUMN target_anon_thread_id uuid,
  ADD COLUMN target_anon_message_id uuid,
  ADD COLUMN context_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN reporter_ip inet;

ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check
  CHECK (kind IN ('user','message','beacon','anon_message','story_overlay','share_page'));

-- Exactly one target shape per kind (the 0003 CHECK, widened).
ALTER TABLE reports DROP CONSTRAINT reports_target_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_check
  CHECK (
    (kind = 'user' AND target_user_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'message' AND target_conversation_id IS NOT NULL AND target_seq IS NOT NULL
      AND target_user_id IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'beacon' AND target_beacon_id IS NOT NULL
      AND target_user_id IS NULL AND target_conversation_id IS NULL AND target_seq IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'anon_message' AND target_anon_thread_id IS NOT NULL AND target_anon_message_id IS NOT NULL
      AND target_user_id IS NOT NULL -- the SERVER-attached identity (FEATURES #77)
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL)
    OR (kind = 'story_overlay' AND target_object_type = 'story' AND target_object_id IS NOT NULL
      AND target_overlay_id IS NOT NULL
      AND target_user_id IS NOT NULL -- the SERVER-attached overlay author
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_anon_thread_id IS NULL)
    OR (kind = 'share_page' AND target_object_type IS NOT NULL AND target_object_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
  );

-- context_consent exists only on message reports; non-user rows carry an IP.
ALTER TABLE reports ADD CONSTRAINT reports_context_consent_shape_check
  CHECK (context_consent = false OR kind = 'message');
ALTER TABLE reports ADD CONSTRAINT reports_reporter_shape_check
  CHECK (reporter_id IS NOT NULL OR kind = 'share_page');

-- ===================== support tickets (§1.69, #81b) =========================
-- The Settings → Help & feedback intake. The DIALOGUE lives in the per-user
-- "Bored Chat Support" conversation (type 'group', metadata.support = true,
-- the user as sole member, lazily created on first delivery; operator
-- messages are sender_id NULL + metadata.support {ticket_id}); this table is
-- the admin Inbox's index: category, first body, optional screenshot, status.
-- attachment_id follows the 0009 prefs pattern (the reference points
-- ticket → attachment): the orphan GC sweep must ANTI-JOIN this index too,
-- and SET NULL keeps the ticket when the attachment ages away.

CREATE TABLE support_tickets (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('bug','question','idea','safety')),
  body          text NOT NULL
                  CHECK (char_length(body) BETWEEN 1 AND 2000),         -- SUPPORT_BODY_MAX_CHARS
  attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','answered','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Admin inbox (open first) + the user's own list.
CREATE INDEX support_tickets_queue_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_by_user_idx ON support_tickets (user_id, created_at DESC);
-- GC anti-join shield for the optional screenshot (the 0009 background rule).
CREATE INDEX support_tickets_attachment_idx ON support_tickets (attachment_id)
  WHERE attachment_id IS NOT NULL;

-- ======================= release marker (§1.61 machinery) ====================
-- Prepend the v0.8b entry (newest first — the ADR-018 rule; bounds per
-- ReleaseNoteSchema).

UPDATE instance_settings
SET value = '[
  {
    "version": "v0.8b",
    "date": "2026-10-17",
    "title": "Anonymous games, shared canvases & community care",
    "items": [
      "Anonymous messages, opt-in: guess who — reveal by timer (watch the avatar un-blur) or riddle",
      "👀 Someone in the pool waved at you — anonymous nudges you can turn off",
      "People you may know: mutuals, your area and shared groups, dismiss forever",
      "Filter Bored Together by vibe, shared interests and area",
      "Open your story as a canvas — friends doodle, stamp and scribble on it, every mark signed",
      "Share public posts, plans and listings as real links that unfurl anywhere",
      "Group modes: invite-only with join requests, public with a live page, or 👻 ghost with masks",
      "Help & feedback in Settings — replies arrive from Bored Chat Support"
    ]
  }
]'::jsonb || value,
    updated_at = now()
WHERE key = 'release_notes';
