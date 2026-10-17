// Anonymous reveal game (v0.8b — API.md §1.62, FEATURES #77, ADR-019).
// A guessing game, not a mask for abuse: the sender is anonymous to the
// RECIPIENT only, never to the server. Text only, OFF the seq log — no
// receipts, no typing, no reactions. Binding client rules carried here:
//   * refusals are INVISIBLE (404 anon_unavailable for opt-out, unmet
//     'connections', blocks, bans, unknown, self) — the UI must never
//     disambiguate them;
//   * the recipient's view of the sender's avatar rides ONLY the thread-gated
//     blur proxy (server-rendered pixels) — the un-blur factor is derived
//     client-side purely to animate/describe progress, never to render;
//   * reveal truth is live: revealed_at set OR reveal_at <= now().
import type {
  AnonMessage,
  AnonMessagesResponse,
  AnonThread,
  AnonThreadResponse,
  AnonThreadsResponse,
  SetRevealRequest,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

// §0 AnonMessageResponse is {message}; alias kept local for clarity.
type MessageRes = { message: AnonMessage };

let inflight: Promise<void> | null = null;

/** GET /api/anon/threads — the reconnect truth (frames patch live). */
export async function refreshAnonThreads(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.get<AnonThreadsResponse>('/api/anon/threads');
      store.setAnonThreads(res.threads);
    } catch {
      /* offline — the last mirror stands */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** POST /api/anon/threads — open (or append to) my open thread to user_id.
 * A 404 is the INVISIBLE refusal shape — callers show one neutral copy. */
export async function openAnonThread(userId: string, body: string): Promise<AnonThread> {
  const res = await api.post<AnonThreadResponse>('/api/anon/threads', {
    user_id: userId,
    body,
  });
  store.upsertAnonThread(res.thread);
  return res.thread;
}

export async function listAnonMessages(threadId: string, cursor: string | null): Promise<AnonMessagesResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return api.get<AnonMessagesResponse>(`/api/anon/threads/${threadId}/messages${qs}`);
}

export async function sendAnonMessage(threadId: string, body: string): Promise<AnonMessage> {
  const res = await api.post<MessageRes>(`/api/anon/threads/${threadId}/messages`, { body });
  store.appendAnonMessage(threadId, res.message);
  return res.message;
}

/** RECIPIENT only — idempotent; no nag, no timer on the request. */
export async function requestReveal(threadId: string): Promise<void> {
  const res = await api.post<AnonThreadResponse>(`/api/anon/threads/${threadId}/request-reveal`);
  store.upsertAnonThread(res.thread);
}

/** SENDER only — pick (or replace) the game. */
export async function setReveal(threadId: string, req: SetRevealRequest): Promise<void> {
  const res = await api.post<AnonThreadResponse>(`/api/anon/threads/${threadId}/set-reveal`, req);
  store.upsertAnonThread(res.thread);
}

/** RECIPIENT, riddle mode only — the answer lands as an ordinary message
 * with is_riddle_answer; satisfying is the SENDER's call, by design. */
export async function answerRiddle(threadId: string, answer: string): Promise<void> {
  const res = await api.post<MessageRes>(`/api/anon/threads/${threadId}/answer-riddle`, { answer });
  store.appendAnonMessage(threadId, res.message);
}

/** SENDER only, anytime — the riddle confirm and reveal-anytime are the same. */
export async function revealNow(threadId: string): Promise<void> {
  const res = await api.post<AnonThreadResponse>(`/api/anon/threads/${threadId}/reveal`);
  store.upsertAnonThread(res.thread);
}

/** Either party — HARD-deletes the thread + messages for both. */
export async function deleteAnonThread(threadId: string): Promise<void> {
  try {
    await api.del(`/api/anon/threads/${threadId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  store.removeAnonThread(threadId);
}

/** Live reveal rule (§1.62): revealed_at stamped OR the timer ran out. */
export function isRevealed(t: AnonThread, now = Date.now()): boolean {
  if (t.revealed_at !== null) return true;
  return t.reveal_mode === 'timer' && t.reveal_at !== null && new Date(t.reveal_at).getTime() <= now;
}

/** The un-blur factor: 1 = fully masked, 0 = clear. The SERVER renders the
 * actual pixels; this only drives progress copy/animation cadence. */
export function blurFactor(t: AnonThread, now = Date.now()): number {
  if (isRevealed(t, now)) return 0;
  if (t.reveal_mode !== 'timer' || t.reveal_at === null || t.reveal_timer_s === null) return 1;
  const remaining = (new Date(t.reveal_at).getTime() - now) / 1000;
  return Math.min(1, Math.max(0, remaining / t.reveal_timer_s));
}

/** The thread-gated blurred-avatar proxy URL. The bucket busts the private
 * 60 s cache (ANON_AVATAR_CACHE_TTL_S) so the blur keeps moving. */
export function anonAvatarUrl(threadId: string, now = Date.now()): string {
  const bucket = Math.floor(now / 60_000);
  return `/api/anon/threads/${threadId}/avatar?v=static&r=${bucket}`;
}

export function timerLabel(seconds: number): string {
  return seconds >= 86400 ? '24h' : `${Math.round(seconds / 3600)}h`;
}
