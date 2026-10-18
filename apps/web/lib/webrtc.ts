// v0.6 calls (API.md §1.42 + §2.12, ADR-014) — browser-native WebRTC, no
// libraries. This module is the ONE owner of call media state: one
// RTCPeerConnection per remote peer (mesh, ≤ CALL_MESH_MAX−1), the local
// MediaStream, and TURN credential refresh. Durable transitions are REST
// (create/join/end/reject); everything live rides the WS gateway as ephemeral
// relayed frames sent through lib/signals.ts. The store carries render state
// only (lib/store.ts CallUi); components re-grab streams via the getters here
// whenever callUi.media_version bumps.
//
// Offer direction — one rule everywhere (§2.12): the JOINING peer offers.
// For mid-call renegotiation/reconnect, the LOWER user id is the impolite
// peer (perfect-negotiation applied per pair — deterministic, no glare).
import {
  CALL_ICE_DISCONNECT_GRACE_MS,
  CALL_ICE_RESTART_BACKOFF_MS,
  CALL_ICE_RESTART_MAX_ATTEMPTS,
  type Call,
  type CallConnState,
  type CallKind,
  type CallResponse,
  type CallInviteEvent,
  type CallRingingEvent,
  type CallAcceptEvent,
  type CallRejectEvent,
  type CallOfferEvent,
  type CallAnswerEvent,
  type CallIceEvent,
  type CallLeaveEvent,
  type CallEndEvent,
  type CallStateEvent,
  type CallUpdatedEvent,
  type IceCandidate,
  type TurnCredentials,
  type TurnCredentialsResponse,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import { noteTurnFromCall, relayKnownUnreachable } from './selftest';
import { sendEvent } from './signals';
import * as store from './store';

export type CallServerEvent =
  | CallInviteEvent
  | CallRingingEvent
  | CallAcceptEvent
  | CallRejectEvent
  | CallOfferEvent
  | CallAnswerEvent
  | CallIceEvent
  | CallLeaveEvent
  | CallEndEvent
  | CallStateEvent
  | CallUpdatedEvent;

interface PeerEntry {
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** Trickled candidates that arrived before the remote description. */
  pendingIce: IceCandidateInitLike[];
  makingOffer: boolean;
  /** Timer waiting out a transient 'disconnected' before restarting ICE
   * (CALL_ICE_DISCONNECT_GRACE_MS, §1.55). */
  lostTimer: ReturnType<typeof setTimeout> | null;
  // ---- v0.7.1 (§1.55, ADR-017): bounded automatic ICE restart ----
  /** MY view of this pair (feeds the aggregate conn_state machine). */
  connState: CallConnState;
  /** Media connected at least once — a 1:1 call that NEVER connected ends
   * with POST end {reason:'failed'} when the pair gives up (§1.55). */
  everConnected: boolean;
  /** Restart attempts burned for the CURRENT outage (reset on reconnect);
   * capped at CALL_ICE_RESTART_MAX_ATTEMPTS, backed off per attempt. */
  restartAttempts: number;
  /** Pending backoff/watchdog timer for the restart loop (impolite side)
   * or the give-up timer on the polite side. */
  restartTimer: ReturnType<typeof setTimeout> | null;
}

type IceCandidateInitLike = IceCandidate;

// ---------------------------------------------------------------------------
// Module state (per active call; cleared by teardown)
// ---------------------------------------------------------------------------

let localStream: MediaStream | null = null;
const peers = new Map<string, PeerEntry>();
let turn: TurnCredentials | null = null;
let turnTimer: ReturnType<typeof setTimeout> | null = null;
let endCardTimer: ReturnType<typeof setTimeout> | null = null;

export function getLocalStream(): MediaStream | null {
  return localStream;
}

export function getRemoteStream(userId: string): MediaStream | null {
  return peers.get(userId)?.stream ?? null;
}

function meId(): string {
  return store.state.me?.id ?? '';
}

function bumpMedia(): void {
  const ui = store.state.callUi;
  if (ui) store.patchCallUi({ media_version: ui.media_version + 1 });
}

function iceServers(): RTCIceServer[] {
  // turn: null = local dev without TURN_SECRET — host candidates still
  // connect same-network peers (§1.42); no third-party STUN, ever.
  if (!turn) return [];
  return [{ urls: turn.uris, username: turn.username, credential: turn.credential }];
}

// ---------------------------------------------------------------------------
// Media acquisition
// ---------------------------------------------------------------------------

async function getMedia(kind: CallKind, facing: 'user' | 'environment'): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: kind === 'video' ? { facingMode: facing } : false,
  });
}

