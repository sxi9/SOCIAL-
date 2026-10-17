// v0.6 Bored Together: discovery, roulette, expectation feedback & rescue
// (API.md §1.44–§1.46, ADR-015, PSYCHOLOGY finding #10). REST writes with
// store mirrors; WS frames (discovery.matched / roulette.*) patch live via
// lib/connection.ts. Binding client rules carried here:
//   * the encouragement aggregate is shown PRE-opt-in only;
//   * the one-tap feedback sheet shows EXACTLY ONCE per match — skippable,
//     never re-surfaced (localStorage guard, keyed by conversation id);
//   * a single wave notifies nobody, so the UI never implies otherwise.
import type {
  DiscoveryCardsResponse,
  DiscoveryOptinResponse,
  DiscoveryScope,
  DiscoveryVibe,
  EncouragementResponse,
  ExpectationContext,
  ExpectationVerdict,
  RescueResponse,
  RouletteKeepResponse,
  WaveResponse,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import * as db from './db';
import * as store from './store';

// ---------------------------------------------------------------------------
// Discovery opt-in & cards (§1.44)
// ---------------------------------------------------------------------------

export async function refreshOptin(): Promise<void> {
  try {
    const res = await api.get<DiscoveryOptinResponse>('/api/discovery/optin');
    const live =
      res.optin && new Date(res.optin.expires_at).getTime() > Date.now() ? res.optin : null;
    store.setDiscoveryOptin(live);
  } catch {
    /* offline — the last mirror stands */
  }
}

export async function optIn(
  scope: DiscoveryScope,
  note: string,
  vibe: DiscoveryVibe | null = null
): Promise<void> {
  // v0.8b §1.65: the optional what-for chip rides the same PUT; re-PUT
  // re-scopes it (and refreshes the hour — which also clears the nudge claim).
  const res = await api.put<DiscoveryOptinResponse>('/api/discovery/optin', { scope, note, vibe });
  store.setDiscoveryOptin(res.optin);
}

export async function optOut(): Promise<void> {
  try {
    await api.del('/api/discovery/optin');
  } catch {
    /* idempotent */
  }
  store.setDiscoveryOptin(null);
  store.setRouletteQueued(false);
}

/** v0.8b §1.65: the card-stack filters — each only ever NARROWS the pool. */
export interface CardFilters {
  vibe: DiscoveryVibe | null;
  interests: boolean;
  area: boolean;
}

const NO_FILTERS: CardFilters = { vibe: null, interests: false, area: false };
let lastFilters: CardFilters = NO_FILTERS;

export async function refreshCards(filters?: CardFilters): Promise<void> {
  if (filters) lastFilters = filters;
  const f = filters ?? lastFilters;
  const params = new URLSearchParams();
  if (f.vibe) params.set('vibe', f.vibe);
  if (f.interests) params.set('interests', '1');
  if (f.area) params.set('area', '1');
  const qs = params.toString();
  try {
    const res = await api.get<DiscoveryCardsResponse>(`/api/discovery/cards${qs ? `?${qs}` : ''}`);
    store.setDiscoveryCards(res.cards);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'discovery_not_opted_in') {
      store.setDiscoveryOptin(null); // lapsed under us
    }
  }
}

/** Wave at a card. matched:false = parked silently (nobody is notified —
 * the card just shows my own "waved" chip). matched:true also arrives as a
 * discovery.matched frame, which drives the celebration overlay. */
export async function waveAt(userId: string): Promise<WaveResponse> {
  const res = await api.post<WaveResponse>('/api/discovery/wave', { user_id: userId });
  store.markCardWaved(userId);
  if (res.matched) store.removeCard(userId);
  return res;
}

export async function refreshEncouragement(): Promise<void> {
  try {
    const res = await api.get<EncouragementResponse>('/api/discovery/encouragement');
    store.setEncouragement(res);
  } catch {
    /* non-essential */
  }
}

export async function blockUser(userId: string): Promise<void> {
  await api.put(`/api/users/${userId}/block`);
  store.removeCard(userId);
}

// ---------------------------------------------------------------------------
// Roulette (§1.45)
// ---------------------------------------------------------------------------

export async function joinRoulette(): Promise<void> {
  await api.post('/api/roulette/join');
  store.setRouletteQueued(true);
}

export async function leaveRoulette(): Promise<void> {
  try {
    await api.del('/api/roulette/join');
  } catch {
    /* idempotent */
  }
  store.setRouletteQueued(false);
}

export async function keepRoulette(conversationId: string): Promise<RouletteKeepResponse> {
  const res = await api.post<RouletteKeepResponse>('/api/roulette/keep', {
    conversation_id: conversationId,
  });
  // permanent:true collapses the rider to origin-only; the RouletteBanner
  // reacts to that DTO change (celebration + the one-time feedback prompt) —
  // the same path the FIRST keeper's conv.updated frame takes.
  store.upsertConversation(res.conversation);
  return res;
}

/** roulette.expired frame: the conversation is hard-deleted server-side —
 * drop local state, show the friendly goodbye, queue the one-tap feedback. */
export function onRouletteExpired(conversationId: string): void {
  store.removeConversation(conversationId);
  void db.dropConversation(conversationId).catch(() => undefined);
  store.setRouletteGoodbye(conversationId);
  queueFeedback('roulette', conversationId);
}

// ---------------------------------------------------------------------------
// Expectation feedback (§1.45) — PRIVATE, once per match, skippable
// ---------------------------------------------------------------------------

function guardKey(conversationId: string): string {
  return `bored:fb:${conversationId}`;
}

function keptKey(conversationId: string): string {
  return `bored:kept:${conversationId}`;
}

/** True once the prompt was shown (answered OR skipped) for this match. */
export function feedbackSeen(conversationId: string): boolean {
  try {
    return localStorage.getItem(guardKey(conversationId)) !== null;
  } catch {
    return true; // no storage → cannot guarantee once-only, so never prompt
  }
}

export function markFeedbackSeen(conversationId: string): void {
  try {
    localStorage.setItem(guardKey(conversationId), '1');
  } catch {
    /* private mode */
  }
}

/** Queue the one-tap sheet unless it already showed for this match. */
export function queueFeedback(context: ExpectationContext, conversationId: string): void {
  if (feedbackSeen(conversationId)) return;
  if (store.state.feedbackAsk) return; // one at a time; never a nag queue
  store.setFeedbackAsk({ context, conversation_id: conversationId });
}

export async function sendFeedback(
  context: ExpectationContext,
  conversationId: string,
  verdict: ExpectationVerdict
): Promise<void> {
  try {
    await api.post('/api/discovery/feedback', {
      context,
      conversation_id: conversationId,
      verdict,
    });
  } catch {
    /* best effort — the prompt never re-surfaces either way */
  }
}

/** Both-kept celebration: fire exactly once per conversation. */
export function shouldCelebrateKeep(conversationId: string): boolean {
  try {
    if (localStorage.getItem(keptKey(conversationId)) !== null) return false;
  } catch {
    return false;
  }
  return true;
}

export function markKept(conversationId: string): void {
  try {
    localStorage.setItem(keptKey(conversationId), '1');
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------
// Rescue me (§1.46)
// ---------------------------------------------------------------------------

export async function sendRescue(userIds: string[], note: string): Promise<RescueResponse> {
  return api.post<RescueResponse>('/api/rescue', { user_ids: userIds, note });
}
