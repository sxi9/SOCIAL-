# ADR-014: Calls — mesh WebRTC over the existing gateway, coturn with minted credentials, a documented SFU seam

Status: accepted · Date: 2026-10-17

## Context

v0.6 ships FEATURES #49–#51: 1:1 voice/video, group calls, and watch
together. The chassis was designed for this moment — ARCHITECTURE §8 reserved
the seam in one sentence: "signaling = more ephemeral WS event types over the
existing gateway; coturn or LiveKit arrive as additional compose services."
The open questions were real, though: do group calls need a media server
(SFU) or does browser-native mesh suffice; how do peers traverse NAT on a
single self-hosted VPS; how are TURN credentials issued without a shared
database between the api and the relay; and where does signaling state live
in a product whose protocol religion is "REST for durable writes, WS for
ephemeral fan-out, seq for sync". The zero-new-dependencies rule (no
socket.io, no livekit-client, no SDK wrappers) and the one-command-deploy
promise constrain every answer.

## Decision

- **Signaling rides the existing WS gateway as relayed ephemeral frames —
  nothing new is persisted for a live call.** Nine `call.*` client frame
  types (API.md §2.12) are Zod-validated, authorized per frame (active
  participant; live call member past the invite stage), relayed to named
  recipients with `from_user` stamped server-side, and dropped. No SDP or
  candidate ever touches Postgres or Redis; there is no replay on reconnect —
  a reconnecting member re-joins and re-offers, because WebRTC state was
  dead the moment the peer connection dropped anyway. This is the typing
  model, not the messages model: losing a frame loses a moment of UX, never
  state. The durable record is one `calls` row (the call log: initiator,
  kind, status machine, timestamps), written exclusively by REST (§1.42),
  with `call.updated` fan-out through the same Redis `events` channel as
  everything else. The split keeps the receipt-honesty worldview intact:
  anything that must survive a crash is in Postgres; anything that can't
  survive a crash by nature (a live media session) is ephemeral on purpose.

- **Group calls are MESH, hard-capped at `CALL_MESH_MAX=8`.** Every
  participant holds n−1 peer connections and encodes its outgoing streams
  n−1 times. That is the honest ceiling for mid-range phones on video (CPU
  and uplink grow linearly; at 8 the uplink is ~7× one stream) — and it is
  enforced where it cannot race: an atomic Redis check-and-add in the REST
  join (`409 call_full`), so by the time anyone may offer, the cap already
  held. Why mesh and not an SFU now: an SFU is a second media-path server
  with its own ports, keys, codecs, and failure modes, and every integration
  path (LiveKit, mediasoup, Janus) violates either the zero-new-dependency
  rule (client + server SDKs) or the one-box simplicity budget — for a cap of
  8, the browser IS the media server. The mesh also keeps E2E media
  encryption trivially true (DTLS-SRTP peer to peer; the server never sees
  media), which an SFU forfeits by design.

- **The LiveKit SFU upgrade seam, documented so it stays cheap** (the §8
  pattern: seams cut, not promised). Everything an SFU replaces is behind
  two boundaries. (1) *Media path:* clients speak to each other through
  `RTCPeerConnection`s negotiated by `call.offer/answer/ice`; with an SFU
  they speak to one endpoint instead — the REST join response already
  carries the connection material (`turn` today, a LiveKit room token
  tomorrow: mint a JWT with the api's secret, the same HMAC pattern as TURN
  creds). (2) *Topology knowledge:* only the join/leave code and the §2.12
  offer rule know the mesh exists. The migration is therefore: add a
  `livekit` compose service + `LIVEKIT_*` env, teach `POST /calls/:id/join`
  to return `{sfu: {url, token}}` when the call (or the instance) is flagged
  `sfu`, and the client to attach instead of offering; the `calls` row, the
  REST lifecycle, `call.updated`, ringing UX, missed-call machinery and push
  are all UNTOUCHED — they never knew about the mesh either. The
  `call.offer/answer/ice` frames simply go quiet for SFU calls; they are not
  removed (1:1 calls should stay mesh forever — peer-to-peer is strictly
  better for two people). Raise `CALL_MESH_MAX` only via this door, never by
  widening the mesh.

