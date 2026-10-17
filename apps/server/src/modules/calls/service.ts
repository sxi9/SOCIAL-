// v0.6 calls (API.md §1.42 + §2.12, ADR-014). The durable truth is the calls
// row (REST-written, call.updated fan-out); everything live is ephemeral: the
// in-call member set is Redis `call:{id}:members` (deleted on any terminal
// status) and signaling frames are relayed, never persisted. Group calls are
// MESH, hard-capped at CALL_MESH_MAX by the atomic check-and-add below — the
// LiveKit SFU upgrade seam is documented in ADR-014, deliberately not built.
import { eq, sql } from 'drizzle-orm';
import {
  CALL_MESH_MAX,
  CALL_RING_TIMEOUT_S,
  type Call,
  type CallKind,
  type CallStatus,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { filterBlockedFrom } from '../../lib/blocks.js';
import { activeParticipantUserIds } from '../../lib/dto.js';
import {
  enqueueCallPushBulk,
  enqueueCallRingPushBulk,
  enqueueCallRingStopPushBulk,
} from '../../queues.js';
import { redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { registry } from '../../ws/registry.js';
import { fanOutNewMessage, insertMessage } from '../messages/service.js';

export type CallRow = typeof schema.calls.$inferSelect;

export const callMembersKey = (callId: string): string => `call:${callId}:members`;

// v0.7.1 (§1.55/§2.9, ADR-017): who actually got a ring PUSH for this call —
// written by the push worker right before sending, read by stopCallRing so the
// silent retraction goes to exactly the subscriptions the ring went to.
// Ephemeral like the member set (no table); dropped the moment the call is
// handled anywhere. The TTL is only a leak belt against a worker dying between
// SADD and the stop (a ring is ≤45 s old by definition).
export const callRangKey = (callId: string): string => `call:${callId}:rang`;
export const CALL_RANG_TTL_S = CALL_RING_TIMEOUT_S * 4;

export async function loadCall(callId: string): Promise<CallRow | null> {
  const [row] = await db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1);
  return row ?? null;
}

export function isLiveStatus(status: string): boolean {
  return status === 'ringing' || status === 'ongoing';
}

/** The CURRENT live mesh members (Redis truth); [] once terminal (§1.42). */
export async function callMemberIds(call: CallRow): Promise<string[]> {
  if (!isLiveStatus(call.status)) return [];
  return redis.smembers(callMembersKey(call.id));
}

export function callDto(row: CallRow, participantIds: string[]): Call {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    initiator_id: row.initiatorId,
    kind: row.kind as CallKind,
    is_group: row.isGroup,
    status: row.status as CallStatus,
    participant_ids: participantIds,
    started_at: row.startedAt.toISOString(),
    answered_at: row.answeredAt ? row.answeredAt.toISOString() : null,
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

// Atomic mesh-cap check-and-add (§1.42/ADR-014): by the time anyone may
// offer, the cap already held. Re-adding an existing member is idempotent
// and never counts against the cap.
const CHECK_AND_ADD_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then return 0 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[1]) then return -1 end
return redis.call('SADD', KEYS[1], ARGV[2])
`;

export type CheckAndAddResult = 'added' | 'already_member' | 'full';

export async function addCallMember(callId: string, userId: string): Promise<CheckAndAddResult> {
  const res = (await redis.eval(
    CHECK_AND_ADD_LUA,
    1,
    callMembersKey(callId),
    String(CALL_MESH_MAX),
    userId,
  )) as number;
  if (res === -1) return 'full';
  return res === 1 ? 'added' : 'already_member';
}

export async function removeCallMember(callId: string, userId: string): Promise<number> {
  await redis.srem(callMembersKey(callId), userId);
  return redis.scard(callMembersKey(callId));
}

export async function isCallMember(callId: string, userId: string): Promise<boolean> {
  return (await redis.sismember(callMembersKey(callId), userId)) === 1;
}

export async function deleteCallMembers(callId: string): Promise<void> {
  await redis.del(callMembersKey(callId));
}

/** call.updated on every durable transition, to the conversation's active
 * participants (§2.3). Full-DTO replace by call.id; reconnect truth is the
 * REST call log, never frame replay. */
export async function publishCallUpdated(call: CallRow): Promise<void> {
  const members = await callMemberIds(call);
  const recipients = await activeParticipantUserIds(call.conversationId);
  await publishToUsers(recipients, { t: 'call.updated', d: { call: callDto(call, members) } });
}

/**
 * v0.7.1 ring push (§1.55/§2.9, ADR-017, FEATURES #88): at call create,
 * enqueue a `call.ring` push for every callee who has NO live socket (a live
 * socket already rings via call.invite) — blocked pairs structurally excluded
 * (the belt re-checks in the worker), everything else (presence, muted_until,
 * still-ringing, per-call debounce) re-checked at execution exactly like the
 * missed-call push. Online callees are skipped at enqueue, not delayed: a ring
 * is time-critical, and the worker's presence guard re-covers races.
 */
export async function enqueueCallRingPushes(call: CallRow): Promise<void> {
  const participants = await activeParticipantUserIds(call.conversationId);
  let targets = participants.filter((id) => id !== call.initiatorId);
  if (call.initiatorId) targets = await filterBlockedFrom(call.initiatorId, targets);
  targets = targets.filter((id) => !registry.userHasSockets(id));
  if (targets.length === 0) return;
  await enqueueCallRingPushBulk(
    targets.map((userId) => ({
      kind: 'call_ring' as const,
      user_id: userId,
      call_id: call.id,
      conversation_id: call.conversationId,
      initiator_id: call.initiatorId,
      call_kind: call.kind as CallKind,
      is_group: call.isGroup,
    })),
  );
}

/**
 * v0.7.1 (§1.55/§2.9): the call was HANDLED somewhere — first join, DM
 * reject, initiator cancel, ring timeout — so every ring push that went out
 * is retracted by a silent `call.ring.stop` (the worker closes the
 * notification by tag, shows nothing). Reads + drops the `call:{id}:rang`
 * set; idempotent (an empty set is a no-op), so every ringing→* transition
 * calls it unconditionally.
 */
export async function stopCallRing(callId: string): Promise<void> {
  const rang = await redis.smembers(callRangKey(callId));
  await redis.del(callRangKey(callId));
  if (rang.length === 0) return;
  await enqueueCallRingStopPushBulk(
    rang.map((userId) => ({ kind: 'call_ring_stop' as const, user_id: userId, call_id: callId })),
  );
}

// withinTx abort sentinel: the ring already resolved (join/reject/end raced
// the timeout) — the whole seq transaction rolls back, no system message.
class CallNotRingingError extends Error {}

/**
 * The §1.42 missed-call machinery, shared by the ring-timeout job, the
 * safety sweep and the initiator's cancel-before-answer: in ONE transaction
 * the call flips ringing→missed (guarded UPDATE — a race simply no-ops) and
 * the missed-call system message is inserted with the server-written
 * metadata.call_ref snapshot. Fan-out after commit: call.updated + msg.new,
 * plus a missed-call push to every callee who never joined, through the
 * UNCHANGED §2.9 guards (blocked pairs structurally excluded here).
 */
export async function runMissedCall(callId: string): Promise<void> {
  const call = await loadCall(callId);
  if (!call || call.status !== 'ringing') return;

  // Who had joined (initiator only, for a ringing call) — read before the
  // flip deletes the set; these users never get the missed-call push.
  const joined = await redis.smembers(callMembersKey(call.id));

  const body = `Missed ${call.kind} call`;
  let msg;
  try {
    msg = await insertMessage({
      conversationId: call.conversationId,
      senderId: null,
      type: 'system',
      body,
      metadata: {
        system: {
          event: 'call_missed',
          ...(call.initiatorId ? { actor_id: call.initiatorId } : {}),
        },
        call_ref: {
          call_id: call.id,
          kind: call.kind as CallKind,
          status: 'missed',
          duration_s: null,
        },
      },
      withinTx: async (tx) => {
        const rows = (await tx.execute(sql`
          UPDATE calls SET status = 'missed', ended_at = now()
          WHERE id = ${call.id} AND status = 'ringing'
          RETURNING id
        `)) as unknown as { id: string }[];
        if (rows.length === 0) throw new CallNotRingingError();
      },
    });
  } catch (err) {
    if (err instanceof CallNotRingingError) return; // raced: already resolved
    throw err;
  }

  await deleteCallMembers(call.id);
  // v0.7.1: a timed-out/cancelled ring stops ringing on lock screens too.
  await stopCallRing(call.id);
  const fresh = await loadCall(call.id);
  if (fresh) await publishCallUpdated(fresh);
  await fanOutNewMessage(msg); // sender null → no ordinary message push

  // Missed-call push (§1.42): every callee who never joined, minus blocked
  // pairs (structural), offline-only per §2.9 — in the worker the registry is
  // empty, so the execution-time presence guard carries that rule; the
  // OFFLINE_GRACE delay mirrors fanOutNewMessage so a just-disconnected
  // callee is not swallowed by a stale presence key.
  const participants = await activeParticipantUserIds(call.conversationId);
  const joinedSet = new Set(joined);
  let targets = participants.filter((id) => id !== call.initiatorId && !joinedSet.has(id));
  if (call.initiatorId) targets = await filterBlockedFrom(call.initiatorId, targets);
  targets = targets.filter((id) => !registry.userHasSockets(id));
  if (targets.length > 0) {
    await enqueueCallPushBulk(
      targets.map((userId) => ({
        kind: 'call' as const,
        user_id: userId,
        conversation_id: call.conversationId,
        seq: msg.seq,
        initiator_id: call.initiatorId,
        call_kind: call.kind as CallKind,
      })),
    );
  }
}

/** Repeatable safety sweep over calls_ringing_idx — catches ring-timeout
 * jobs lost to a Redis wipe (the afterglow pattern). */
export async function runCallRingSweep(): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT id FROM calls
    WHERE status = 'ringing'
      AND started_at < now() - (${CALL_RING_TIMEOUT_S}::int * interval '1 second')
    ORDER BY started_at ASC
    LIMIT 100
  `)) as unknown as { id: string }[];
  for (const row of rows) {
    await runMissedCall(row.id);
  }
}
