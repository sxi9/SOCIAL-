-- 0000_init — mirrors docs/SCHEMA.sql exactly (PostgreSQL 17).

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================== identity ====================================

CREATE TABLE users (
  id                  uuid PRIMARY KEY,
  username            citext NOT NULL UNIQUE,
  email               citext NOT NULL UNIQUE,
  email_verified_at   timestamptz,
  password_hash       text NOT NULL,
  display_name        text NOT NULL,
  bio                 text NOT NULL DEFAULT '',
  avatar_status       text NOT NULL DEFAULT 'none'
                        CHECK (avatar_status IN ('none','processing','ready','failed')),
  avatar_static_key   text,
  avatar_animated_key text,
  avatar_version      int NOT NULL DEFAULT 0,
  avatar_motion       text NOT NULL DEFAULT 'auto'
                        CHECK (avatar_motion IN ('auto','reduced','off')),
  last_seen_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expired_idx ON sessions (expires_at);

-- ============================ conversations =================================

CREATE TABLE conversations (
  id                  uuid PRIMARY KEY,
  type                text NOT NULL CHECK (type IN ('dm','group')),
  title               text,
  avatar_status       text NOT NULL DEFAULT 'none'
                        CHECK (avatar_status IN ('none','processing','ready','failed')),
  avatar_static_key   text,
  avatar_animated_key text,
  avatar_version      int NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  dm_key              text UNIQUE,
  last_seq            bigint NOT NULL DEFAULT 0,
  last_message_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'dm') = (dm_key IS NOT NULL))
);
CREATE INDEX conversations_activity_idx
  ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_participants (
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at          timestamptz NOT NULL DEFAULT now(),
  join_seq           bigint NOT NULL DEFAULT 0,
  left_at            timestamptz,
  last_delivered_seq bigint NOT NULL DEFAULT 0,
  last_read_seq      bigint NOT NULL DEFAULT 0,
  muted_until        timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX participants_by_user_idx
  ON conversation_participants (user_id) WHERE left_at IS NULL;

-- =============================== messages ===================================

CREATE TABLE messages (
  id              uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL CHECK (seq > 0),
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  client_msg_id   uuid,
  type            text NOT NULL CHECK (type IN ('text','image','video','file','system')),
  body            text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX messages_idempotency_idx
  ON messages (conversation_id, sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

-- ============================ link previews =================================

CREATE TABLE link_previews (
  url_hash    text PRIMARY KEY,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','ok','failed')),
  site_name   text,
  title       text,
  description text,
  image_key   text,
  fetched_at  timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================ share-target inbox ============================

CREATE TABLE share_imports (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text,
  text_body        text,
  url              text,
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
  message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,
  share_import_id uuid REFERENCES share_imports(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('image','video','file')),
  original_key    text NOT NULL,
  thumb_key       text,
  blurhash        text,
  mime            text NOT NULL,
  file_name       text,
  size_bytes      bigint NOT NULL,
  width           int,
  height          int,
  duration_ms     int,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','ready','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
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
  fail_count      int NOT NULL DEFAULT 0
);
CREATE INDEX push_by_user_idx ON push_subscriptions (user_id);