function mediaErrorCopy(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return 'Microphone/camera permission was denied — allow it in your browser settings to call.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') {
    return 'No microphone or camera found on this device.';
  }
  return 'Could not start your microphone/camera.';
}

// ---------------------------------------------------------------------------
// Peer connections (one per remote user — the mesh)
// ---------------------------------------------------------------------------

function ensurePeer(callId: string, userId: string): PeerEntry {
  const existing = peers.get(userId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const entry: PeerEntry = {
    pc,
    stream: new MediaStream(),
    pendingIce: [],
    makingOffer: false,
    lostTimer: null,
    connState: 'connecting',
    everConnected: false,
    restartAttempts: 0,
    restartTimer: null,
  };
  peers.set(userId, entry);
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  pc.ontrack = (ev) => {
    entry.stream.addTrack(ev.track);
    bumpMedia();
  };
  pc.onicecandidate = (ev) => {
    // End-of-candidates (null) is not relayed — the schema wants a candidate.
    if (!ev.candidate) return;
    sendEvent({
      t: 'call.ice',
      d: {
        call_id: callId,
        to_user: userId,
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        },
      },
    });
  };
  // v0.7.1 (§1.55): states derive from iceConnectionState — 'disconnected'
  // persisting CALL_ICE_DISCONNECT_GRACE_MS (or 'failed' immediately) starts
  // the bounded automatic ICE-restart loop; 'connected'/'completed' heals.
  pc.oniceconnectionstatechange = () => {
    const ui = store.state.callUi;
    if (!ui || ui.call_id !== callId) return;
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      clearPeerTimers(entry);
      entry.connState = 'connected';
      entry.everConnected = true;
      entry.restartAttempts = 0;
      store.patchCallUi({
        phase: ui.phase === 'ended' ? ui.phase : 'ongoing',
        reconnecting_ids: ui.reconnecting_ids.filter((id) => id !== userId),
      });
      reportConnState();
    } else if (s === 'failed') {
      pairLost(callId, userId);
    } else if (s === 'disconnected') {
      // Wait out a blip (transient blips self-heal and must not thrash
      // renegotiation); if it does not heal, the restart loop takes over.
      if (entry.lostTimer === null) {
        entry.lostTimer = setTimeout(() => {
          entry.lostTimer = null;
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            pairLost(callId, userId);
          }
        }, CALL_ICE_DISCONNECT_GRACE_MS);
      }
    }
  };
  syncPeerIds();
  return entry;
}

function clearPeerTimers(entry: PeerEntry): void {
  if (entry.lostTimer !== null) {
    clearTimeout(entry.lostTimer);
    entry.lostTimer = null;
  }
  if (entry.restartTimer !== null) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
}

function syncPeerIds(): void {
  const ui = store.state.callUi;
  if (!ui) return;
  store.patchCallUi({ peer_ids: [...peers.keys()] });
}

function closePeer(userId: string): void {
  const entry = peers.get(userId);
  if (!entry) return;
  clearPeerTimers(entry);
  entry.pc.onicecandidate = null;
  entry.pc.ontrack = null;
  entry.pc.oniceconnectionstatechange = null;
  entry.pc.close();
  peers.delete(userId);
  const ui = store.state.callUi;
  if (ui) {
    const peerStates = { ...ui.peer_states };
    delete peerStates[userId];
    store.patchCallUi({
      peer_ids: [...peers.keys()],
      reconnecting_ids: ui.reconnecting_ids.filter((id) => id !== userId),
      peer_states: peerStates,
    });
  }
  reportConnState();
  bumpMedia();
}

