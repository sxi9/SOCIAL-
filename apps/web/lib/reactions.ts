// Reaction toggles (API.md §1.12): REST writes (idempotent 204s), with an
// optimistic local patch. The authoritative count arrives as the
// `reaction.updated` WS frame (§2.3) — the server fans one out to everyone,
// including the actor — and reconnects reconcile from message DTO aggregates.
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
