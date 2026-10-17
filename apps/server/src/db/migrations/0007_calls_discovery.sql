-- 0007_calls_discovery — v0.6: calls + discovery (ADR-014/ADR-015; API.md
-- §1.42–§1.46 + §2.12; FEATURES #49–#53). The calls LOG, discovery opt-ins +
-- waves, the private expectation-feedback taps (PSYCHOLOGY finding #10), and
-- the conversation columns roulette's provisional DMs need. Mirrors nothing
-- new in docs/SCHEMA.sql (frozen at v0.4, like 0005/0006); Drizzle twin in
-- src/db/schema.ts.
--
-- HARD RULES carried by this schema: call SIGNALING is never persisted (no
-- sdp/candidate columns exist anywhere — only the call-log row is durable;
-- live mesh membership is Redis state, ADR-014); a single wave notifies
-- nobody (waves have no read model for their target — ADR-015); roulette DMs
-- that are not kept are HARD-DELETED (conversations.expires_at + the sweep —
-- messages cascade, no archive of awkward dead ends); expectation feedback is
-- PRIVATE (only the anonymous instance aggregate is ever serialized). Watch
-- together and the roulette queue are Redis-only — no tables here. Rescue me
-- is ordinary DMs + messages + a Redis rate window — no table either.

-- ============================ calls (§1.42) ==================================
-- The durable call row: who called whom, when, how it ended — the call log
-- and the §2.12 authorization anchor (signaling frames must name a live call
-- the sender belongs to). Everything live (mesh member set, per-peer state)
-- is Redis (`call:{id}:members`); on any terminal status the set is deleted.
-- initiator_id SET NULL (the messages.sender_id pattern): the log outlives
-- the account. answered_at is the first successful join; ended_at is set on
-- every terminal status. is_group is a SNAPSHOT of the conversation type at
-- start (a DM can never become a group, but the column keeps the log
-- self-describing). Status reachability:
--   ringing  → ongoing (first join) | rejected (DM callee reject)
--            | missed (ring timeout / initiator hang-up before answer)
--   ongoing  → completed (last member leaves or an end) | failed (end with
--              reason 'failed' — media never (re)connected)

CREATE TABLE calls (
  id              uuid PRIMARY KEY,                   -- uuidv7, app-side
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('audio','video')),      -- CALL_KINDS
  is_group        boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'ringing'
                    CHECK (status IN ('ringing','ongoing','completed',
                                      'missed','rejected','failed')),   -- CALL_STATUSES
  started_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  -- Terminal states carry ended_at; live states don't.
  CONSTRAINT calls_ended_shape_check
    CHECK ((status IN ('ringing','ongoing')) = (ended_at IS NULL)),
  -- An answered call was answered; completed/failed require it, ringing
  -- forbids it (missed/rejected never answered by construction).
  CONSTRAINT calls_answered_shape_check CHECK (
    (status IN ('ringing','missed','rejected') AND answered_at IS NULL)
    OR (status IN ('ongoing','completed','failed') AND answered_at IS NOT NULL)
  )
);
-- ONE live call per conversation (the §1.42 409 call_active guard) — claimed
-- atomically by the INSERT, exactly like dm_key dedupes DMs.
CREATE UNIQUE INDEX calls_live_idx ON calls (conversation_id)
  WHERE status IN ('ringing','ongoing');
-- The per-conversation call log read (GET /api/conversations/:id/calls).
CREATE INDEX calls_by_conversation_idx ON calls (conversation_id, started_at DESC);
-- Ring-timeout safety sweep (the delayed `timers` job is primary; the sweep
-- catches jobs lost to a Redis wipe — the beacons afterglow pattern).
CREATE INDEX calls_ringing_idx ON calls (started_at) WHERE status = 'ringing';

-- ================ conversations: roulette provisional DMs (§1.45) ============
-- metadata is the house jsonb rider (messages.metadata pattern): the shape
-- authority is the shared Zod contract, the DB pins only the json type.
-- Today it holds the roulette state — {"origin":"roulette","roulette":
-- {"kept_by":[user_id,...]}} while provisional, {"origin":"roulette"} once
-- kept — and {"origin":"discovery"} on mutual-wave DMs (§1.44). expires_at is
-- a COLUMN (not buried in jsonb) because the sweep walks an index over it;
-- non-null means "this conversation self-destructs": the sweep HARD-DELETES
-- the row (messages, participants, receipts cascade). Keeping clears it in
-- the same guarded UPDATE that clears the roulette metadata.

ALTER TABLE conversations
  ADD COLUMN metadata   jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT conversations_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  ADD COLUMN expires_at timestamptz;

CREATE INDEX conversations_expiry_idx ON conversations (expires_at)
  WHERE expires_at IS NOT NULL;

-- ======================= discovery opt-ins (§1.44) ===========================
-- Being discoverable is a MOMENT, not a setting (ADR-015): one row per user
-- (PK), upserted by PUT /api/discovery/optin with expires_at = now() + 60 min
-- (DISCOVERY_OPTIN_TTL_S); every read joins `expires_at > now()` live, so
-- lapsing requires no sweep precision (the `discovery` worker sweep only
-- prunes dead rows + their waves). scope 'area' additionally requires the
-- user's users.area to be set (route-enforced; the card never prints the
-- area text — matching is server-side citext equality, FEATURES #30).

CREATE TABLE discovery_optins (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('area','public')),   -- DISCOVERY_SCOPES
  note       text NOT NULL DEFAULT ''
               CHECK (char_length(note) <= 80),                  -- DISCOVERY_NOTE_MAX_CHARS
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
-- Card reads filter live rows; the sweep walks expired ones.
CREATE INDEX discovery_optins_expiry_idx ON discovery_optins (expires_at);

-- ========================= discovery waves (§1.44) ===========================
-- One row per (waver, target). DELIBERATELY NO read model for the target: a
-- single wave notifies NOBODY and is queryable by NOBODY but the matcher
-- transaction — no FoMO, no rejection surface (ADR-015; the PSYCHOLOGY
-- never-build list). Mutuality check is a PK lookup of the reciprocal row
-- inside the wave transaction; on match BOTH rows are deleted and the DM is
-- created. A wave is only honored while BOTH parties' opt-ins are live
-- (route-joined); the sweep deletes rows older than DISCOVERY_OPTIN_TTL_S —
-- a wave can never outlive the moment it was made in.

CREATE TABLE discovery_waves (
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_user_id, to_user_id),
  CONSTRAINT discovery_waves_not_self_check CHECK (from_user_id <> to_user_id)
);
-- Sweep walk (stale waves) — mutuality lookups are PK hits both directions.
CREATE INDEX discovery_waves_sweep_idx ON discovery_waves (created_at);