async function sendOfferTo(callId: string, userId: string, iceRestart = false): Promise<void> {
  const entry = ensurePeer(callId, userId);
  try {
    entry.makingOffer = true;
    const offer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await entry.pc.setLocalDescription(offer);
    const sdp = entry.pc.localDescription?.sdp;
    if (sdp) sendEvent({ t: 'call.offer', d: { call_id: callId, to_user: userId, sdp } });
  } catch {
    /* peer may be mid-teardown; the next call.updated reconciles */
  } finally {
    entry.makingOffer = false;
  }
}

// ---------------------------------------------------------------------------
// v0.7.1 connectivity state machine + bounded automatic ICE restart (§1.55,
// §2.12, ADR-017). The aggregate conn_state (connecting / connected /
// reconnecting / failed) is derived from the per-pair views; each TRANSITION
// is patched into the UI and reported to peers via ONE relayed `call.state`
// frame (a healthy call sends two, ever). ICE restart adds NO frame: it is
// restartIce() + a re-offer riding the existing call.offer/call.answer pair
// under the lower-user-id-impolite rule.
// ---------------------------------------------------------------------------

/** How long the POLITE side of a lost pair waits for the impolite peer's
 * restarts before calling the pair failed: the full backoff budget plus a
 * gather margin. */
const POLITE_GIVE_UP_MS =
  CALL_ICE_RESTART_BACKOFF_MS.reduce((a, b) => a + b, 0) + CALL_ICE_DISCONNECT_GRACE_MS * 3;

function aggregateConnState(): CallConnState {
  if (peers.size === 0) return 'connecting';
  const states = [...peers.values()].map((e) => e.connState);
  if (states.some((s) => s === 'connected')) return 'connected';
  if (states.some((s) => s === 'reconnecting')) return 'reconnecting';
  if (states.every((s) => s === 'failed')) return 'failed';
  return 'connecting';
}

/** WHY — verdict copy keyed on what is known (§1.55): no relay configured,
 * relay unreachable from here, peer gone. Never a bare "call failed". */
function failReason(): string {
  const ui = store.state.callUi;
  if (ui && ui.relay_available === false) {
    return 'This server has no call relay — calls only work on the same network.';
  }
  if (relayKnownUnreachable()) {
    return 'The call relay was not reachable from your network — cross-network calls cannot connect from here.';
  }
  return 'Their connection dropped and did not come back.';
}

/** Patch the aggregate into the UI and relay the transition (one frame per
 * transition, §2.12). */
function reportConnState(): void {
  const ui = store.state.callUi;
  if (!ui || ui.phase === 'ended' || !ui.call_id) return;
  const next = aggregateConnState();
  if (next === ui.conn_state) return;
  // All pairs gone at once only happens mid-teardown (hang-up closing peers)
  // or when everyone left (call.updated ends the call right behind) — never
  // report a bogus connected→connecting transition for that.
  if (ui.conn_state === 'connected' && next === 'connecting' && peers.size === 0) return;
  store.patchCallUi({
    conn_state: next,
    conn_reason: next === 'failed' ? failReason() : null,
  });
  sendEvent({ t: 'call.state', d: { call_id: ui.call_id, state: next } });
}

/** A pair's ICE dropped (grace elapsed, or hard 'failed'). Deterministic
 * roles (§2.12): the LOWER user id (impolite) restarts; the higher one marks
 * the tile, waits, and gives up after the full restart budget. */
function pairLost(callId: string, userId: string): void {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  const entry = peers.get(userId);
  if (!entry || entry.connState === 'failed') return;
  entry.connState = 'reconnecting';
  if (!ui.reconnecting_ids.includes(userId)) {
    store.patchCallUi({ reconnecting_ids: [...ui.reconnecting_ids, userId] });
  }
  reportConnState();
  if (meId() < userId) {
    scheduleRestartAttempt(callId, userId);
  } else if (entry.restartTimer === null) {
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      const s = entry.pc.iceConnectionState;
      if (s !== 'connected' && s !== 'completed') pairFailed(callId, userId);
    }, POLITE_GIVE_UP_MS);
  }
}

