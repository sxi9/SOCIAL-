-- 0019 — AUDIT-PLAN §1b phase 5 (2026-10-28): call links. 0018 is never
-- reused.
--
-- share_tokens.object_type gains 'call': a capability minted by a member of
-- a LIVE group call (object_id = the call id). The public page shows who
-- invites you and how many are in; joining (signed in) adds you to the
-- group and lands you in the call. The token is revoked on every terminal
-- call transition (calls/service deleteCallMembers), so it dies with the
-- call. The reports CHECK widens in step (the page carries a Report link).
ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_object_type_check;
ALTER TABLE share_tokens
  ADD CONSTRAINT share_tokens_object_type_check
  CHECK (object_type IN ('post','beacon','listing','story','group','profile','call'));
ALTER TABLE reports DROP CONSTRAINT reports_target_object_type_check;
ALTER TABLE reports
  ADD CONSTRAINT reports_target_object_type_check
  CHECK (target_object_type IN ('post','beacon','listing','story','group','profile','comment','call'));
