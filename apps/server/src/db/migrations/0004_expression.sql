-- 0004_expression — v0.4: expression pack (ADR-010; API.md §1.19–§1.27;
-- FEATURES #31–#38). Avatar stamps, voice notes, doodles, message effects,
-- vibe checks, chat prefs (themes/wallpapers/nicknames), disappearing
-- messages, scheduled messages & time capsules, tic-tac-toe, daily puzzle.
-- Mirrors docs/SCHEMA.sql; Drizzle twin in src/db/schema.ts.

-- ===================== messages: new types + effect CHECK ===================
-- 'audio' = voice note (§1.20); 'vibe_check' = prompt message whose replies
-- carry metadata.vibe_reply_seq (§1.23); 'game_ttt' = tic-tac-toe game message
-- with the whole state in metadata.game (§1.27); 'puzzle_result' = the
-- no-spoiler daily-puzzle grid share, metadata.puzzle server-populated (§1.27).

ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','video','file','system','poll',
                  'audio','vibe_check','game_ttt','puzzle_result'));

-- metadata.effect is CHECK-pinned to the fixed set (MESSAGE_EFFECTS). The
-- CONSENT rule is client-side but binding: effects are auto-SUGGESTED on
-- trigger phrases and only attached after the sender confirms — never
-- auto-fired (§1.22).
ALTER TABLE messages ADD CONSTRAINT messages_metadata_effect_check
  CHECK (NOT (metadata ? 'effect')
         OR metadata->>'effect' IN ('confetti','hearts','fireworks','snow'));

-- ================= message_reactions: avatar stamps (§1.19) =================
-- A stamp is a reaction row with kind='stamp' and the ':stamp:' sentinel
-- (STAMP_REACTION_KEY) in the emoji column, so the EXISTING PK
-- (conversation_id, seq, user_id, emoji) enforces the one-stamp-per-user-per-
-- message cap with zero new indexes. The 8-distinct-emoji route cap counts
-- kind='emoji' rows only. All pre-v0.4 rows are 'emoji' via the DEFAULT.

ALTER TABLE message_reactions
  ADD COLUMN kind text NOT NULL DEFAULT 'emoji'
    CHECK (kind IN ('emoji','stamp'));
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_stamp_key_check
  CHECK ((kind = 'stamp') = (emoji = ':stamp:'));

-- ============== scheduled messages & time capsules (§1.26) ==================
-- Payload mirrors a §1.5 send (body + attachments bound via
-- attachments.scheduled_message_id below + metadata effect/capsule). Delivery
-- is worker-driven (queue `timers`): a delayed job per row plus a minute
-- safety sweep over scheduled_due_idx; the claim is the idempotent guarded
--   UPDATE scheduled_messages SET status='sent', sent_at=now(), sent_seq=$seq
--     WHERE id=$1 AND status='pending'
-- inside the same transaction as the real §1.5 message insert (seq bump,
-- author watermark raise), so a job retry or sweep/job race can never deliver
-- twice. If delivery is impossible (author left, DM frozen by a block,
-- conversation gone), the claim flips to 'cancelled' instead — never a
-- partial send. A time capsule is the same row with metadata.capsule=true.

CREATE TABLE scheduled_messages (
  id              uuid PRIMARY KEY,                  -- uuidv7, app-side
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_msg_id   uuid NOT NULL,                     -- create idempotency (unique per author)
  type            text NOT NULL
                    CHECK (type IN ('text','image','video','file','audio')),
  body            text CHECK (char_length(body) <= 8192),  -- MAX_MESSAGE_BODY_CHARS
  metadata        jsonb NOT NULL DEFAULT '{}'        -- {effect?, capsule?} only
                    CHECK (NOT (metadata ? 'effect')
                           OR metadata->>'effect' IN ('confetti','hearts','fireworks','snow')),
  deliver_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  sent_seq        bigint,                            -- delivered message's seq (jump-to)
  CONSTRAINT scheduled_sent_shape_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL AND sent_seq IS NOT NULL))
);
CREATE UNIQUE INDEX scheduled_idempotency_idx
  ON scheduled_messages (author_id, client_msg_id);
CREATE INDEX scheduled_due_idx
  ON scheduled_messages (deliver_at) WHERE status = 'pending';   -- delivery sweep
CREATE INDEX scheduled_by_author_idx
  ON scheduled_messages (author_id, created_at DESC);            -- list-mine
CREATE INDEX scheduled_author_pending_idx
  ON scheduled_messages (author_id) WHERE status = 'pending';    -- 50-pending cap count

