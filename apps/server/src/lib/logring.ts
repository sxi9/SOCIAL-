// Admin log ring (v0.5b — API.md §1.41, ADR-013). A capped Redis list
// (LPUSH + LTRIM to LOG_RING_MAX) holding pino warn+error entries from api and
// worker PLUS every admin action (level 'admin', always written). Telemetry,
// not product data: it lives in Redis on purpose — losing it loses nothing a
// user owns (ADR-013). Entries are AdminLogEntry-shaped JSON strings.
import { Writable } from 'node:stream';
import { ADMIN_LOG_LEVELS, LOG_RING_MAX, type AdminLogEntry } from '@socialchat/shared';
import { redis } from '../redis.js';

export const LOG_RING_KEY = 'admin:logring';

/** Fire-and-forget LPUSH + LTRIM — the ring must never fail a request. */
export function pushRingEntry(entry: AdminLogEntry): void {
  try {
    void redis
      .multi()
      .lpush(LOG_RING_KEY, JSON.stringify(entry))
      .ltrim(LOG_RING_KEY, 0, LOG_RING_MAX - 1)
      .exec()
      .catch(() => {});
  } catch {
    /* redis down — stdout still has the line */
  }
}

/** EVERY admin action goes through here (API.md §1.41 — always written). */
export function adminLog(
  actor: { id: string; username: string },
  msg: string,
  data?: Record<string, unknown>,
): void {
  pushRingEntry({
    ts: new Date().toISOString(),
    level: 'admin',
    msg,
    actor: { id: actor.id, username: actor.username },
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  });
}

/** Worker-side error reporting (the worker has no fastify/pino instance). */
export function ringError(msg: string, data?: Record<string, unknown>): void {
  pushRingEntry({
    ts: new Date().toISOString(),
    level: 'error',
    msg,
    actor: null,
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  });
}

// Pino numeric levels: warn = 40, error = 50, fatal = 60.
const PINO_WARN = 40;

/**
 * The api's pino sink: every line still reaches stdout verbatim (docker logs
 * stay the primary stream); warn+ lines are additionally parsed and mirrored
 * into the ring. Wired as the fastify `logger.stream` in app.ts — a hook on
 * the destination, not on the logger, so child loggers (req.log) are covered.
 */
export function createRingLogStream(out: NodeJS.WritableStream = process.stdout): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.write(chunk);
      try {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line) continue;
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const level = parsed.level;
          if (typeof level !== 'number' || level < PINO_WARN) continue;
          const { level: _l, time, msg, pid: _p, hostname: _h, ...rest } = parsed;
          pushRingEntry({
            ts: new Date(typeof time === 'number' ? time : Date.now()).toISOString(),
            level: level >= 50 ? 'error' : 'warn',
            msg: typeof msg === 'string' ? msg : '',
            actor: null,
            ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
          });
        }
      } catch {
        /* non-JSON log line — stdout already has it */
      }
      cb();
    },
  });
}

/** Offset-paged ring read (newest first — a ring has no stable cursors). */
export async function readLogRing(
  offset: number,
  limit: number,
): Promise<{ entries: AdminLogEntry[]; next_offset: number | null }> {
  const [raw, total] = await Promise.all([
    redis.lrange(LOG_RING_KEY, offset, offset + limit - 1),
    redis.llen(LOG_RING_KEY),
  ]);
  const entries: AdminLogEntry[] = [];
  for (const s of raw) {
    try {
      const e = JSON.parse(s) as AdminLogEntry;
      if (typeof e.ts === 'string' && (ADMIN_LOG_LEVELS as readonly string[]).includes(e.level)) {
        entries.push({ ...e, actor: e.actor ?? null });
      }
    } catch {
      /* skip corrupt entry */
    }
  }
  const next = offset + raw.length;
  return { entries, next_offset: next < total ? next : null };
}
