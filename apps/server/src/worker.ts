// Entrypoint: BullMQ consumers (ARCHITECTURE §2/§3) — queues avatar | media |
// unfurl | push | gc | beacons. Same image as the api; node dist/worker.js.
import { Worker, type Job } from 'bullmq';
import { processAvatarJob } from './jobs/avatar.js';
import { processBeaconsJob } from './jobs/beacons.js';
import { runGc } from './jobs/gc.js';
import { processMediaJob } from './jobs/media.js';
import { initWebPush, processPushJob } from './jobs/push.js';
import { processTimersJob } from './jobs/timers.js';
import { processUnfurlJob } from './jobs/unfurl.js';
import {
  DISAPPEAR_SWEEP_INTERVAL_S,
  LISTING_SWEEP_INTERVAL_S,
  MOOD_SWEEP_INTERVAL_S,
  ROULETTE_PAIR_INTERVAL_S,
  ROULETTE_SWEEP_INTERVAL_S,
  STORY_SWEEP_INTERVAL_S,
} from '@socialchat/shared';
import { processDiscoveryJob } from './jobs/discovery.js';
import { ringError } from './lib/logring.js';
import type { AvatarJob, BeaconsJob, DiscoveryJob, MediaJob, PushJob, TimersJob, UnfurlJob } from './queues.js';
import { beaconsQueue, discoveryQueue, gcQueue, timersQueue } from './queues.js';
import { createRedis } from './redis.js';

