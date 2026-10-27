-- 0014 — share-everything plumbing (AUDIT-PLAN §1b / §10; 2026-10-27 owner
-- requirement, decision 11). Phase 1 columns only; the Wave 1 legal/account/
-- report columns §10 also lists go in 0015 when that wave starts (§10 allows
-- the split; 0013 is never reused).

-- share_tokens.preview — decision 11: a NON-public object shared by token
-- shows a TEASER by default with a sharer-side Teaser/Full switch chosen at
-- mint time and stored on the token; the server decides what to render.
-- Every existing token points at a PUBLIC object (the only kind that could
-- mint before this), and public objects are fully viewable with no switch,
-- so 'full' is the truthful backfill. Plain text validated by the shared
-- Zod enum (SHARE_PREVIEWS), the 0013 convention.
ALTER TABLE share_tokens
  ADD COLUMN preview text NOT NULL DEFAULT 'full'
    CONSTRAINT share_tokens_preview_check
      CHECK (preview IN ('teaser','full'));

-- Settings columns (the ADR-009 / 0010 pattern — same one-row read as every
-- other setting). Both are STORED here and ENFORCED later at their surfaces
-- (the §1.13 doctrine: serialization-time, nothing stored is rewritten).
--
-- dm_policy (Wave 1.7): who may open a DM / start a call with me —
-- 'everyone' | 'connections' (accepted §1.28 connections literally) |
-- 'nobody'. Owner decision (2026-10-27): EXISTING accounts keep today's
-- behaviour ('everyone' — nothing closes on them silently; the
-- anon_messages lesson), NEW accounts default to 'connections' per
-- AUDIT-PLAN §1.7. Hence: add with DEFAULT 'everyone' so the backfill is
-- 'everyone', then switch the column default to 'connections' for every
-- row inserted from now on. NOT enforced by this migration's release:
-- POST /api/conversations {dm} and call creation gain the check in the
-- profile-share phase, 404-shaped like blocks, with a stranger's message
-- landing in Requests.
--
-- profile_visibility (§1b): how much of my profile a logged-out share link
-- may show — 'public' = the full teaser (avatar, name, one bio line,
-- interests, joined-month; never counts), 'connections' | 'private' reduce
-- it to avatar + name. Same value set as the activity_* toggles.
ALTER TABLE users
  ADD COLUMN dm_policy text NOT NULL DEFAULT 'everyone'
    CONSTRAINT users_dm_policy_check
      CHECK (dm_policy IN ('everyone','connections','nobody')),
  ADD COLUMN profile_visibility text NOT NULL DEFAULT 'public'
    CONSTRAINT users_profile_visibility_check
      CHECK (profile_visibility IN ('public','connections','private'));
ALTER TABLE users
  ALTER COLUMN dm_policy SET DEFAULT 'connections';
