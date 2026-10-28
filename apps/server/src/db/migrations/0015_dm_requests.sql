-- 0015 — Wave 1.7 "who can message me + Requests" (AUDIT-PLAN §1.7 / §10;
-- 2026-10-28). The ONE column this wave needs; the rest of §10's Wave 1
-- list keeps moving down (0016 next). 0014 is never reused.

-- conversation_participants.accepted_at — when this member said yes to the
-- conversation. A DM a stranger opens with someone whose dm_policy is
-- 'connections' (and who is not an accepted §1.28 connection) is CREATED
-- but the recipient's row stays NULL: the chat parks in their Requests row
-- (no push, no ring, no receipts or typing either way) until they accept,
-- reply, or leave. DEFAULT now() so every other insert path — groups,
-- channels, invites, joins, matches, roulette, rescue — stays "accepted"
-- without knowing the column exists; only the two stranger-DM creators
-- write NULL on purpose. Backfill = joined_at: nothing already open closes
-- (the anon_messages lesson, the 0014 dm_policy backfill).
ALTER TABLE conversation_participants
  ADD COLUMN accepted_at timestamptz DEFAULT now();
UPDATE conversation_participants SET accepted_at = joined_at WHERE accepted_at IS NULL;
