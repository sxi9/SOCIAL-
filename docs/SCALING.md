# Bored Chat — Measured Capacity & Scaling (v0.3)

What this single-box deployment actually holds, measured, not guessed. All numbers
below were produced by a load run on 2026-10-16 against the real `apps/server`
API built with `tsc` and run as `NODE_ENV=production node dist/api.js` — the same
code path the Docker image runs. Where a number is extrapolated rather than
measured, it is explicitly labeled **derived**.

---

## 1. Test rig (read this before quoting any number)

| Item | Value |
|---|---|
| CPU | 4 vCPU, Intel Xeon @ 2.80 GHz (VM) |
| RAM | 16 GB |
| Node | 22.22.0 (default `UV_THREADPOOL_SIZE=4`) |
| Postgres | 16.15, stock config (`shared_buffers=128MB`, `work_mem=4MB`, `synchronous_commit=on`) |
| Redis | 7.0.15 |
| Topology | api, Postgres, Redis **and the load generator all on the same box**, no Caddy, no `web`, no `worker` running |

Consequences to keep in mind:

- The load generator (autocannon + a ws client) competed for the same 4 cores, so
  throughput numbers are **conservative** — a dedicated client box would push the
  API somewhat harder.
- The **worker was not running**, so push jobs enqueued for offline users
  accumulated in Redis instead of being drained. Enqueue cost is included in the
  send numbers (it is part of every production send); delivery cost is not.
- `web` (Next.js SSR) was not measured at all. Everything below is API + WS only.
- Dataset: 2,100 users, one 50-member group ("big50"), 50 spread groups of 9
  members, 9 DMs, 200 prefilled messages per conversation (~44k messages total).
- Latency percentiles for REST come from autocannon; its bucket above p90 is
  p97.5, reported in the p95 column (an over-estimate of p95, which is fine —
  it errs honest). WS percentiles are exact (computed from raw samples).

---

## 2. Measured numbers

### 2.1 REST

| Scenario | Concurrency | Throughput | p50 | p95* | Notes |
|---|---|---|---|---|---|
| `POST /auth/register` burst | 20 | **12.9 req/s** | 1,519 ms | 1,769 ms | argon2id m=64MiB t=3 bound; 4 libuv threads ≈ 4 × ~290 ms hashes |
| `POST /auth/login` burst | 20 | **14.0 req/s** | 1,408 ms | 1,559 ms | same argon2 verify cost |
| login, rate-limited path (429s) | 10 | 4,978 req/s | 1.6 ms | 6 ms | the Redis fixed-window limiter rejects cheaply |
| Send, **one** 50-member conversation, members offline | 25 | **121.9 msg/s** | 191 ms | 345 ms | includes 49 push enqueues/send |
| same, c=50 | 50 | 126.4 msg/s | 384 ms | 522 ms | throughput flat, latency doubles → saturated ≈ **125 msg/s/conversation** |
| Send, one 50-member conversation, **all members on live sockets** | 25 | **139.2 msg/s** | 169 ms | 293 ms | no push enqueues; Redis CPU 30% → 1.6% |
| Send, spread over **50** 9-member conversations | 25 | **207.5 msg/s** | 118 ms | 165 ms | no seq-lock contention |
| same, c=50 | 50 | 221.9 msg/s | 223 ms | 288 ms | aggregate ceiling ≈ **220 msg/s** (API process CPU-bound ~1.1 cores) |
| `GET /api/sync`, light user (1–2 convs, ~4.7 KB) | 20 | 213 req/s | 92 ms | 123 ms | 14 ms single-request unloaded |
| `GET /api/sync`, heavy user (60 convs incl. big50, **250 KB** response) | 10 | **42 req/s** | 235 ms | 299 ms | 38 ms single-request unloaded |
| `GET /api/sync` light **while 100 msg/s send load runs** | 20 | 125 req/s | 171 ms | 259 ms | graceful degradation, no errors |
| `GET .../messages?before_seq=…` (50-row page) | 20 | 227 req/s | 87 ms | 116 ms | PK backward index scan, 0.1 ms in PG |

Zero 5xx, zero timeouts in every REST phase.

### 2.2 WebSockets

Sockets are cookie-authed real upgrades (one DB session lookup each), ramped in
batches of 100. Fan-out latency = wall time from *just before* the sender's REST
`POST /messages` to each of the 50 big50 members' sockets receiving `msg.new`
(so it includes the whole durable write, not just the WS hop).

