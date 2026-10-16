import { Redis } from 'ioredis';
import { config } from './config.js';

// General-purpose client (presence, rate limits, stash, pub).
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

// Dedicated connection factory — BullMQ and pub/sub subscribers each need
// their own connection (a subscribed connection cannot run other commands).
export function createRedis(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

export const presenceKey = (userId: string) => `presence:${userId}`;
