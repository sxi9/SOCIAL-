-- 0008_interactivity — v0.7: interactivity pack (ADR-016; API.md §1.47–§1.54;
-- FEATURES #60–#71). Beacon editing + custom vibes + early spark + the
-- starting-soon ping, listing editing, the public feed lane, interactive
-- posts (polls / open game challenges / join cards), comment attachments +
-- reactions, locations everywhere, and the 'location' chat message. Mirrors
-- nothing new in docs/SCHEMA.sql (frozen at v0.4, like 0005–0007); Drizzle
-- twin in src/db/schema.ts.
--
-- HARD RULES carried by this schema: poll-option counts are a VOTE TALLY on
-- choices, never approval attached to a person (ADR-016 argues the line vs
-- PSYCHOLOGY rule 3 — post_poll_votes has no read model beyond aggregates +
-- the voter's own row); comment reactions render as capped FACES lists,
-- never totals (no count is ever computed into a DTO); a join_card may never
-- WIDEN its ref's audience (route-enforced nesting at create, per-viewer
-- re-resolution at read); locations are user-initiated snapshots (lat/lng
-- optional, never required, never tracked) and the DB pins only the jsonb
-- type — the shape authority is the shared Zod LocationSchema, the house
-- metadata pattern. The OG banner (§1.53), scheduled toast and wordmark
-- (§1.54) need no schema.

-- ===================== messages: the 'location' type (§1.52) =================
-- A "📍 join me here" drop: metadata.location = {label, lat?, lng?} (+
-- optional metadata.join_me: true), body = an optional note. The on-my-way
-- quick action is an ORDINARY text reply (reply_to_seq = the drop's seq, body
-- ON_MY_WAY_BODY) — zero new machinery, the headcount is derived client-side
-- from those replies.

ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','video','file','system','poll',
                  'audio','vibe_check','game_ttt','puzzle_result','location'));

-- ========== beacons: custom vibes, edits, early spark, pings (§1.47) =========
-- vibe gains 'custom' (BEACON_VIBE_VALUES): the creator's own chip, emoji +
-- word, both required together. edited_at drives the card's "edited" marker
-- (the §1.30 pattern — no edit history is stored). starting_soon_pinged_at is
-- the once-per-beacon claim for the T-30min worker ping (the repinged_at
-- pattern: guarded UPDATE ... WHERE starting_soon_pinged_at IS NULL).
-- location is the §1.52 place chip. Early spark (POST .../spark-now) and
-- edits reuse the 0003 row-locked spark machinery — no new state needed.

ALTER TABLE beacons
  ADD COLUMN custom_vibe_emoji text
    CONSTRAINT beacons_custom_vibe_emoji_check
      CHECK (char_length(custom_vibe_emoji) BETWEEN 1 AND 16),
  ADD COLUMN custom_vibe_label text
    CONSTRAINT beacons_custom_vibe_label_check
      CHECK (char_length(custom_vibe_label) BETWEEN 1 AND 24),
  ADD COLUMN location jsonb
    CONSTRAINT beacons_location_check
      CHECK (location IS NULL OR jsonb_typeof(location) = 'object'),
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN starting_soon_pinged_at timestamptz;

ALTER TABLE beacons DROP CONSTRAINT beacons_vibe_check;
ALTER TABLE beacons ADD CONSTRAINT beacons_vibe_check
  CHECK (vibe IN ('food','chai','walk','game','movie','study','sport','chill',
                  'custom'));                              -- BEACON_VIBE_VALUES
-- Both custom fields exactly when vibe='custom'.
ALTER TABLE beacons ADD CONSTRAINT beacons_custom_vibe_shape_check
  CHECK ((vibe = 'custom')
         = (custom_vibe_emoji IS NOT NULL AND custom_vibe_label IS NOT NULL));

-- The starting-soon sweep walk (worker queue `beacons`, every minute): open
-- or sparked beacons with ≥1 joiner whose starts_at is within
-- BEACON_STARTING_SOON_LEAD_S and no ping claimed yet.
CREATE INDEX beacons_starting_soon_idx ON beacons (starts_at)
  WHERE status IN ('open','sparked') AND starting_soon_pinged_at IS NULL;

-- ================== listings: edits + location chip (§1.48/§1.52) ============
-- PATCH /api/listings/:id is author-only, active-only; per-kind details are
-- revalidated by the SAME shared discriminated union as create (kind itself
-- is immutable). The board stays PULL-BASED: an edit fans out nothing.

ALTER TABLE listings
  ADD COLUMN location jsonb
    CONSTRAINT listings_location_check
      CHECK (location IS NULL OR jsonb_typeof(location) = 'object'),
  ADD COLUMN edited_at timestamptz;

-- ============ posts: kinds, public lane, game claim, refs (§1.49/§1.50) ======
-- kind picks the card: 'text' (the v0.5a post), 'poll' (post_polls below),
-- 'game' (an open ttt challenge — the claim lives here as columns, the board
-- itself is an ordinary game_ttt message in the claimer↔author DM), and
-- 'join_card' (ref = {type:'beacon'|'listing', id}, stored verbatim; the
-- live summary is resolved per viewer at serialization time and the
-- audience-intersection rule binds at create — ADR-016). audience gains
-- 'public' (the §1.49 discover lane); 'friends_of' rows are untouched.
-- game_claimed_by is claimed atomically: pg_advisory_xact_lock on the post id
-- + the guarded UPDATE ... WHERE game_claimed_by IS NULL (the spark pattern).