async function main(): Promise<void> {
  const pushEnabled = initWebPush();
  if (!pushEnabled) console.warn('worker: VAPID keys missing — push queue is a no-op');

  const workers: Worker[] = [
    new Worker<AvatarJob>('avatar', async (job) => processAvatarJob(job.data), {
      connection: createRedis(),
      concurrency: 2, // ffmpeg-heavy
    }),
    new Worker<MediaJob>(
      'media',
      async (job: Job<MediaJob>) =>
        processMediaJob(job.data, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
      { connection: createRedis(), concurrency: 2 },
    ),
    new Worker<UnfurlJob>('unfurl', async (job) => processUnfurlJob(job.data), {
      connection: createRedis(),
      concurrency: 5,
    }),
    new Worker<PushJob>('push', async (job) => processPushJob(job.data), {
      connection: createRedis(),
      concurrency: 10,
    }),
    new Worker('gc', async () => runGc(), { connection: createRedis(), concurrency: 1 }),
    // v0.3 (ARCHITECTURE §10): beacon-expire | beacon-ritual | beacon-afterglow.
    new Worker<BeaconsJob>('beacons', async (job: Job<BeaconsJob>) => processBeaconsJob(job.name, job.data), {
      connection: createRedis(),
      concurrency: 2,
    }),
    // v0.4 (API.md §1.25/§1.26): disappear-sweep | scheduled-deliver |
    // scheduled-sweep. Delivery is claim-guarded, so concurrency is safe.
    // v0.6 (§1.42) adds call-ring-timeout | call-ring-sweep (guarded flips).
    new Worker<TimersJob>('timers', async (job: Job<TimersJob>) => processTimersJob(job.name, job.data), {
      connection: createRedis(),
      concurrency: 4,
    }),
    // v0.6 (API.md §1.44/§1.45): discovery-sweep | roulette-pair |
    // roulette-sweep. Concurrency 1 — the pairing pass owns the queue; two
    // concurrent passes could double-pair one user.
    new Worker<DiscoveryJob>('discovery', async (job: Job<DiscoveryJob>) => processDiscoveryJob(job.name, job.data), {
      connection: createRedis(),
      concurrency: 1,
    }),
  ];

  for (const w of workers) {
    // v0.5b (§1.41): worker failures mirror into the admin log ring too.
    w.on('failed', (job, err) => {
      console.error(`worker[${w.name}]: job ${job?.id ?? '?'} failed:`, err.message);
      ringError(`worker[${w.name}]: job failed`, { job_id: job?.id ?? null, err: err.message });
    });
    w.on('error', (err) => {
      console.error(`worker[${w.name}]: error:`, err.message);
      ringError(`worker[${w.name}]: error`, { err: err.message });
    });
  }

  // Nightly repeatable GC at 04:00 UTC.
  await gcQueue.add(
    'gc',
    {},
    { repeat: { pattern: '0 4 * * *' }, jobId: 'gc-nightly', removeOnComplete: 10, removeOnFail: 10 },
  );

  // v0.3 repeatable beacon jobs (API.md §1.15): 1-min expiry sweep, hourly
  // ritual re-creation, and the afterglow safety sweep backing the per-spark
  // delayed jobs.
  await beaconsQueue.add(
    'beacon-expire',
    {},
    { repeat: { every: 60_000 }, jobId: 'beacon-expire', removeOnComplete: 10, removeOnFail: 10 },
  );
  await beaconsQueue.add(
    'beacon-ritual',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'beacon-ritual', removeOnComplete: 10, removeOnFail: 10 },
  );
  await beaconsQueue.add(
    'beacon-afterglow-sweep',
    {},
    { repeat: { every: 10 * 60_000 }, jobId: 'beacon-afterglow-sweep', removeOnComplete: 10, removeOnFail: 10 },
  );
  // v0.7 (API.md §1.47): the T-30min "starting soon" ping sweep — every
  // minute over beacons_starting_soon_idx; push only, claimed once per beacon.
  await beaconsQueue.add(
    'beacon-starting-soon',
    {},
    { repeat: { every: 60_000 }, jobId: 'beacon-starting-soon', removeOnComplete: 10, removeOnFail: 10 },
  );

  // v0.4 repeatable timers (API.md §1.25/§1.26): the disappearing-messages
  // tombstone sweep and the scheduled-delivery minute safety net.
  await timersQueue.add(
    'disappear-sweep',
    {},
    {
      repeat: { every: DISAPPEAR_SWEEP_INTERVAL_S * 1000 },
      jobId: 'disappear-sweep',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );
  await timersQueue.add(
    'scheduled-sweep',
    {},
    { repeat: { every: 60_000 }, jobId: 'scheduled-sweep', removeOnComplete: 10, removeOnFail: 10 },
  );

  // v0.5a (API.md §1.34): expired stories hard-delete silently (rows + views +
  // attachment + refcount-guarded MinIO objects) — no fan-out, no event.
  await timersQueue.add(
    'story-sweep',
    {},
    {
      repeat: { every: STORY_SWEEP_INTERVAL_S * 1000 },
      jobId: 'story-sweep',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );

  // v0.5b (API.md §1.38): hourly listing expiry sweep — bookkeeping only,
  // board reads filter expires_at live; no fan-out, no push (pull-based board).
  await timersQueue.add(
    'listing-sweep',
    {},
    {
      repeat: { every: LISTING_SWEEP_INTERVAL_S * 1000 },
      jobId: 'listing-sweep',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );

  // v0.6 (API.md §1.42): the ring-timeout safety sweep backing the per-call
  // delayed jobs (a Redis wipe must not leave calls ringing forever).
  await timersQueue.add(
    'call-ring-sweep',
    {},
    { repeat: { every: 60_000 }, jobId: 'call-ring-sweep', removeOnComplete: 10, removeOnFail: 10 },
  );

  // v0.8a (API.md §1.57): mood expiry bookkeeping (reads already filter
  // mood_expires_at live — never a stale chip) + the 🎢 swing rotation walk
  // over users_mood_swing_idx. Moods never push; fan-out is user.updated only.
  await timersQueue.add(
    'mood-sweep',
    {},
    {
      repeat: { every: MOOD_SWEEP_INTERVAL_S * 1000 },
      jobId: 'mood-sweep',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );
  await timersQueue.add(
    'mood-swing-sweep',
    {},
    { repeat: { every: 60_000 }, jobId: 'mood-swing-sweep', removeOnComplete: 10, removeOnFail: 10 },
  );

  // v0.6 (API.md §1.44/§1.45): discovery bookkeeping + the roulette loop.
  await discoveryQueue.add(
    'discovery-sweep',
    {},
    { repeat: { every: 10 * 60_000 }, jobId: 'discovery-sweep', removeOnComplete: 10, removeOnFail: 10 },
  );
  await discoveryQueue.add(
    'roulette-pair',
    {},
    {
      repeat: { every: ROULETTE_PAIR_INTERVAL_S * 1000 },
      jobId: 'roulette-pair',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );
  await discoveryQueue.add(
    'roulette-sweep',
    {},
    {
      repeat: { every: ROULETTE_SWEEP_INTERVAL_S * 1000 },
      jobId: 'roulette-sweep',
      removeOnComplete: 10,
      removeOnFail: 10,
    },
  );

  console.log(
    'worker: consuming queues avatar | media | unfurl | push | gc | beacons | timers | discovery',
  );

  const shutdown = async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('worker: failed to start', err);
  process.exit(1);
});
