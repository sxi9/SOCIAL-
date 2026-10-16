// Redis "events" channel — EVERY server→client event is published here and
// fanned out by the gateway subscriber, so multi-node stays a config change
// (ARCHITECTURE §3 scaling honesty).
import type { ReceiptEvent, ServerEvent } from '@socialchat/shared';
import { RECEIPT_COALESCE_MS } from '@socialchat/shared';
import { redis } from '../redis.js';

export const EVENTS_CHANNEL = 'events';

export type EventEnvelope =
  | { scope: 'users'; user_ids: string[]; event: ServerEvent }
  | { scope: 'presence'; user_id: string; event: ServerEvent }
  | { scope: 'session_close'; session_id: string; code: number }
  | { scope: 'user_sessions_close'; user_id: string; code: number };

export async function publishEnvelope(env: EventEnvelope): Promise<void> {
  await redis.publish(EVENTS_CHANNEL, JSON.stringify(env));
}

export function publishToUsers(userIds: string[], event: ServerEvent): Promise<void> {
  if (userIds.length === 0) return Promise.resolve();
  return publishEnvelope({ scope: 'users', user_ids: userIds, event });
}

export function publishPresence(userId: string, online: boolean, lastSeenAt?: string): Promise<void> {
  return publishEnvelope({
    scope: 'presence',
    user_id: userId,
    event: { t: 'presence', d: { user_id: userId, online, ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}) } },
  });
}

export function publishSessionClose(sessionId: string, code: number): Promise<void> {
  return publishEnvelope({ scope: 'session_close', session_id: sessionId, code });
}

export function publishUserSessionsClose(userId: string, code: number): Promise<void> {
  return publishEnvelope({ scope: 'user_sessions_close', user_id: userId, code });
}

// ---------------------------------------------------------------------------
// Receipt coalescing (API.md §2.3): at most one `receipt` per
// (conversation, user) per 1000 ms — leading publish, trailing flush,
// nothing lost (watermarks are monotonic state, latest wins).
// ---------------------------------------------------------------------------

type ReceiptD = ReceiptEvent['d'];

interface PendingReceipt {
  d: ReceiptD;
  recipients: string[];
}

const receiptTimers = new Map<string, NodeJS.Timeout>();
const receiptPending = new Map<string, PendingReceipt>();

function flushReceipt(key: string): void {
  const pending = receiptPending.get(key);
  if (pending) {
    receiptPending.delete(key);
    void publishToUsers(pending.recipients, { t: 'receipt', d: pending.d });
    const timer = setTimeout(() => flushReceipt(key), RECEIPT_COALESCE_MS);
    timer.unref();
    receiptTimers.set(key, timer);
  } else {
    receiptTimers.delete(key);
  }
}

export function queueReceipt(d: ReceiptD, recipients: string[]): void {
  const key = `${d.conversation_id}:${d.user_id}`;
  if (!receiptTimers.has(key)) {
    void publishToUsers(recipients, { t: 'receipt', d });
    const timer = setTimeout(() => flushReceipt(key), RECEIPT_COALESCE_MS);
    timer.unref();
    receiptTimers.set(key, timer);
  } else {
    receiptPending.set(key, { d, recipients });
  }
}
