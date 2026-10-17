'use client';

// v0.6 calls (API.md §1.42 + §2.12): the incoming-ring overlay (works
// anywhere — mounted by GlobalOverlays inside AppShell), the full in-call
// screen (local preview + remote mesh grid, mute/camera/flip/end), the
// minimized floating pill, and the transient ended-call card. All media state
// lives in lib/webrtc.ts; this component only renders store.callUi /
// store.callInvite and re-grabs streams when media_version bumps.
import { useEffect, useRef } from 'react';
import type { CallKind } from '@socialchat/shared';
import { conversationTitle } from '@/lib/format';
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
import styles from './calls.module.css';

export default function CallOverlay() {
  const state = useAppState();
  const invite = state.callInvite;
  const ui = state.callUi;

  return (
    <>
      {/* The ring overlay hides while I'm already in a call (webrtc guards
          the invite away in that case, but belt and braces). */}
      {invite && !ui ? <IncomingRing /> : null}
      {ui && ui.phase !== 'ended' ? (ui.minimized ? <CallPill /> : <CallScreen />) : null}
      {ui && ui.phase === 'ended' ? <EndCard /> : null}
    </>
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
      : ui.phase === 'connecting'
        ? 'Connecting…'
        : duration ?? '';

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
                {ui.reconnecting_ids.includes(id) ? (
                  <span className={styles.tileBadge}>reconnecting…</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {ui.error ? <p className={styles.callStatus}>{ui.error}</p> : null}

      {ui.kind === 'video' ? (
        <div className={styles.pip} aria-label="Your camera preview">
          <LocalPreview version={ui.media_version} camOn={ui.cam_on} />
        </div>
      ) : null}

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
// Minimized pill + ended card
// ---------------------------------------------------------------------------

function CallPill() {
  const state = useAppState();
  const now = useNow(1000);
  const ui = state.callUi;
  if (!ui) return null;
  const duration = durationLabel(ui.answered_at, now);
  return (
    <button
      type="button"
      className={styles.pill}
      onClick={() => setMinimized(false)}
      aria-label="Return to call"
    >
      <PhoneIcon /> {duration ?? 'In call'} · Return
    </button>
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

function MinimizeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 12 L10 16.5 L16 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 6 L10 10.5 L16 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
    </svg>
  );
}
