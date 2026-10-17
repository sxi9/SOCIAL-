'use client';

// v0.6 calls (API.md §1.42 + §2.12) + v0.7.1 reliability (§1.55–§1.56,
// FEATURES #87–#90b): the incoming-ring overlay (works anywhere — mounted by
// GlobalOverlays inside AppShell), the full in-call screen (local preview +
// remote mesh grid, mute/camera/flip/end, honest connectivity states, TURN
// honesty banner, push-off note), the DRAGGABLE floating pill (avatar, live
// timer, mute, hang-up, video thumbnail / browser PiP), and the transient
// ended-call card. All media state lives in lib/webrtc.ts (a module
// singleton — the call survives full app navigation); this component only
// renders store.callUi / store.callInvite and re-grabs streams when
// media_version bumps. EVERYTHING renders through Portal into <body>
// (TROUBLESHOOTING: never a fixed overlay inside app chrome).
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Link from 'next/link';
import type { CallConnState, CallKind } from '@socialchat/shared';
import { conversationTitle } from '@/lib/format';
import { pushSupported } from '@/lib/push';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import { useReducedMotion } from '@/lib/useReducedMotion';
import {
  clearEndCard,
  flipCamera,
  getLocalStream,
  getRemoteStream,
  hangUp,
  joinCall,
  rejectIncoming,
  setMinimized,
  toggleCam,
  toggleMic,
} from '@/lib/webrtc';
import Avatar from './Avatar';
import Mascot from './Mascot';
import Portal from './Portal';
import styles from './calls.module.css';

export default function CallOverlay() {
  const state = useAppState();
  const invite = state.callInvite;
  const ui = state.callUi;

  return (
    <Portal>
      {/* The ring overlay hides while I'm already in a call (webrtc guards
          the invite away in that case, but belt and braces). */}
      {invite && !ui ? <IncomingRing /> : null}
      {ui && ui.phase !== 'ended' ? (ui.minimized ? <CallPill /> : <CallScreen />) : null}
      {ui && ui.phase === 'ended' ? <EndCard /> : null}
    </Portal>
  );
}

const KIND_LABEL: Record<CallKind, string> = { audio: 'Voice call', video: 'Video call' };

// ---------------------------------------------------------------------------
// Incoming ring
// ---------------------------------------------------------------------------