/** The impolite side's restart loop: backoff → refresh TURN creds →
 * restartIce() + re-offer → watchdog → next attempt, at most
 * CALL_ICE_RESTART_MAX_ATTEMPTS per outage (§1.55). */
function scheduleRestartAttempt(callId: string, userId: string): void {
  const entry = peers.get(userId);
  if (!entry || entry.restartTimer !== null) return;
  if (entry.restartAttempts >= CALL_ICE_RESTART_MAX_ATTEMPTS) {
    pairFailed(callId, userId);
    return;
  }
  const backoff =
    CALL_ICE_RESTART_BACKOFF_MS[Math.min(entry.restartAttempts, CALL_ICE_RESTART_BACKOFF_MS.length - 1)];
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = null;
    void (async () => {
      const ui = store.state.callUi;
      if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
      if (!peers.has(userId)) return;
      const s = entry.pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') return; // healed meanwhile
      entry.restartAttempts += 1;
      // Fresh TURN credentials before the restart (§1.55; 503/offline is fine
      // — host candidates carry on, exactly like the periodic refresh).
      try {
        const res = await api.get<TurnCredentialsResponse>(`/api/turn-credentials?call_id=${callId}`);
        turn = res.turn;
        entry.pc.setConfiguration({ iceServers: iceServers() });
      } catch {
        /* unconfigured or offline — restart on what we have */
      }
      try {
        entry.pc.restartIce();
      } catch {
        /* older engines: createOffer({iceRestart:true}) below does the job */
      }
      await sendOfferTo(callId, userId, true);
      // Watchdog: a restart that neither connects nor hard-fails within the
      // grace+gather window goes around again (bounded by the attempt cap).
      if (entry.restartTimer === null) {
        entry.restartTimer = setTimeout(() => {
          entry.restartTimer = null;
          const st = entry.pc.iceConnectionState;
          if (st !== 'connected' && st !== 'completed') scheduleRestartAttempt(callId, userId);
        }, CALL_ICE_DISCONNECT_GRACE_MS * 3);
      }
    })();
  }, backoff);
}

/** Out of attempts → the pair is failed (§1.55). A 1:1 call whose media NEVER
 * connected ends with the existing POST end {reason:'failed'}; one that had
 * connected shows the failed state + reason and leaves hanging up to the
 * user. In a group only that tile fails — the rest of the mesh carries on. */
function pairFailed(callId: string, userId: string): void {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  const entry = peers.get(userId);
  if (!entry || entry.connState === 'failed') return;
  clearPeerTimers(entry);
  entry.connState = 'failed';
  store.patchCallUi({ reconnecting_ids: ui.reconnecting_ids.filter((id) => id !== userId) });
  reportConnState();
  if (!ui.is_group && !entry.everConnected) {
    const reason = failReason();
    void api.post(`/api/calls/${callId}/end`, { reason: 'failed' }).catch(() => undefined);
    const cur = store.state.callUi;
    if (cur && cur.call_id === callId && cur.phase !== 'ended') {
      store.patchCallUi({ error: reason });
      endLocally('failed');
    }
  }
}

async function flushPendingIce(entry: PeerEntry): Promise<void> {
  const pending = entry.pendingIce.splice(0);
  for (const c of pending) {
    try {
      await entry.pc.addIceCandidate(toIceInit(c));
    } catch {
      /* stale candidate for a replaced description — harmless */
    }
  }
}

function toIceInit(c: IceCandidateInitLike): RTCIceCandidateInit {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  };
}

// ---------------------------------------------------------------------------
// TURN credential refresh (long calls refresh before expiry, §1.42)
// ---------------------------------------------------------------------------

