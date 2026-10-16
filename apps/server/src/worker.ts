// Entrypoint: BullMQ consumers (ARCHITECTURE §2/§3) — queues avatar | media |
// unfurl | push | gc. Same image as the api; node dist/worker.js.
import { Worker, type Job } from 'bullmq';
import { processAvatarJob } from './jobs/avatar.js';
import { runGc } from './jobs/gc.js';
import { processMediaJob } from './jobs/media.js';
import { initWebPush, processPushJob } from './jobs/push.js';
import { processUnfurlJob } from './jobs/unfurl.js';
import type { AvatarJob, MediaJob, PushJob, UnfurlJob } from './queues.js';
import { gcQueue } from './queues.js';
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
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`worker[${w.name}]: job ${job?.id ?? '?'} failed:`, err.message);
    });
    w.on('error', (err) => {
      console.error(`worker[${w.name}]: error:`, err.message);
    });
  }

  // Nightly repeatable GC at 04:00 UTC.
  await gcQueue.add(
    'gc',
    {},
    { repeat: { pattern: '0 4 * * *' }, jobId: 'gc-nightly', removeOnComplete: 10, removeOnFail: 10 },
  );

  console.log('worker: consuming queues avatar | media | unfurl | push | gc');

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
