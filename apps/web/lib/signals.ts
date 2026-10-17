// Tiny indirection so feature modules (webrtc, watch) can SEND ephemeral
// client frames without importing lib/connection.ts (which imports them for
// inbound dispatch — a direct import would be a cycle). connection.ts
// registers the real socket sender at module load; before that, sends are
// no-ops that report failure (callers treat the frame as lost UX, never lost
// state — API.md §2.4: v0.6 call.*/watch.* frames are signals, not writes).
import type { ClientEvent } from '@socialchat/shared';

type EventSender = (frame: ClientEvent) => boolean;

let sender: EventSender = () => false;

export function registerEventSender(fn: EventSender): void {
  sender = fn;
}

/** Send an ephemeral client frame; returns false when no socket is open. */
export function sendEvent(frame: ClientEvent): boolean {
  return sender(frame);
}