function scheduleTurnRefresh(callId: string): void {
  if (turnTimer !== null) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (!turn) return;
  const ms = new Date(turn.expires_at).getTime() - Date.now() - 60_000;
  turnTimer = setTimeout(() => {
    turnTimer = null;
    void (async () => {
      const ui = store.state.callUi;
      if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
      try {
        const res = await api.get<TurnCredentialsResponse>(`/api/turn-credentials?call_id=${callId}`);
        turn = res.turn;
        for (const entry of peers.values()) {
          try {
            entry.pc.setConfiguration({ iceServers: iceServers() });
          } catch {
            /* closing pc */
          }
        }
        scheduleTurnRefresh(callId);
      } catch {
        /* 503 turn_unconfigured or offline — host candidates carry on */
      }
    })();
  }, Math.max(5_000, ms));
}

// ---------------------------------------------------------------------------
// Public API: start / accept / reject / hang up / controls
// ---------------------------------------------------------------------------

function baseUi(call: Call, kind: CallKind, outgoing: boolean): store.CallUi {
  return {
    call_id: call.id,
    conversation_id: call.conversation_id,
    kind,
    is_group: call.is_group,
    outgoing,
    phase: outgoing ? 'ringing' : 'connecting',
    answered_at: call.answered_at,
    mic_on: true,
    cam_on: kind === 'video',
    facing: 'user',
    peer_ids: [],
    reconnecting_ids: [],
    media_version: 0,
    ringing_heard: false,
    minimized: false,
    error: null,
    ended_reason: null,
    conn_state: 'connecting',
    conn_reason: null,
    peer_states: {},
    relay_available: null,
    push_note_dismissed: false,
  };
}

/** Start a call in a conversation (header buttons). Media first: a denied
 * permission never creates a durable call row. */
export async function startCall(conversationId: string, kind: CallKind): Promise<void> {
  if (store.state.callUi && store.state.callUi.phase !== 'ended') return;
  clearEndCard();
  let media: MediaStream;
  try {
    media = await getMedia(kind, 'user');
  } catch (err) {
    showCallError(mediaErrorCopy(err));
    return;
  }
  let res: CallResponse;
  try {
    res = await api.post<CallResponse>(`/api/conversations/${conversationId}/calls`, { kind });
  } catch (err) {
    stopTracks(media);
    if (err instanceof ApiError && err.code === 'call_active') {
      // A live call already exists — join it instead (§1.42).
      const live = store.state.liveCalls.get(conversationId);
      if (live) {
        await joinCall(live.id, live.kind, media);
        return;
      }
      showCallError('A call is already running in this chat — join it from the header.');
      return;
    }
    showCallError('Could not start the call. Try again.');
    return;
  }
  localStream = media;
  turn = res.turn;
  // TURN honesty (§1.55, FEATURES #90): POST …/calls returning turn: null is
  // the in-band "no relay" fact — the caller sees the inline warning on the
  // call screen BEFORE anyone picks up, never a silent failure.
  noteTurnFromCall(res.turn);
  store.upsertLiveCall(res.call);
  store.setCallUi({ ...baseUi(res.call, kind, true), relay_available: res.turn !== null });
  bumpMedia();
  scheduleTurnRefresh(res.call.id);
  // The invite frame makes everyone else ring (§2.12). The callee(s) will
  // offer to us once they join — the joining peer offers.
  sendEvent({ t: 'call.invite', d: { call_id: res.call.id } });
  // §2.12: the first of the (at most two, when healthy) call.state frames.
  sendEvent({ t: 'call.state', d: { call_id: res.call.id, state: 'connecting' } });
}

