-- 0005_social — v0.5a: social layer (ADR-011; API.md §1.28–§1.37;
-- FEATURES #46–#48). Connections, threads/replies, edit/delete, forwarding,
-- pins, @mentions, stories (24 h), broadcast channels, the finite feed
-- (posts/reactions/comments), rich profiles.
-- Mirrors docs/SCHEMA.sql; Drizzle twin in src/db/schema.ts.

-- ===================== conversations: 'channel' type (§1.35) ================
-- Channels: creator = 'owner' (one per channel), owner/admins send, everyone
-- reads + reacts. Cap CHANNEL_MAX=10000 (route-enforced) — watermark receipts
-- are the entire reason this is safe (ADR-002: one cursor row per member,
-- O(participants), never O(messages × participants)). Joining is the existing
-- §1.11 invite system with a channel conversation_id; join_seq = last_seq
-- keeps the standard history floor (ARCHITECTURE §8). Typing is suppressed in
-- channels at the gateway; seen-by is never exposed (watermarks still drive
-- unread counts). NO member count is ever serialized (PSYCHOLOGY rule 3:
-- no follower counts).

ALTER TABLE conversations DROP CONSTRAINT conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('dm','group','channel'));

-- The 0000 role CHECK was inline/unnamed, so Postgres auto-named it
-- conversation_participants_role_check; re-add under the schema.ts name.
ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS conversation_participants_role_check;
ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS participants_role_check;
ALTER TABLE conversation_participants ADD CONSTRAINT participants_role_check
  CHECK (role IN ('member','admin','owner'));

-- ========================= connections (§1.28) ==============================
-- The social graph edge. Unordered pair unique (one row per pair, whoever
-- asked); status 'pending' until the addressee accepts. Decline DELETES the
-- row (re-requests possible; the requester is never notified — no rejection
-- ping). Blocked pairs cannot connect (404-shaped, §1.14); a block also
-- deletes any pending request between the pair and makes an accepted
-- connection DORMANT (excluded from friends-of at read time; the row
-- survives, like shared groups — §1.14 "does not delete history").
-- FRIENDS-OF (the v0.5a audience primitive) = accepted connections UNION
-- dm-partners, minus blocks — resolved at read/fan-out time, never stored.

CREATE TABLE connections (
  id           uuid PRIMARY KEY,                     -- uuidv7, app-side
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT connections_not_self_check CHECK (requester_id <> addressee_id),
  CONSTRAINT connections_responded_shape_check
    CHECK ((status = 'accepted') = (responded_at IS NOT NULL))
);
-- One row per unordered pair, whichever side asked first.
CREATE UNIQUE INDEX connections_pair_idx
  ON connections (LEAST(requester_id, addressee_id),
                  GREATEST(requester_id, addressee_id));
CREATE INDEX connections_by_requester_idx ON connections (requester_id, status);
CREATE INDEX connections_by_addressee_idx ON connections (addressee_id, status);

-- ================== messages: replies, mentions, forwards (§1.29–§1.33) =====
-- reply_to_seq names an EARLIER message in the SAME conversation by the seq
-- identity everything else already uses (reactions, polls, reports) — the
-- v0.1 reply_to_id column is retired (kept, always NULL from v0.5a on).
-- The composite FK only ever cascades on whole-conversation deletion:
-- individual messages are tombstoned, never deleted (ADR-003), so a reply's
-- target row always exists — its reply_context just renders deleted:true.
-- metadata.mentions (user id array) and metadata.forwarded_from ({username,
-- display_name} snapshot) are SERVER-written jsonb riders — Zod + route
-- enforce their shapes (the house jsonb-metadata pattern, migration 0004).

ALTER TABLE messages
  ADD COLUMN reply_to_seq bigint
    CHECK (reply_to_seq IS NULL OR (reply_to_seq > 0 AND reply_to_seq < seq));
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_fk
  FOREIGN KEY (conversation_id, reply_to_seq)
  REFERENCES messages (conversation_id, seq) ON DELETE CASCADE;

-- ======================== conversation pins (§1.32) =========================
-- ≤ MAX_PINS=10 per conversation (route-enforced under the conversation row
-- lock → 409 pin_limit). DM: any active participant pins; group: admins;
-- channel: owner/admins. Keyed by the message identity; tombstoning a pinned
-- message (delete or §1.25 sweep) removes its pin row in the same
-- transaction. Fan-out: conv.updated (pins ride the Conversation DTO).

CREATE TABLE conversation_pins (
  conversation_id uuid NOT NULL,
  seq             bigint NOT NULL,
  pinned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq),
  CONSTRAINT conversation_pins_message_fk
    FOREIGN KEY (conversation_id, seq)
    REFERENCES messages (conversation_id, seq) ON DELETE CASCADE
);

-- ============================ stories (§1.34) ===============================
-- 24 h ephemera reusing the §1.6 upload pipeline. audience is CHECK-pinned to
-- the single value 'friends_of' (= accepted connections ∪ dm-partners, minus
-- blocks — resolved at read/fan-out time): one value today, enum stable for
-- later options. Expired stories are HARD-deleted by the worker sweep (queue
-- `timers`, STORY_SWEEP_INTERVAL_S): story rows, view rows (cascade), the
-- attachment row AND its MinIO objects — object deletion is refcount-guarded
-- (see attachments note below). Stories never ride the seq log.