-- ================= attachments: audio kind + waveform (§1.20) ===============
-- Voice notes ride the EXISTING proxied upload pipeline: magic-byte sniff →
-- audio allowlist (ogg/opus, webm/opus, m4a/aac, mp3; ≤ 10 MB streamed) →
-- status 'pending' → worker `media` job ffprobes duration (> 300 s → 'failed')
-- and computes the 48-bucket peaks array (ffmpeg astats per equal segment,
-- normalized 0..100 integers) → status 'ready', hydrated via the existing
-- attachment.ready / msg.updated events.

ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('image','video','file','audio'));

ALTER TABLE attachments
  ADD COLUMN waveform jsonb
    CHECK (waveform IS NULL
           OR (jsonb_typeof(waveform) = 'array'
               AND jsonb_array_length(waveform) = 48));          -- AUDIO_WAVEFORM_BUCKETS

-- An attachment bound to a pending scheduled message is NOT an orphan: the
-- nightly GC must not reap it while it waits (possibly a year, for capsules).
ALTER TABLE attachments
  ADD COLUMN scheduled_message_id uuid
    REFERENCES scheduled_messages(id) ON DELETE SET NULL;

DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL
    AND scheduled_message_id IS NULL;

-- =================== conversations: disappearing TTL (§1.25) ================
-- NULL = off. Set by any participant in DMs, admins in groups; every change
-- drops a system message (event 'disappear_changed', metadata.system.ttl_s).
-- The worker sweep (queue `timers`, every minute) TOMBSTONES expired rows —
-- deleted_at set, body NULLed, metadata emptied, attachments deleted (rows +
-- MinIO objects), dependent reaction/poll rows removed — and NEVER deletes the
-- message row: seqs are never reused, so sync cursors, receipts and unread
-- math survive untouched. System messages are exempt (announcements persist).

ALTER TABLE conversations
  ADD COLUMN disappear_ttl_s int
    CHECK (disappear_ttl_s IN (3600, 86400, 604800, 2592000));   -- DISAPPEAR_TTL_OPTIONS_S

CREATE INDEX conversations_disappearing_idx
  ON conversations (id) WHERE disappear_ttl_s IS NOT NULL;       -- sweep's outer loop
CREATE INDEX messages_disappear_sweep_idx
  ON messages (conversation_id, created_at)
  WHERE deleted_at IS NULL AND type <> 'system';                 -- sweep's inner walk

-- ============ chat prefs: themes, wallpapers, nicknames (§1.24) =============
-- ALL PERSONAL: per (conversation, user), visible to that user only, synced
-- across their devices via prefs.updated (own sockets). Themes are a fixed
-- palette set and wallpapers a fixed CSS-pattern set (text + CHECK, the house
-- enum pattern; NO wallpaper uploads in v0.4). NULL = app default.

CREATE TABLE conversation_prefs (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme           text CHECK (theme IN ('classic','sunset','ocean','forest',
                                        'grape','bubblegum','mono','midnight')),  -- CHAT_THEMES
  wallpaper       text CHECK (wallpaper IN ('dots','grid','waves','stars',
                                            'scribbles','blobs')),                -- CHAT_WALLPAPERS
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- Nickname map: owner's private labels for other members (and themselves) of
-- one conversation. Never serialized to anyone but the owner.
CREATE TABLE member_nicknames (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname        text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 32),  -- NICKNAME_MAX_CHARS
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, owner_id, target_id)
);

-- ===================== daily word puzzle attempts (§1.27) ===================
-- One row per (user, UTC day). guesses is the ordered attempt log
-- [{guess, score}] (score = 5 chars of g/y/x); the day's word is NEVER stored
-- — it is recomputed as PUZZLE_WORDLIST[sha256(date || ':' || PUZZLE_SECRET)
-- mod length] (secret = env PUZZLE_SECRET), so a DB dump spoils nothing and
-- the wordlist can ship in the public shared package. NO leaderboard, NO
-- rankings, NO streaks — ever (PSYCHOLOGY never-build list): opt-in sharing is
-- posting a puzzle_result message; GET /api/puzzle/today/friends merely echoes
-- what DM partners already posted, ordered by username.

CREATE TABLE puzzle_attempts (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  puzzle_date date NOT NULL,
  guesses     jsonb NOT NULL DEFAULT '[]'
                CHECK (jsonb_typeof(guesses) = 'array'
                       AND jsonb_array_length(guesses) <= 6),    -- PUZZLE_MAX_GUESSES
  solved      boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, puzzle_date)
);
