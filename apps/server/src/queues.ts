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

export interface PushJob {
  user_id: string;
  conversation_id: string;
  message_id: string;
  seq: number;
}

export type GcJob = Record<string, never>;

export const queueConnection = createRedis();
const connection = queueConnection;

export const avatarQueue = new Queue<AvatarJob>('avatar', { connection });
export const mediaQueue = new Queue<MediaJob>('media', { connection });
export const unfurlQueue = new Queue<UnfurlJob>('unfurl', { connection });
export const pushQueue = new Queue<PushJob>('push', { connection });
export const gcQueue = new Queue<GcJob>('gc', { connection });

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

export function enqueuePush(job: PushJob) {
  return pushQueue.add('push', job, { ...defaultJobOpts, attempts: 2 });
}
