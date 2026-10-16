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

export type PushJob = MessagePushJob | BeaconPushJob;

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
export type TimersJob = ScheduledDeliverJob | Record<string, never>;

export const queueConnection = createRedis();
const connection = queueConnection;

export const avatarQueue = new Queue<AvatarJob>('avatar', { connection });
export const mediaQueue = new Queue<MediaJob>('media', { connection });
export const unfurlQueue = new Queue<UnfurlJob>('unfurl', { connection });
export const pushQueue = new Queue<PushJob>('push', { connection });
export const gcQueue = new Queue<GcJob>('gc', { connection });
export const beaconsQueue = new Queue<BeaconsJob>('beacons', { connection });
export const timersQueue = new Queue<TimersJob>('timers', { connection });

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
