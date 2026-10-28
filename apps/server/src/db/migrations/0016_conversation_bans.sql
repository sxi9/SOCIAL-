-- 0016 — AUDIT-PLAN §2.5 admin half (2026-10-28): conversation bans.
-- 0015 is never reused; the rest of §10's Wave 1 list moves to 0017+.

-- conversation_bans — written when an admin REMOVES a member from a group
-- (or a channel's owner/admin removes one): a kicked member used to walk
-- straight back in through any open invite link, the public join, or a
-- parked join request. Honoured INVISIBLY at every door — invite accept
-- answers the blocked-pair 404, the public join the unlisted 404, an
-- invite-only request parks nothing and answers the usual 202 — never a
-- confirmable "you are banned" (the §1.14 shape doctrine). An ADMIN
-- re-adding or approving the person lifts the ban (admins are the
-- authority), as does DELETE /bans/:userId. banned_by is informational.
CREATE TABLE conversation_bans (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
