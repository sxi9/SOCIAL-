import { Queue } from 'bullmq';
import { createRedis } from './redis.js';

// Queue names (ARCHITECTURE §3): avatar | media | unfurl | push | gc
export type AvatarTarget = { user_id: string } | { conversation_id: string };

export interface AvatarJob {
  target: AvatarTarget;
  raw_key: string;
  mime: string;
}

export interface MediaJob {
  attachment_id: string;
}

export interface UnfurlJob {
  url: string;
  url_hash: string;
  requested_by: string;
  // Set when the unfurl was triggered by a sent message (URL extracted from
  // body): on success the snapshot is written into the message and recipients
  // get msg.updated.
  message?: { id: string; conversation_id: string };
}

// v0.3: push jobs are a union — ordinary message pushes plus beacon pushes
// (beacon.new to offline audience, spark, re-ping, kudos; API.md §1.15). Both
// run the §2.9-style guards at execution (presence, debounce).
export interface MessagePushJob {
  kind?: 'message';
  user_id: string;
  conversation_id: string;
  message_id: string;
  seq: number;
}

export interface BeaconPushJob {
  kind: 'beacon';
  user_id: string;
  beacon_id: string;
  title: string;
  body: string;
  url: string;
}

// v0.5a (§1.28): connection request/accept pushes — the only social-layer
// pushes that exist (stories and posts NEVER push; §1.34/§1.36). Guards:
// presence + per-dedupe_key debounce, re-checked at execution.
export interface SocialPushJob {
  kind: 'social';
  user_id: string;
  dedupe_key: string;
  title: string;
  body: string;
  url: string;
}

// v0.6 (§1.42): the missed-call push — runs the UNCHANGED §2.9 guards at
// execution (presence, read-elsewhere via `seq` = the missed-call system
// message's seq, muted_until, per-(user, conversation) debounce; the block
// belt re-checks initiator⊥target). Title/body are computed at execution.
export interface CallPushJob {
  kind: 'call';
  user_id: string;
  conversation_id: string;
  /** seq of the missed-call system message (the read-elsewhere guard). */
  seq: number;
  initiator_id: string | null;
  call_kind: 'audio' | 'video';
}

// v0.7.1 (§1.55 + §2.9, ADR-017, FEATURES #88): the incoming-call RING push —
// enqueued at call create for every callee the structural guards allow who has
// no live socket (a live socket rings via call.invite). The worker re-checks
// at execution: presence, membership, muted_until (NO mention-style override —
// a call is not a mention), the block belt, the call STILL RINGING (a handled
// call must never ring late), and a per-(user, call) debounce. Title/body are
// computed at execution; sent with TTL=CALL_RING_PUSH_TTL_S + Urgency: high.
export interface CallRingPushJob {
  kind: 'call_ring';
  user_id: string;
  call_id: string;
  conversation_id: string;
  initiator_id: string | null;
  call_kind: 'audio' | 'video';
  is_group: boolean;
}

// v0.7.1 (§1.55 + §2.9): the silent RETRACTION — "the call was handled
// somewhere". No guards at all (closing a stale ring is always right); the
// service worker closes the notification by tag and displays nothing. Sent to
// exactly the users the ring went to (the Redis `call:{id}:rang` set).
export interface CallRingStopPushJob {
  kind: 'call_ring_stop';
  user_id: string;
  call_id: string;
}

// v0.6 (§1.46): the ONE push that bypasses the §2.9 guards — presence,
// read-elsewhere and debounce SKIPPED, muted_until OVERRIDDEN (the §1.33
// mention precedent: an SOS from a friend outranks a per-chat mute). Blocks
// stay structural: the route's friends-of gate excludes blocked pairs before
// any enqueue; the worker re-checks as the belt.
export interface RescuePushJob {
  kind: 'rescue';
  user_id: string;
  sender_id: string;
  conversation_id: string;
  title: string;
  body: string;
}

