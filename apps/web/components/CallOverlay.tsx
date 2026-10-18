'use client';

// v0.6 calls (API.md §1.42 + §2.12) + v0.7.1 reliability (§1.55–§1.56,
// FEATURES #87–#90b), reskinned to Royal v2 (proto refs 22–26): the
// full-screen incoming ring (blurred avatar backdrop, pulsing ring), the
// in-call screen (centered 1:1 voice, two-half split video with tap-to-swap
// focus + a draggable 86×120 PiP, 2×2 group grid with an active-speaker
// ring), honest connectivity states, TURN honesty banner, push-off note,
// the DRAGGABLE green minimized pill ("tap to return"), and the transient
// ended-call card. All media state lives in lib/webrtc.ts (a module
// singleton — the call survives full app navigation); this component only
// renders store.callUi / store.callInvite and re-grabs streams when
// media_version bumps. EVERYTHING renders through Portal into <body>
// (TROUBLESHOOTING: never a fixed overlay inside app chrome).
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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

/** Enter/Space activation for the tap-to-swap video tiles. */
function keyActivate(fn: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

// ---------------------------------------------------------------------------
// Incoming ring (proto 22): full-screen bg-deep, blurred avatar backdrop,
// pulsing avatar ring (static under reduced motion), 66px decline/accept.
// ---------------------------------------------------------------------------

function IncomingRing() {
  const state = useAppState();
  const reduced = useReducedMotion();
  const invite = state.callInvite;
  if (!invite) return null;
  const conv = state.conversations.get(invite.conversation_id);
  const caller = conv?.participants.find((p) => p.user.id === invite.from_user)?.user ?? null;
  const callerName = caller?.display_name ?? 'Someone';
  const where = conv && conv.type !== 'dm' ? ` · ${conversationTitle(conv, state.me?.id)}` : '';

  return (
    <div className={styles.ringBackdrop} role="dialog" aria-modal="true" aria-label="Incoming call">
      {caller ? (
        <span className={styles.ringBlur} aria-hidden>
          <Avatar avatar={caller.avatar} name={callerName} size={300} />
        </span>
      ) : null}
      <div className={styles.ringBody}>
        {caller ? (
          <span
            className={`${styles.ringAvatar}${reduced ? '' : ` ${styles.ringAvatarPulse}`}`}
            aria-hidden
          >
            <Avatar avatar={caller.avatar} name={callerName} size={104} animated />
          </span>
        ) : null}
        <h2 className={styles.ringTitle}>{callerName}</h2>
        <p className={styles.ringSub}>
          incoming {invite.kind === 'video' ? 'video' : 'voice'} call
          {where}
        </p>
      </div>
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
        <Link href="/settings/notifications">Turn them on</Link>
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

const EMPTY_IDS: string[] = [];

/** Active-speaker detection for the group-grid ring (proto 25): a local
 * AnalyserNode per remote stream, sampled a few times a second. Pure view
 * layer — it never touches lib/webrtc — and any failure (autoplay policy,
 * missing AudioContext) just means no ring. */
function useSpeakingIds(peerIds: string[], version: number, enabled: boolean): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const key = peerIds.join('|');
  useEffect(() => {
    if (!enabled || peerIds.length === 0) {
      setSpeaking((prev) => (prev.size === 0 ? prev : new Set<string>()));
      return;
    }
    let ctx: AudioContext | null = null;
    const probes: Array<{ id: string; node: AnalyserNode; data: Uint8Array }> = [];
    try {
      ctx = new AudioContext();
      for (const id of peerIds) {
        const stream = getRemoteStream(id);
        if (!stream || stream.getAudioTracks().length === 0) continue;
        const node = ctx.createAnalyser();
        node.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(node);
        probes.push({ id, node, data: new Uint8Array(node.fftSize) });
      }
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      probes.length = 0;
    }
    if (!ctx || probes.length === 0) {
      if (ctx) void ctx.close().catch(() => undefined);
      return;
    }
    const owned = ctx;
    const timer = window.setInterval(() => {
      const next = new Set<string>();
      for (const p of probes) {
        try {
          p.node.getByteTimeDomainData(p.data);
        } catch {
          continue;
        }
        let sum = 0;
        for (let i = 0; i < p.data.length; i += 1) {
          const v = (p.data[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / p.data.length) > 0.05) next.add(p.id);
      }
      setSpeaking((prev) =>
        prev.size === next.size && Array.from(next).every((id) => prev.has(id)) ? prev : next,
      );
    }, 260);
    return () => {
      window.clearInterval(timer);
      void owned.close().catch(() => undefined);
    };
    // peerIds is folded into `key`; version re-runs when streams change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, enabled]);
  return speaking;
}

function CallScreen() {
  const state = useAppState();
  const now = useNow(1000);
  const ui = state.callUi;

  // 1:1 video layout state (proto 24): null = two-half split (the default);
  // otherwise that party fills and the other rides the draggable PiP.
  const [focus, setFocus] = useState<'remote' | 'local' | null>(null);
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pipDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const pipMovedRef = useRef(false);

  const speakingIds = useSpeakingIds(
    ui?.peer_ids ?? EMPTY_IDS,
    ui?.media_version ?? 0,
    (ui?.peer_ids.length ?? 0) > 1 && ui?.phase !== 'ended',
  );

  if (!ui || ui.phase === 'ended') return null;
  const me = state.me;
  const conv = state.conversations.get(ui.conversation_id);
  const title = conv ? conversationTitle(conv, me?.id) : 'Call';
  const duration = durationLabel(ui.answered_at, now);
  const status =
    ui.phase === 'ringing'
      ? ui.ringing_heard
        ? 'Ringing…'
        : 'Calling…'
      : connStatusLabel(ui.conn_state, duration);
  const statusLive = ui.phase !== 'ringing' && ui.conn_state === 'connected' && duration !== null;

  const nameOf = (userId: string): string =>
    conv?.participants.find((p) => p.user.id === userId)?.user.display_name ?? 'Peer';
  const avatarOf = (userId: string) =>
    conv?.participants.find((p) => p.user.id === userId)?.user ?? null;
  const badgeOf = (userId: string): string | null =>
    ui.reconnecting_ids.includes(userId)
      ? 'reconnecting…'
      : // My view of the pair wins; otherwise the peer's own relayed
        // call.state report (§2.12) — their tile is honest about THEIR
        // network too.
        PEER_STATE_BADGE[ui.peer_states[userId] ?? 'connected'];

  const peerIds = ui.peer_ids;
  const voiceCentered = !ui.is_group && ui.kind === 'audio';
  const videoSplit = !ui.is_group && ui.kind === 'video';
  // Group video gets a "You" tile in the grid (proto 25); voice doesn't.
  const tileCount = peerIds.length + (ui.kind === 'video' && !videoSplit ? 1 : 0);
  const gridClass =
    tileCount <= 1
      ? styles.grid
      : tileCount <= 4
        ? `${styles.grid} ${styles.grid2}`
        : `${styles.grid} ${styles.grid9}`;

  // media_version is read so this component re-renders (and tiles re-grab
  // their streams) whenever lib/webrtc mutates media.
  void ui.media_version;

  const voiceUser = (peerIds[0] ? avatarOf(peerIds[0]) : null) ??
    conv?.participants.find((p) => p.user.id !== me?.id)?.user ??
    null;
  const voiceBadge = peerIds[0] ? badgeOf(peerIds[0]) : null;
  const remoteId = peerIds[0] ?? null;

  /** One remote party's media + name chip + honesty badge. */
  const renderPeerInner = (id: string) => {
    const user = avatarOf(id);
    const video = ui.kind === 'video';
    const hasVideo = video && remoteHasVideo(id);
    const speaking = speakingIds.has(id);
    const badge = badgeOf(id);
    return (
      <>
        <RemoteMedia userId={id} version={ui.media_version} video={video} />
        {!hasVideo ? (
          <div className={styles.tileFace}>
            {user ? <Avatar avatar={user.avatar} name={user.display_name} size={64} /> : null}
          </div>
        ) : null}
        <span className={styles.tileName}>
          {nameOf(id)}
          {speaking ? ' · speaking' : video && !hasVideo ? ' · cam off' : ''}
        </span>
        {badge ? <span className={styles.tileBadge}>{badge}</span> : null}
      </>
    );
  };

  /** My own camera (mirrored) + "You" chip; avatar on panel when cam off. */
  const renderYouInner = () => (
    <>
      <LocalPreview version={ui.media_version} camOn={ui.cam_on} />
      {!ui.cam_on ? (
        <div className={styles.tileFace}>
          {me ? <Avatar avatar={me.avatar} name={me.display_name} size={64} /> : null}
        </div>
      ) : null}
      <span className={styles.tileName}>You{ui.cam_on ? '' : ' · cam off'}</span>
    </>
  );

  // ---- draggable PiP (focus mode, proto 24): same capture-on-threshold
  // pattern as the pill, so a plain tap still swaps. ----
  function onPipPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    pipDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: rect.left - wr.left,
      y: rect.top - wr.top,
    };
    pipMovedRef.current = false;
  }

  function onPipPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = pipDragRef.current;
    const wrap = wrapRef.current;
    if (!d || !wrap) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!pipMovedRef.current) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      pipMovedRef.current = true;
      try {
        e.currentTarget.setPointerCapture(d.pointerId);
      } catch {
        /* pointer already gone — the drag just ends */
      }
    }
    const wr = wrap.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    const maxX = Math.max(8, wr.width - r.width - 8);
    const maxY = Math.max(8, wr.height - r.height - 8);
    setPipPos({
      x: Math.min(Math.max(8, d.x + dx), maxX),
      y: Math.min(Math.max(8, d.y + dy), maxY),
    });
  }

  function onPipPointerUp(): void {
    pipDragRef.current = null;
  }

  function onPipTap(): void {
    if (pipMovedRef.current) {
      pipMovedRef.current = false;
      return; // that was a drag, not a tap
    }
    setFocus(focus === 'remote' ? 'local' : 'remote');
  }

  return (
    <div className={styles.callScreen} role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[ui.kind]} — ${title}`}>
      <div className={styles.callTop}>
        {ui.is_group ? (
          <h2 className={styles.topTitle}>{title} · group call</h2>
        ) : (
          <span className={styles.topSpacer} aria-hidden />
        )}
        {!voiceCentered ? (
          <p className={`${styles.topStatus}${statusLive ? ` ${styles.topStatusLive}` : ''}`}>
            {status}
          </p>
        ) : null}
        <button
          type="button"
          className={styles.minBtn}
          aria-label="Minimize call"
          onClick={() => setMinimized(true)}
        >
          <MinimizeIcon />
        </button>
      </div>

      {voiceCentered ? (
        // Centered 1:1 voice (proto 23): blurred backdrop, ringed avatar,
        // serif name, green timer. Hidden sinks keep the remote audio alive.
        <div className={styles.voiceBody}>
          {voiceUser ? (
            <span className={styles.ringBlur} aria-hidden>
              <Avatar avatar={voiceUser.avatar} name={voiceUser.display_name} size={300} />
            </span>
          ) : null}
          <span className={styles.voiceAvatar}>
            {voiceUser ? (
              <Avatar avatar={voiceUser.avatar} name={voiceUser.display_name} size={112} animated />
            ) : null}
          </span>
          <h2 className={styles.voiceName}>{voiceUser?.display_name ?? title}</h2>
          <p className={`${styles.voiceStatus}${statusLive ? ` ${styles.voiceStatusLive}` : ''}`}>
            {status}
          </p>
          {voiceBadge ? <p className={styles.voiceBadge}>{voiceBadge}</p> : null}
          <PillAudio peerIds={peerIds} version={ui.media_version} />
        </div>
      ) : (
        // gridWrap anchors the floating PiP INSIDE the video area, so it can
        // never cover the notice lines (TURN warning, push-off note, failure
        // reason) that sit between the grid and the controls.
        <div className={styles.gridWrap} ref={wrapRef}>
          {videoSplit ? (
            remoteId === null ? (
              // Still ringing: my own camera full-bleed while the top bar
              // says "Calling…".
              <div className={styles.splitStack}>
                <div className={styles.splitTile}>{renderYouInner()}</div>
              </div>
            ) : focus === null ? (
              <div className={styles.splitStack}>
                <div
                  role="button"
                  tabIndex={0}
                  className={styles.splitTile}
                  aria-label={`Show ${nameOf(remoteId)} full screen`}
                  onClick={() => setFocus('remote')}
                  onKeyDown={keyActivate(() => setFocus('remote'))}
                >
                  {renderPeerInner(remoteId)}
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  className={styles.splitTile}
                  aria-label="Show your video full screen"
                  onClick={() => setFocus('local')}
                  onKeyDown={keyActivate(() => setFocus('local'))}
                >
                  {renderYouInner()}
                </div>
                <span className={styles.swapHint} aria-hidden>
                  tap a tile to swap
                </span>
              </div>
            ) : (
              <>
                <div
                  role="button"
                  tabIndex={0}
                  className={styles.focusTile}
                  aria-label="Back to split view"
                  onClick={() => setFocus(null)}
                  onKeyDown={keyActivate(() => setFocus(null))}
                >
                  {focus === 'remote' ? renderPeerInner(remoteId) : renderYouInner()}
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  className={styles.focusPip}
                  aria-label={
                    focus === 'remote'
                      ? 'Swap your video to full screen'
                      : `Swap ${nameOf(remoteId)} to full screen`
                  }
                  style={pipPos ? { left: pipPos.x, top: pipPos.y, right: 'auto' } : undefined}
                  onPointerDown={onPipPointerDown}
                  onPointerMove={onPipPointerMove}
                  onPointerUp={onPipPointerUp}
                  onPointerCancel={onPipPointerUp}
                  onClick={onPipTap}
                  onKeyDown={keyActivate(onPipTap)}
                >
                  {focus === 'remote' ? renderYouInner() : renderPeerInner(remoteId)}
                </div>
              </>
            )
          ) : (
            <div className={gridClass}>
              {peerIds.length === 0 ? (
                <div className={styles.tile}>
                  <div className={styles.tileFace}>
                    <span className="muted small">{status}</span>
                  </div>
                </div>
              ) : (
                <>
                  {peerIds.map((id) => (
                    <div
                      key={id}
                      className={`${styles.tile}${speakingIds.has(id) ? ` ${styles.tileSpeaking}` : ''}`}
                    >
                      {renderPeerInner(id)}
                    </div>
                  ))}
                  {ui.kind === 'video' ? <div className={styles.tile}>{renderYouInner()}</div> : null}
                </>
              )}
            </div>
          )}
        </div>
      )}

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
          className={styles.ctl}
          aria-label={ui.mic_on ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={!ui.mic_on}
          onClick={toggleMic}
        >
          <span className={`${styles.ctlOrb}${ui.mic_on ? '' : ` ${styles.ctlOrbOff}`}`} aria-hidden>
            {ui.mic_on ? <MicIcon /> : <MicOffIcon />}
          </span>
          {ui.kind === 'audio' ? <span className={styles.ctlLabel}>Mute</span> : null}
        </button>
        {ui.kind === 'video' ? (
          <>
            <button
              type="button"
              className={styles.ctl}
              aria-label={ui.cam_on ? 'Turn camera off' : 'Turn camera on'}
              aria-pressed={!ui.cam_on}
              onClick={toggleCam}
            >
              <span
                className={`${styles.ctlOrb}${ui.cam_on ? '' : ` ${styles.ctlOrbOff}`}`}
                aria-hidden
              >
                {ui.cam_on ? <CamIcon /> : <CamOffIcon />}
              </span>
            </button>
            <button
              type="button"
              className={styles.ctl}
              aria-label="Flip camera"
              onClick={() => void flipCamera()}
            >
              <span className={styles.ctlOrb} aria-hidden>
                <FlipIcon />
              </span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={styles.ctl}
          aria-label="End call"
          onClick={() => void hangUp()}
        >
          <span className={`${styles.ctlOrb} ${styles.ctlOrbEnd}`} aria-hidden>
            <PhoneDownIcon />
          </span>
          {ui.kind === 'audio' ? <span className={styles.ctlLabel}>End</span> : null}
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
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={styles.mirror}
      style={camOn ? undefined : { opacity: 0.25 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Minimized floating pill (v0.7.1 — FEATURES #87, reskinned per proto 26):
// green-tinted, pulsing, "name · timer · tap to return", mute, hang-up;
// video keeps a thumbnail (+ browser PiP where supported); tap expands.
// Still draggable — the RTCPeerConnections live in the lib/webrtc module
// singleton, so the call itself survives any navigation; this pill merely
// keeps it on screen. Position persists across remounts/pages in a module
// variable (per-session UI convenience, not state).
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
  const who = conv ? conversationTitle(conv, state.me?.id) : peerUser?.display_name ?? null;
  const pillLabel = [who, label, 'tap to return'].filter(Boolean).join(' · ');

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
      style={
        pillPos
          ? { left: pillPos.x, top: pillPos.y, right: 'auto', bottom: 'auto', transform: 'none' }
          : undefined
      }
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
        <span className={styles.pillTime}>{pillLabel}</span>
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