/** DM accept and group join are the same durable transition (§1.42). */
export async function joinCall(
  callId: string,
  kind: CallKind,
  preAcquired?: MediaStream
): Promise<void> {
  if (store.state.callUi && store.state.callUi.phase !== 'ended') return;
  clearEndCard();
  let media = preAcquired ?? null;
  if (!media) {
    try {
      media = await getMedia(kind, 'user');
    } catch (err) {
      showCallError(mediaErrorCopy(err));
      return;
    }
  }
  // The accept frame races ahead so the caller's UI reacts instantly and my
  // other devices stop ringing (§2.12); REST join is the durable flip.
  sendEvent({ t: 'call.accept', d: { call_id: callId } });
  let res: CallResponse;
  try {
    res = await api.post<CallResponse>(`/api/calls/${callId}/join`, {});
  } catch (err) {
    stopTracks(media);
    if (err instanceof ApiError && err.code === 'call_full') {
      showCallError('This call is full — 8 people max.');
    } else if (err instanceof ApiError && err.status === 410) {
      showCallError('That call already ended.');
    } else {
      showCallError('Could not join the call.');
    }
    store.setCallInvite(null);
    return;
  }
  localStream = media;
  turn = res.turn;
  noteTurnFromCall(res.turn);
  store.upsertLiveCall(res.call);
  store.setCallInvite(null);
  store.setCallUi({ ...baseUi(res.call, kind, false), relay_available: res.turn !== null });
  bumpMedia();
  scheduleTurnRefresh(callId);
  sendEvent({ t: 'call.state', d: { call_id: callId, state: 'connecting' } });
  // Mesh rule: the JOINING peer offers to every existing member (§2.12).
  for (const uid of res.call.participant_ids) {
    if (uid !== meId()) void sendOfferTo(callId, uid);
  }
}

/** Decline an incoming ring. DM: durable REST reject; group: the frame is
 * all a decline is — personal and ephemeral, the call keeps ringing. */
export async function rejectIncoming(): Promise<void> {
  const invite = store.state.callInvite;
  if (!invite) return;
  store.setCallInvite(null);
  sendEvent({ t: 'call.reject', d: { call_id: invite.call_id } });
  const conv = store.state.conversations.get(invite.conversation_id);
  if (!conv || conv.type === 'dm') {
    try {
      await api.post(`/api/calls/${invite.call_id}/reject`);
    } catch {
      /* already terminal / raced — the frame did the UI work */
    }
  }
}

/** Hang up / leave. The frame drops remote tiles instantly; REST is the
 * durable record (ring-cancel → missed; last member out → completed).
 *
 * The local teardown happens FIRST, before the durable POST is awaited: the
 * user's hang-up must be instant no matter how long the server takes. On a
 * stalled box the old order (await POST, then end) kept the call UI alive
 * for 10+ s, and every extra tap on the hang-up button fired another
 * POST /end (13 in 14 s on one call). Ending locally flips `phase` to
 * 'ended' synchronously, so the guard above makes every repeat a no-op —
 * exactly one durable POST per hang-up. */
export async function hangUp(reason: 'completed' | 'failed' = 'completed'): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.phase === 'ended') return;
  const frame = ui.is_group && peers.size > 1 ? 'call.leave' : 'call.end';
  sendEvent({ t: frame, d: { call_id: ui.call_id } });
  endLocally(ui.outgoing && ui.phase === 'ringing' ? 'cancelled' : 'ended');
  try {
    await api.post(`/api/calls/${ui.call_id}/end`, { reason });
  } catch {
    /* terminal already — idempotent server-side */
  }
}

export function toggleMic(): void {
  const ui = store.state.callUi;
  if (!ui || !localStream) return;
  const next = !ui.mic_on;
  for (const t of localStream.getAudioTracks()) t.enabled = next;
  store.patchCallUi({ mic_on: next });
}

export function toggleCam(): void {
  const ui = store.state.callUi;
  if (!ui || !localStream || ui.kind !== 'video') return;
  const next = !ui.cam_on;
  for (const t of localStream.getVideoTracks()) t.enabled = next;
  store.patchCallUi({ cam_on: next });
}

/** Front/back camera flip: new video track, replaceTrack on every sender. */
export async function flipCamera(): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || !localStream || ui.kind !== 'video') return;
  const facing = ui.facing === 'user' ? 'environment' : 'user';
  let fresh: MediaStream;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
  } catch {
    return; // single-camera device — keep what we have
  }
  const newTrack = fresh.getVideoTracks()[0];
  if (!newTrack) return;
  newTrack.enabled = ui.cam_on;
  const old = localStream.getVideoTracks()[0] ?? null;
  for (const entry of peers.values()) {
    const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) void sender.replaceTrack(newTrack);
  }
  if (old) {
    localStream.removeTrack(old);
    old.stop();
  }
  localStream.addTrack(newTrack);
  store.patchCallUi({ facing });
  bumpMedia();
}