function IncomingRing() {
  const state = useAppState();
  const reduced = useReducedMotion();
  const invite = state.callInvite;
  if (!invite) return null;
  const conv = state.conversations.get(invite.conversation_id);
  const caller = conv?.participants.find((p) => p.user.id === invite.from_user)?.user ?? null;
  const callerName = caller?.display_name ?? 'Someone';
  const where = conv && conv.type !== 'dm' ? ` in ${conversationTitle(conv, state.me?.id)}` : '';

  return (
    <div className={styles.ringBackdrop} role="dialog" aria-modal="true" aria-label="Incoming call">
      <div className={styles.ringCard}>
        <span className={reduced ? undefined : styles.ringMascot} aria-hidden>
          <Mascot state="wave" size={104} />
        </span>
        {caller ? <Avatar avatar={caller.avatar} name={callerName} size={48} animated /> : null}
        <h2 className={styles.ringTitle}>{callerName}</h2>
        <p className={styles.ringSub}>
          {KIND_LABEL[invite.kind]}
          {where}
        </p>
        <span className={styles.ringPulse} aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <div className={styles.ringActions}>
          <button
            type="button"
            className={styles.ringAction}
            onClick={() => void rejectIncoming()}
          >
            <span className={`${styles.roundBtn} ${styles.reject}`} aria-hidden>
              <PhoneDownIcon />
            </span>
            Decline
          </button>
          <button
            type="button"
            className={styles.ringAction}
            onClick={() => void joinCall(invite.call_id, invite.kind)}
            autoFocus
          >
            <span className={`${styles.roundBtn} ${styles.accept}`} aria-hidden>
              <PhoneIcon />
            </span>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-call screen
// ---------------------------------------------------------------------------

function durationLabel(answeredAt: string | null, now: number): string | null {
  if (!answeredAt) return null;
  const s = Math.max(0, Math.floor((now - new Date(answeredAt).getTime()) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = (m % 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** v0.7.1 (§1.55): the states say the truth — connecting / connected /
 * reconnecting / failed, with the duration standing in for "connected". */
function connStatusLabel(connState: CallConnState, duration: string | null): string {
  switch (connState) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return duration ?? 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return 'Connection failed';
  }
}

const PEER_STATE_BADGE: Record<CallConnState, string | null> = {
  connecting: 'connecting…',
  connected: null,
  reconnecting: 'reconnecting…',
  failed: 'connection lost',
};

/** v0.7.1 (§1.56, FEATURES #90b): ring-dependent features surface the
 * push-off state instead of failing silently — dismissible context, never a
 * gate (calls still work in-app). */
function PushOffNote() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      setVisible(pushSupported() && Notification.permission !== 'granted');
    } catch {
      setVisible(false);
    }
  }, []);
  const dismissed = useAppState().callUi?.push_note_dismissed ?? true;
  if (!visible || dismissed) return null;
  return (
    <p className={styles.pushNote} role="note">
      <span>
        Notifications are off — you won&rsquo;t be rung when the app is closed.{' '}
        <Link href="/settings/profile">Turn them on</Link>
      </span>
      <button
        type="button"
        className={styles.pushNoteDismiss}
        aria-label="Dismiss"
        onClick={() => store.patchCallUi({ push_note_dismissed: true })}
      >
        ×
      </button>
    </p>
  );
}

function CallScreen() {
  const state = useAppState();
  const now = useNow(1000);
  const ui = state.callUi;
  if (!ui || ui.phase === 'ended') return null;
  const conv = state.conversations.get(ui.conversation_id);
  const title = conv ? conversationTitle(conv, state.me?.id) : 'Call';
  const duration = durationLabel(ui.answered_at, now);
  const status =
    ui.phase === 'ringing'
      ? ui.ringing_heard
        ? 'Ringing…'
        : 'Calling…'
      : connStatusLabel(ui.conn_state, duration);

  const nameOf = (userId: string): string =>
    conv?.participants.find((p) => p.user.id === userId)?.user.display_name ?? 'Peer';
  const avatarOf = (userId: string) =>
    conv?.participants.find((p) => p.user.id === userId)?.user ?? null;

  const peerIds = ui.peer_ids;
  const gridClass =
    peerIds.length <= 1
      ? styles.grid
      : peerIds.length <= 4
        ? `${styles.grid} ${styles.grid2}`
        : `${styles.grid} ${styles.grid9}`;

  // media_version is read so this component re-renders (and tiles re-grab
  // their streams) whenever lib/webrtc mutates media.
  void ui.media_version;

  return (
    <div className={styles.callScreen} role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[ui.kind]} — ${title}`}>
      <div className={styles.callTop}>
        <div className={styles.callTitle}>
          <h2>{title}</h2>
          <p>
            {KIND_LABEL[ui.kind]} · {status}
          </p>
        </div>
        <button
          type="button"
          className={styles.minBtn}
          aria-label="Minimize call"
          onClick={() => setMinimized(true)}
        >
          <MinimizeIcon />
        </button>
      </div>

      {/* gridWrap anchors the self-camera PiP INSIDE the video area, so it
          can never cover the notice lines (TURN warning, push-off note,
          failure reason) that sit between the grid and the controls. */}
      <div className={styles.gridWrap}>
        <div className={gridClass}>
          {peerIds.length === 0 ? (
          <div className={styles.tile}>
            <div className={styles.tileFace}>
              <Mascot state={ui.phase === 'ringing' ? 'watch' : 'idle'} size={84} />
              <span className="muted small">{status}</span>
            </div>
          </div>
        ) : (
          peerIds.map((id) => {
            const user = avatarOf(id);
            return (
              <div key={id} className={styles.tile}>
                <RemoteMedia userId={id} version={ui.media_version} video={ui.kind === 'video'} />
                {ui.kind !== 'video' || !remoteHasVideo(id) ? (
                  <div className={styles.tileFace}>
                    {user ? <Avatar avatar={user.avatar} name={user.display_name} size={64} /> : null}
                  </div>
                ) : null}
                <span className={styles.tileName}>{nameOf(id)}</span>
                {(() => {
                  // My view of the pair wins; otherwise the peer's own
                  // relayed call.state report (§2.12) — their tile is honest
                  // about THEIR network too.
                  const badge = ui.reconnecting_ids.includes(id)
                    ? 'reconnecting…'
                    : PEER_STATE_BADGE[ui.peer_states[id] ?? 'connected'];
                  return badge ? <span className={styles.tileBadge}>{badge}</span> : null;
                })()}
              </div>
            );
          })
          )}
        </div>
        {ui.kind === 'video' ? (
          <div className={styles.pip} aria-label="Your camera preview">
            <LocalPreview version={ui.media_version} camOn={ui.cam_on} />
          </div>
        ) : null}
      </div>

      {/* TURN honesty (§1.55, FEATURES #90): inline + non-blocking — the
          caller learns BEFORE anyone picks up, never via a silent failure. */}
      {ui.relay_available === false ? (
        <p className={styles.relayWarn} role="note">
          This server has no call relay — calls only work on the same network.
        </p>
      ) : null}
      {ui.conn_state === 'failed' && ui.conn_reason ? (
        <p className={styles.callStatus}>{ui.conn_reason}</p>
      ) : null}
      {ui.error ? <p className={styles.callStatus}>{ui.error}</p> : null}
      <PushOffNote />

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.ctl}${ui.mic_on ? '' : ` ${styles.ctlOff}`}`}
          aria-label={ui.mic_on ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={!ui.mic_on}
          onClick={toggleMic}
        >
          {ui.mic_on ? <MicIcon /> : <MicOffIcon />}
        </button>
        {ui.kind === 'video' ? (
          <>
            <button
              type="button"
              className={`${styles.ctl}${ui.cam_on ? '' : ` ${styles.ctlOff}`}`}
              aria-label={ui.cam_on ? 'Turn camera off' : 'Turn camera on'}
              aria-pressed={!ui.cam_on}
              onClick={toggleCam}
            >
              {ui.cam_on ? <CamIcon /> : <CamOffIcon />}
            </button>
            <button
              type="button"
              className={styles.ctl}
              aria-label="Flip camera"
              onClick={() => void flipCamera()}
            >
              <FlipIcon />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`${styles.ctl} ${styles.ctlEnd}`}
          aria-label="End call"
          onClick={() => void hangUp()}
        >
          <PhoneDownIcon />
        </button>
      </div>
    </div>
  );
}

function remoteHasVideo(userId: string): boolean {
  const s = getRemoteStream(userId);
  return !!s && s.getVideoTracks().some((t) => t.readyState === 'live');
}

function RemoteMedia({ userId, version, video }: { userId: string; version: number; video: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const stream = getRemoteStream(userId);
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [userId, version]);
  // A <video> element carries audio-only streams fine; it just stays black
  // behind the avatar face when there is no live video track.
  return <video ref={ref} autoPlay playsInline style={video ? undefined : { display: 'none' }} />;
}

function LocalPreview({ version, camOn }: { version: number; camOn: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const stream = getLocalStream();
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [version]);
  return <video ref={ref} autoPlay playsInline muted style={camOn ? undefined : { opacity: 0.25 }} />;
}

// ---------------------------------------------------------------------------
// Minimized floating pill (v0.7.1 — FEATURES #87): draggable, avatar, live
// timer, mute, hang-up; video keeps a thumbnail (+ browser PiP where
// supported); tap expands. The RTCPeerConnections live in the lib/webrtc
// module singleton, so the call itself survives any navigation — this pill
// merely keeps it on screen. Position persists across remounts/pages in a
// module variable (per-session UI convenience, not state).
// ---------------------------------------------------------------------------

let pillPos: { x: number; y: number } | null = null;

function clampPillPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

function CallPill() {
  const state = useAppState();
  const now = useNow(1000);
  const ui = state.callUi;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  // Survives past pointerup so the click that follows a drag never expands.
  const movedRef = useRef(false);
  const [, forceRender] = useState(0);

  if (!ui) return null;
  const duration = durationLabel(ui.answered_at, now);
  const label =
    ui.phase === 'ringing'
      ? 'Ringing…'
      : ui.conn_state === 'reconnecting'
        ? 'Reconnecting…'
        : ui.conn_state === 'failed'
          ? 'Failed'
          : duration ?? 'In call';

  const conv = state.conversations.get(ui.conversation_id);
  const peerUser =
    conv?.participants.find((p) => p.user.id === ui.peer_ids[0])?.user ??
    (conv && state.me ? conv.participants.find((p) => p.user.id !== state.me?.id)?.user ?? null : null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement;
    if (target.closest('[data-nodrag]')) return; // mute/hang-up/PiP taps
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pillPos = { x: rect.left, y: rect.top };
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: rect.left,
      y: rect.top,
    };
    movedRef.current = false;
    // Deliberately NO setPointerCapture here: capturing on pointerdown makes
    // the browser retarget the follow-up click to this wrapper, which
    // swallowed plain taps (the expand button's click never fired). Capture
    // starts only once movement crosses the drag threshold (onPointerMove).
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    const el = wrapRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!movedRef.current) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      movedRef.current = true;
      try {
        el.setPointerCapture(d.pointerId); // now it's a drag — keep it smooth
      } catch {
        /* pointer already gone — the drag just ends */
      }
    }
    const rect = el.getBoundingClientRect();
    pillPos = clampPillPos(d.x + dx, d.y + dy, rect.width, rect.height);
    forceRender((v) => v + 1);
  }

  function onPointerUp(): void {
    dragRef.current = null;
  }

  // Expand lives on the WRAPPER click (not only the inner button): after a
  // captured drag the release-click retargets to the wrapper, so this is the
  // one place that reliably sees both the drag-release click (consumed via
  // movedRef) and a genuine tap anywhere on the pill body. Keyboard
  // activation of the "Return to call" button bubbles here too.
  function onWrapClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // mute/hang-up/PiP
    if (movedRef.current) {
      movedRef.current = false;
      return; // that was a drag, not a tap
    }
    expand();
  }

  function expand(): void {
    // Leave browser PiP when returning to the full screen.
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
    }
    setMinimized(false);
  }

  // Thumbnail stream for video calls: first remote with live video, else me.
  const thumbUserId =
    ui.kind === 'video' ? ui.peer_ids.find((id) => remoteHasVideo(id)) ?? null : null;

  return (
    <div
      ref={wrapRef}
      className={styles.pillWrap}
      style={pillPos ? { left: pillPos.x, top: pillPos.y, right: 'auto', bottom: 'auto' } : undefined}
      role="group"
      aria-label="Ongoing call"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onWrapClick}
    >
      {/* Remote AUDIO must keep playing while the full screen's <video>
          elements are unmounted — hidden sinks hold every peer's stream. */}
      <PillAudio peerIds={ui.peer_ids} version={ui.media_version} />
      {ui.kind === 'video' ? (
        <PillThumb userId={thumbUserId} version={ui.media_version} />
      ) : null}
      <button type="button" className={styles.pillMain} aria-label="Return to call">
        {peerUser ? (
          <Avatar avatar={peerUser.avatar} name={peerUser.display_name} size={26} />
        ) : (
          <PhoneIcon />
        )}
        <span className={styles.pillTime}>{label}</span>
      </button>
      <button
        type="button"
        data-nodrag
        className={`${styles.pillCtl}${ui.mic_on ? '' : ` ${styles.pillCtlOff}`}`}
        aria-label={ui.mic_on ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={!ui.mic_on}
        onClick={toggleMic}
      >
        {ui.mic_on ? <MicIcon /> : <MicOffIcon />}
      </button>
      <button
        type="button"
        data-nodrag
        className={`${styles.pillCtl} ${styles.pillEnd}`}
        aria-label="End call"
        onClick={() => void hangUp()}
      >
        <PhoneDownIcon />
      </button>
    </div>
  );
}

