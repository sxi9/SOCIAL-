// Push job (ARCHITECTURE §7 / API.md §2.9). The four guard conditions are all
// re-checked at execution; tag collapses stacked notifications; subscriptions
// prune after 404/410 or 5 consecutive failures. Push acceptance NEVER
// advances last_delivered_seq — the service worker only shows the notification.
import { and, eq, sql } from 'drizzle-orm';
import webpush from 'web-push';
import {
  CALL_RING_PUSH_TAG_PREFIX,
  CALL_RING_PUSH_TTL_S,
  PUSH_DEBOUNCE_S,
  PUSH_KIND_CALL_RING,
  PUSH_KIND_CALL_RING_STOP,
  type CallRingPushPayload,
  type CallRingStopPushPayload,
} from '@socialchat/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { isBlockedPair } from '../lib/blocks.js';
// The pure guard verdicts live in lib/pushGuard.ts (no infra imports — the
// mention/mute/block rules are unit-tested there); re-exported for callers.
import { callRingPushAllowed, messagePushAllowed } from '../lib/pushGuard.js';
export { callRingPushAllowed, messagePushAllowed };
import { CALL_RANG_TTL_S, callRangKey } from '../modules/calls/service.js';
import type {
  BeaconPushJob,
  CallPushJob,
  CallRingPushJob,
  CallRingStopPushJob,
  MessagePushJob,
  PushJob,
  RescuePushJob,
  SocialPushJob,
} from '../queues.js';
import { presenceKey, redis } from '../redis.js';

export function initWebPush(): boolean {
  if (!config.vapid) return false;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  return true;
}

function snippetFor(type: string, body: string | null): string {
  switch (type) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'file':
      return 'File';
    // v0.4 (§1.20/§1.27): fixed snippets — no content leaks into the push.
    case 'audio':
      return 'Voice note';
    case 'game_ttt':
      return 'Tic-tac-toe challenge';
    case 'puzzle_result':
      return 'Puzzle result';
    // v0.7 (§1.52): the fixed location snippet — the place never leaks into
    // the push.
    case 'location':
      return '📍 Location';
    default:
      return (body ?? '').slice(0, 140) || 'New message';
  }
}

async function sendToSubscriptions(
  userId: string,
  payload: string,
  // v0.7.1 (§2.9): the ring push rides TTL=CALL_RING_PUSH_TTL_S + Urgency:
  // high — a ring that cannot be delivered within the ring window must never
  // arrive late. Omitted everywhere else (web-push defaults unchanged).
  options?: webpush.RequestOptions,
): Promise<void> {
  const subs = await db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId));

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        options,
      );
      await db
        .update(schema.pushSubscriptions)
        .set({ lastSuccessAt: new Date(), failCount: 0 })
        .where(eq(schema.pushSubscriptions.id, sub.id));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410 || sub.failCount + 1 >= 5) {
        await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
      } else {
        await db
          .update(schema.pushSubscriptions)
          .set({ failCount: sql`${schema.pushSubscriptions.failCount} + 1` })
          .where(eq(schema.pushSubscriptions.id, sub.id));
      }
    }
  }
}

// v0.3 beacon pushes (API.md §1.15): a beacon is a live invite. Guards:
// presence (online users get the WS frame instead) + per-(user, beacon)
// debounce. No read-watermark guard — beacons have none.
async function processBeaconPushJob(job: BeaconPushJob): Promise<void> {
  if ((await redis.exists(presenceKey(job.user_id))) === 1) return;
  const debounced = await redis.set(
    `pushdb:${job.user_id}:beacon:${job.beacon_id}`,
    '1',
    'EX',
    PUSH_DEBOUNCE_S,
    'NX',
  );
  if (debounced !== 'OK') return;
  const payload = JSON.stringify({
    title: job.title,
    body: job.body,
    tag: `beacon:${job.beacon_id}`,
    data: { url: job.url },
  });
  await sendToSubscriptions(job.user_id, payload);
}

// v0.5a (§1.28): connection request/accept pushes — presence + per-key
// debounce; blocked pairs can never reach this path (requests between them
// are 404-shaped before any enqueue).
async function processSocialPushJob(job: SocialPushJob): Promise<void> {
  if ((await redis.exists(presenceKey(job.user_id))) === 1) return;
  const debounced = await redis.set(
    `pushdb:${job.user_id}:social:${job.dedupe_key}`,
    '1',
    'EX',
    PUSH_DEBOUNCE_S,
    'NX',
  );
  if (debounced !== 'OK') return;
  const payload = JSON.stringify({
    title: job.title,
    body: job.body,
    tag: `social:${job.dedupe_key}`,
    data: { url: job.url },
  });
  await sendToSubscriptions(job.user_id, payload);
}

