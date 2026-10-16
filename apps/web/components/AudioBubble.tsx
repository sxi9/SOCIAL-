'use client';

// Voice-note playback bubble (v0.4 — API.md §1.20). The 48-bucket peaks array
// is inlined on the attachment DTO, so the scrubber renders with zero extra
// fetches; duration_ms drives the label. NEVER autoplays — tap to play, like
// every media surface. Playback speed cycles 1× → 1.5× → 2×.
import { useEffect, useRef, useState } from 'react';
import { AUDIO_WAVEFORM_BUCKETS, AUDIO_WAVEFORM_PEAK_MAX, type Attachment } from '@socialchat/shared';
import { formatDuration } from '@/lib/format';
import styles from './expression.module.css';

const SPEEDS = [1, 1.5, 2] as const;

export default function AudioBubble({ attachment }: { attachment: Attachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [speedIdx, setSpeedIdx] = useState(0);

  const peaks =
    attachment.waveform ??
    // Pending/legacy rows: flat placeholder bars until msg.updated hydrates.
    Array.from({ length: AUDIO_WAVEFORM_BUCKETS }, () => 24);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      if (el.duration > 0 && Number.isFinite(el.duration)) setProgress(el.currentTime / el.duration);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('pause', onPause);
    el.addEventListener('play', onPlay);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('play', onPlay);
    };
  }, []);

  function toggle(): void {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play().catch(() => undefined);
  }

  function cycleSpeed(): void {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    const el = audioRef.current;
    if (el) el.playbackRate = SPEEDS[next];
  }

  function seek(e: React.MouseEvent<HTMLButtonElement>): void {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = frac * el.duration;
    setProgress(frac);
  }

  if (attachment.status === 'failed') {
    return <span className={styles.audioPendingNote}>Voice note failed to process.</span>;
  }

  const ready = attachment.status === 'ready';
  const playedBars = Math.round(progress * peaks.length);

  return (
    <span className={styles.audioBubble}>
      {/* preload=none: no bytes move until the listener asks (tap to play). */}
      <audio ref={audioRef} src={attachment.url} preload="none" />
      <button
        type="button"
        className={styles.audioPlay}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        disabled={!ready}
        onClick={toggle}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <rect x="3" y="2.5" width="3.4" height="11" rx="1.2" />
            <rect x="9.6" y="2.5" width="3.4" height="11" rx="1.2" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4.5 2.8 L13 8 L4.5 13.2 Z" />
          </svg>
        )}
      </button>
      <span className={styles.waveWrap}>
        <button
          type="button"
          className={styles.wave}
          aria-label="Seek within voice note"
          disabled={!ready}
          onClick={seek}
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={`${styles.waveBar}${i < playedBars ? ` ${styles.waveBarPlayed}` : ''}`}
              style={{ height: `${Math.max(12, Math.round((p / AUDIO_WAVEFORM_PEAK_MAX) * 100))}%` }}
            />
          ))}
        </button>
        <span className={styles.audioMeta}>
          {ready ? (
            <>
              <span>{formatDuration(attachment.duration_ms)}</span>
              <button
                type="button"
                className={styles.speedBtn}
                aria-label={`Playback speed ${SPEEDS[speedIdx]}x — tap to change`}
                onClick={cycleSpeed}
              >
                {SPEEDS[speedIdx]}×
              </button>
            </>
          ) : (
            <span className={styles.audioPendingNote}>
              <span className="spinner" /> Processing…
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