function PillAudio({ peerIds, version }: { peerIds: string[]; version: number }) {
  return (
    <span hidden>
      {peerIds.map((id) => (
        <PillAudioSink key={id} userId={id} version={version} />
      ))}
    </span>
  );
}

function PillAudioSink({ userId, version }: { userId: string; version: number }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const stream = getRemoteStream(userId);
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [userId, version]);
  return <audio ref={ref} autoPlay />;
}

/** The pill's video thumbnail; doubles as the browser-PiP source where the
 * engine supports requestPictureInPicture (FEATURES #87). Muted — audio
 * rides the hidden sinks above so a group call keeps every voice. */
function PillThumb({ userId, version }: { userId: string | null; version: number }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [pipOk, setPipOk] = useState(false);
  useEffect(() => {
    setPipOk(typeof document !== 'undefined' && document.pictureInPictureEnabled === true);
  }, []);
  useEffect(() => {
    const el = ref.current;
    const stream = userId ? getRemoteStream(userId) : getLocalStream();
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [userId, version]);
  async function togglePip(): Promise<void> {
    const el = ref.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* unsupported / no video track yet — the thumbnail stays */
    }
  }
  return (
    <span className={styles.pillThumb}>
      <video ref={ref} autoPlay playsInline muted />
      {pipOk ? (
        <button type="button" data-nodrag className={styles.pillPip} aria-label="Picture in picture" onClick={() => void togglePip()}>
          <PipIcon />
        </button>
      ) : null}
    </span>
  );
}