CREATE TABLE stories (
  id            uuid PRIMARY KEY,                    -- uuidv7, app-side
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  caption       text NOT NULL DEFAULT ''
                  CHECK (char_length(caption) <= 140),   -- STORY_CAPTION_MAX_CHARS
  audience      text NOT NULL DEFAULT 'friends_of'
                  CHECK (audience IN ('friends_of')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'  -- STORY_TTL_S
);
CREATE INDEX stories_by_author_idx ON stories (author_id, created_at);
CREATE INDEX stories_expiry_idx ON stories (expires_at);          -- expiry sweep
CREATE INDEX stories_attachment_idx ON stories (attachment_id);   -- orphan-GC guard

-- Who viewed which story. DELIBERATELY NO TIMESTAMP COLUMN: the DB cannot
-- leak what it does not store — view lists are faces ordered by username,
-- "seen X min ago" is on the PSYCHOLOGY never-build list (the §1.18 seen-by
-- pattern, FEATURES #27). Author-private; the author's own view is never
-- recorded. Mirrors the watermark-receipts philosophy (ADR-002).

CREATE TABLE story_views (
  story_id  uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, viewer_id)
);

-- ========================== feed: posts (§1.36) =============================
-- The FINITE feed: posts by my friends-of set + me, newest first, cursor-
-- paginated to a HARD all_caught_up end — no wraparound, no ranking, no
-- share/repost mechanic (PSYCHOLOGY design rule 5). attachment_ids keeps the
-- author's ordering; the binding/GC shield is attachments.post_id (below).

CREATE TABLE posts (
  id             uuid PRIMARY KEY,                   -- uuidv7, app-side
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           text NOT NULL DEFAULT ''
                   CHECK (char_length(body) <= 2000),    -- POST_BODY_MAX_CHARS
  attachment_ids jsonb NOT NULL DEFAULT '[]'
                   CHECK (jsonb_typeof(attachment_ids) = 'array'
                          AND jsonb_array_length(attachment_ids) <= 4),  -- POST_MAX_ATTACHMENTS
  audience       text NOT NULL DEFAULT 'friends_of'
                   CHECK (audience IN ('friends_of')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_by_author_idx ON posts (author_id, created_at DESC);  -- feed assembly

-- Reactions render as NAMED FACES: the DTO carries the first 12 reactors as
-- UserLite + has_more — never a numeric total (PSYCHOLOGY rule 3). created_at
-- orders the face row (first-reaction order) and is never serialized.
-- 8-distinct-emoji cap per user per post (REACTIONS_PER_USER_PER_POST_MAX)
-- is enforced in the route transaction, like message reactions.

CREATE TABLE post_reactions (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),  -- REACTION_EMOJI_MAX_LEN
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE TABLE post_comments (
  id         uuid PRIMARY KEY,                       -- uuidv7, app-side
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),  -- POST_COMMENT_MAX_CHARS
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_comments_by_post_idx ON post_comments (post_id, created_at);

-- ============== attachments: post binding + re-referencing (§1.31/§1.36) ====
-- post_id is the binding/GC shield for feed attachments (the message_id /
-- scheduled_message_id pattern). Stories and profile media bind through their
-- own tables (stories.attachment_id, profile_media.attachment_id) — the GC
-- worker's delete adds cheap indexed NOT EXISTS guards over both, so the
-- partial index below stays the CANDIDATE list, not the final verdict.
--
-- RE-REFERENCING RULE (new in v0.5a, binding): forwarding (§1.31) and
-- share-recap-to-story (§1.34) create NEW attachment rows pointing at the
-- SAME content-hashed MinIO objects — never re-uploads. Therefore EVERY MinIO
-- object deletion (tombstones, story expiry, post/story deletes, orphan GC)
-- must first check that no other attachment row references the same
-- original_key/thumb_key (the refcount guard). Content-hash keys make this
-- one indexed lookup.

CREATE INDEX attachments_original_key_idx ON attachments (original_key);

ALTER TABLE attachments
  ADD COLUMN post_id uuid REFERENCES posts(id) ON DELETE SET NULL;

DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL
    AND scheduled_message_id IS NULL AND post_id IS NULL;

-- ======================= rich profiles (§1.37) ==============================
-- users.interests: ≤ 10 tags (array cardinality CHECKed here; the ≤ 24-char
-- per-tag bound is Zod/route-enforced — element-length CHECKs don't fit the
-- house one-line style). Serialized on the profile page response only, never
-- into participant lists.

ALTER TABLE users
  ADD COLUMN interests text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(interests) <= 10);                 -- INTERESTS_MAX

-- Work/skill portfolio rows. PATCH /users/me/profile full-replaces the set in
-- one transaction (delete + insert, order_idx = array order), so no partial
-- states and no per-row endpoints.

CREATE TABLE profile_entries (
  id         uuid PRIMARY KEY,                        -- uuidv7, app-side
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('work','skill')),
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),   -- PROFILE_ENTRY_TITLE_MAX_CHARS
  detail     text NOT NULL DEFAULT ''
               CHECK (char_length(detail) <= 160),        -- PROFILE_ENTRY_DETAIL_MAX_CHARS
  order_idx  int  NOT NULL CHECK (order_idx >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, order_idx)
);

-- The 3-GIF strip: ≤ 3 image attachments (GIFs upload as images), ordered.
-- Full-replace semantics like entries; unbound attachments fall to orphan GC.

CREATE TABLE profile_media (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  order_idx     int  NOT NULL CHECK (order_idx BETWEEN 0 AND 2),  -- PROFILE_MEDIA_MAX
  PRIMARY KEY (user_id, order_idx)
);
CREATE INDEX profile_media_attachment_idx ON profile_media (attachment_id);  -- orphan-GC guard
