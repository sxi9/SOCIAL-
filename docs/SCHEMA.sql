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