ALTER TABLE posts
  ADD COLUMN kind text NOT NULL DEFAULT 'text'
    CONSTRAINT posts_kind_check
      CHECK (kind IN ('text','poll','game','join_card')),  -- POST_KINDS
  ADD COLUMN ref jsonb
    CONSTRAINT posts_ref_check
      CHECK (ref IS NULL OR jsonb_typeof(ref) = 'object'),
  ADD COLUMN game_claimed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN location jsonb
    CONSTRAINT posts_location_check
      CHECK (location IS NULL OR jsonb_typeof(location) = 'object');

ALTER TABLE posts DROP CONSTRAINT posts_audience_check;
ALTER TABLE posts ADD CONSTRAINT posts_audience_check
  CHECK (audience IN ('friends_of','public'));             -- POST_AUDIENCES

-- A join_card always has a ref; nothing else ever does.
ALTER TABLE posts ADD CONSTRAINT posts_ref_shape_check
  CHECK ((kind = 'join_card') = (ref IS NOT NULL));
-- Only game posts carry a claim.
ALTER TABLE posts ADD CONSTRAINT posts_game_claim_shape_check
  CHECK (game_claimed_by IS NULL OR kind = 'game');

-- The discover lane read (§1.49): audience='public', created_at DESC keyset —
-- finite with all_caught_up, exactly like the friends lane.
CREATE INDEX posts_discover_idx ON posts (created_at DESC)
  WHERE audience = 'public';

-- ========================== post polls (§1.50) ===============================
-- One poll per poll post (post_id PK). Options are jsonb like the 0003 chat
-- polls; the per-option ≤80-char bound is Zod/route-enforced (shape authority
-- packages/shared). No closes_at: a post poll lives and dies with its post.

CREATE TABLE post_polls (
  post_id    uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  question   text NOT NULL
               CHECK (char_length(question) BETWEEN 1 AND 120),  -- POST_POLL_QUESTION_MAX_CHARS
  options    jsonb NOT NULL                                      -- 2..6 option strings
               CHECK (jsonb_typeof(options) = 'array'
                      AND jsonb_array_length(options) BETWEEN 2 AND 6),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Revote REPLACES (UPSERT on the PK — the 0003 poll_votes semantics). The
-- only reads are the per-option aggregate and the viewer's own my_vote row:
-- no voter lists, no vote timestamps in any payload (§1.50).

CREATE TABLE post_poll_votes (
  post_id    uuid NOT NULL REFERENCES post_polls(post_id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_idx integer NOT NULL CHECK (option_idx >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- ================= post_comments: image/GIF attachments (§1.51) ==============
-- One optional image attachment per comment, riding the EXISTING §1.6 upload
-- pipeline (a GIF is just an image upload). body may now be empty — at least
-- one of body/attachment is route-enforced (400 empty_comment). The comment-
-- delete route deletes the attachment explicitly (rows + objects, refcount-
-- guarded §1.31), like §1.30 message deletes.

ALTER TABLE post_comments
  ADD COLUMN attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE post_comments ALTER COLUMN body SET DEFAULT '';
ALTER TABLE post_comments DROP CONSTRAINT post_comments_body_check;
ALTER TABLE post_comments ADD CONSTRAINT post_comments_body_check
  CHECK (char_length(body) <= 500);                 -- POST_COMMENT_MAX_CHARS

CREATE INDEX post_comments_attachment_idx ON post_comments (attachment_id);

-- ===================== comment reactions (§1.51) =============================
-- Emoji + avatar-stamp reactions on comments — the §1.19 machinery re-applied:
-- a stamp is kind='stamp' with the ':stamp:' sentinel (STAMP_REACTION_KEY) in
-- the emoji column, so the PK enforces one stamp per user per comment and the
-- 8-distinct-emoji route cap counts kind='emoji' rows only. Rendered as
-- capped FACES lists (COMMENT_REACTORS_PREVIEW_MAX + has_more) — no numeric
-- total is ever computed into a payload (PSYCHOLOGY rule 3). No fan-out:
-- feed surfaces reconcile on pull (§1.36 doctrine).

CREATE TABLE comment_reactions (
  comment_id uuid NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  kind       text NOT NULL DEFAULT 'emoji' CHECK (kind IN ('emoji','stamp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id, emoji, kind),
  CONSTRAINT comment_reactions_stamp_key_check
    CHECK ((kind = 'stamp') = (emoji = ':stamp:'))
);

-- ================ attachments: comment binding (§1.51) =======================
-- comment_id is the binding/GC shield (the post_id/listing_id pattern); the
-- orphan-GC partial index is rebuilt to match.

ALTER TABLE attachments
  ADD COLUMN comment_id uuid REFERENCES post_comments(id) ON DELETE SET NULL;

DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments (created_at)
  WHERE message_id IS NULL AND share_import_id IS NULL
    AND scheduled_message_id IS NULL AND post_id IS NULL AND listing_id IS NULL
    AND comment_id IS NULL;
