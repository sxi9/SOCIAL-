// v0.5a §1.33/§2.9 — the message-push guard verdict, PURE (no imports, no
// infra) so the mention rules are unit-testable:
//   - a BLOCK is absolute: a mention NEVER overrides it (§1.14 is structural —
//     the send-path fan-out already excludes blocked pairs; this is the belt
//     against a block created between enqueue and execution);
//   - a mention of the target user SKIPS the muted_until guard, and ONLY that
//     guard — read-elsewhere still suppresses;
//   - everything else is the v0.1 §2.9 contract. Presence + debounce stay
//     Redis-side in the worker.
export interface MessagePushGuardInput {
  blockedPair: boolean;
  lastReadSeq: number;
  seq: number;
  mutedUntil: Date | null;
  mentioned: boolean;
  now?: number;
}

export function messagePushAllowed(g: MessagePushGuardInput): boolean {
  if (g.blockedPair) return false; // mentions never cross a block
  if (g.lastReadSeq >= g.seq) return false; // read on another device
  const now = g.now ?? Date.now();
  if (g.mutedUntil && g.mutedUntil.getTime() > now && !g.mentioned) return false;
  return true;
}

// v0.7.1 §2.9/§1.55 — the incoming-call ring-push verdict, same pure shape:
//   - a BLOCK is absolute (structural exclusion at enqueue; this is the belt
//     against a block created between enqueue and execution);
//   - muted_until SUPPRESSES the ring with NO mention-style override — a call
//     is not a mention (API.md §2.9);
//   - there is no read-elsewhere guard (a ring has no seq); the "handled
//     anywhere" retraction is the call.ring.stop push, and the worker's
//     call-still-ringing re-check carries it for not-yet-sent jobs.
export interface CallRingPushGuardInput {
  blockedPair: boolean;
  mutedUntil: Date | null;
  now?: number;
}

export function callRingPushAllowed(g: CallRingPushGuardInput): boolean {
  if (g.blockedPair) return false;
  const now = g.now ?? Date.now();
  if (g.mutedUntil && g.mutedUntil.getTime() > now) return false;
  return true;
}
