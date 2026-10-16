# ADR-003: Gapless per-conversation seq as the message primary key

Status: accepted · Date: 2026-10-16

## Context

Ordering, receipts, unread counts, offline sync, and push dedup all need a total
order per conversation. Timestamps collide and skew; global sequences hotspot;
UUIDs don't order. PostgreSQL is already the single source of truth and can
assign a per-conversation counter transactionally with a row lock.

## Decision

- `messages` has `PRIMARY KEY (conversation_id, seq)`; `seq` is a gapless
  integer assigned inside the send transaction:
  `UPDATE conversations SET last_seq = last_seq + 1 … RETURNING last_seq`,
  then insert, then raise the sender's own watermarks — commit, then fan out.
- UUIDv7 `id` remains for identity/idempotency (`client_msg_id` replay returns
  the existing row); `seq` is for order.
- `join_seq` is stamped on `conversation_participants` at add time and enforced
  as the history visibility floor in every history query.

## Consequences

- Everything reduces to integer compares: history pages by `after_seq` /
  `before_seq` on an index-only walk; catch-up is deterministic
  (`GET /sync` snapshot → gap-fill where `last_seq > max_seq_stored`); a client
  offline a month syncs exactly as correctly as one that blinked.
- Gaplessness means a gap is always "not yet fetched", never "lost" — there is
  no missed-event class and no per-device mailbox.
- The row lock serializes writers per conversation — the accepted cost; it is
  per-conversation, not global, and fine at single-VPS scale.
- Seqs are never reused, so Phase-2 edits/tombstones (`msg.updated` full-DTO
  replacement) can't break cursor arithmetic. `seq` stays far below 2^53, so it
  is a plain JSON number.