export type PushJob =
  | MessagePushJob
  | BeaconPushJob
  | SocialPushJob
  | CallPushJob
  | CallRingPushJob
  | CallRingStopPushJob
  | RescuePushJob;

export type GcJob = Record<string, never>;

// v0.3 queue `beacons` (ARCHITECTURE §10): beacon-expire (1-min sweep),
// beacon-ritual (hourly), beacon-afterglow (delayed per spark + safety sweep).
export interface BeaconAfterglowJob {
  beacon_id: string;
}
export type BeaconsJob = BeaconAfterglowJob | Record<string, never>;

// v0.4 queue `timers` (API.md §1.25/§1.26): disappear-sweep (repeatable),
// scheduled-deliver (delayed per row) + scheduled-sweep (minute safety net).
export interface ScheduledDeliverJob {
  scheduled_id: string;
}
// v0.6 (§1.42): call-ring-timeout — one delayed job per ringing call
// (CALL_RING_TIMEOUT_S), backed by the repeatable call-ring-sweep safety net
// over calls_ringing_idx (the scheduled-deliver pattern; the flip is a
// guarded UPDATE, so job/sweep races can never double-run the missed-call
// machinery).
export interface CallRingTimeoutJob {
  call_id: string;
}
export type TimersJob = ScheduledDeliverJob | CallRingTimeoutJob | Record<string, never>;

// v0.6 queue `discovery` (API.md §1.44/§1.45, ADR-015): discovery-sweep
// (prunes lapsed opt-ins + stale waves — bookkeeping, reads filter live),
// roulette-pair (every ROULETTE_PAIR_INTERVAL_S) and roulette-sweep (the
// provisional-DM hard-delete, every ROULETTE_SWEEP_INTERVAL_S). All
// repeatable, no per-item jobs.
export type DiscoveryJob = Record<string, never>;

export const queueConnection = createRedis();
const connection = queueConnection;

export const avatarQueue = new Queue<AvatarJob>('avatar', { connection });
export const mediaQueue = new Queue<MediaJob>('media', { connection });
export const unfurlQueue = new Queue<UnfurlJob>('unfurl', { connection });
export const pushQueue = new Queue<PushJob>('push', { connection });
export const gcQueue = new Queue<GcJob>('gc', { connection });
export const beaconsQueue = new Queue<BeaconsJob>('beacons', { connection });
export const timersQueue = new Queue<TimersJob>('timers', { connection });
export const discoveryQueue = new Queue<DiscoveryJob>('discovery', { connection });

