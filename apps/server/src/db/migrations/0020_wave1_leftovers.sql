-- 0020 — AUDIT-PLAN Wave 1 leftovers (2026-10-28). 0019 is never reused.

-- §1.2 deactivate / pause: self-serve, distinct from an admin suspension.
-- Login is allowed and REACTIVATES (createSession clears it); while set the
-- account is hidden like a banned one and its sessions are dead.
ALTER TABLE users ADD COLUMN deactivated_at timestamptz;

-- §1.9 appear offline: the online dot and the last-seen stamp are withheld
-- from everyone but the owner (show_last_seen keeps governing the stamp).
ALTER TABLE users ADD COLUMN appear_offline boolean NOT NULL DEFAULT false;

-- §1.4 a sign-out that signs out: a push subscription belongs to the
-- SESSION that created it, so revoking that session (remote sign-out,
-- logout-all, expiry) kills the browser's push with it. Nullable: rows
-- subscribed before 0020 keep working until re-subscribed.
ALTER TABLE push_subscriptions
  ADD COLUMN session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX push_by_session_idx ON push_subscriptions (session_id)
  WHERE session_id IS NOT NULL;

-- §1.5 reports: a formal outcome on close (warned → a Support message was
-- sent; suspended → the shortcut; removed → a takedown).
ALTER TABLE reports ADD COLUMN outcome text NOT NULL DEFAULT '';
ALTER TABLE reports ADD CONSTRAINT reports_outcome_check
  CHECK (outcome IN ('', 'warned', 'suspended', 'removed'));

-- §1.5 the `legal` support category.
ALTER TABLE support_tickets DROP CONSTRAINT support_tickets_category_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_category_check
  CHECK (category IN ('bug','question','idea','safety','legal'));
