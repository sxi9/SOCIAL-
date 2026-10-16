# ADR-002: Watermark cursors for delivery/read receipts

Status: accepted · Date: 2026-10-16

## Context

Per-message receipt rows cost O(messages × participants) writes and storage, and
melt down the moment groups grow or Phase-2 broadcast channels arrive. Messages
already carry a gapless per-conversation `seq` (ADR-003), so "read up to here"
is a single integer.

## Decision

Receipts are two monotonic watermark cursors per participant on
`conversation_participants`: `last_delivered_seq` and `last_read_seq`.

- Clients send `delivered {conversation_id, seq}` only after the message is
  durably stored locally (IndexedDB write committed), and `read` when the
  conversation is visible. One frame covers a burst (max contiguous seq).
- Server applies `GREATEST(stored, seq)` — monotonic, so duplicates and
  out-of-order frames are harmless — and `read` implies `delivered`.
- Broadcasts are coalesced: at most one `receipt` event per (conversation, user)
  per 1000 ms, trailing flush. Nothing is lost; watermarks are state, not events.
- Receipt honesty: push acceptance by the service worker NEVER advances
  `last_delivered_seq`. Only a running client that persisted the message does.

## Consequences

- Receipt state is O(participants), not O(messages × participants); unread count
  is `last_seq - my last_read_seq`; sync needs no receipt replay — the `/sync`
  snapshot carries current cursors.
- Sender ticks are derived locally: DM = peer watermark ≥ seq; group =
  `min(watermark over active participants) ≥ seq` — trivial under the
  `MAX_GROUP_PARTICIPANTS=256` cap.
- This is the one receipt model that survives Phase-2 channels: a 50k-follower
  channel costs one cursor row per member.
- Trade-off: no per-message "read at" timestamp per user — only "read up to
  seq". Accepted; no UI in the roadmap needs more.
