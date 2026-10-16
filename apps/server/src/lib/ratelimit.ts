// Redis fixed-window rate limiter (ARCHITECTURE §4).
import { redis } from '../redis.js';

export interface RateResult {
  allowed: boolean;
  retryAfterS: number;
}

export async function fixedWindow(key: string, limit: number, windowS: number): Promise<RateResult> {
  const fullKey = `rl:${key}`;
  const count = await redis.incr(fullKey);
  if (count === 1) {
    await redis.expire(fullKey, windowS);
  }
  if (count > limit) {
    const ttl = await redis.ttl(fullKey);
    return { allowed: false, retryAfterS: ttl > 0 ? ttl : windowS };
  }
  return { allowed: true, retryAfterS: 0 };
}
