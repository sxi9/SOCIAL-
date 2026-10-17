-- 0009_identity — v0.8a: identity & moods slice of v0.8 (ADR-018; API.md
-- §1.57–§1.61; FEATURES #72–#76, #79, #80). Moods + 🍻 drunk mode, animated
-- names, the profile activity strip with per-kind privacy, GIF/video chat
-- backgrounds, and the discoverability release markers. Mirrors nothing new
-- in docs/SCHEMA.sql (frozen at v0.4, like 0005–0008); Drizzle twin in
-- src/db/schema.ts.
--
-- HARD RULES carried by this schema: a mood lives ONLY in users.mood_*
-- columns and leaves NO trace anywhere once cleared/expired — it is never
-- copied into messages, activities, or any history row, and no mood kind
-- exists in the activities CHECK, by contract (PSYCHOLOGY: no archaeology);
-- a mood change never generates push (the drunk banner is a passive in-chat
-- render of an already-visible chip); activity visibility is resolved at
-- READ time as (per-group setting) ∩ (the underlying object's own audience)
-- — nothing about audiences is denormalized into activities.ref, so the
-- intersection can never go stale; the drunk send-undo is an ordinary §1.30
-- tombstone (seq survives, golden rule 2) distinguished only by
-- metadata {"undone": true} — no schema change needed for it.

-- ======================== users: moods (§1.57, #72–#73) ======================
-- Columns, not a table (the ADR-009 settings pattern): the mood chip rides
-- EVERY UserLite serialization, so it must come from the same one-row read.
-- All mood_* NULL = no mood. Reads filter mood_expires_at > now() LIVE (the
-- discovery-optin pattern — never a stale chip); the worker sweep clears the
-- columns + fans the user.updated goodbye. kind='swing' keeps the chosen set
-- in mood_swing_set ([{emoji,label}…], Zod shape authority) and materializes
-- the CURRENT entry into mood_emoji/mood_label on each ~30min rotation.
-- kind='drunk' pins emoji/label to 🍻/'drunk' route-side and DEFAULTS
-- visibility to 'connections' (route-enforced; the column default stays
-- 'everyone' for ordinary moods).

ALTER TABLE users
  ADD COLUMN mood_emoji text
    CONSTRAINT users_mood_emoji_check
      CHECK (char_length(mood_emoji) BETWEEN 1 AND 16),     -- MOOD_EMOJI_MAX_LEN
  ADD COLUMN mood_label text
    CONSTRAINT users_mood_label_check
      CHECK (char_length(mood_label) BETWEEN 1 AND 24),     -- MOOD_LABEL_MAX_CHARS
  ADD COLUMN mood_kind text
    CONSTRAINT users_mood_kind_check
      CHECK (mood_kind IN ('preset','custom','swing','drunk')),
  ADD COLUMN mood_visibility text NOT NULL DEFAULT 'everyone'
    CONSTRAINT users_mood_visibility_check
      CHECK (mood_visibility IN ('everyone','connections','nobody')),
  ADD COLUMN mood_swing_set jsonb,
  ADD COLUMN mood_expires_at timestamptz,
  ADD COLUMN mood_swing_rotated_at timestamptz;

-- All-or-nothing mood shape; the swing set exists exactly for kind='swing'.
ALTER TABLE users ADD CONSTRAINT users_mood_shape_check
  CHECK (((mood_kind IS NULL) = (mood_emoji IS NULL))
     AND ((mood_kind IS NULL) = (mood_label IS NULL))
     AND ((mood_kind IS NULL) = (mood_expires_at IS NULL)));
ALTER TABLE users ADD CONSTRAINT users_mood_swing_shape_check
  CHECK ((mood_kind = 'swing') = (mood_swing_set IS NOT NULL));
ALTER TABLE users ADD CONSTRAINT users_mood_swing_set_check
  CHECK (mood_swing_set IS NULL OR (jsonb_typeof(mood_swing_set) = 'array'
     AND jsonb_array_length(mood_swing_set) BETWEEN 2 AND 6)); -- MOOD_SWING_SET_MIN/MAX

-- Expiry sweep + swing rotation walks (partial: most users have no mood).
CREATE INDEX users_mood_expiry_idx ON users (mood_expires_at)
  WHERE mood_expires_at IS NOT NULL;
CREATE INDEX users_mood_swing_idx ON users (mood_swing_rotated_at)
  WHERE mood_kind = 'swing';

-- ================= users: animated names & mood effects (§1.58) ==============
-- name_style is identity (PATCH /users/me), serialized on UserLite/UserPublic;
-- 'surprise' rotates daily and deterministically CLIENT-side (hash(user_id +
-- UTC date) over NAME_STYLE_SURPRISE_POOL) — no server state, every viewer
-- agrees. mood_effects is the per-VIEWER toggle for performing other people's
-- mood-reactive bubbles — a settings column (ADR-009 pattern) purely for
-- cross-device sync; all rendering is client-side.

ALTER TABLE users
  ADD COLUMN name_style text NOT NULL DEFAULT 'none'
    CONSTRAINT users_name_style_check
      CHECK (name_style IN ('none','glow','shimmer','rainbow','surprise')),
  ADD COLUMN mood_effects boolean NOT NULL DEFAULT true;

-- ================ users: activity privacy settings (§1.59, #76) ==============
-- Per-GROUP visibility of the owner's activity strip (ACTIVITY_KIND_GROUP:
-- beacon_lit/beacon_sparked → beacons, post_created → posts, listing_posted →
-- listings, puzzle_played/game_won → games). 'private' = owner only. Default
-- 'connections' — the calm default. ALWAYS intersected with the underlying
-- object's own audience at read time: these toggles narrow, never widen.

ALTER TABLE users
  ADD COLUMN activity_beacons text NOT NULL DEFAULT 'connections'
    CONSTRAINT users_activity_beacons_check
      CHECK (activity_beacons IN ('public','connections','private')),
  ADD COLUMN activity_posts text NOT NULL DEFAULT 'connections'
    CONSTRAINT users_activity_posts_check
      CHECK (activity_posts IN ('public','connections','private')),
  ADD COLUMN activity_listings text NOT NULL DEFAULT 'connections'
    CONSTRAINT users_activity_listings_check
      CHECK (activity_listings IN ('public','connections','private')),
  ADD COLUMN activity_games text NOT NULL DEFAULT 'connections'
    CONSTRAINT users_activity_games_check
      CHECK (activity_games IN ('public','connections','private'));

-- ===================== activities (§1.59, FEATURES #76) ======================
-- Written by the OWNING module's transaction through the one helper
-- (src/lib/activity.ts recordActivity): beacon create → beacon_lit, spark →
-- beacon_sparked (creator only — a joiner's attendance is the plan group's
-- business, not a public strip item), POST /api/posts → post_created,
-- POST /api/listings → listing_posted, a FINISHED puzzle attempt (solved or
-- out of guesses; once per user per UTC day) → puzzle_played, a server-
-- validated tic-tac-toe win → game_won (winner's row). ref is the minimal
-- pointer/facts jsonb (shape authority: shared §1.59 contract):
--   beacon_lit/beacon_sparked  {beacon_id}
--   post_created               {post_id}
--   listing_posted             {listing_id}
--   puzzle_played              {date, solved, attempts_used}  -- no-spoiler facts
--   game_won                   {conversation_id, seq, opponent_id}
-- Resolution is per-viewer at read time (§1.59 table there); rows older than
-- ACTIVITY_RETENTION_DAYS (30) are hard-deleted by the nightly gc sweep.
-- NO mood kind exists here, by contract — moods leave no trace (ADR-018).

CREATE TABLE activities (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('beacon_lit','beacon_sparked',
               'post_created','listing_posted','puzzle_played','game_won')),
  ref        jsonb NOT NULL CHECK (jsonb_typeof(ref) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_by_user_idx ON activities (user_id, created_at DESC);
CREATE INDEX activities_sweep_idx ON activities (created_at);

-- ============ conversation_prefs: chat backgrounds (§1.60, #79) ==============
-- PERSONAL like theme/wallpaper (§1.24): my view only, prefs.updated to my
-- own sockets only. The attachment must be the OWNER's own upload (route-
-- checked: uploader_id = me, kind image|video, status 'ready', video ≤
-- CHAT_BG_VIDEO_MAX_BYTES and ≤ CHAT_BG_VIDEO_MAX_DURATION_S). SET NULL
-- keeps the prefs row when the attachment goes. GC: a background-referenced
-- attachment cannot ride the attachments_orphan_idx binding-column pattern
-- (the reference points the other way, and one upload may back several of
-- the owner's chats) — the orphan sweep instead ANTI-JOINS this index, so a
-- referenced attachment is never collected.

ALTER TABLE conversation_prefs
  ADD COLUMN background_attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL;

CREATE INDEX conversation_prefs_background_idx
  ON conversation_prefs (background_attachment_id)
  WHERE background_attachment_id IS NOT NULL;

-- ================ discoverability release markers (§1.61, #80) ===============
-- The "new since your last visit" machinery: the instance's shipped releases
-- live in instance_settings key 'release_notes' (newest first; seeded here,
-- appended by future release migrations, curable via the admin PATCH), and
-- the per-user cursor is users.last_seen_release. Register stamps the newest
-- version at signup so day-one users never get a card storm.

ALTER TABLE users ADD COLUMN last_seen_release text
  CONSTRAINT users_last_seen_release_check
    CHECK (char_length(last_seen_release) <= 20);          -- RELEASE_VERSION_MAX_CHARS

INSERT INTO instance_settings (key, value) VALUES ('release_notes', '[
  {
    "version": "v0.8a",
    "date": "2026-10-17",
    "title": "Moods, animated names & make-it-yours",
    "items": [
      "Set a mood chip — it fades on its own, and 🎢 swing mode cycles through your picks",
      "🍻 Drunk mode: undo any send for 10 seconds, with gentle guardrails",
      "Chats react to visible moods (toggle it off in Settings)",
      "Animated display names: glow, shimmer, rainbow or surprise-me",
      "Your profile shows recent activity — you choose who sees each kind",
      "Put your own GIF or clip behind any chat (only you see it)",
      "New ✨ Things-you-can-do directory and a first-run tour"
    ]
  }
]'::jsonb);
