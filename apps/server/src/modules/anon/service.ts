// Anonymous reveal game (v0.8b — API.md §1.62, FEATURES #77, ADR-019).
// The sender is anonymous to the RECIPIENT only, never to the server:
// anon_threads.sender_id is an ordinary FK and this module's DTO stamping is
// the entire anonymity mechanism — role/counterpart resolve PER VIEWER, with
// the recipient's counterpart null until revealed. Timer reveals resolve LIVE
// at read (reveal_at <= now() ⇒ revealed — the §1.44 pattern); the `timers`
// sweep only stamps revealed_at and fans the anon.updated goodbye-blur.
import { eq, sql } from 'drizzle-orm';
import {
  ANON_PUSH_BODY_RECIPIENT,
  ANON_PUSH_BODY_SENDER,
  type AnonMessage,
  type AnonThread,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { enqueueSocialPush } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { registry } from '../../ws/registry.js';

export type AnonThreadRow = typeof schema.anonThreads.$inferSelect;
export type AnonMessageRow = typeof schema.anonMessages.$inferSelect;

const at = schema.anonThreads;
const am = schema.anonMessages;

/** Live reveal resolution (§1.62): stamped, or the timer has run out. */
export function isRevealed(row: AnonThreadRow, now = Date.now()): boolean {
  if (row.revealedAt !== null) return true;
  return row.revealAt !== null && row.revealAt.getTime() <= now;
}

export function anonMessageDto(row: AnonMessageRow): AnonMessage {
  return {
    id: row.id,
    thread_id: row.threadId,
    from_sender: row.fromSender,
    body: row.body,
    is_riddle_answer: row.isRiddleAnswer,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The VIEWER-SPECIFIC thread DTO — the whole game lives here: the recipient's
 * counterpart is NULL until revealed; the sender always sees the recipient
 * (they chose them). No mood on the counterpart chip (no per-viewer ctx on
 * this surface — the §1.57 conservative null).
 */
export function anonThreadDto(
  row: AnonThreadRow,
  viewerId: string,
  sender: UserRow | null,
  recipient: UserRow | null,
  lastMessage: AnonMessageRow | null,
): AnonThread {
  const role = viewerId === row.senderId ? 'sender' : 'recipient';
  const revealed = isRevealed(row);
  const counterpartRow = role === 'sender' ? recipient : revealed ? sender : null;
  return {
    id: row.id,
    role,
    counterpart: counterpartRow ? userLiteDto(counterpartRow) : null,
    reveal_mode: row.revealMode as AnonThread['reveal_mode'],
    reveal_timer_s: row.revealTimerS as AnonThread['reveal_timer_s'],
    reveal_at: row.revealAt ? row.revealAt.toISOString() : null,
    riddle_q: row.riddleQ,
    reveal_requested: row.revealRequestedAt !== null,
    // Live resolution: a lapsed timer reads as revealed even before the
    // sweep stamps it — the stamp time is then the timer's own reveal_at.
    revealed_at: row.revealedAt
      ? row.revealedAt.toISOString()
      : revealed && row.revealAt
        ? row.revealAt.toISOString()
        : null,
    last_message: lastMessage ? anonMessageDto(lastMessage) : null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function loadAnonThread(id: string): Promise<AnonThreadRow | null> {
  const [row] = await db.select().from(at).where(eq(at.id, id)).limit(1);
  return row ?? null;
}

export async function loadLastAnonMessage(threadId: string): Promise<AnonMessageRow | null> {
  const [row] = await db
    .select()
    .from(am)
    .where(eq(am.threadId, threadId))
    .orderBy(sql`${am.createdAt} DESC`)
    .limit(1);
  return row ?? null;
}

async function loadParties(
  row: AnonThreadRow,
): Promise<{ sender: UserRow | null; recipient: UserRow | null }> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${row.senderId}::uuid, ${row.recipientId}::uuid)`);
  return {
    sender: rows.find((u) => u.id === row.senderId) ?? null,
    recipient: rows.find((u) => u.id === row.recipientId) ?? null,
  };
}

/**
 * anon.updated to the TWO parties, each frame VIEWER-STAMPED (§2.3): one
 * envelope never ships one party's view to the other. message rides along on
 * new-message mutations, null otherwise.
 */
export async function fanAnonUpdated(
  row: AnonThreadRow,
  message: AnonMessageRow | null,
): Promise<void> {
  const { sender, recipient } = await loadParties(row);
  const msgDto = message ? anonMessageDto(message) : null;
  for (const viewerId of [row.senderId, row.recipientId]) {
    await publishToUsers([viewerId], {
      t: 'anon.updated',
      d: {
        thread: anonThreadDto(row, viewerId, sender, recipient, message ?? null),
        message: msgDto,
      },
    });
  }
}

/** §2.9-guarded identity-free push to the OTHER party of a new message:
 * enqueued only when they hold no live socket (the fanOutNewMessage rule);
 * the worker re-checks presence + debounces per thread. The copy carries NO
 * identity in either direction, and the deep link is the thread id alone. */
export async function pushAnonMessage(row: AnonThreadRow, toUserId: string): Promise<void> {
  if (registry.userHasSockets(toUserId)) return;
  const title =
    toUserId === row.recipientId ? ANON_PUSH_BODY_RECIPIENT : ANON_PUSH_BODY_SENDER;
  await enqueueSocialPush({
    kind: 'social',
    user_id: toUserId,
    dedupe_key: `anon:${row.id}`,
    title,
    body: '',
    url: `/anon/${row.id}`,
  });
}

/**
 * Timer-reveal sweep (worker, queue `timers`, every ANON_SWEEP_INTERVAL_S):
 * stamps revealed_at where the timer ran out (via anon_threads_reveal_idx)
 * and fans anon.updated — reads already resolve the reveal live, so the
 * sweep's only user-visible act is the goodbye-blur frame.
 */
export async function runAnonRevealSweep(): Promise<void> {
  const revealed = (await db.execute(sql`
    UPDATE anon_threads SET revealed_at = reveal_at
    WHERE revealed_at IS NULL AND reveal_at IS NOT NULL AND reveal_at <= now()
    RETURNING id
  `)) as unknown as { id: string }[];
  for (const r of revealed) {
    const row = await loadAnonThread(r.id);
    if (row) await fanAnonUpdated(row, null);
  }
}
