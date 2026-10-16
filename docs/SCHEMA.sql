-- ============================================================================
-- SocialChat — MVP schema (PostgreSQL 17). Executable top-to-bottom.
-- Conventions:
--   * UUIDv7 primary keys, generated app-side (time-ordered, index-friendly).
--   * text + CHECK instead of PG enums (adding a value = one-line migration).
--   * timestamptz everywhere; citext for case-insensitive uniqueness.
--   * Deliberate deletions: NO message_receipts table (watermark cursors on
--     conversation_participants replace O(messages x participants) rows) and
--     NO devices table (sessions = browser devices, push_subscriptions = push
--     targets, live sockets live in the WS registry + Redis).
--   * App-enforced invariant (shared constant, not a trigger):
--     MAX_GROUP_PARTICIPANTS = 256 — keeps O(participants) fan-out and
--     receipt math safe until Phase-2 channels.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================== identity ====================================

CREATE TABLE users (
  id                  uuid PRIMARY KEY,
  username            citext NOT NULL UNIQUE,
  email               citext NOT NULL UNIQUE,
  email_verified_at   timestamptz,                  -- column now, flow Phase 2
  password_hash       text NOT NULL,                -- argon2id (m=64MiB,t=3,p=1)
  display_name        text NOT NULL,
  bio                 text NOT NULL DEFAULT '',
  -- Animated avatar (signature feature). Static JPEG renders in lists/bubbles;
  -- animated WebP renders on profile pages and the open-chat header only.
  avatar_status       text NOT NULL DEFAULT 'none'
                        CHECK (avatar_status IN ('none','processing','ready','failed')),
  avatar_static_key   text,                         -- MinIO key: 512px JPEG poster
  avatar_animated_key text,                         -- MinIO key: 512px animated WebP
  avatar_version      int NOT NULL DEFAULT 0,       -- bumped each transcode; cache-buster in DTOs
  avatar_motion       text NOT NULL DEFAULT 'auto'  -- viewer-side motion preference
                        CHECK (avatar_motion IN ('auto','reduced','off')),
  last_seen_at        timestamptz,                  -- coarse; flushed from Redis presence
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Opaque session tokens. This IS the device registry for auth purposes:
-- cookie carries the raw token, DB stores sha256 only. The WS socket registry
-- is keyed by sessions.id, so deleting a row closes its live sockets.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,                -- sha256(raw token)
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),  -- written at most hourly
  expires_at   timestamptz NOT NULL                 -- 30-day sliding
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expired_idx ON sessions (expires_at);  -- nightly GC sweep

-- ============================ conversations =================================

