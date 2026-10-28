-- 0018 — AUDIT-PLAN Wave 1, the P0 floor (2026-10-28): legal consent,
-- account lifecycle, triageable reports, age gate. 0017 is never reused.
-- Mute needs no DDL (conversation_participants.muted_until exists since
-- 0000 and finally gets a writer); the legal markdown and operator_contact
-- are instance_settings JSON keys (no DDL).

-- §1.1 consent + §1.8 age gate: NON-stored attestations (no DOB, #78b) —
-- the moment the person ticked the box. Pre-existing accounts stay NULL:
-- discovery / roulette ask once (POST /api/users/me/attest-age) before the
-- first opt-in; terms are re-asked nowhere (the operator's call).
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN age_attested_at timestamptz;

-- §1.2 account lifecycle: DELETE /api/users/me schedules; signing in again
-- during the grace cancels; the GC sweep tombstones at the due time
-- (deleted_at set, identity scrubbed, content removed — the row itself stays
-- so message history keeps a "Deleted account" author).
ALTER TABLE users ADD COLUMN scheduled_deletion_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE INDEX users_scheduled_deletion_idx ON users (scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL AND deleted_at IS NULL;

-- §1.5 reporting that can be triaged: a required CATEGORY beside the free
-- text (admin queue lanes), and five object kinds the sheet could not name
-- before. New kinds point at target_object_type/_id (the 0010 pointers);
-- 'comment' joins that CHECK.
ALTER TABLE reports ADD COLUMN category text NOT NULL DEFAULT 'other';
ALTER TABLE reports ADD CONSTRAINT reports_category_check CHECK (category IN
  ('spam','harassment','hate','nudity','self_harm','scam','impersonation',
   'underage','off_platform','ip','other'));
ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check CHECK (kind IN
  ('user','message','beacon','anon_message','story_overlay','share_page',
   'post','comment','story','listing','group'));
ALTER TABLE reports DROP CONSTRAINT reports_target_object_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_object_type_check CHECK
  (target_object_type IN ('post','beacon','listing','story','group','profile','comment'));

-- The per-kind target shape (0003, widened by 0010) gains the object kinds:
-- target_object_type names the kind, target_object_id the thing, and
-- target_user_id the SERVER-attached author (the queue acts on a person).
ALTER TABLE reports DROP CONSTRAINT reports_target_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_check
  CHECK (
    (kind = 'user' AND target_user_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'message' AND target_conversation_id IS NOT NULL AND target_seq IS NOT NULL
      AND target_user_id IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'beacon' AND target_beacon_id IS NOT NULL
      AND target_user_id IS NULL AND target_conversation_id IS NULL AND target_seq IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind = 'anon_message' AND target_anon_thread_id IS NOT NULL AND target_anon_message_id IS NOT NULL
      AND target_user_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_object_type IS NULL AND target_overlay_id IS NULL)
    OR (kind = 'story_overlay' AND target_object_type = 'story' AND target_object_id IS NOT NULL
      AND target_overlay_id IS NOT NULL
      AND target_user_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_anon_thread_id IS NULL)
    OR (kind = 'share_page' AND target_object_type IS NOT NULL AND target_object_id IS NOT NULL
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
    OR (kind IN ('post','comment','story','listing','group')
      AND target_object_type = kind AND target_object_id IS NOT NULL
      AND target_user_id IS NOT NULL -- the SERVER-attached author / group admin
      AND target_conversation_id IS NULL AND target_seq IS NULL AND target_beacon_id IS NULL
      AND target_overlay_id IS NULL AND target_anon_thread_id IS NULL)
  );
