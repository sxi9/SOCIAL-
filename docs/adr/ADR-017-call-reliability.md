# ADR-017: Call reliability — honest connectivity, a retractable ring push, and telling the truth about TURN

Status: accepted · Date: 2026-10-17

## Context

v0.6 calls (ADR-014) work: mesh WebRTC, ephemeral WS signaling, coturn with
minted HMAC credentials. What they do badly is *fail*. A callee without a
live socket never learns a call happened until the missed-call push; a
dropped ICE path shows a frozen tile until someone hangs up; and — the big
one — an instance without a working relay produces calls that connect
same-network and silently hang forever cross-network, which users read as
"the app is broken", not "this deployment has no relay".

The deployment reality that forces honesty (FEATURES #90): the flagship
"try it at home" setup is a **laptop behind home NAT serving the app through
an HTTP quick tunnel**. That topology can never relay media:

- the tunnel carries **HTTP(S)/WebSocket only** — TURN is UDP-first
  (3478 + the 49160–49200 relay range, ADR-014's one exception to
  "only Caddy publishes") and cannot ride it;
- coturn on the laptop sits behind the same home NAT, unreachable from
  outside without port forwarding, and `TURN_EXTERNAL_IP` has nothing
  truthful to say;
- so cross-network calls on a tunnel deploy **cannot work, by physics, no
  matter what we code**. Same-WiFi and same-machine calls work fine on host
  candidates with no TURN at all. Cross-network calls require the VPS deploy
  (public IP, open relay ports) or real port forwarding.
- Phones must also open the app via the HTTPS tunnel URL, never a plain LAN
  IP: browsers refuse `getUserMedia` on insecure origins, which presents as
  "calls broken on my phone" and is actually "HTTP".

v0.7.1 (FEATURES #87–#90b, SPECS "Calls that just work") commits us to
surfacing all of this instead of letting it fail silently, plus the ring
push, connection-state UX with automatic ICE restart, one shared toast, and
the notifications-on explainer. Binding constraints walking in: REST writes /
WS fan-out (golden rule 1), signaling stays ephemeral (ADR-014), push guards
and blocks are structural (§2.9, §1.14), PSYCHOLOGY rule 2 (never notify
someone about something they cannot join) and rule 5 (no guilt mechanics —
which shapes the notifications prompt).

## Decision

- **The ring push is a retractable, kind-discriminated payload — not a new
  write path.** `CallRingPushPayload {kind:'call.ring', tag:'call:<id>',
  data:{url, call_id, conversation_id, call_kind, is_group}}` goes, at call
  create, to callees the unchanged §2.9 guards allow **and who have no live
  socket** (a live socket already rings via `call.invite`; the push is the
  offline path only). Web-push `TTL = CALL_RING_TIMEOUT_S` and
  `Urgency: high`: an undeliverable ring expires with the ring window —
  a late "incoming call" is a lie, so the transport is told to drop it.
  `muted_until` suppresses it with no mention-style override (a call is not
  a mention); blocked pairs were never in the fan-out. The payload is the
  first to carry a `kind`; kind-less payloads keep their pre-v0.7.1 service
  worker behavior byte-for-byte, so old subscriptions need nothing.

- **"Stops ringing the instant the call is handled anywhere" = a silent stop
  push, closing by tag.** Web push cannot retract a shown notification, but
  a service worker can close one it finds by tag:
  `CallRingStopPushPayload {kind:'call.ring.stop', tag}` is sent on first
  join, DM reject, initiator cancel, ring timeout and end, to exactly the
  subscriptions the ring went to — tracked in the ephemeral Redis set
  `call:{id}:rang`, dropped with the member set on terminal status (the
  ADR-014 pattern: live-call state is Redis ephemera, never a table).

- **Answer/Decline route in the worker, inside the existing auth model.**
  Answer (and plain tap, and platforms without notification actions — iOS
  Safari) deep-links to the call screen, which runs the ordinary §1.42 join.
  Decline on a DM has the worker itself `POST /api/calls/:id/reject`: the
  `sid` cookie rides the worker's same-origin fetch and the worker sets
  `X-Requested-With: fetch`, so CSRF and sessions are untouched — no token
  in the payload, nothing new to steal. Decline on a group just closes the
  notification: a group decline is personal and ephemeral (§1.42) and MUST
  NOT get a durable endpoint invented for the worker's convenience.

- **Connection states are reported, not inferred, and the report is just
  more ephemeral signaling.** One new relayed frame, `call.state
  {call_id, state ∈ connecting|connected|reconnecting|failed}`, sent once per
  transition of the sender's aggregate connectivity (a healthy call sends
  two, ever), live-member-gated like `call.leave`, `from_user` stamped,
  flood-guarded on its own 10 s budget so a flapping network cannot starve
  the hang-up budget, never persisted. It is advisory UI truth — the durable
  truth remains the `calls` row and `call.updated`.

- **ICE restart adds no signaling frame.** Restart is `restartIce()` plus a
  re-offer riding the existing `call.offer`/`call.answer` pair under the
  established perfect-negotiation rule (lower user id is impolite and
  initiates); the gateway cannot distinguish a restart from any other
  renegotiation and must not try. Before restarting, the client refreshes
  TURN credentials (`GET /api/turn-credentials` + `setConfiguration`) — the
  drop may *be* credential expiry. Bounded:
  `CALL_ICE_DISCONNECT_GRACE_MS=3000` before acting on `'disconnected'`
  (blips self-heal; renegotiation thrash is worse than a 3 s freeze),
  `CALL_ICE_RESTART_MAX_ATTEMPTS=3` with backoff `[2s,4s,8s]`, then the pair
  is `failed` and the UI says why. A 1:1 whose media never connected still
  ends via the existing `POST /end {reason:'failed'}` coherence-checked path.

- **One authed GET is the whole TURN-state surface:**
  `GET /api/call-selftest → {turn_configured, turn}` — authed,
  **participant-free** (the point is learning the truth *before* a call
  fails; ADR-014's participant gate protects relay *usage*, and this
  endpoint's probe credentials are too short-lived to farm:
  `CALL_SELFTEST_CRED_TTL_S=300`, username
  `"<expiry>:selftest:<user_id>"` so relay logs attribute probes), and
  rate-limited per user. Reachability is judged **client-side** — a
  relay-only ICE gather either produces a relay candidate or it doesn't,
  and only the user's browser can test the UDP path from where they sit; the
  server asserting "relay reachable" from inside docker-compose would be
  exactly the false comfort this release exists to kill. The same bool
  drives all three honesty surfaces: the Settings self-test verdict, the
  **caller-facing banner** ("this server has no call relay — calls only work
  on the same network") shown *before dialing* whenever `turn_configured`
  is false or a past self-test found the relay unreachable, and the admin
  panel row (`./bored status` prints the host-side equivalent).
  `InstanceSettings` stays untouched: TURN state is a read-only environment
  fact, not a PATCHable setting, and teaching the settings table to mirror
  env vars would create two sources of truth.

- **One toast component, confirmations only** (`components/Toast.tsx`,
  API.md §1.56): Portal to `<body>` (the TROUBLESHOOTING overlay law),
  bottom-anchored above the tab bar on the globals.css z-scale,
  `TOAST_DEFAULT_MS` auto-dismiss, `TOAST_MAX_VISIBLE=2`, fade-only under
  reduced motion, `role="status"`. Toasts confirm the user's **own**
  actions ("posted to board", "invite copied") and never carry incoming
  events or counters — a toast channel that starts announcing other people
  is a notification system with no consent model, so the boundary is drawn
  here, in the contract.

- **The notifications explainer is one-time, device-local, and never
  guilt-trips** (§1.56): shown once post-login when permission is `default`,
  it names what push is for (messages, calls, sparked plans, wave nudges);
  "Not now" or a deny writes `PUSH_EXPLAINER_SEEN_KEY` to localStorage and
  it never returns on that device. Device-local on purpose: push permission
  is a per-browser fact, so syncing prompt state through prefs would re-nag
  every new device exactly when it must not. The settings row states ON /
  OFF / blocked-by-browser (with per-browser unblock steps, since a denied
  page cannot re-ask), and ring-dependent surfaces note "you won't be rung
  when the app is closed" as dismissible context, never a gate.

## Consequences

- Cross-network calls on a tunnel deploy still do not work — **by design we
  now say so**, at dial time, in the self-test, and in the docs, instead of
  burning user trust on a spinner. The fix remains deployment-shaped (VPS
  or port forwarding), not code-shaped.
- The ring push wakes devices for calls they can answer (PSYCHOLOGY rule 2
  holds: a ring is joinable by construction), and the stop push bounds the
  annoyance window to "until anyone handles it". Cost: roughly 2× push
  volume per rung offline callee; acceptable, both pushes are tiny.
- `call:{id}:rang` is more Redis ephemera on the ADR-014 pattern; a crashed
  api can orphan it for at most the ring window, after which the terminal
  sweep deletes it. A lost stop push leaves a stale notification until the
  OS expires it — degraded, never wrong-facts (tapping it lands on a call
  screen that shows the terminal state from REST truth).
- The service worker gains its first POST (DM decline). It is same-origin,
  cookie-authed, CSRF-headed and idempotent on terminal calls (§1.42), so
  the REST-for-durable-writes rule bends nowhere: the worker is just another
  client.
- `call.state` is gossip, not state: a client that dies mid-`reconnecting`
  is corrected by `call.leave`/`call.updated`, and nothing server-side ever
  trusts it. Flood budget 20/10 s on its own key keeps a flapping NIC from
  starving hang-up frames.
- The self-test endpoint mints relay-capable credentials to any
  authenticated user without a live call — deliberately, with TTL 300 s,
  per-user rate limits and log-attributable usernames. An account holder
  determined to proxy 5-minute bursts through coturn buys little and is
  traceable; the alternative (participant-gating the probe) would make the
  self-test unusable exactly when it matters (before the first failed call).
- v0.7.1 adds **no migration, no new table, no new dependency**: one GET,
  one relayed frame, two push payload kinds, Redis ephemera, and web-client
  contracts. Everything ADR-014 promised about the mesh, the SFU seam and
  signaling ephemerality is unchanged.
