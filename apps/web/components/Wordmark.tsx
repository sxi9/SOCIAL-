'use client';

// The flipping auth wordmark (v0.7 — API.md §1.54, FEATURES #71): "[Bored]
// Chat" where the bracketed word rolls through WORDMARK_WORDS every
// WORDMARK_FLIP_INTERVAL_MS on a FIXED-WIDTH slot (width of the widest word,
// measured once) so "Chat" never shifts. The roll is the odometer pattern — a
// vertical column translated word by word, with a duplicated first word so the
// wrap snaps invisibly. The cycle pauses while the tab is hidden and resumes
// on return; prefers-reduced-motion renders a static "Bored" (full
// replacement, not a slower animation). SSR renders "Bored" statically and
// the cycle starts client-side after mount (the TROUBLESHOOTING hydration
// rule: no clock-dependent text in SSR output).
import { useCallback, useEffect, useRef, useState } from 'react';
import { WORDMARK_FLIP_INTERVAL_MS, WORDMARK_WORDS } from '@socialchat/shared';
import { useReducedMotion } from '@/lib/useReducedMotion';
import styles from './auth.module.css';

const N = WORDMARK_WORDS.length;

export default function Wordmark({
  onWordChange,
}: {
  /** Fires with the word now showing — the mascot reacts per word (§1.54). */
  onWordChange?: (word: (typeof WORDMARK_WORDS)[number]) => void;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  // 0..N — index N is the duplicated 'Bored' at the end of the column; once
  // its roll lands, the column snaps (transition off) back to 0.
  const [rollIdx, setRollIdx] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const [slotWidth, setSlotWidth] = useState<number | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => setMounted(true), []);

  // Fixed-width slot: the widest word, measured once after mount.
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    let max = 0;
    for (const child of Array.from(el.children)) {
      max = Math.max(max, (child as HTMLElement).offsetWidth);
    }
    if (max > 0) setSlotWidth(Math.ceil(max) + 1);
  }, [mounted]);

  const running = mounted && !reduced;

  // The tick — paused whenever the tab is hidden (visibilitychange), resumed
  // on return. Stopping for good (reduced motion / unmount) settles on Bored.
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer === null) {
        timer = setInterval(() => setRollIdx((i) => Math.min(i + 1, N)), WORDMARK_FLIP_INTERVAL_MS);
      }
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = (): void => {
      if (document.hidden) stop();
      else start();
    };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [running]);

  // Reduced motion (live toggle included): settle on "Bored" instantly.
  useEffect(() => {
    if (reduced) {
      setSnapping(true);
      setRollIdx(0);
    }
  }, [reduced]);

  const word = WORDMARK_WORDS[rollIdx % N];
  useEffect(() => {
    onWordChange?.(word);
  }, [word, onWordChange]);

  // The wrap: the duplicated Bored (index N) finished rolling in → snap the
  // column back to the real first row with the transition disabled.
  const onRollEnd = useCallback(() => {
    setRollIdx((i) => {
      if (i !== N) return i;
      setSnapping(true);
      return 0;
    });
  }, []);
  useEffect(() => {
    if (!snapping) return;
    const raf = requestAnimationFrame(() => setSnapping(false));
    return () => cancelAnimationFrame(raf);
  }, [snapping]);

  // Reduced motion or pre-mount (SSR included): static "Bored".
  if (!running) {
    return <span className={styles.wordSlot}>Bored</span>;
  }

  return (
    <span
      className={styles.wordSlot}
      style={slotWidth !== null ? { width: slotWidth } : undefined}
      role="text"
      aria-label={word}
    >
      {/* Hidden measurer — every word, same font, zero layout impact. */}
      <span ref={measureRef} className={styles.wordMeasure} aria-hidden>
        {WORDMARK_WORDS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </span>
      <span
        className={`${styles.wordCol}${snapping ? ` ${styles.wordColSnap}` : ''}`}
        style={{ transform: `translateY(-${rollIdx * 1.2}em)` }}
        onTransitionEnd={onRollEnd}
        aria-hidden
      >
        {WORDMARK_WORDS.map((w) => (
          <span key={w} className={styles.wordItem}>
            {w}
          </span>
        ))}
        {/* the duplicated first word — the invisible wrap */}
        <span className={styles.wordItem}>{WORDMARK_WORDS[0]}</span>
      </span>
    </span>
  );
}