export function setMinimized(min: boolean): void {
  store.patchCallUi({ minimized: min });
}

/** Dismiss the ended-call card. */
export function clearEndCard(): void {
  if (endCardTimer !== null) {
    clearTimeout(endCardTimer);
    endCardTimer = null;
  }
  const ui = store.state.callUi;
  if (ui && ui.phase === 'ended') store.setCallUi(null);
}

function showCallError(message: string): void {
  // A call that never got media/row still deserves visible feedback: surface
  // it as an ended-card with the error copy.
  store.setCallUi({
    call_id: '',
    conversation_id: '',
    kind: 'audio',
    is_group: false,
    outgoing: true,
    phase: 'ended',
    answered_at: null,
    mic_on: false,
    cam_on: false,
    facing: 'user',
    peer_ids: [],
    reconnecting_ids: [],
    media_version: 0,
    ringing_heard: false,
    minimized: false,
    error: message,
    ended_reason: null,
    conn_state: 'connecting',
    conn_reason: null,
    peer_states: {},
    relay_available: null,
    push_note_dismissed: false,
  });
  scheduleEndCardDismiss();
}

function scheduleEndCardDismiss(): void {
  if (endCardTimer !== null) clearTimeout(endCardTimer);
  endCardTimer = setTimeout(() => {
    endCardTimer = null;
    const ui = store.state.callUi;
    if (ui && ui.phase === 'ended') store.setCallUi(null);
  }, 4000);
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

/** Full teardown → ended card (auto-dismisses). */
function endLocally(reason: string): void {
  for (const id of [...peers.keys()]) closePeer(id);
  stopTracks(localStream);
  localStream = null;
  turn = null;
  if (turnTimer !== null) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  const ui = store.state.callUi;
  if (ui && ui.phase !== 'ended') {
    store.patchCallUi({ phase: 'ended', ended_reason: reason, minimized: false });
    scheduleEndCardDismiss();
  }
}

/** Hard teardown with no end card (logout). */
export function teardownCall(): void {
  for (const id of [...peers.keys()]) closePeer(id);
  stopTracks(localStream);
  localStream = null;
  turn = null;
  if (turnTimer !== null) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  clearEndCard();
  if (store.state.callUi) store.setCallUi(null);
  if (store.state.callInvite) store.setCallInvite(null);
}

// ---------------------------------------------------------------------------
// Inbound frames (dispatched from lib/connection.ts)
// ---------------------------------------------------------------------------

export function handleCallEvent(ev: CallServerEvent): void {
  switch (ev.t) {
    case 'call.invite': {
      // Busy in another call → let it ring on other devices; no overlay here.
      if (store.state.callUi && store.state.callUi.phase !== 'ended') return;
      store.setCallInvite(ev.d);
      // Tell the caller this device is ringing (their UI flips to "Ringing…").
      sendEvent({ t: 'call.ringing', d: { call_id: ev.d.call_id } });
      return;
    }
    case 'call.ringing': {
      const ui = store.state.callUi;
      if (ui && ui.call_id === ev.d.call_id && !ui.ringing_heard) {
        store.patchCallUi({ ringing_heard: true });
      }
      return;
    }
    case 'call.accept': {
      // My own other device accepted → this one stops ringing (§2.12).
      const invite = store.state.callInvite;
      if (invite && invite.call_id === ev.d.call_id && ev.d.from_user === meId()) {
        store.setCallInvite(null);
      }
      return;
    }
    case 'call.reject': {
      const invite = store.state.callInvite;
      if (invite && invite.call_id === ev.d.call_id && ev.d.from_user === meId()) {
        store.setCallInvite(null); // my other device declined
        return;
      }
      const ui = store.state.callUi;
      // DM caller: the decline frame stops the UI instantly; the durable
      // rejected status follows as call.updated.
      if (ui && ui.call_id === ev.d.call_id && !ui.is_group && ui.phase === 'ringing') {
        endLocally('declined');
      }
      return;
    }
    case 'call.offer': {
      void onOffer(ev.d.call_id, ev.d.from_user, ev.d.sdp);
      return;
    }
    case 'call.answer': {
      void onAnswer(ev.d.call_id, ev.d.from_user, ev.d.sdp);
      return;
    }
    case 'call.ice': {
      void onIce(ev.d.call_id, ev.d.from_user, ev.d.candidate);
      return;
    }
    case 'call.leave': {
      const ui = store.state.callUi;
      if (ui && ui.call_id === ev.d.call_id) closePeer(ev.d.from_user);
      return;
    }
    // v0.7.1 (§2.12): a peer's self-reported connection state — their tile
    // says the truth too ("reconnecting…"). Advisory UI truth only; a stale
    // value is corrected by the next frame or the member's leave/updated.
    case 'call.state': {
      const ui = store.state.callUi;
      if (!ui || ui.call_id !== ev.d.call_id || ui.phase === 'ended') return;
      if (ev.d.from_user === meId()) return; // my own relayed frame
      store.patchCallUi({ peer_states: { ...ui.peer_states, [ev.d.from_user]: ev.d.state } });
      return;
    }
    case 'call.end': {
      const invite = store.state.callInvite;
      if (invite && invite.call_id === ev.d.call_id) store.setCallInvite(null);
      const ui = store.state.callUi;
      if (ui && ui.call_id === ev.d.call_id && ui.phase !== 'ended') {
        endLocally('ended');
      }
      return;
    }
    case 'call.updated': {
      onCallUpdated(ev.d.call);
      return;
    }
  }
}

async function onOffer(callId: string, from: string, sdp: string): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  const entry = ensurePeer(callId, from);
  // Perfect negotiation per pair: the LOWER user id is impolite (§2.12) —
  // it ignores a colliding offer; the polite side rolls back implicitly.
  const polite = meId() > from;
  const collision = entry.makingOffer || entry.pc.signalingState !== 'stable';
  if (collision && !polite) return;
  try {
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    await flushPendingIce(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    const out = entry.pc.localDescription?.sdp;
    if (out) sendEvent({ t: 'call.answer', d: { call_id: callId, to_user: from, sdp: out } });
  } catch {
    /* mid-teardown; call.updated reconciles */
  }
}

async function onAnswer(callId: string, from: string, sdp: string): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  const entry = peers.get(from);
  if (!entry) return;
  try {
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    await flushPendingIce(entry);
  } catch {
    /* stale answer after a restart — the next offer cycle heals it */
  }
}