-- ===================== expectation feedback (§1.45) ==========================
-- PSYCHOLOGY finding #10: people underestimate how pleasant strangers are.
-- The PRIVATE better/worse-than-expected one-tap after a roulette/discovery
-- DM ends or persists. conversation_id is a plain uuid (NO FK, unique per
-- user): expired roulette DMs are hard-deleted, and the tap often lands right
-- after that deletion — the id is a dedupe key, not a reference. NOTHING
-- here is ever serialized per-person: the only read is the anonymous
-- instance-wide aggregate (GET /api/discovery/encouragement), shown
-- pre-opt-in to hesitant users and null under ENCOURAGEMENT_MIN_SAMPLES.

CREATE TABLE expectation_feedback (
  id              uuid PRIMARY KEY,                   -- uuidv7, app-side
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,                      -- dedupe key, NOT an FK
  context         text NOT NULL CHECK (context IN ('roulette','discovery')),  -- EXPECTATION_CONTEXTS
  verdict         text NOT NULL CHECK (verdict IN ('better','same','worse')), -- EXPECTATION_VERDICTS
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expectation_feedback_once UNIQUE (user_id, conversation_id)
);
-- The aggregate count (verdict tallies, optionally per context).
CREATE INDEX expectation_feedback_aggregate_idx ON expectation_feedback (context, verdict);
