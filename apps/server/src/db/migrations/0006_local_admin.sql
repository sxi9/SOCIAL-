-- 0006_local_admin — v0.5b: local board + admin (ADR-012/ADR-013; API.md
-- §1.38–§1.41; FEATURES #39–#45 + #54). One listing system with four card
-- kinds, message-the-author contacts, gig team-ups, person reviews (the
-- marketplace trust layer), and the operator admin surface (admin flag,
-- suspend/ban, registration IP + retention, report-queue columns, instance
-- settings). Mirrors nothing new in docs/SCHEMA.sql (frozen at v0.4, like
-- 0005); Drizzle twin in src/db/schema.ts.
--
-- HARD PRODUCT RULES carried by this schema: price columns are DISPLAY TEXT
-- (no payment machinery exists anywhere — FEATURES #45); the board is
-- pull-based (no fan-out state here, deliberately); admin never gets private
-- message content (nothing in this migration stores or indexes bodies for
-- the admin surface).

-- ============================ listings (§1.38) ===============================
-- ONE table, four kinds (gig / ride / room / place_review — FEATURES #39–#42).
-- Per-kind payloads live in `details` jsonb, shape-validated by the shared Zod
-- discriminated union (the house metadata pattern; the DB pins only the json
-- type). `area` is a citext SNAPSHOT of the author's users.area at mint (the
-- beacons.area pattern — the audience cannot drift); visibility = same area
-- OR is_public, minus §1.14 blocks both ways, resolved at read time.
-- Expiry: gig/room = created_at + 30 d (LISTING_TTL_S); ride = the jsonb
-- departs_at copied here at create/edit time so the sweep and board reads
-- never parse jsonb; place_review = never (NULL). Reads filter
-- `expires_at > now()` live — the hourly worker sweep (queue `timers`) only
-- does the status bookkeeping. conversation_id is the gig team-up group,
-- claimed once by a guarded UPDATE ... WHERE conversation_id IS NULL (the
-- beacon-spark pattern; §1.39).

CREATE TABLE listings (
  id              uuid PRIMARY KEY,                   -- uuidv7, app-side
  author_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL
                    CHECK (kind IN ('gig','ride','room','place_review')),  -- LISTING_KINDS
  title           text NOT NULL
                    CHECK (char_length(title) BETWEEN 1 AND 80),   -- LISTING_TITLE_MAX_CHARS
  body            text NOT NULL DEFAULT ''
                    CHECK (char_length(body) <= 2000),             -- LISTING_BODY_MAX_CHARS
  -- DISPLAY TEXT ONLY ("₹2000 / month", "free", "split petrol"): never parsed,
  -- never summed, never charged. Money settles outside the app (FEATURES #45).
  price_text      text CHECK (char_length(price_text) <= 40),      -- LISTING_PRICE_TEXT_MAX_CHARS
  area            citext NOT NULL
                    CHECK (char_length(area) <= 64),               -- AREA_MAX_CHARS
  is_public       boolean NOT NULL DEFAULT false,     -- false = my area only
  details         jsonb NOT NULL DEFAULT '{}'
                    CHECK (jsonb_typeof(details) = 'object'),      -- shape: shared Zod per kind
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','closed','expired')),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,  -- §1.39 team-up group
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  -- Exactly the place_review kind is evergreen.
  CONSTRAINT listings_expiry_shape_check
    CHECK ((kind = 'place_review') = (expires_at IS NULL))
);
-- The board read: my area's active cards, newest first.
CREATE INDEX listings_board_idx ON listings (area, created_at DESC)
  WHERE status = 'active';
-- The is_public arm of visibility (board-wide cards).
CREATE INDEX listings_public_idx ON listings (created_at DESC)
  WHERE status = 'active' AND is_public;
CREATE INDEX listings_by_author_idx ON listings (author_id, created_at DESC);
-- Worker expiry sweep walk (status bookkeeping; reads filter live).
CREATE INDEX listings_expiry_idx ON listings (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

-- ======================= listing contacts (§1.39) ===========================
-- One row per (listing, contacter), written by POST /api/listings/:id/contact
-- in the same transaction as the DM create/dedupe + 'listing_contact' system
-- message. This row is load-bearing three ways: it makes contact idempotent
-- (re-POST returns the DM, no second system message), it is the author's
-- team-up pick pool, and it is THE GATE for §1.40 person reviews ("a contact
-- DM exists between the two, tied to that listing"). conversation_id names
-- the DM for the re-POST fast path; rows cascade with the listing (reviews
-- already written survive — see person_reviews).

CREATE TABLE listing_contacts (
  listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, user_id)
);
CREATE INDEX listing_contacts_by_user_idx ON listing_contacts (user_id);

-- ======================== person reviews (§1.40) ============================
-- The marketplace trust layer (FEATURES #44). A review exists ONLY between
-- the two parties of a listing contact — {reviewer, subject} must equal
-- {listing.author, a listing_contacts.user_id} for that listing, each party
-- reviewing the OTHER (route-enforced; blocked pairs are 404-shaped per
-- §1.14). listing_id is SET NULL on listing deletion, with listing_kind
-- SNAPSHOTTED here, because trust data must survive its subject matter (the
-- reports-table precedent): a cascading FK would let an author purge bad
-- reviews by deleting the listing. The uniqueness guard is therefore partial
-- — it binds at creation time, when the listing necessarily still exists.
-- Star AVERAGES here are safety information, not social approval; the
-- distinction vs PSYCHOLOGY design rule 3 is argued in ADR-012.

CREATE TABLE person_reviews (
  id           uuid PRIMARY KEY,                      -- uuidv7, app-side
  listing_id   uuid REFERENCES listings(id) ON DELETE SET NULL,
  listing_kind text NOT NULL
                 CHECK (listing_kind IN ('gig','ride','room','place_review')),  -- snapshot
  reviewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       int  NOT NULL CHECK (rating BETWEEN 1 AND 5),   -- LISTING_RATING_MIN/MAX
  body         text NOT NULL DEFAULT ''
                 CHECK (char_length(body) <= 500),             -- PERSON_REVIEW_BODY_MAX_CHARS
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_reviews_not_self_check CHECK (reviewer_id <> subject_id)
);
-- UNIQUE (listing_id, reviewer_id) — partial: it binds while the listing
-- lives (creation requires a live listing); orphaned rows keep their history.
CREATE UNIQUE INDEX person_reviews_once_idx
  ON person_reviews (listing_id, reviewer_id)
  WHERE listing_id IS NOT NULL;
-- The profile trust panel + list-by-user read.
CREATE INDEX person_reviews_by_subject_idx
  ON person_reviews (subject_id, created_at DESC);

-- ================= attachments: room-photo binding (§1.38) ==================
-- Room listings reuse the §1.6 upload pipeline; details.attachment_ids keeps
-- the author's ordering and listing_id is the binding/GC shield (the post_id
-- pattern from 0005). The orphan-GC partial index is rebuilt to match.

ALTER TABLE attachments
  ADD COLUMN listing_id uuid REFERENCES listings(id) ON DELETE SET NULL;

DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL
    AND scheduled_message_id IS NULL AND post_id IS NULL AND listing_id IS NULL;

-- ====================== users: admin & account state (§1.41) ================
-- is_admin is set ONLY by the ops CLI (grant-admin / revoke-admin) — no web
-- path to adminhood exists (ADR-013). suspended_at: login refused
-- (403 account_suspended), sessions revoked, sockets closed 4401; banned_at:
-- suspension PLUS public invisibility (profile/listings/stories/posts hidden
-- at read/fan-out time — serialization-side, nothing stored is rewritten).
-- registration_ip is captured at register and NULLED by the nightly retention
-- GC after IP_RETENTION_DAYS (90) — sessions.ip (a 0000 column, captured at
-- login) ages out on the same sweep. Documented in the instance privacy note.

ALTER TABLE users
  ADD COLUMN is_admin        boolean NOT NULL DEFAULT false,
  ADD COLUMN suspended_at    timestamptz,
  ADD COLUMN banned_at       timestamptz,
  ADD COLUMN registration_ip inet;

-- ===================== reports: queue resolution (§1.41) ====================
-- v0.3 wrote reports append-only for exactly this consumer (FEATURES #54).
-- Closing is an admin action: who, when, optional note — all ring-logged too.
-- Backfill before the shape CHECK binds, for instances where an operator
-- closed rows by hand.

ALTER TABLE reports
  ADD COLUMN closed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN closed_at  timestamptz,
  ADD COLUMN close_note text NOT NULL DEFAULT ''
    CHECK (char_length(close_note) <= 500);          -- ADMIN_NOTE_MAX_CHARS

UPDATE reports SET closed_at = created_at
  WHERE status = 'closed' AND closed_at IS NULL;

ALTER TABLE reports ADD CONSTRAINT reports_closed_shape_check
  CHECK ((status = 'closed') = (closed_at IS NOT NULL));

-- ===================== instance settings (§1.41) ============================
-- Operator-tunable instance state: key PK + jsonb value (adding a setting is
-- an INSERT, not a migration). One key today: invites_enabled (boolean) —
-- enforced at invite MINT and ACCEPT (403 invites_disabled; register-with-
-- token degrades to invite: null per §1.1, as for every bad invite).

CREATE TABLE instance_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO instance_settings (key, value) VALUES ('invites_enabled', 'true'::jsonb);