| Concurrent sockets | Time-to-hello p50 / p95 | Fan-out p50 / p95 (50 recipients × 30 msgs = 1,500 samples) | API RSS | API CPU avg |
|---|---|---|---|---|
| 200 | 140 / 170 ms | **17.9 / 22.5 ms** | 161 MB | 4% |
| 500 | 131 / 165 ms | 16.1 / 20.6 ms | 161 MB | 4% |
| 1,000 | 107 / 137 ms | 16.6 / 34.2 ms | 162 MB | 8% |
| 2,000 | 101 / 130 ms | **17.0 / 29.7 ms** | 162 MB | 13% (ramp peaks 120%) |
| 2,000 + 100 msg/s REST send load | 97 / 146 ms | **33.4 / 131.6 ms** | 171 MB | 60% avg |

- Every expected frame arrived at every level (1,500/1,500). No drops.
- Idle sockets are nearly free: RSS stayed ~162 MB from 200 → 2,000 sockets;
  heartbeat sweep + presence refresh at 2,000 sockets costs ~13% of one core.
- The degradation lever is **not** socket count, it is concurrent REST work
  sharing the one event loop (p95 18→132 ms when 100 msg/s runs alongside).

**Presence churn** (40 watcher sockets subscribed, 10 users reconnecting, 60
reconnect cycles): `presence online` frame reached watchers in **p50 6.0 ms /
p95 14.6 ms** at the 2,000-socket level; all 2,400 expected frames delivered.

### 2.3 Receipt frames (the chattiest inbound path)

50 sockets in big50 sending WS `read` frames:

| Inbound read frames | API CPU | PG CPU | Effect on a probe message send |
|---|---|---|---|
| 45 frames/s (1/s/socket) | 12% | 8% | p50 130 ms — fine |
| **987 frames/s** (20/s/socket) | **114% (pegged)** | **100% (pegged)** | probe send took **6.3 s**; most probes never completed |

Each inbound `read` frame costs 4 DB queries (watermark UPDATE, participant
list, reader's setting, other members' settings) plus a fan-out that the 1 s
coalescer only bounds **per reader** — 50 readers × 50 recipients still emitted
2,250 outbound receipt frames/s at the *sane* rate. See hotspot H4.

### 2.4 Resources at each step (same box, api process / all postgres / redis)

| Phase | API CPU avg/max | API RSS max | PG CPU avg | Redis CPU avg |
|---|---|---|---|---|
| idle, 0 sockets | ~0% | 117 MB | ~0% | ~0% |
| register/login burst | (argon2 in threadpool) | — | 3% | <1% |
| send one-conv c25 | 105% / 117% | 231 MB | 56% | 30% |
| send spread c50 | 110% / 123% | 242 MB | 81% | 13% |
| sync light c20 | 112% / 124% | 242 MB | **101%** | <1% |
| 2,000 sockets idle | 13% / 120% (ramp) | 163 MB | 5% | <1% |
| 2,000 sockets + 100 msg/s | 60% / 109% | 172 MB | 36% | 4% |
| receipt storm 987 f/s | 114% / 129% | 326 MB | 100% | <1% |

Peak PG RSS over the whole run: ~500 MB. Peak Redis RSS: ~192 MB (that was
almost entirely the **undrained push-job backlog** — with no worker running,
~30 s of one-conversation sends enqueued ~120k jobs; keep the worker alive).
The box never ran out of anything; the binding constraint everywhere was the
**single Node event loop** (~1.1–1.3 cores busy of 4 — the process never used
more because almost all work is on one thread).

---

## 3. What a given VPS should hold — **derived**, not measured

Scaling the measured numbers by core count/clock and remembering that (a) the
load generator stole CPU here, (b) `web` + `worker` + Caddy must also fit, and
(c) the per-conversation ceiling is commit-latency-bound (disk), not CPU-bound:

**2 GB / 2 vCPU VPS (all eight compose services)** — *derived*:
- ~1,000 concurrent sockets comfortably (sockets cost ~nothing in RSS; the 13%
  heartbeat/presence cost at 2,000 sockets maps to roughly one quarter of this box).
- ~60–100 msg/s aggregate sends; per-hot-conversation ceiling similar to here
  (~100+/s) if the disk fsyncs comparably, lower on slow cloud block storage.
- Logins/registrations: **~5–7/s** sustained, and watch RAM — argon2id at
  m=64MiB × 4 threadpool lanes can spike ~256 MB; on a 2 GB box consider
  `UV_THREADPOOL_SIZE=2` for the api process (halves login throughput, halves the spike).
- Postgres `shared_buffers` 256–512 MB. This fits a community of a few thousand
  registered users with hundreds online at once.

**8 GB / 4 vCPU VPS (all services, dedicated)** — *derived*:
- At least the numbers in §2 (they were measured with the client stealing CPU):
  **2,000+ concurrent sockets, ~200–250 msg/s aggregate, ~125 msg/s inside any
  single conversation, ~40 heavy syncs/s.** File-descriptor limits (`ulimit -n`)
  become the socket cap before memory does.