const defaultJobOpts = {
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;

export function enqueueAvatar(job: AvatarJob) {
  return avatarQueue.add('avatar', job, { ...defaultJobOpts, attempts: 1 });
}

export function enqueueMedia(job: MediaJob) {
  return mediaQueue.add('media', job, {
    ...defaultJobOpts,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

export function enqueueUnfurl(job: UnfurlJob) {
  // Duplicate suppression lives in the link_previews row state (pending/ok/
  // failed), not in jobIds — expired-row refetches stay possible.
  return unfurlQueue.add('unfurl', job, { ...defaultJobOpts, attempts: 1 });
}

export function enqueuePush(job: MessagePushJob, opts: { delayMs?: number } = {}) {
  return pushQueue.add('push', job, {
    ...defaultJobOpts,
    attempts: 2,
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
  });
}

/** Send-path fan-out (hotspot H2): ONE Redis round trip (addBulk pipelines
 * internally) instead of one queue.add per offline participant. */
export function enqueuePushBulk(jobs: { job: MessagePushJob; delayMs?: number }[]) {
  if (jobs.length === 0) return Promise.resolve([]);
  return pushQueue.addBulk(
    jobs.map(({ job, delayMs }) => ({
      name: 'push',
      data: job,
      opts: { ...defaultJobOpts, attempts: 2, ...(delayMs ? { delay: delayMs } : {}) },
    })),
  );
}

export function enqueueBeaconPush(job: BeaconPushJob) {
  return pushQueue.add('beacon-push', job, { ...defaultJobOpts, attempts: 2 });
}

export function enqueueSocialPush(job: SocialPushJob) {
  return pushQueue.add('social-push', job, { ...defaultJobOpts, attempts: 2 });
}

/** Beacon fan-out can target a whole audience — same single-round-trip rule. */
export function enqueueBeaconPushBulk(jobs: BeaconPushJob[]) {
  if (jobs.length === 0) return Promise.resolve([]);
  return pushQueue.addBulk(
    jobs.map((data) => ({ name: 'beacon-push', data, opts: { ...defaultJobOpts, attempts: 2 } })),
  );
}

/** Scheduled delivery (API.md §1.26): one delayed job per row; the minute
 * sweep is the safety net. Delivery itself is idempotent (guarded claim), so
 * a job/sweep race or retry can never double-send. */
export function enqueueScheduledDelivery(scheduledId: string, delayMs: number) {
  return timersQueue.add(
    'scheduled-deliver',
    { scheduled_id: scheduledId },
    {
      ...defaultJobOpts,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      delay: Math.max(0, delayMs),
      jobId: `scheduled:${scheduledId}`,
    },
  );
}

/** v0.6 (§1.42): the 45 s ring-timeout job — one per ringing call (jobId
 * dedupes retries); the repeatable call-ring-sweep remains the safety net
 * against a Redis wipe. */
export function enqueueCallRingTimeout(callId: string, delayMs: number) {
  return timersQueue.add(
    'call-ring-timeout',
    { call_id: callId },
    {
      ...defaultJobOpts,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      delay: Math.max(0, delayMs),
      jobId: `callring:${callId}`,
    },
  );
}

/** v0.6 (§1.42): missed-call pushes — one addBulk round trip (hotspot H2). */
export function enqueueCallPushBulk(jobs: CallPushJob[]) {
  if (jobs.length === 0) return Promise.resolve([]);
  return pushQueue.addBulk(
    jobs.map((data) => ({ name: 'call-push', data, opts: { ...defaultJobOpts, attempts: 2 } })),
  );
}

/** v0.7.1 (§1.55/§2.9): ring pushes for a starting call — one addBulk round
 * trip (hotspot H2), attempts: 1 (a retried ring could fire after the stop
 * already retracted it; the worker's still-ringing re-check is per attempt,
 * but a ring is time-critical ephemera — better never than late). */
export function enqueueCallRingPushBulk(jobs: CallRingPushJob[]) {
  if (jobs.length === 0) return Promise.resolve([]);
  return pushQueue.addBulk(
    jobs.map((data) => ({ name: 'call-ring-push', data, opts: { ...defaultJobOpts, attempts: 1 } })),
  );
}

/** v0.7.1 (§1.55/§2.9): the silent stop push — retries allowed (closing a
 * notification twice is harmless; failing to close one leaves a lying ring). */
export function enqueueCallRingStopPushBulk(jobs: CallRingStopPushJob[]) {
  if (jobs.length === 0) return Promise.resolve([]);
  return pushQueue.addBulk(
    jobs.map((data) => ({
      name: 'call-ring-stop-push',
      data,
      opts: { ...defaultJobOpts, attempts: 2 },
    })),
  );
}

/** v0.6 (§1.46): the rescue SOS push — enqueued for EVERY target, online or
 * not (the point is a buzzing phone); the worker skips the §2.9 guards. */
export function enqueueRescuePush(job: RescuePushJob) {
  return pushQueue.add('rescue-push', job, { ...defaultJobOpts, attempts: 2 });
}

/** Afterglow recap: delayed to expires_at + 2 h (plus a worker safety sweep). */
export function enqueueAfterglow(beaconId: string, delayMs: number) {
  return beaconsQueue.add(
    'beacon-afterglow',
    { beacon_id: beaconId },
    {
      ...defaultJobOpts,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      delay: Math.max(0, delayMs),
      // One delayed job per beacon; the sweep remains the safety net.
      jobId: `afterglow:${beaconId}`,
    },
  );
}
