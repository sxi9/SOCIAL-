// v0.6 watch together (API.md §1.43 + §2.12). EPHEMERAL ONLY: three WS frame
// types and nothing durable. The relayed start/sync frames carry FULL state,
// so this module just mirrors the latest frame into the store; a session with
// no sync inside WATCH_SESSION_TTL_S is stale and treated as stopped (the
// host vanished — their Redis key lapsed the same way).
import {
  WATCH_SESSION_TTL_S,
  WATCH_SYNC_MIN_INTERVAL_MS,
  type WatchStartEvent,
  type WatchStopEvent,
  type WatchSyncEvent,
} from '@socialchat/shared';
import { sendEvent } from './signals';
import * as store from './store';

export type WatchServerEvent = WatchStartEvent | WatchSyncEvent | WatchStopEvent;

export function handleWatchEvent(ev: WatchServerEvent): void {
  if (ev.t === 'watch.stop') {
    store.clearWatchSession(ev.d.conversation_id);
    return;
  }
  store.setWatchSession({
    conversation_id: ev.d.conversation_id,
    video_id: ev.d.video_id,
    host: ev.d.host,
    position_s: ev.d.position_s,
    playing: ev.d.playing,
    received_at: Date.now(),
  });
}

/** A session is live only while syncs keep arriving (host keepalive ≥15 s). */
export function isSessionLive(ws: store.WatchSession | undefined, now: number): ws is store.WatchSession {
  return !!ws && now - ws.received_at < WATCH_SESSION_TTL_S * 1000;
}

/** Host starts a session: the server parses the video id out of the URL
 * (extractYoutubeVideoId — error watch_bad_url otherwise). We optimistically
 * mirror the state so the sheet opens instantly; the relayed frame confirms. */
export function startWatch(conversationId: string, url: string, videoId: string): void {
  sendEvent({ t: 'watch.start', d: { conversation_id: conversationId, url } });
  const meId = store.state.me?.id;
  if (meId && !store.state.watch.has(conversationId)) {
    store.setWatchSession({
      conversation_id: conversationId,
      video_id: videoId,
      host: meId,
      position_s: 0,
      playing: false,
      received_at: Date.now(),
    });
  }
}

const lastSyncSent = new Map<string, number>();

/** HOST-only sync (play/pause/seek + ≥15 s keepalive). Client-throttled to
 * the gateway's flood guard so frames are honored, not dropped. */
export function syncWatch(conversationId: string, positionS: number, playing: boolean): void {
  const now = Date.now();
  const last = lastSyncSent.get(conversationId) ?? 0;
  if (now - last < WATCH_SYNC_MIN_INTERVAL_MS) return;
  lastSyncSent.set(conversationId, now);
  sendEvent({
    t: 'watch.sync',
    d: { conversation_id: conversationId, position_s: Math.max(0, positionS), playing },
  });
  // Refresh our own mirror too (the host follows itself on reconnect).
  const cur = store.state.watch.get(conversationId);
  if (cur) {
    store.setWatchSession({ ...cur, position_s: Math.max(0, positionS), playing, received_at: now });
  }
}

/** Host stop — or anyone's, once the host has no live socket (§1.43). */
export function stopWatch(conversationId: string): void {
  sendEvent({ t: 'watch.stop', d: { conversation_id: conversationId } });
  store.clearWatchSession(conversationId);
}