- That is a few tens of thousands of registered users with ~2–5k simultaneously
  connected, provided no single group chat needs >125 msg/s (it won't — that is
  ~2 messages per member per second in a 50-member group).

The honest summary: **one modest VPS holds this product far past the point
where a v0.3 social graph can realistically generate the load.** The first real
wall is social, not technical: a single conversation hot enough to exceed ~125
msg/s, or a login stampede after downtime.

---

## 4. The single-api-replica constraint (and the documented way out)

`ARCHITECTURE.md §3` is already honest about this: the WS socket registry
(`apps/server/src/ws/registry.ts`) is in-process, so **api runs at exactly 1
replica**. Everything the gateway fans out already flows through the Redis
`events` channel (`ws/events.ts` → `ws/gateway.ts` subscriber), so N replicas
subscribe-and-filter with **no protocol change**. What actually has to move
when that day comes:

1. **Nothing in fan-out** — `publishToUsers` / `presence` / `session_close`
   envelopes are already broadcast; every replica routes to whatever sockets it
   holds. This was verified under load: all delivery already crosses Redis.
2. **The push-enqueue decision** (`messages/service.ts` `fanOutNewMessage`):
   "does this user have a live socket" is answered by the in-process registry.
   With N replicas that truth must come from shared state (Redis presence with
   the grace-window caveat the code itself documents, or a registry keyspace).
3. **Receipt coalescing timers** (`ws/events.ts`) are per-process; N replicas
   would coalesce per-replica — correct but N× chattier. Fine at small N.
4. The sticky part is none of these: it is that **per-conversation throughput
   does not change** with more replicas — the seq row lock (H1) lives in
   Postgres. Replicas buy concurrent *conversations*, sockets, and syncs.

Until a single event loop saturating at ~220 msg/s aggregate is actually the
problem (see §3 — it is a long way off), stay at 1 replica.

---

## 5. Postgres knobs that matter for THIS schema

Stock 16.x config was used for all measurements; these are the levers in rough
order of real-world payoff for this workload:

- **`shared_buffers`**: default 128 MB. Set to ~25% of box RAM. The whole hot
  set (participants, watermarks, recent messages) is small; this mostly keeps
  index pages resident.
- **Commit latency IS the per-conversation ceiling.** The seq transaction holds
  the conversation row lock until commit, so one conversation's max msg/s ≈
  1 / (commit fsync time). Fast local NVMe matters more than any GUC. Do **not**
  be tempted by `synchronous_commit=off` to raise it — an acked message that
  evaporates on crash breaks the gapless-seq contract clients sync against
  (`after_seq` would skip a seq that later reappears… or never does).
- **Fillfactor on the churn tables.** Every send UPDATEs `conversations`
  (last_seq) and every receipt UPDATEs `conversation_participants` — both are
  100%-fillfactor tables whose updates are HOT-eligible (no indexed columns
  change). `ALTER TABLE conversations SET (fillfactor=70);` same for
  `conversation_participants`, keeps those updates HOT and off the index-churn
  path as the tables grow.
- **Autovacuum**: same two tables are update-heavy; lower their
  `autovacuum_vacuum_scale_factor` (e.g. 0.02) so bloat never builds between
  nightly lulls.
- **`max_connections`**: leave near default. The api opens a pool of **10**
  (`db/index.ts`), the worker a handful more. Do not raise the pool first when
  things feel slow — at 4 cores, 10 was never the bottleneck (PG CPU pegged
  before pool exhaustion only in the receipt storm, which is an app-side issue, H4).
- **`pg_stat_statements`**: enable it (`shared_preload_libraries`) in every
  deploy. Every hotspot in §7 was found with it in minutes. It is enabled in
  the load-test database already.
- `work_mem` default 4 MB is plenty — every query this app runs is a sub-ms
  index scan (verified: history page 0.11 ms, idempotency check 0.08 ms,
  reactions tuple-IN 0.14 ms index-only, blocks UNION 0.11 ms).

---

## 6. Runbook: "the app feels slow"

Work down this list; each step was the actual cause of a slowdown reproduced
during the load run.

1. **`top` on the box. Is the api node process near 100% of one core?**
   That is its ceiling (single event loop — it will never use 400%).
   - If yes with modest user count → suspect a receipt storm (H4) or a heavy
     sync loop: `ss -tn | wc -l` for socket count, then look for one client
     spamming frames (gateway strikes only punish malformed frames, not volume).
2. **Is exactly one group chat slow while the rest is fine?** Expected once a
   single conversation needs >~125 msg/s: sends serialize on the seq lock (H1).
   Confirm in PG: `SELECT wait_event_type, count(*) FROM pg_stat_activity GROUP BY 1`
   — a pile-up of `Lock` waits on the same conversation row is the signature.
   There is no knob; this is the ordering guarantee costing what it costs.
