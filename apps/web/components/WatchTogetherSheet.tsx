'use client';

// v0.6 watch together (API.md §1.43 + §2.12): the synced YouTube player.
// Playback is the IFrame player embedded from www.youtube-nocookie.com; the
// controller script https://www.youtube.com/iframe_api is the ONE allowed
// external script (Caddyfile CSP script-src carve-out). The HOST's player
// drives everyone: their play/pause/seek state rides host-only watch.sync
// frames (≥ every WATCH_KEEPALIVE_S as keepalive); followers lock onto each
// relayed frame — a local seek simply snaps back on the next sync. A session
// with no sync inside WATCH_SESSION_TTL_S means the host vanished: the Redis
// key lapsed the same way, so the sheet ends it client-side too.
import { useEffect, useRef, useState } from 'react';
import type { WatchSession } from '@/lib/store';
import { isSessionLive, stopWatch, syncWatch } from '@/lib/watch';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import styles from './watch.module.css';

// ---------------------------------------------------------------------------
// Minimal IFrame-API typings (no @types package — zero new dependencies).
// ---------------------------------------------------------------------------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  loadVideoById(videoId: string): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      host?: string;
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (ev: { data: number }) => void;
      };
    }
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  const existing = window.YT;
  if (existing && existing.Player) return Promise.resolve(existing);
  if (!ytPromise) {
    ytPromise = new Promise<YTNamespace>((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        if (window.YT) resolve(window.YT);
      };
      const s = document.createElement('script');
      // https://www.youtube.com/iframe_api — see the Caddyfile CSP comment.
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    });
  }
  return ytPromise;
}

// Follower drift tolerance (§2.12: clients >2 s off the relayed position seek).
const DRIFT_S = 2;
// Host cadence: every 5 s covers seeks AND satisfies the ≥15 s keepalive.
const HOST_TICK_MS = 5000;

export default function WatchTogetherSheet({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const state = useAppState();
  const now = useNow(5000);
  const meId = state.me?.id;
  const session = state.watch.get(conversationId);
  const live = isSessionLive(session, now);
  const isHost = live && session.host === meId;
  const conv = state.conversations.get(conversationId);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const loadedVideoRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  // The latest session snapshot, readable from player callbacks/intervals.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Create the player once per sheet open; swap videos via loadVideoById.
  const videoId = session?.video_id ?? null;
  useEffect(() => {
    if (!videoId || !boxRef.current || playerRef.current) return;
    let cancelled = false;
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !boxRef.current || playerRef.current) return;
      const holder = document.createElement('div');
      boxRef.current.appendChild(holder);
      loadedVideoRef.current = videoId;
      playerRef.current = new YT.Player(holder, {
        // The nocookie host keeps frame-src to the one whitelisted origin.
        host: 'https://www.youtube-nocookie.com',
        videoId,
        playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: () => {
            if (cancelled) return;
            setReady(true);
            const s = sessionRef.current;
            if (s && !isHostRef.current) applyRemote(playerRef.current, s, YT);
          },
          onStateChange: (ev) => {
            // HOST only: every play/pause (and the re-PLAYING after a seek)
            // becomes a sync frame; follower state changes send nothing.
            const p = playerRef.current;
            if (!p || !isHostRef.current) return;
            const YTNS = window.YT;
            if (!YTNS) return;
            if (ev.data === YTNS.PlayerState.PLAYING) {
              syncWatch(conversationId, p.getCurrentTime(), true);
            } else if (ev.data === YTNS.PlayerState.PAUSED || ev.data === YTNS.PlayerState.ENDED) {
              syncWatch(conversationId, p.getCurrentTime(), false);
            }
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [videoId, conversationId]);

  // Teardown on close.
  useEffect(
    () => () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    },
    []
  );

  // HOST: periodic sync — keepalive even while paused (§1.43), and it carries
  // seeks that fired no state change.
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => {
      const p = playerRef.current;
      const YTNS = window.YT;
      if (!p || !YTNS || !ready) return;
      syncWatch(conversationId, p.getCurrentTime(), p.getPlayerState() === YTNS.PlayerState.PLAYING);
    }, HOST_TICK_MS);
    return () => clearInterval(t);
  }, [isHost, ready, conversationId]);

  // FOLLOWER: lock onto every relayed sync (video swap, drift > 2 s, state).
  const posKey = session ? `${session.video_id}:${session.position_s}:${session.playing}:${session.received_at}` : '';
  useEffect(() => {
    if (!session || isHost || !ready) return;
    const YTNS = window.YT;
    if (!YTNS) return;
    applyRemote(playerRef.current, session, YTNS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posKey, isHost, ready]);

  function applyRemote(p: YTPlayer | null, s: WatchSession, YTNS: YTNamespace): void {
    if (!p) return;
    if (loadedVideoRef.current !== s.video_id) {
      loadedVideoRef.current = s.video_id;
      p.loadVideoById(s.video_id);
    }
    const expected = s.playing ? s.position_s + (Date.now() - s.received_at) / 1000 : s.position_s;
    try {
      if (Math.abs(p.getCurrentTime() - expected) > DRIFT_S) p.seekTo(expected, true);
      const playing = p.getPlayerState() === YTNS.PlayerState.PLAYING;
      if (s.playing && !playing) p.playVideo();
      else if (!s.playing && playing) p.pauseVideo();
    } catch {
      /* player mid-load */
    }
  }

  // Host vanished (no sync within the TTL): the session is over server-side
  // too — anyone may stop it now (§1.43). Offer that explicitly.
  const stale = !!session && !live;
  useEffect(() => {
    if (!session) onClose(); // watch.stop arrived (or expiry cleanup)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session === undefined]);

  const participants = conv?.participants.filter((p) => p.left_at === null) ?? [];
  const hostName =
    participants.find((p) => p.user.id === session?.host)?.user.display_name ??
    (isHost ? 'you' : 'the host');

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Watch together">
        <div className={styles.head}>
          <h2>
            <span aria-hidden>📺</span> Watch together
          </h2>
          <button type="button" className={styles.close} aria-label="Leave the player" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={styles.playerBox} ref={boxRef}>
          {!ready ? <span className={styles.playerLoading}>Warming up the projector…</span> : null}
        </div>

        {/* Participant chips: the conversation's people (watch frames carry
            no per-viewer presence — ephemeral by design, §1.43). */}
        <div className={styles.chips} aria-label="In this chat">
          {participants.map((p) => (
            <span
              key={p.user.id}
              className={`${styles.chip}${p.user.id === session?.host ? ` ${styles.hostChip}` : ''}`}
            >
              <Avatar avatar={p.user.avatar} name={p.user.display_name} size={22} />
              {p.user.display_name}
              {p.user.id === session?.host ? ' · host' : ''}
            </span>
          ))}
        </div>

        <p className={styles.note}>
          {stale
            ? 'The host disappeared — the session ends on its own in a moment.'
            : isHost
              ? 'You are the host — your play, pause and seeks sync to everyone.'
              : `${hostName} drives the playback; your seeks snap back to theirs.`}
        </p>

        <div className={styles.row}>
          {isHost || stale ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                stopWatch(conversationId);
                onClose();
              }}
            >
              Stop for everyone
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
