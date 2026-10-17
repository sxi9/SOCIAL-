// v0.7.1 call self-test + TURN honesty (API.md §1.55, ADR-017, FEATURES
// #89/#90). GET /api/call-selftest is the ONE authed read of the instance's
// TURN state; relay REACHABILITY is decided client-side — only the browser can
// test the UDP path from where the user actually sits. What a past self-test
// learned on this device is remembered in localStorage (device-local by
// design, like the push explainer) so the pre-dial warning can say "the relay
// wasn't reachable from here" instead of silently failing.
import {
  CALL_SELFTEST_GATHER_TIMEOUT_MS,
  type CallSelftestResponse,
  type TurnCredentials,
} from '@socialchat/shared';
import { api } from './api';

/** Device-local memory of the last relay-reachability verdict ('1' = the last
 * self-test on this device could NOT reach the relay). */
const RELAY_UNREACHABLE_KEY = 'bc.call-relay-unreachable';

// Session cache: turn_configured is a read-only environment fact — one GET
// per session is plenty (§1.55 caller warning: "cached per session").
let turnConfiguredCache: boolean | null = null;

/** The instance's TURN state, cached per session. null = could not be read
 * (offline / rate-limited) — callers treat that as "unknown", never "absent". */
export async function getTurnConfigured(): Promise<boolean | null> {
  if (turnConfiguredCache !== null) return turnConfiguredCache;
  try {
    const res = await api.get<CallSelftestResponse>('/api/call-selftest');
    turnConfiguredCache = res.turn_configured;
    return turnConfiguredCache;
  } catch {
    return null;
  }
}

/** POST …/calls returning turn: null is the same fact in-band (§1.55). */
export function noteTurnFromCall(turn: TurnCredentials | null): void {
  if (turn !== null) turnConfiguredCache = true;
  else turnConfiguredCache = false;
}

export function relayKnownUnreachable(): boolean {
  try {
    return localStorage.getItem(RELAY_UNREACHABLE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberRelayVerdict(reachable: boolean): void {
  try {
    if (reachable) localStorage.removeItem(RELAY_UNREACHABLE_KEY);
    else localStorage.setItem(RELAY_UNREACHABLE_KEY, '1');
  } catch {
    /* storage blocked — the verdict still shows on the page */
  }
}

// ---------------------------------------------------------------------------
// The self-test itself (Settings → Call self-test, FEATURES #89)
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface SelftestReport {
  secureContext: boolean;
  /** 'granted' | 'denied' | 'no-device' | 'error' */
  mic: string;
  cam: string;
  /** null = the GET failed (offline / rate-limited). */
  turnConfigured: boolean | null;
  /** null = not probed (TURN unconfigured or GET failed). */
  relayReachable: boolean | null;
  /** Candidate types the default-policy gather found (host / srflx / relay). */
  candidateTypes: string[];
  /** Plain-words verdict, worst finding first (§1.55). */
  verdict: string;
  verdictStatus: CheckStatus;
}

/** One bounded ICE gather; resolves with the candidate types seen. */
function gatherCandidateTypes(
  iceServers: RTCIceServer[],
  policy: RTCIceTransportPolicy
): Promise<Set<string>> {
  return new Promise((resolve) => {
    const types = new Set<string>();
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: policy });
    } catch {
      resolve(types);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      resolve(types);
    };
    // A gather that produces nothing within the window is the verdict
    // (CALL_SELFTEST_GATHER_TIMEOUT_MS, §1.55).
    const timer = setTimeout(finish, CALL_SELFTEST_GATHER_TIMEOUT_MS);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        finish(); // end-of-candidates
        return;
      }
      const m = / typ ([a-z]+)/.exec(ev.candidate.candidate);
      if (m) types.add(m[1]);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.createDataChannel('probe');
    void pc
      .createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}

async function probePermission(kind: 'audio' | 'video'): Promise<string> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'audio' ? { audio: true } : { video: true }
    );
    for (const t of stream.getTracks()) t.stop(); // probe only — stop at once
    return 'granted';
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'denied';
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'no-device';
    }
    return 'error';
  }
}

/** Runs the §1.55 checks in order: secure context → mic/cam probe → GET
 * /api/call-selftest → (when configured) relay-only gather with the probe
 * creds + default-policy candidate inventory. */
export async function runCallSelftest(): Promise<SelftestReport> {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;

  const mic = secureContext ? await probePermission('audio') : 'error';
  const cam = secureContext ? await probePermission('video') : 'error';

  let turnConfigured: boolean | null = null;
  let turn: TurnCredentials | null = null;
  try {
    const res = await api.get<CallSelftestResponse>('/api/call-selftest');
    turnConfigured = res.turn_configured;
    turn = res.turn;
    turnConfiguredCache = res.turn_configured;
  } catch {
    turnConfigured = null;
  }

  let relayReachable: boolean | null = null;
  let candidateTypes: string[] = [];
  if (secureContext) {
    const turnServers: RTCIceServer[] =
      turn !== null ? [{ urls: turn.uris, username: turn.username, credential: turn.credential }] : [];
    if (turnConfigured && turn) {
      // Relay reachable iff a `relay` candidate appears in a relay-only gather.
      const relayTypes = await gatherCandidateTypes(turnServers, 'relay');
      relayReachable = relayTypes.has('relay');
      rememberRelayVerdict(relayReachable);
    }
    // Default-policy gather: the candidate-type inventory (host/srflx/relay).
    const all = await gatherCandidateTypes(turnServers, 'all');
    candidateTypes = ['host', 'srflx', 'relay'].filter((t) => all.has(t));
  }

  // Verdict in plain words, worst finding first (§1.55).
  let verdict: string;
  let verdictStatus: CheckStatus;
  if (!secureContext) {
    verdict =
      'This page is not a secure context, so the browser blocks the microphone and camera entirely. Open the app via its HTTPS address (the tunnel URL), never a plain LAN IP.';
    verdictStatus = 'fail';
  } else if (mic === 'denied') {
    verdict =
      'Microphone permission is blocked — calls cannot start. Allow it for this site in your browser settings, then run the test again.';
    verdictStatus = 'fail';
  } else if (mic === 'no-device') {
    verdict = 'No microphone was found on this device — calls need one.';
    verdictStatus = 'fail';
  } else if (turnConfigured === false) {
    verdict =
      'This server has no call relay — calls only work on the same network. Same-WiFi and same-machine calls are fine; cross-network calls need the server deployed with a reachable relay (VPS or port forwarding).';
    verdictStatus = 'warn';
  } else if (turnConfigured === true && relayReachable === false) {
    verdict =
      'A relay is configured but it was not reachable from your network, so cross-network calls will fail from here. Same-network calls still work. A laptop behind home NAT with an HTTP-only tunnel can never relay media — cross-network calls need the VPS deploy or port forwarding.';
    verdictStatus = 'warn';
  } else if (turnConfigured === null) {
    verdict =
      'Could not read the server call-relay state (offline or rate-limited) — try again in a bit. Your microphone and camera look fine.';
    verdictStatus = 'warn';
  } else {
    verdict =
      cam === 'granted'
        ? 'Everything looks good — calls should work, including across networks through the relay.'
        : 'Voice calls should work, including across networks through the relay. Camera is unavailable, so video calls will be voice-only from this device.';
    verdictStatus = 'pass';
  }

  return { secureContext, mic, cam, turnConfigured, relayReachable, candidateTypes, verdict, verdictStatus };
}