3. **`pg_stat_statements` top-5 by `total_exec_time`.** In a healthy system the
   seq UPDATE leads with a sub-ms mean. A mean in the tens of ms = lock
   contention (step 2) or slow fsync (check disk latency, `checkpoint` logs).
4. **Redis memory climbing?** (`redis-cli info memory`) — the push/unfurl/media
   queues are backing up: the **worker is down or wedged**. Restart it; jobs are
   durable (AOF) and guarded against stale delivery (presence/read re-checks at
   execution).
5. **Everyone reconnecting at once** (after an api restart/deploy): expect a
   burst of upgrade auth queries + `GET /sync` per client + argon2 logins for
   expired sessions at only ~14/s. This self-drains; measured sync held 125/s
   *while* 100 msg/s of sends ran. If deploys hurt, stagger client reconnect
   jitter before buying hardware.
6. **RSS of the api process** is normally ~120–170 MB and barely moves with
   socket count. If it is far above that and climbing, something is buffering
   (one slow consumer socket with a huge send queue — `ws` buffers in process
   memory; the 326 MB peak in the receipt storm was exactly this).

---

## 7. Hotspots — proven under load (documented, deliberately not "fixed")

- **H1 — The gapless-seq row lock serializes each conversation.**
  `messages/service.ts` `insertMessage` holds the `conversations` row lock from
  `last_seq + 1` to commit. Proof: with 25 concurrent senders on ONE
  conversation the seq UPDATE's mean exec time is **56.9 ms** (lock wait); the
  identical statement across 50 conversations: **0.12 ms** (474× less). Ceiling
  measured at ~125 msg/s per conversation, independent of concurrency. This is
  the price of the ordering/sync/receipt model and it is a *good* trade — but
  it is the number to know.
- **H2 — Send cost is O(participants), twice.** Each send loads the participant
  list, then (a) publishes one envelope but (b) enqueues **one BullMQ job per
  offline participant** behind a presence-EXISTS pipeline (`fanOutNewMessage`).
  Proof: 50-member conversation = 122 msg/s; 9-member = 207 msg/s; with all 50
  members online (no push jobs) the same test gains 14% throughput and Redis
  CPU drops 30% → 1.6%. At the 256-member cap a fully-offline group costs ~5×
  big50's enqueue work per message. Phase-2 channels cannot ride this path (the
  docs already say so).
- **H3 — Heavy `GET /sync` payloads.** A 60-conversation user's sync is 250 KB
  and 38 ms (vs 4.7 KB / 14 ms light), and serialization pins the event loop:
  42 req/s at c=10 with api CPU >100%. Most of the bytes are **full
  `UserPublic` DTOs for every participant of every conversation** — big50 alone
  contributes 50. The queries are fine (lateral last-message scan: 0.28 ms);
  the cost is JSON mass. Watch it as groups multiply; a reconnect storm
  multiplies it by every online user.
- **H4 — Inbound `read`/`delivered` frames are unthrottled and O(N²) on
  fan-out.** Each frame costs 4 queries; the 1 s coalescer bounds *outbound*
  frames per reader, so a 50-member group where everyone reads still emits
  ~2,250 receipt frames/s (50 readers × ~45 coalesced publishes/s), and nothing
  bounds *inbound* rate at all: 20 frames/s/client from 50 clients (987/s) pegged
  both API and PG and delayed a message send to **6.3 s**. One buggy or hostile
  client can do this alone from a single group membership. (The WS strike
  system only counts malformed frames, not frequency.)
- **H5 — argon2 at the front door.** 12.9 registers/s / 14 logins/s is the
  whole box's capacity (by parameter choice — m=64MiB t=3 is the right
  security call). The per-IP limiter protects it against strangers but not
  against a legitimate thundering herd (mass session expiry). Each concurrent
  hash also holds 64 MB; the 4-lane libuv default bounds that at 256 MB.
- **Explicitly NOT hotspots** (checked and cleared): message history pagination
  (PK backward scan, 0.11 ms), the idempotency replay check
  (`messages_idempotency_idx`, 0.08 ms), reaction aggregates (index-only,
  0.14 ms), blocks lookups (0.11 ms), presence churn (p95 14.6 ms end-to-end at
  2,000 sockets), and idle socket mass (2,000 sockets ≈ +1 MB RSS, 13% CPU).

---

*Method note: load tooling (autocannon 7.15.0 + a raw `ws` client) ran from a
scratch directory outside the repo; users were seeded directly in Postgres with
a real argon2id hash; sessions were pre-minted so WS tests exercise the genuine
cookie-auth upgrade path. Register/login bursts bypassed the per-IP limiter via
`X-Forwarded-For` (the app runs `trustProxy: true` behind Caddy), which is why
those numbers measure argon2, not the limiter — the limiter's own rejection
path was measured separately at ~5,000 req/s.*
