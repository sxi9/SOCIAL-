# ADR-006: Server-side share inbox (persisted imports + logged-out stash)

Status: accepted · Date: 2026-10-16

## Context

The PWA is an OS share target: the share sheet POSTs multipart to `/share` and
the user picks a recipient afterwards. The original design parked the payload in
Redis for 5 minutes — but Android routinely kills the page mid-share, sessions
may be logged out, and the user may want to finish composing on another device.
A share that reached our server must never be droppable.

## Decision

- `POST /api/share-imports` persists a `share_imports` row the moment the share
  POST lands: files go through the normal upload pipeline (ADR-004) as
  attachments bound to the import; if a URL is present the unfurl job is
  enqueued eagerly, right there — before any recipient is picked.
- The share route replies `303 See Other → /compose?import=<id>`
  (POST-redirect-GET); `/compose` hydrates from `GET /api/share-imports/:id` on
  any device. Send is the ordinary idempotent message POST (ADR-005) with the
  preview card snapshotted into the message; the composer then marks the import
  consumed.
- Logged out: the share route POSTs to `POST /api/share-stash`
  (unauthenticated, hard-limited: ≤ 30 MB total, ≤ 3 pending stashes per IP,
  30-min Redis TTL, objects under `stash/`), redirects to
  `/login?next=/share/claim/<stash_id>`; after login,
  `POST /api/share-imports/claim` promotes the stash to a real import.

## Consequences

- Nothing is lost if the OS kills the page mid-share; compose resumes on any
  device; the preview card is usually ready before a recipient is chosen.
- Logged-out shares survive the login round-trip instead of being dropped.
- Cost: an unauthenticated write endpoint — mitigated by the hard per-IP limits
  and short TTL — plus GC obligations: consumed/expired imports (and their
  attachments) are pruned by the nightly `gc` job after 7 days, stashes at 30
  minutes.
