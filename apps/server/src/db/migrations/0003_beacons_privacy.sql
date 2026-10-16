-- 0003_beacons_privacy — v0.3: beacons + plan roles + polls + privacy
-- settings + blocks + reports (ADR-008, ADR-009; API.md §1.13–§1.18).
-- Mirrors docs/SCHEMA.sql; Drizzle twin in src/db/schema.ts.

-- ===================== users: area, karma, privacy settings =================
-- Settings are columns on users, not a settings table: one row read on the
-- presence/typing/receipt hot paths, same pattern as avatar_motion (ADR-009).
-- area is citext so 'area' beacon visibility is case-insensitive equality for
-- free. It is self-declared, coarse, nullable, and PRIVATE (UserPrivate only —
-- never serialized to other users; FEATURES #30).
-- beacons_created / beacons_sparked are the plan-karma counters (UserPublic):
-- profile facts, never ranked or compared (PSYCHOLOGY design rule 3).

ALTER TABLE users
  ADD COLUMN area                    citext CHECK (char_length(area) <= 64),  -- AREA_MAX_CHARS
  ADD COLUMN beacons_created         int NOT NULL DEFAULT 0 CHECK (beacons_created >= 0),
  ADD COLUMN beacons_sparked         int NOT NULL DEFAULT 0 CHECK (beacons_sparked >= 0),
  -- RECIPROCAL: off hides your reads from everyone AND everyone's reads from
  -- you. Watermarks still advance (unread counts, push suppression) — only
  -- SERIALIZATION is filtered (ADR-009).
  ADD COLUMN read_receipts           boolean NOT NULL DEFAULT true,
  ADD COLUMN show_last_seen          text NOT NULL DEFAULT 'everyone'
                                       CHECK (show_last_seen IN ('everyone','dm_partners','nobody')),
  ADD COLUMN show_typing             boolean NOT NULL DEFAULT true,
  ADD COLUMN invites_paused          boolean NOT NULL DEFAULT false,
  ADD COLUMN beacon_default_audience text NOT NULL DEFAULT 'friends'
                                       CHECK (beacon_default_audience IN ('friends','area','public')),
  ADD COLUMN group_add_policy        text NOT NULL DEFAULT 'everyone'
                                       CHECK (group_add_policy IN ('everyone','dm_partners','nobody'));

-- ===================== messages: 'poll' message type ========================
-- A poll IS a message (rides the gapless seq log); the poll row hangs off the
-- message identity (conversation_id, seq) below.

ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','video','file','system','poll'));

-- ================================ beacons ===================================
-- "I'm bored — let's plan" (ADR-008). Audience resolution at fan-out/read time:
--   friends = users sharing a DM conversation with the creator (both active);
--   area    = users whose users.area = beacons.area (citext equality; area is
--             SNAPSHOTTED from the creator at mint so the audience cannot
--             drift if the creator moves);
--   public  = every user;
--   always minus blocks (either direction, viewer <-> creator).
-- spark_threshold counts JOINERS (creator excluded). The spark is atomic
-- inside the join transaction:
--   SELECT * FROM beacons WHERE id = $1 FOR UPDATE;      -- stable count
--   INSERT INTO beacon_joins ... ON CONFLICT DO NOTHING; -- idempotent join
--   -- if join count >= spark_threshold: create the plan group conversation
--   -- (creator admin + all joiners), icebreaker system message, venue poll,
--   -- then the guarded flip (0 rows = someone else sparked it — impossible
--   -- under the row lock, kept as belt-and-braces):
--   UPDATE beacons SET status = 'sparked', conversation_id = $c
--     WHERE id = $1 AND status = 'open';
-- Ritual chain: each weekly run is a NEW row linked by ritual_parent_id (at
-- most one child per parent — partial unique index). ritual_count counts UP
-- (sparked runs — "12 chai nights"); ritual_skips counts consecutive unsparked
-- runs; at RITUAL_AUTO_PAUSE_SKIPS (2) the worker silently stops re-creating.

CREATE TABLE beacons (
  id               uuid PRIMARY KEY,                 -- uuidv7, app-side
  creator_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vibe             text NOT NULL                     -- BEACON_VIBES chip set
                     CHECK (vibe IN ('food','chai','walk','game','movie','study','sport','chill')),
  note             text NOT NULL DEFAULT ''
                     CHECK (char_length(note) <= 140),  -- BEACON_NOTE_MAX_CHARS
  audience         text NOT NULL CHECK (audience IN ('friends','area','public')),
  area             citext,                           -- creator-area snapshot; required iff audience='area'
  starts_at        timestamptz NOT NULL,             -- client-computed from now/tonight/weekend presets
  expires_at       timestamptz NOT NULL,
  spark_threshold  int NOT NULL DEFAULT 2
                     CHECK (spark_threshold BETWEEN 2 AND 10),
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','sparked','expired','cancelled')),
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  repinged_at      timestamptz,                      -- "needs 1 more" re-ping: at most once per beacon
  ritual_rrule     text CHECK (ritual_rrule = 'FREQ=WEEKLY'),  -- RITUAL_RRULE_WEEKLY; weekly only for now
  ritual_count     int NOT NULL DEFAULT 0 CHECK (ritual_count >= 0),
  ritual_skips     int NOT NULL DEFAULT 0 CHECK (ritual_skips >= 0),
  ritual_parent_id uuid REFERENCES beacons(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beacons_window_check CHECK (expires_at > starts_at),
  CONSTRAINT beacons_area_audience_check CHECK (audience <> 'area' OR area IS NOT NULL),
  -- One-directional: a conversation link implies sparked (the reverse would
  -- break under ON DELETE SET NULL if a plan conversation is ever removed).
  CONSTRAINT beacons_conversation_sparked_check
    CHECK (conversation_id IS NULL OR status = 'sparked')
);
CREATE INDEX beacons_creator_idx       ON beacons (creator_id, created_at DESC);
CREATE INDEX beacons_open_expiry_idx   ON beacons (expires_at) WHERE status = 'open';      -- expiry sweep + active lists
CREATE INDEX beacons_afterglow_idx     ON beacons (expires_at) WHERE status = 'sparked';   -- afterglow safety sweep
CREATE INDEX beacons_area_idx          ON beacons (area)       WHERE status = 'open' AND audience = 'area';
CREATE INDEX beacons_ritual_due_idx    ON beacons (starts_at)  WHERE ritual_rrule IS NOT NULL;
CREATE UNIQUE INDEX beacons_ritual_parent_idx ON beacons (ritual_parent_id)
  WHERE ritual_parent_id IS NOT NULL;                -- at most one next run per ritual beacon

CREATE TABLE beacon_joins (
  beacon_id  uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (beacon_id, user_id)
);
CREATE INDEX beacon_joins_by_user_idx ON beacon_joins (user_id);

-- Named micro-roles on the plan card (PSYCHOLOGY §4 — visible contributions,
-- never anonymous pooling). Mutations fan out the FULL list via plan.updated.
CREATE TABLE beacon_roles (
  id          uuid PRIMARY KEY,
  beacon_id   uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),  -- BEACON_ROLE_LABEL_MAX_CHARS
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  done        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX beacon_roles_by_beacon_idx ON beacon_roles (beacon_id, created_at);

-- Private "glad you came / glad you posted" (PSYCHOLOGY §9 liking gap).
-- One kudos per (beacon, sender, recipient) — the PK makes re-sends
-- idempotent. Delivered to the recipient ONLY; never aggregated publicly.
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

-- ================================= polls ====================================
-- A poll is a message (type 'poll'); identity is the messages PK
-- (conversation_id, seq) so the composite FK cascades with deletion — the
-- message_reactions pattern. Votes UPSERT on (poll_id, user_id): revoting
-- replaces. option_idx < jsonb_array_length(options) is route-enforced
-- (400 bad_option), as is closes_at (409 poll_closed).

CREATE TABLE polls (
  id              uuid PRIMARY KEY,
  conversation_id uuid   NOT NULL,
  seq             bigint NOT NULL,                   -- the message the poll rides on
  question        text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),  -- POLL_QUESTION_MAX_CHARS
  options         jsonb NOT NULL                     -- array of 2..6 option strings
                    CHECK (jsonb_typeof(options) = 'array'
                           AND jsonb_array_length(options) BETWEEN 2 AND 6),
  closes_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),                     -- one poll per message
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

-- ================================= blocks ===================================
-- Mutual invisibility (ADR-009). Enforcement is 404-SHAPED wherever a 403
-- would confirm the block exists; the full per-surface table is API.md §1.14.

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_by_blocked_idx ON blocks (blocked_id);

-- ================================ reports ===================================
-- Audit log for the future admin dashboard (FEATURES #54). Targets carry NO
-- foreign keys on purpose: a report must survive deletion of what it reports
-- (and of the reported user's content). Message identity is the usual
-- (conversation_id, seq) pair. Exactly one target shape per kind (CHECK).

CREATE TABLE reports (
  id                     uuid PRIMARY KEY,
  reporter_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('user','message','beacon')),
  target_user_id         uuid,
  target_conversation_id uuid,
  target_seq             bigint,
  target_beacon_id       uuid,
  reason                 text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),  -- REPORT_REASON_MAX_CHARS
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