- **TURN is coturn in static-auth-secret mode; the api mints time-limited
  HMAC credentials.** Host candidates connect same-network and local-dev
  peers for free, but two phones on different carrier NATs need a relay.
  coturn joins docker-compose; credentials follow the TURN REST API memo
  format: `username = "<unix expiry>:<user_id>"`, `credential =
  base64(HMAC-SHA1(TURN_SECRET, username))`, TTL `TURN_CRED_TTL_S=1h`
  (§1.42). The api and coturn share only the `TURN_SECRET` env var — no
  database wiring, no user table in the relay, revocation-by-expiry. Minting
  is participant-gated (`GET /api/turn-credentials?call_id=` → 404 unless
  you're in a live call), so the relay cannot be farmed as a free proxy by
  arbitrary account holders beyond their own calls, and abuse traces to a
  user id baked into the TURN username. `turn: null` when `TURN_SECRET` is
  unset keeps local dev dependency-free — and on the relay side the same
  empty-secret state is a hard stop (fixer r1): the `turn` service sits
  behind the `turn` compose profile (`COMPOSE_PROFILES=turn`, set together
  with `TURN_SECRET`) and its entrypoint exits when `TURN_SECRET` is empty,
  because coturn verifying HMACs against `""` on published ports would be an
  open relay anyone could mint credentials for.

- **coturn publishes its own host ports — the ONE exception to
  "only caddy publishes", documented here and in compose.** TURN is
  UDP-first (3478/udp + tcp for the handshake, `TURN_RELAY_PORT_MIN..MAX` =
  49160–49200/udp for relayed media); an HTTP reverse proxy cannot carry it,
  and pushing media through Caddy would serialize every call through the
  one process whose job is TLS for web traffic. The relay range is kept
  deliberately small (41 ports ≈ 20 concurrent relayed streams — plenty at
  self-hosted scale, one compose edit to widen) so the firewall statement
  stays auditable. TURN-over-TLS (turns:, port 5349) is future scope: it
  needs the Caddy-managed cert synced into coturn, and plain TURN is not a
  privacy hole — media is DTLS-SRTP end-to-end regardless; TURN is blind
  transport.

- **Watch together is Redis-only ephemera on the same gateway** (§1.43):
  three relayed frame types, one `watch:{conversation_id}` key with a 60 s
  TTL refreshed by host syncs, host-only sync authority, server-side URL
  parsing. No table, no REST — a watch session that nobody is syncing is
  not state worth keeping, and sync correctness is "within one keepalive",
  not seq-exact. It shares the §2.12 authorization and flood-guard
  machinery with calls, which is why it ships in the same ADR.

## Consequences

- A dropped api process drops live calls' signaling — but not the calls
  themselves: media is peer-to-peer and keeps flowing; clients re-join and
  re-negotiate when the socket returns. The `calls` row may briefly read
  `ongoing` for a dead call; the ring-timeout sweep and the next member's
  REST end reconcile it. Acceptable for one-box scale, and the multi-node
  story is unchanged (the gateway relays via the Redis `events` channel like
  every other fan-out).
- Mesh caps are a product truth, not a config knob: groups of 9+ cannot call
  until the SFU door is opened. The cap is enforced at join, surfaced as
  `409 call_full`, and the UI never offers "call" affordances that would
  immediately bounce.
- Blocked pairs in one group call never exchange frames, so no media path
  forms between them — but they can see each other's tiles exist via the
  member list, exactly as they see each other's messages in a shared group
  (§1.14's "group function" line, honestly extended).
- The relay range and 3478 must be open in any host firewall — a new deploy
  step (README). Instances behind NAT (home servers) must set
  `TURN_EXTERNAL_IP`; a VPS with a public IP needs nothing.
- CPU cost of video mesh on phones is real at 6–8 participants; the client
  mitigates (lower encode resolution as n grows) but the real fix is the
  SFU seam, deliberately deferred.