// v0.6 (§1.42): the missed-call push — the UNCHANGED §2.9 guards re-checked
// at execution: presence, read-elsewhere (the missed-call system message's
// seq), muted_until, per-(user, conversation) debounce; the block belt covers
// a block created between enqueue and execution.
async function processCallPushJob(job: CallPushJob): Promise<void> {
  if ((await redis.exists(presenceKey(job.user_id))) === 1) return;
  const [part] = await db
    .select()
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, job.conversation_id),
        eq(schema.conversationParticipants.userId, job.user_id),
      ),
    )
    .limit(1);
  // Wave 1.7: a parked request never pushes.
  if (!part || part.leftAt !== null || part.acceptedAt === null) return;
  const blockedPair = job.initiator_id
    ? await isBlockedPair(job.user_id, job.initiator_id)
    : false;
  if (
    !messagePushAllowed({
      blockedPair,
      lastReadSeq: part.lastReadSeq,
      seq: job.seq,
      mutedUntil: part.mutedUntil,
      mentioned: false,
    })
  ) {
    return;
  }
  const debounced = await redis.set(
    `pushdb:${job.user_id}:${job.conversation_id}`,
    '1',
    'EX',
    PUSH_DEBOUNCE_S,
    'NX',
  );
  if (debounced !== 'OK') return;

  // Title: caller display name (DM) or the group title (§1.42).
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversation_id))
    .limit(1);
  if (!conv) return;
  let title = conv.title ?? 'Missed call';
  if (conv.type === 'dm' && job.initiator_id) {
    const [caller] = await db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, job.initiator_id))
      .limit(1);
    if (caller) title = caller.displayName;
  }
  const payload = JSON.stringify({
    title,
    body: `Missed ${job.call_kind} call`,
    tag: job.conversation_id,
    data: { url: `/c/${job.conversation_id}` },
  });
  await sendToSubscriptions(job.user_id, payload);
}

// v0.7.1 (§1.55 + §2.9, ADR-017, FEATURES #88): the incoming-call RING push.
// Guards re-checked at execution: presence (a live socket rings via
// call.invite), active membership, the block belt, muted_until with NO
// mention-style override (a call is not a mention), the call STILL RINGING
// (a handled call must never ring late — this is the queue-side half of the
// call.ring.stop retraction), and a per-(user, CALL) debounce (one ring push
// per call per user, never collapsed with message pushes). The user is added
// to the `call:{id}:rang` set BEFORE sending, so stopCallRing retracts
// exactly the subscriptions the ring went to even when the two race.
async function processCallRingPushJob(job: CallRingPushJob): Promise<void> {
  if ((await redis.exists(presenceKey(job.user_id))) === 1) return;
  const [part] = await db
    .select()
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, job.conversation_id),
        eq(schema.conversationParticipants.userId, job.user_id),
      ),
    )
    .limit(1);
  if (!part || part.leftAt !== null || part.acceptedAt === null) return; // Wave 1.7
  const blockedPair = job.initiator_id
    ? await isBlockedPair(job.user_id, job.initiator_id)
    : false;
  if (!callRingPushAllowed({ blockedPair, mutedUntil: part.mutedUntil })) return;

  // Still ringing? (fresh read — join/reject/cancel/timeout between enqueue
  // and execution means the ring was handled; PSYCHOLOGY rule 2: never
  // announce a call the recipient can no longer join.)
  const [call] = await db
    .select({ status: schema.calls.status })
    .from(schema.calls)
    .where(eq(schema.calls.id, job.call_id))
    .limit(1);
  if (!call || call.status !== 'ringing') return;

  const debounced = await redis.set(
    `pushdb:${job.user_id}:callring:${job.call_id}`,
    '1',
    'EX',
    PUSH_DEBOUNCE_S,
    'NX',
  );
  if (debounced !== 'OK') return;

  // Title: caller display name (DM) or the group title (the §1.42 copy rule).
  // v1.0 (owner: "see WHO called"): the caller is ALWAYS resolved — in a
  // group the body names them, so a rung member knows who is calling before
  // opening the app.
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversation_id))
    .limit(1);
  if (!conv) return;
  let title = conv.title ?? 'Incoming call';
  let callerName: string | null = null;
  if (job.initiator_id) {
    const [caller] = await db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, job.initiator_id))
      .limit(1);
    if (caller) callerName = caller.displayName;
  }
  if (!job.is_group && callerName !== null) title = callerName;

  // Record the rung user BEFORE the send: a stop racing this job then still
  // reaches this subscription. TTL is the leak belt only — stopCallRing
  // deletes the set the moment the call is handled.
  await redis.sadd(callRangKey(job.call_id), job.user_id);
  await redis.expire(callRangKey(job.call_id), CALL_RANG_TTL_S);

  const payload: CallRingPushPayload = {
    kind: PUSH_KIND_CALL_RING,
    title,
    body:
      job.is_group && callerName !== null
        ? `${callerName} — incoming ${job.call_kind} call`
        : `Incoming ${job.call_kind} call`,
    tag: `${CALL_RING_PUSH_TAG_PREFIX}${job.call_id}`,
    data: {
      url: `/c/${job.conversation_id}?call=${job.call_id}`,
      call_id: job.call_id,
      conversation_id: job.conversation_id,
      call_kind: job.call_kind,
      is_group: job.is_group,
    },
  };
  await sendToSubscriptions(job.user_id, JSON.stringify(payload), {
    TTL: CALL_RING_PUSH_TTL_S,
    urgency: 'high',
  });
}

