# ADR-005: Durable sends over REST only; WebSocket is an event pipe

Status: accepted · Date: 2026-10-16

## Context

Carrying message sends over the WebSocket couples durability to socket health: a
frame in flight when the socket drops is lost unless we build acks, resume
tokens, and a per-device replay mailbox — a second delivery system next to the
seq log. The share composer also needs to send before any socket exists.

## Decision

- All durable writes are REST. `POST /conversations/:id/messages` carries a
  client-generated `client_msg_id` (UUIDv7); replays return the previously
  created row (`200` instead of `201`), so retries are free and idempotent.
- The WS carries only downstream events (`msg.new`, `msg.updated`, `receipt`,
  `typing`, `presence`, `conv.*`, `user.updated`, `preview.ready`,
  `attachment.ready`) and ephemeral upstream signals (`delivered`, `read`,
  `typing`, `presence.sub/unsub`). Durable writes over WS are rejected.
- Reconnect needs no WS resume: open the socket first, then `GET /sync`, then
  gap-fill with `after_seq` paging; events arriving meanwhile apply
  idempotently by `(conversation_id, seq)`.

## Consequences

- A dropped socket can never lose a message — "sent" is the `201` response, and
  the offline outbound queue flushes through the same idempotent POST.
- One delivery mechanism: the seq log (ADR-003) is the only replay machinery;
  no Socket.IO rooms/acks, no per-device mailbox, no missed-event class.
- The share composer and SSR pages work before a socket exists.
- Cost: two transports to operate (HTTP + WS), and sends pay HTTP overhead per
  message. Accepted: the WS stays stateless enough that multi-node later is
  "publish all fan-out through the Redis events channel", nothing more.
