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
import type {
  Call,
  CallKind,
  CallResponse,
  CallInviteEvent,
  CallRingingEvent,
  CallAcceptEvent,
  CallRejectEvent,
  CallOfferEvent,
  CallAnswerEvent,
  CallIceEvent,
  CallLeaveEvent,
  CallEndEvent,
  CallUpdatedEvent,
  IceCandidate,
  TurnCredentials,
  TurnCredentialsResponse,
} from '@socialchat/shared';
import { api, ApiError } from './api';
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
  | CallUpdatedEvent;

interface PeerEntry {
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** Trickled candidates that arrived before the remote description. */
  pendingIce: IceCandidateInitLike[];
  makingOffer: boolean;
  /** Timer waiting out a transient 'disconnected' before restarting ICE. */
  lostTimer: ReturnType<typeof setTimeout> | null;
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
  pc.onconnectionstatechange = () => {
    const ui = store.state.callUi;
    if (!ui || ui.call_id !== callId) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      if (entry.lostTimer !== null) {
        clearTimeout(entry.lostTimer);
        entry.lostTimer = null;
      }
      store.patchCallUi({
        phase: ui.phase === 'ended' ? ui.phase : 'ongoing',
        reconnecting_ids: ui.reconnecting_ids.filter((id) => id !== userId),
      });
    } else if (s === 'failed') {
      void attemptReconnect(callId, userId);
    } else if (s === 'disconnected') {
      // Wait out a blip; if it does not heal, restart ICE via a new offer.
      if (entry.lostTimer === null) {
        entry.lostTimer = setTimeout(() => {
          entry.lostTimer = null;
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            void attemptReconnect(callId, userId);
          }
        }, 3000);
      }
    }
  };
  syncPeerIds();
  return entry;
}

function syncPeerIds(): void {
  const ui = store.state.callUi;
  if (!ui) return;
  store.patchCallUi({ peer_ids: [...peers.keys()] });
}

function closePeer(userId: string): void {
  const entry = peers.get(userId);
  if (!entry) return;
  if (entry.lostTimer !== null) clearTimeout(entry.lostTimer);
  entry.pc.onicecandidate = null;
  entry.pc.ontrack = null;
  entry.pc.onconnectionstatechange = null;
  entry.pc.close();
  peers.delete(userId);
  const ui = store.state.callUi;
  if (ui) {
    store.patchCallUi({
      peer_ids: [...peers.keys()],
      reconnecting_ids: ui.reconnecting_ids.filter((id) => id !== userId),
    });
  }
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

/** Peer lost → reconnect attempt via a new offer. Deterministic roles: the
 * LOWER user id makes the restart offer (impolite peer, §2.12); the higher
 * one marks the tile and waits for it. */
async function attemptReconnect(callId: string, userId: string): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.call_id !== callId || ui.phase === 'ended') return;
  if (!ui.reconnecting_ids.includes(userId)) {
    store.patchCallUi({ reconnecting_ids: [...ui.reconnecting_ids, userId] });
  }
  if (meId() < userId) {
    await sendOfferTo(callId, userId, true);
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
  store.upsertLiveCall(res.call);
  store.setCallUi(baseUi(res.call, kind, true));
  bumpMedia();
  scheduleTurnRefresh(res.call.id);
  // The invite frame makes everyone else ring (§2.12). The callee(s) will
  // offer to us once they join — the joining peer offers.
  sendEvent({ t: 'call.invite', d: { call_id: res.call.id } });
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
  store.upsertLiveCall(res.call);
  store.setCallInvite(null);
  store.setCallUi(baseUi(res.call, kind, false));
  bumpMedia();
  scheduleTurnRefresh(callId);
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
 * durable record (ring-cancel → missed; last member out → completed). */
export async function hangUp(reason: 'completed' | 'failed' = 'completed'): Promise<void> {
  const ui = store.state.callUi;
  if (!ui || ui.phase === 'ended') return;
  const frame = ui.is_group && peers.size > 1 ? 'call.leave' : 'call.end';
  sendEvent({ t: frame, d: { call_id: ui.call_id } });
  try {
    await api.post(`/api/calls/${ui.call_id}/end`, { reason });
  } catch {
    /* terminal already — idempotent server-side */
  }
  endLocally(ui.outgoing && ui.phase === 'ringing' ? 'cancelled' : 'ended');
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
