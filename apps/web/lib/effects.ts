// Message effects (v0.4 — API.md §1.22) + capsule reveals (§1.26).
//
// CONSENT RULE (binding): trigger phrases only ever SUGGEST an effect as a
// tappable chip in the composer — the sender must confirm; never auto-attached.
// PLAYBACK RULE (binding): an effect plays once per viewer per message —
// tracked in IndexedDB (lib/db.ts seen_fx) with an in-session guard — and is
// fully replaced by a static badge under prefers-reduced-motion. No sound.
import { EFFECT_TRIGGERS, type MessageEffect } from '@socialchat/shared';
import * as db from './db';

export const EFFECT_EMOJI: Record<MessageEffect, string> = {
  confetti: '🎉',
  hearts: '💗',
  fireworks: '🎆',
  snow: '❄️',
};

export const EFFECT_LABEL: Record<MessageEffect, string> = {
  confetti: 'Confetti',
  hearts: 'Hearts',
  fireworks: 'Fireworks',
  snow: 'Snow',
};

/** Case-insensitive substring match against the shared trigger table. */
export function suggestEffect(text: string): MessageEffect | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const t of EFFECT_TRIGGERS) {
    if (lower.includes(t.phrase)) return t.effect;
  }
  return null;
}

// Session guard: never double-fire within one tab even while the IDB write is
// in flight (or when IndexedDB is unavailable → once per session is the
// graceful floor).
const sessionClaimed = new Set<string>();

/**
 * Claim the one-shot first view of (kind, conversation, seq). Returns true
 * exactly once per viewer; replays on scroll-back/reconnect/re-render return
 * false forever after.
 */
export async function claimFirstView(
  kind: db.SeenFxKind,
  conversationId: string,
  seq: number
): Promise<boolean> {
  const key = `${kind}:${conversationId}:${seq}`;
  if (sessionClaimed.has(key)) return false;
  sessionClaimed.add(key);
  try {
    if (await db.hasSeenFx(kind, conversationId, seq)) return false;
    await db.markSeenFx(kind, conversationId, seq);
    return true;
  } catch {
    return true; // no durable storage: once per session
  }
}

/** Non-claiming read — e.g. was this capsule already opened on this device? */
export async function wasViewed(kind: db.SeenFxKind, conversationId: string, seq: number): Promise<boolean> {
  if (sessionClaimed.has(`${kind}:${conversationId}:${seq}`)) return true;
  try {
    return await db.hasSeenFx(kind, conversationId, seq);
  } catch {
    return false;
  }
}
