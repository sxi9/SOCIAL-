// Reaction toggles (API.md §1.12): REST writes (idempotent 204s), with an
// optimistic local patch. The authoritative count arrives as the
// `reaction.updated` WS frame (§2.3) — the server fans one out to everyone,
// including the actor — and reconnects reconcile from message DTO aggregates.
import { STAMP_REACTION_KEY } from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

export async function toggleReaction(
  conversationId: string,
  seq: number,
  emoji: string,
  mine: boolean
): Promise<void> {
  if (!store.state.me) return;
  // Optimistic: flip locally now; the WS frame confirms the true total.
  store.applyReactionLocal(conversationId, seq, emoji, !mine);
  try {
    if (mine) {
      await api.del(
        `/api/conversations/${conversationId}/messages/${seq}/reactions/${encodeURIComponent(emoji)}`
      );
    } else {
      await api.post(`/api/conversations/${conversationId}/messages/${seq}/reactions`, { emoji });
    }
  } catch (err) {
    // Roll the optimistic patch back (409 reaction_limit — 8 distinct emoji
    // per user per message —, offline, revoked membership, …).
    store.applyReactionLocal(conversationId, seq, emoji, mine);
    if (err instanceof ApiError && (err.code === 'reaction_limit' || err.status === 404)) return;
  }
}

/**
 * Avatar stamp toggle (v0.4 — API.md §1.19): one stamp per user per message,
 * PK-enforced server-side (the :stamp: sentinel rides the emoji column).
 * Requires MY avatar to be ready (409 stamp_no_avatar otherwise) — callers
 * disable the control, this is just the belt-and-braces rollback.
 */
export async function toggleStamp(conversationId: string, seq: number, mine: boolean): Promise<void> {
  if (!store.state.me) return;
  store.applyStampLocal(conversationId, seq, !mine);
  try {
    if (mine) {
      await api.del(
        `/api/conversations/${conversationId}/messages/${seq}/reactions/${encodeURIComponent(STAMP_REACTION_KEY)}`
      );
    } else {
      await api.post(`/api/conversations/${conversationId}/messages/${seq}/reactions`, { kind: 'stamp' });
    }
  } catch (err) {
    store.applyStampLocal(conversationId, seq, mine);
    if (err instanceof ApiError && (err.code === 'stamp_no_avatar' || err.status === 404)) return;
  }
}