CREATE TABLE conversations (
  id                  uuid PRIMARY KEY,
  type                text NOT NULL CHECK (type IN ('dm','group')),  -- Phase 2 adds 'channel'
  title               text,                         -- groups only; NULL for DMs
  -- Groups get animated avatars via the same avatar job as users.
  avatar_status       text NOT NULL DEFAULT 'none'
                        CHECK (avatar_status IN ('none','processing','ready','failed')),
  avatar_static_key   text,
  avatar_animated_key text,
  avatar_version      int NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  dm_key              text UNIQUE,                  -- sorted 'uuidMin:uuidMax'; dedupes DM creation races
  last_seq            bigint NOT NULL DEFAULT 0,    -- THE per-conversation message counter
  last_message_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'dm') = (dm_key IS NOT NULL))      -- dm_key iff DM
);
CREATE INDEX conversations_activity_idx
  ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_participants (
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at          timestamptz NOT NULL DEFAULT now(),
  -- History-visibility floor: conversations.last_seq at join time (0 for
  -- founding members). History queries return only seq > join_seq. One column
  -- now; no migration when channels/late-join groups need it.
  join_seq           bigint NOT NULL DEFAULT 0,
  left_at            timestamptz,                   -- soft leave: history retained up to leave
  left_seq           bigint,                        -- conversations.last_seq at leave time:
                                                    -- departed members see only seq <= left_seq
  -- Receipt watermarks (cursors), NOT per-message rows. Monotonic: writes use
  -- GREATEST(stored, incoming). "msg N read by U" <=> U.last_read_seq >= N.
  -- Unread count = conversations.last_seq - last_read_seq. Invariant:
  -- last_read_seq <= last_delivered_seq is maintained by the server (a read
  -- raises delivered too). Push acceptance NEVER advances last_delivered_seq —
  -- only a client ack after durable local store does (receipt honesty).
  last_delivered_seq bigint NOT NULL DEFAULT 0,
  last_read_seq      bigint NOT NULL DEFAULT 0,
  muted_until        timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX participants_by_user_idx
  ON conversation_participants (user_id) WHERE left_at IS NULL;

-- =============================== messages ===================================

-- seq is assigned transactionally:
--   UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now()
--     WHERE id = $1 RETURNING last_seq;
--   INSERT INTO messages (..., seq) VALUES (..., that value);
-- The row lock serializes writers per conversation only; gapless total order
-- is guaranteed by the database. seqs are never reused (tombstones, Phase 2).
CREATE TABLE messages (
  id              uuid NOT NULL UNIQUE,             -- UUIDv7, globally unique handle
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL CHECK (seq > 0),
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system message
  client_msg_id   uuid,                             -- sender-generated idempotency key; NULL for system
  type            text NOT NULL CHECK (type IN ('text','image','video','file','system')),
  body            text,                             -- text content / system event description
  -- metadata carries: link_preview snapshot {url, site_name, title, description,
  -- image_url} frozen at send time (survives link_previews cache pruning),
  -- system payloads {event, actor_id, target_id}, Phase-2 forwarded_from.
  metadata        jsonb NOT NULL DEFAULT '{}',
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,  -- Phase-2 ready, dark in MVP
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,                      -- Phase-2 ready
  deleted_at      timestamptz,                      -- Phase-2 tombstone; seq never reused
  PRIMARY KEY (conversation_id, seq)                -- clusters history; THE pagination/sync index
);
-- Idempotent sends: a REST retry with the same client_msg_id returns the
-- existing row instead of inserting a duplicate.
CREATE UNIQUE INDEX messages_idempotency_idx
  ON messages (conversation_id, sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

-- ============================ link previews =================================

-- Shared unfurl cache. Messages snapshot the card into metadata at send time,
-- so pruning/refreshing rows here never strips previews from old messages.
CREATE TABLE link_previews (
  url_hash    text PRIMARY KEY,                     -- sha256(normalized url), hex
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','ok','failed')),
  site_name   text,
  title       text,
  description text,
  image_key   text,                                 -- og:image re-encoded to WebP, in MinIO
  fetched_at  timestamptz,
  -- ok: fetched_at + 7 days. failed: fetched_at + 1 hour (negative cache —
  -- stops retry storms against dead/hostile URLs). Expired rows are refetched
  -- on next request; GC prunes rows + images past expiry + 7 days.
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================ share-target inbox ============================

-- Persisted the moment the PWA share POST lands (files uploaded, row created),
-- so Android killing the page mid-share loses nothing and compose can resume
-- on another device. Logged-out shares park in a Redis stash (30-min TTL) and
-- are promoted here via /share-imports/claim after login.
CREATE TABLE share_imports (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text,
  text_body        text,
  url              text,                            -- unfurl enqueued eagerly on insert
  preview_url_hash text REFERENCES link_previews(url_hash) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','consumed','expired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  consumed_at      timestamptz
);
CREATE INDEX share_imports_open_idx
  ON share_imports (user_id, created_at DESC) WHERE status = 'open';

-- ============================== attachments =================================

CREATE TABLE attachments (
  id              uuid PRIMARY KEY,
  uploader_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,        -- NULL until bound at send
  share_import_id uuid REFERENCES share_imports(id) ON DELETE SET NULL,  -- set for share-sheet uploads
  kind            text NOT NULL CHECK (kind IN ('image','video','file')),
  original_key    text NOT NULL,                    -- MinIO key (content-hashed)
  thumb_key       text,                             -- 512px WebP thumb / video poster
  blurhash        text,                             -- inlined into message DTOs for instant placeholders
  mime            text NOT NULL,                    -- SNIFFED from magic bytes; client claim is advisory
  file_name       text,                             -- original name (sanitized); used in Content-Disposition
  size_bytes      bigint NOT NULL,
  width           int,
  height          int,
  duration_ms     int,                              -- video only (ffprobe)
  status          text NOT NULL DEFAULT 'pending'   -- pending: derived fields in flight (video poster)
                    CHECK (status IN ('pending','ready','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
-- Nightly GC: unbound, un-shared attachments older than 24h (+ their objects).
CREATE INDEX attachments_orphan_idx  ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL;

-- ================================ web push ==================================

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  fail_count      int NOT NULL DEFAULT 0            -- delete at 5 consecutive failures or 404/410
);
CREATE INDEX push_by_user_idx ON push_subscriptions (user_id);

-- ================================ invites ===================================
-- v0.2 invite links (ADR-007, API.md §1.11). token is PLAINTEXT + unique —
-- deliberately not hashed like sessions.token_hash: GET /api/invites must
-- re-display /join/<token>, and the token is a revocable, expiring, use-capped
-- capability, not an auth credential (32 random bytes base64url = 43 chars).
-- status (valid|expired|exhausted|revoked) is DERIVED, never stored; accepts
-- run:  UPDATE invites SET use_count = use_count + 1
--       WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
--         AND use_count < max_uses RETURNING *;   -- 0 rows = not acceptable

CREATE TABLE invites (
  id              uuid PRIMARY KEY,                 -- uuidv7, app-side
  token           text NOT NULL UNIQUE,             -- plaintext capability
  inviter_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
                                                    -- NULL = DM-with-inviter
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  max_uses        int NOT NULL DEFAULT 50 CHECK (max_uses > 0),
  use_count       int NOT NULL DEFAULT 0  CHECK (use_count >= 0),
  revoked_at      timestamptz                       -- DELETE /api/invites/:id
);
CREATE INDEX invites_by_inviter_idx ON invites (inviter_id, created_at DESC);

-- =========================== message reactions ==============================
-- v0.2 (API.md §1.12). Keyed by the messages PK (conversation_id, seq): the
-- composite FK cascades with deletion and the PK prefix serves the per-message
-- GROUP BY emoji aggregate. The 8-distinct-emoji cap per (user, message) is
-- enforced in the route transaction (REACTIONS_PER_USER_PER_MESSAGE_MAX).

CREATE TABLE message_reactions (
  conversation_id uuid   NOT NULL,
  seq             bigint NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji           text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq, user_id, emoji),
  FOREIGN KEY (conversation_id, seq)
    REFERENCES messages (conversation_id, seq) ON DELETE CASCADE
);

-- ======================= v0.3 — beacons + privacy ===========================
-- Migration 0003 (ADR-008 beacons, ADR-009 privacy enforcement). Kept as
-- ALTER + CREATE so this file stays executable top-to-bottom.

-- users: self-declared coarse area (citext ⇒ case-insensitive 'area' beacon
-- matching; PRIVATE — never serialized to other users), plan-karma counters
-- (profile facts, never ranked), and the privacy settings as columns (one row
-- read on the presence/typing/receipt hot paths — the avatar_motion pattern).
-- read_receipts is RECIPROCAL: off hides your reads from everyone AND
-- everyone's reads from you; watermarks still advance (unread counts, push
-- suppression) — only serialization is filtered.
ALTER TABLE users
  ADD COLUMN area                    citext CHECK (char_length(area) <= 64),
  ADD COLUMN beacons_created         int NOT NULL DEFAULT 0 CHECK (beacons_created >= 0),
  ADD COLUMN beacons_sparked         int NOT NULL DEFAULT 0 CHECK (beacons_sparked >= 0),
  ADD COLUMN read_receipts           boolean NOT NULL DEFAULT true,
  ADD COLUMN show_last_seen          text NOT NULL DEFAULT 'everyone'
                                       CHECK (show_last_seen IN ('everyone','dm_partners','nobody')),
  ADD COLUMN show_typing             boolean NOT NULL DEFAULT true,
  ADD COLUMN invites_paused          boolean NOT NULL DEFAULT false,
  ADD COLUMN beacon_default_audience text NOT NULL DEFAULT 'friends'
                                       CHECK (beacon_default_audience IN ('friends','area','public')),
  ADD COLUMN group_add_policy        text NOT NULL DEFAULT 'everyone'
                                       CHECK (group_add_policy IN ('everyone','dm_partners','nobody'));

-- messages: polls ride the seq log as a first-class message type.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','video','file','system','poll'));

-- beacons: "I'm bored — let's plan" (API.md §1.15). spark_threshold counts
-- JOINERS (creator excluded); the spark is atomic in the join transaction
-- (SELECT ... FOR UPDATE + guarded UPDATE ... WHERE status='open'). area is a
-- creator snapshot at mint. Ritual chains: one child per run
-- (ritual_parent_id, partial unique); count counts UP, skips auto-pause the
-- chain at 2 with zero guilt copy.
CREATE TABLE beacons (
  id               uuid PRIMARY KEY,
  creator_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vibe             text NOT NULL
                     CHECK (vibe IN ('food','chai','walk','game','movie','study','sport','chill')),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 140),
  audience         text NOT NULL CHECK (audience IN ('friends','area','public')),
  area             citext,
  starts_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  spark_threshold  int NOT NULL DEFAULT 2 CHECK (spark_threshold BETWEEN 2 AND 10),
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','sparked','expired','cancelled')),
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  repinged_at      timestamptz,
  ritual_rrule     text CHECK (ritual_rrule = 'FREQ=WEEKLY'),
  ritual_count     int NOT NULL DEFAULT 0 CHECK (ritual_count >= 0),
  ritual_skips     int NOT NULL DEFAULT 0 CHECK (ritual_skips >= 0),
  ritual_parent_id uuid REFERENCES beacons(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beacons_window_check CHECK (expires_at > starts_at),
  CONSTRAINT beacons_area_audience_check CHECK (audience <> 'area' OR area IS NOT NULL),
  CONSTRAINT beacons_conversation_sparked_check
    CHECK (conversation_id IS NULL OR status = 'sparked')
);
CREATE INDEX beacons_creator_idx     ON beacons (creator_id, created_at DESC);
CREATE INDEX beacons_open_expiry_idx ON beacons (expires_at) WHERE status = 'open';
CREATE INDEX beacons_afterglow_idx   ON beacons (expires_at) WHERE status = 'sparked';
CREATE INDEX beacons_area_idx        ON beacons (area)       WHERE status = 'open' AND audience = 'area';
CREATE INDEX beacons_ritual_due_idx  ON beacons (starts_at)  WHERE ritual_rrule IS NOT NULL;
CREATE UNIQUE INDEX beacons_ritual_parent_idx ON beacons (ritual_parent_id)
  WHERE ritual_parent_id IS NOT NULL;

CREATE TABLE beacon_joins (
  beacon_id  uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (beacon_id, user_id)
);
CREATE INDEX beacon_joins_by_user_idx ON beacon_joins (user_id);

-- Named micro-roles on the plan card; full-list fan-out via plan.updated.
CREATE TABLE beacon_roles (
  id          uuid PRIMARY KEY,
  beacon_id   uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  done        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX beacon_roles_by_beacon_idx ON beacon_roles (beacon_id, created_at);

-- Private kudos: recipient-only delivery, PK-idempotent, never public counts.
CREATE TABLE beacon_kudos (
  beacon_id    uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('glad_you_came','glad_you_posted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (beacon_id, from_user_id, to_user_id),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX beacon_kudos_to_idx ON beacon_kudos (to_user_id);

-- polls: identity = the messages PK (conversation_id, seq), like reactions.
CREATE TABLE polls (
  id              uuid PRIMARY KEY,
  conversation_id uuid   NOT NULL,
  seq             bigint NOT NULL,
  question        text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),
  options         jsonb NOT NULL
                    CHECK (jsonb_typeof(options) = 'array'
                           AND jsonb_array_length(options) BETWEEN 2 AND 6),
  closes_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id, seq)
    REFERENCES messages (conversation_id, seq) ON DELETE CASCADE
);

CREATE TABLE poll_votes (
  poll_id    uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_idx int NOT NULL CHECK (option_idx >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)                     -- revoting replaces (UPSERT)
);

-- blocks: mutual invisibility; enforcement 404-shaped (API.md §1.14).
CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_by_blocked_idx ON blocks (blocked_id);

-- reports: audit log; targets carry NO FKs so rows survive target deletion.
CREATE TABLE reports (
  id                     uuid PRIMARY KEY,
  reporter_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('user','message','beacon')),
  target_user_id         uuid,
  target_conversation_id uuid,
  target_seq             bigint,
  target_beacon_id       uuid,
  reason                 text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_target_check CHECK (
    (kind = 'user'    AND target_user_id IS NOT NULL
       AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL) OR
    (kind = 'message' AND target_conversation_id IS NOT NULL AND target_seq IS NOT NULL
       AND target_user_id IS NULL AND target_beacon_id IS NULL) OR
    (kind = 'beacon'  AND target_beacon_id IS NOT NULL
       AND target_user_id IS NULL AND target_conversation_id IS NULL AND target_seq IS NULL)
  )
);
CREATE INDEX reports_queue_idx ON reports (status, created_at DESC);

-- ======================= v0.4 — expression pack ==============================
-- (migration 0004; ADR-010; API.md §1.19–§1.27; FEATURES #31–#38)

-- messages: new client-visible types — 'audio' voice notes (§1.20),
-- 'vibe_check' prompts (§1.23, replies carry metadata.vibe_reply_seq),
-- 'game_ttt' (state in metadata.game, §1.27), 'puzzle_result' (server-built
-- no-spoiler grid, §1.27).
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','video','file','system','poll',
                  'audio','vibe_check','game_ttt','puzzle_result'));

-- metadata.effect pinned to MESSAGE_EFFECTS (§1.22; suggest-only client
-- consent rule — the server never injects an effect).
ALTER TABLE messages ADD CONSTRAINT messages_metadata_effect_check
  CHECK (NOT (metadata ? 'effect')
         OR metadata->>'effect' IN ('confetti','hearts','fireworks','snow'));

-- message_reactions: avatar stamps (§1.19). kind='stamp' rows hold the
-- ':stamp:' sentinel in emoji, so the existing PK enforces one stamp per user
-- per message; the 8-distinct route cap counts kind='emoji' rows only.
ALTER TABLE message_reactions
  ADD COLUMN kind text NOT NULL DEFAULT 'emoji'
    CHECK (kind IN ('emoji','stamp'));
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_stamp_key_check
  CHECK ((kind = 'stamp') = (emoji = ':stamp:'));

-- scheduled messages & time capsules (§1.26). Delivery = worker queue `timers`
-- (delayed job per row + minute sweep over scheduled_due_idx); the claim is a
-- guarded UPDATE ... WHERE status='pending' inside the same transaction as the
-- real message insert, so retries/races can never double-deliver. A time
-- capsule is the same row with metadata.capsule = true.
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

-- attachments: 'audio' kind + worker-computed waveform (§1.20); a binding to a
-- pending scheduled message shields the row from the orphan GC.
ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('image','video','file','audio'));
ALTER TABLE attachments
  ADD COLUMN waveform jsonb
    CHECK (waveform IS NULL
           OR (jsonb_typeof(waveform) = 'array'
               AND jsonb_array_length(waveform) = 48));          -- AUDIO_WAVEFORM_BUCKETS
ALTER TABLE attachments
  ADD COLUMN scheduled_message_id uuid
    REFERENCES scheduled_messages(id) ON DELETE SET NULL;
DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL
    AND scheduled_message_id IS NULL;

-- conversations: disappearing-messages TTL (§1.25). NULL = off. The worker
-- sweep (queue `timers`, every minute) TOMBSTONES expired rows — deleted_at
-- set, body NULLed, metadata emptied, attachments + dependent reaction/poll
-- rows removed — and NEVER deletes the message row: seqs are never reused.
-- System messages are exempt.
ALTER TABLE conversations
  ADD COLUMN disappear_ttl_s int
    CHECK (disappear_ttl_s IN (3600, 86400, 604800, 2592000));   -- DISAPPEAR_TTL_OPTIONS_S
CREATE INDEX conversations_disappearing_idx
  ON conversations (id) WHERE disappear_ttl_s IS NOT NULL;       -- sweep's outer loop
CREATE INDEX messages_disappear_sweep_idx
  ON messages (conversation_id, created_at)
  WHERE deleted_at IS NULL AND type <> 'system';                 -- sweep's inner walk

-- chat prefs: themes, wallpapers, nicknames (§1.24). ALL PERSONAL: per
-- (conversation, user), serialized to that user only, synced via prefs.updated
-- (own sockets). Fixed sets; NO wallpaper uploads in v0.4. NULL = app default.
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

-- Nickname map: the owner's private labels for members of one conversation
-- (self-nicknames allowed). Never serialized to anyone but the owner.
CREATE TABLE member_nicknames (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname        text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 32),  -- NICKNAME_MAX_CHARS
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, owner_id, target_id)
);

-- daily word puzzle attempts (§1.27). One row per (user, UTC day); the day's
-- word is NEVER stored — recomputed from PUZZLE_WORDLIST + env PUZZLE_SECRET.
-- NO leaderboard, NO rankings, NO streaks, ever (PSYCHOLOGY never-build list).
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