async function onIce(callId: string, from: string, candidate: IceCandidate): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  const entry = ensurePeer(callId, from);
  if (!entry.pc.remoteDescription) {
    entry.pendingIce.push(candidate);
    return;
  }
  try {
    await entry.pc.addIceCandidate(toIceInit(candidate));
  } catch {
    /* candidate for a replaced description */
  }
}

/** Durable truth (full-DTO replace by call.id, §2.3). */
function onCallUpdated(call: Call): void {
  store.upsertLiveCall(call);
  const terminal = call.status !== 'ringing' && call.status !== 'ongoing';

  const invite = store.state.callInvite;
  if (invite && invite.call_id === call.id && terminal) {
    store.setCallInvite(null); // missed/ended/rejected while this device rang
  }

  const ui = store.state.callUi;
  if (!ui || ui.call_id !== call.id || ui.phase === 'ended') return;

  if (terminal) {
    endLocally(
      call.status === 'rejected' ? 'declined' : call.status === 'missed' ? 'no answer' : 'ended'
    );
    return;
  }
  if (call.status === 'ongoing') {
    const patch: Partial<store.CallUi> = { answered_at: call.answered_at };
    if (ui.phase === 'ringing') patch.phase = 'connecting';
    store.patchCallUi(patch);
    // Membership reconcile: drop peers that left (their call.leave may have
    // been lost); NEVER offer to newcomers — the joining peer offers to us.
    for (const uid of [...peers.keys()]) {
      if (!call.participant_ids.includes(uid)) closePeer(uid);
    }
  }
}
