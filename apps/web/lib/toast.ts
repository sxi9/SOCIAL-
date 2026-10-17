// v0.7.1 shared toasts (API.md §1.56, FEATURES #90a). ONE helper, ONE host
// (components/Toast.tsx). Toasts are confirmations of the USER'S OWN actions
// only — never incoming-event notifications, never social counters
// (PSYCHOLOGY rule 3). Every action without a visible immediate result
// confirms itself through here: posted to board, beacon lit, invite copied,
// settings saved, report sent, scheduled-for-<time>, kudos sent.
import { TOAST_DEFAULT_MS } from '@socialchat/shared';
import * as store from './store';

/** Show a confirmation toast. Duration override allowed per call (the v0.7
 * scheduled-send toast keeps its SCHEDULED_TOAST_MS=4000). */
export function toast(text: string, ttlMs: number = TOAST_DEFAULT_MS): void {
  store.pushToast(text, ttlMs);
}