// v0.7.1 (§1.55 + §2.9): the silent retraction — the service worker closes
// any notification with this tag and displays NOTHING, so no guards apply
// (closing a stale ring is always right, muted or not). Same TTL/urgency as
// the ring: a stop that arrives after the window matters as little as a ring
// that does.
async function processCallRingStopPushJob(job: CallRingStopPushJob): Promise<void> {
  const payload: CallRingStopPushPayload = {
    kind: PUSH_KIND_CALL_RING_STOP,
    tag: `${CALL_RING_PUSH_TAG_PREFIX}${job.call_id}`,
  };
  await sendToSubscriptions(job.user_id, JSON.stringify(payload), {
    TTL: CALL_RING_PUSH_TTL_S,
    urgency: 'high',
  });
}

// v0.6 (§1.46): the ONE push that bypasses the §2.9 guards — presence,
// read-elsewhere and debounce SKIPPED, muted_until OVERRIDDEN (the §1.33
// mention precedent). Blocks remain structural: the route's friends-of gate
// excludes blocked pairs before any enqueue; this re-check is the belt.
async function processRescuePushJob(job: RescuePushJob): Promise<void> {
  if (await isBlockedPair(job.user_id, job.sender_id)) return;
  const payload = JSON.stringify({
    title: job.title,
    body: job.body,
    tag: job.conversation_id,
    data: { url: `/c/${job.conversation_id}` },
  });
  await sendToSubscriptions(job.user_id, payload);
}

export async function processPushJob(job: PushJob): Promise<void> {
  if (!config.vapid) return;
  if (job.kind === 'beacon') return processBeaconPushJob(job);
  if (job.kind === 'social') return processSocialPushJob(job);
  if (job.kind === 'call') return processCallPushJob(job);
  if (job.kind === 'call_ring') return processCallRingPushJob(job);
  if (job.kind === 'call_ring_stop') return processCallRingStopPushJob(job);
  if (job.kind === 'rescue') return processRescuePushJob(job);
  return processMessagePushJob(job);
}


async function processMessagePushJob(job: MessagePushJob): Promise<void> {
  // Guard (a): Redis presence still shows the user offline.
  if ((await redis.exists(presenceKey(job.user_id))) === 1) return;

  // Guard (b): fresh DB read — not read on another device; still a member.
  const [part] = await db
    .select()
    .from(schema.conversationParticipants)
    .where(
      and(
        eq(schema.conversationParticipants.conversationId, job.conversation_id),
        eq(schema.conversationParticipants.userId, job.user_id),
      ),
    )
    .limit(1);
  if (!part || part.leftAt !== null || part.acceptedAt === null) return; // Wave 1.7

  const [msg] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, job.message_id))
    .limit(1);
  if (!msg) return;
  // v0.8a (§1.57): a tombstoned message never pushes. While the sender's
  // drunk mood is live, the send path enqueues this job with a delay of
  // MOOD_DRUNK_UNDO_WINDOW_S + MOOD_DRUNK_UNDO_SLACK_S, so this fresh
  // deleted_at read always runs AFTER the undo window has closed — an undone
  // message is guaranteed silent (the 5 s debounce alone would not cover the
  // 10 s undo window).
  if (msg.deletedAt !== null) return;

  // Guards (b2)+(c) + the v0.5a §1.33 mention override, as one pure verdict:
  // a mention skips the mute guard for the mentioned user — and NEVER a block
  // (§1.14; the send-path fan-out already excludes blocked pairs, this is the
  // belt against a block created between enqueue and execution).
  const mentions = ((msg.metadata ?? {}) as { mentions?: string[] }).mentions;
  const mentioned = Array.isArray(mentions) && mentions.includes(job.user_id);
  const blockedPair = msg.senderId ? await isBlockedPair(job.user_id, msg.senderId) : false;
  if (
    !messagePushAllowed({
      blockedPair,
      lastReadSeq: part.lastReadSeq,
      seq: job.seq,
      mutedUntil: part.mutedUntil,
      mentioned,
    })
  ) {
    return;
  }

  // Guard (d): per-(user, conversation) debounce, 5 s — bursts collapse.
  const debounced = await redis.set(
    `pushdb:${job.user_id}:${job.conversation_id}`,
    '1',
    'EX',
    PUSH_DEBOUNCE_S,
    'NX',
  );
  if (debounced !== 'OK') return;

  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, job.conversation_id))
    .limit(1);
  if (!conv) return;

  let title = conv.title ?? 'New message';
  if (conv.type === 'dm' && msg.senderId) {
    const [sender] = await db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, msg.senderId))
      .limit(1);
    if (sender) title = sender.displayName;
  }
  // §1.33: mention push copy leads with the sender; payload shape unchanged.
  if (mentioned && msg.senderId) {
    const [sender] = await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, msg.senderId))
      .limit(1);
    if (sender) title = `${sender.username} mentioned you`;
  }

  const payload = JSON.stringify({
    title,
    body: snippetFor(msg.type, msg.body),
    tag: job.conversation_id,
    data: { url: `/c/${job.conversation_id}` },
  });

  await sendToSubscriptions(job.user_id, payload);
}
