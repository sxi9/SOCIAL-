-- Departed-member history floor (API.md §1.5): departed members see only rows
-- with seq <= seq at left_at. A timestamp bound can invert relative to seq
-- under concurrent sends (created_at is taken before the seq row lock), so the
-- seq at leave time is stamped explicitly.
ALTER TABLE conversation_participants ADD COLUMN left_seq bigint;

-- Backfill existing departed rows from the old timestamp bound.
UPDATE conversation_participants p
SET left_seq = COALESCE(
  (SELECT max(m.seq) FROM messages m
   WHERE m.conversation_id = p.conversation_id AND m.created_at <= p.left_at),
  0)
WHERE p.left_at IS NOT NULL;
