-- 0017 — AUDIT-PLAN §1b phase 6 (2026-10-28): the profile share.
-- 0016 is never reused; the rest of §10's Wave 1 list moves to 0018+.

-- share_tokens.object_type gains 'profile': the owner-minted "text me /
-- call me" card (object_id = the owner's user id, ONE open token per user
-- via the existing partial unique index). What the page shows is decided
-- live from users.profile_visibility (migration 0014) — the token stores
-- preview 'full' like every public object; the setting, not the token,
-- narrows it to avatar + name. The CHECK was inline (auto-named by
-- Postgres as <table>_<column>_check), so it is dropped and re-added.
ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_object_type_check;
ALTER TABLE share_tokens
  ADD CONSTRAINT share_tokens_object_type_check
  CHECK (object_type IN ('post','beacon','listing','story','group','profile'));

-- The non-user report (POST /api/share/:token/report) stores the resolved
-- target type — the profile page renders the same Report link, so the
-- reports CHECK (0010) widens in step.
ALTER TABLE reports DROP CONSTRAINT reports_target_object_type_check;
ALTER TABLE reports
  ADD CONSTRAINT reports_target_object_type_check
  CHECK (target_object_type IN ('post','beacon','listing','story','group','profile'));