function EndCard() {
  const state = useAppState();
  const ui = state.callUi;
  if (!ui) return null;
  const copy = ui.error ?? (ui.ended_reason === 'declined'
    ? 'Call declined.'
    : ui.ended_reason === 'no answer'
      ? 'No answer.'
      : ui.ended_reason === 'cancelled'
        ? 'Call cancelled.'
        : 'Call ended.');
  return (
    <div className={styles.endCard} role="status">
      <p>{copy}</p>
      <button type="button" className="btn btn-ghost" onClick={clearEndCard}>
        OK
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons (hand-drawn, same stroke language as the rest of the app)
// ---------------------------------------------------------------------------

export function PhoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 4.5 C5 4.5 7.6 4 8.2 4.6 L9.9 7.4 C10.3 8 9.1 9.4 9.5 10.2 C10.3 11.9 12.1 13.7 13.8 14.5 C14.6 14.9 16 13.7 16.6 14.1 L19.4 15.8 C20 16.4 19.5 19 19.5 19 C19.2 19.8 17.6 20.4 16.4 20.2 C10.6 19.2 4.8 13.4 3.8 7.6 C3.6 6.4 4.2 4.8 5 4.5 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function VideoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="6.5" width="13" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 10.6 L20.4 8 V16 L16 13.4" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function PhoneDownIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.2 13.8 C3.2 13.8 3 11.2 3.7 10.7 C8.5 7.1 15.5 7.1 20.3 10.7 C21 11.2 20.8 13.8 20.8 13.8 C20.6 14.6 19.2 15.4 18 15.3 L15 14.8 C14.3 14.7 13.9 12.9 13 12.7 C11.2 12.3 12.8 12.3 11 12.7 C10.1 12.9 9.7 14.7 9 14.8 L6 15.3 C4.8 15.4 3.4 14.6 3.2 13.8 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4.5 4.5 L19.5 19.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function CamIcon() {
  return <VideoIcon />;
}

function CamOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="6.5" width="13" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 10.6 L20.4 8 V16 L16 13.4" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M4 4.5 L20 19.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 8 a7 5.5 0 0 1 12 2 M17 16 a7 5.5 0 0 1 -12 -2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M19.5 6.5 V10 H16 M4.5 17.5 V14 H8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <rect x="11.5" y="11" width="7" height="5.5" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 12 L10 16.5 L16 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 6 L10 10.5 L16 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
    </svg>
  );
}
