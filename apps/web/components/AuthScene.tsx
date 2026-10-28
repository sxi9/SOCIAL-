'use client';

// Shared Royal v2 scenery for /login, /register and /join/:token — a calm
// centered column on var(--bg): the per-mood ambient backdrop (stars / rain /
// drifting blobs), a slot for the page's mascot, the flipping serif wordmark
// "{mood}." with its mood-synced tagline, the solid panel card, and a slot
// for the page's below-card line. Pure CSS/SVG/WAAPI, no assets. Everything
// animated sits behind prefers-reduced-motion (reduced = static scene,
// instant transitions) and every listener is passive and torn down on
// unmount.
//
// Pages drive page-level effects through useAuthFx(): `party` (logo easter
// egg — mascots should switch to their party state), `burst()` (confetti from
// the card on register success), `lift()` (the card floats away as the app
// routes in) and `reducedMotion` (so pages can route instantly instead).
//
// Pages place content OUTSIDE the card through two portal slots:
//   <SceneMascot>  → above the wordmark (the page's living mascot)
//   <SceneFooter>  → under the card ("New here? Join the fun" etc.)
// Both render nothing until the scene mounts (SSR output stays slot-free, so
// hydration always matches).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { WORDMARK_WORDS } from '@socialchat/shared';
import { useReducedMotion } from '@/lib/useReducedMotion';
import type { MascotState } from './Mascot';
import Wordmark from './Wordmark';
import styles from './auth.module.css';

export interface AuthFx {
  party: boolean;
  reducedMotion: boolean;
  /** Confetti burst of tiny CSS blobs from the card (no-op under reduced motion). */
  burst: () => void;
  /** Lift the card away ahead of routing (no-op under reduced motion). */
  lift: () => void;
  /** v0.7 (§1.54): the mascot state matching the wordmark's current word —
   * null while it reads "Bored" (ambient wins). Pages blend it in only while
   * their mascot is otherwise idle/watching. */
  wordMascot: MascotState | null;
}

const noop = (): void => undefined;
const AuthFxContext = createContext<AuthFx>({
  party: false,
  reducedMotion: false,
  burst: noop,
  lift: noop,
  wordMascot: null,
});

export function useAuthFx(): AuthFx {
  return useContext(AuthFxContext);
}

// ---- scene slots (portal targets above the wordmark / under the card) ----

interface SceneSlots {
  mascot: HTMLDivElement | null;
  footer: HTMLDivElement | null;
}

const SceneSlotContext = createContext<SceneSlots>({ mascot: null, footer: null });

/** Renders its children in the scene's mascot spot, above the wordmark. */
export function SceneMascot({ children }: { children: ReactNode }) {
  const { mascot } = useContext(SceneSlotContext);
  return mascot ? createPortal(children, mascot) : null;
}

/** Renders its children in the scene's below-card spot. */
export function SceneFooter({ children }: { children: ReactNode }) {
  const { footer } = useContext(SceneSlotContext);
  return footer ? createPortal(children, footer) : null;
}

/** The Royal v2 show/hide-password eye (replaces the old text toggle). */
export function EyeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path
        d="M3 12c2.2-4 5.2-6 9-6s6.8 2 9 6c-2.2 4-5.2 6-9 6s-6.8-2-9-6Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

// v1.1 Royal: taglines are MOOD-SYNCED — one per wordmark word, flipped on
// the same clock (index 0 = Bored doubles as the SSR text, so hydration
// always matches).
const WORD_TAGLINE: Record<(typeof WORDMARK_WORDS)[number], string> = {
  Bored: 'chat for when the group chat is dead',
  Happy: 'good vibes travel fast',
  Sad: 'rain check? we got you',
  Drunk: 'maybe text the group first',
};

interface ConfettiPiece {
  dx: number;
  dyu: number;
  dyd: number;
  rot: number;
  delay: number;
  scale: number;
  color: string;
}

const CONFETTI_COLORS = ['#6f8cff', '#4cd4a0', '#ff6b96', '#b78cff', '#ffd166', '#7ae0ff'];

// §1.54: Bored = idle (null → the page's ambient state wins), Sad = droop,
// Happy = smile, Drunk = wobble. State changes ride the same tick as the roll.
const WORD_MASCOT: Record<(typeof WORDMARK_WORDS)[number], MascotState | null> = {
  Bored: null,
  Happy: 'happy',
  Sad: 'droop',
  Drunk: 'drunk',
};

// v1.1 Royal: per-mood ambient background layer (none / star twinkle / rain
// streaks / drifting blurred blobs). Reduced motion renders NONE of these.
const WORD_BG: Record<(typeof WORDMARK_WORDS)[number], 'none' | 'stars' | 'rain' | 'blobs'> = {
  Bored: 'none',
  Happy: 'stars',
  Sad: 'rain',
  Drunk: 'blobs',
};

export default function AuthScene({ children, calm = false }: { children: ReactNode; calm?: boolean }) {
  const reduced = useReducedMotion();
  const [tagline, setTagline] = useState(WORD_TAGLINE.Bored);
  const [party, setParty] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [word, setWord] = useState<(typeof WORDMARK_WORDS)[number]>('Bored');
  const [pieces, setPieces] = useState<ConfettiPiece[] | null>(null);
  const [mascotHost, setMascotHost] = useState<HTMLDivElement | null>(null);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  const tapsRef = useRef<number[]>([]);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // v1.1 Royal: the tagline rides the mood clock (same tick as the word).
  useEffect(() => {
    setTagline(WORD_TAGLINE[word]);
  }, [word]);

  // Easter egg: 5 taps on the logo within 3s → party mode until unmount.
  const onLogoTap = useCallback((): void => {
    const now = Date.now();
    tapsRef.current = tapsRef.current.filter((t) => now - t < 3000);
    tapsRef.current.push(now);
    if (tapsRef.current.length >= 5) setParty(true);
  }, []);

  const burst = useCallback((): void => {
    if (reduced) return;
    setPieces(
      Array.from({ length: 24 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / 24 + (Math.random() - 0.5) * 0.5;
        const r = 90 + Math.random() * 130;
        return {
          dx: Math.cos(angle) * r,
          dyu: Math.sin(angle) * r * 0.6 - 70 - Math.random() * 60,
          dyd: Math.sin(angle) * r * 0.3 + 120 + Math.random() * 90,
          rot: (Math.random() * 2 - 1) * 540,
          delay: Math.random() * 120,
          scale: 0.6 + Math.random() * 0.9,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        };
      }),
    );
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => setPieces(null), 1500);
  }, [reduced]);

  useEffect(
    () => () => {
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    },
    [],
  );

  const lift = useCallback((): void => {
    if (!reduced) setLifted(true);
  }, [reduced]);

  const fx = useMemo<AuthFx>(
    () => ({ party, reducedMotion: reduced, burst, lift, wordMascot: WORD_MASCOT[word] ?? null }),
    [party, reduced, burst, lift, word],
  );

  const slots = useMemo<SceneSlots>(
    () => ({ mascot: mascotHost, footer: footerHost }),
    [mascotHost, footerHost],
  );

  return (
    <AuthFxContext.Provider value={fx}>
      <SceneSlotContext.Provider value={slots}>
        <div className={`${styles.scene}${party ? ` ${styles.party}` : ''}`}>
          {/* v1.1 Royal: per-mood ambient layer — none under reduced motion. */}
          {!reduced ? <MoodBackdrop kind={WORD_BG[word]} /> : null}
          <div className={styles.content}>
            <header className={styles.brand}>
              {/* The page's mascot portals in here, above the wordmark. */}
              <div ref={setMascotHost} className={styles.mascotSlot} />
              <h1 className={styles.title}>
                {/* "{mood}." — the word rolls on the mood clock (§1.54
                    machinery kept), lowercased by CSS, the dot never moves;
                    static "bored." under reduced motion and in SSR. */}
                <button type="button" className={styles.logoBtn} onClick={onLogoTap}>
                  <Wordmark onWordChange={setWord} static={calm} />
                  <span className={styles.logoDot}>.</span>
                </button>
              </h1>
              <p className={styles.pitch}>{tagline}</p>
            </header>
            <div className={styles.cardWrap}>
              <div className={`${styles.card}${lifted ? ` ${styles.cardLift}` : ''}`}>{children}</div>
              {pieces ? (
                <div className={styles.confetti} aria-hidden>
                  {pieces.map((p, i) => (
                    <i
                      key={i}
                      className={styles.piece}
                      style={
                        {
                          '--dx': `${p.dx.toFixed(1)}px`,
                          '--dyu': `${p.dyu.toFixed(1)}px`,
                          '--dyd': `${p.dyd.toFixed(1)}px`,
                          '--rz': `${p.rot.toFixed(0)}deg`,
                          '--s': p.scale.toFixed(2),
                          background: p.color,
                          animationDelay: `${p.delay.toFixed(0)}ms`,
                        } as CSSProperties
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>
            {/* The page's below-card line(s) portal in here. */}
            <div ref={setFooterHost} className={styles.footSlot} />
          </div>
        </div>
      </SceneSlotContext.Provider>
    </AuthFxContext.Provider>
  );
}

/* v1.1 Royal: the mood backdrop — absolutely positioned, pointer-events
 * none; stars twinkle, rain falls, drunk blobs drift. Deterministic layout
 * (no Math.random at render — fixed tables keep SSR/hydration content-free
 * since this renders client-side only anyway, but determinism keeps renders
 * stable). */
const STAR_SPOTS = [
  [8, 12], [22, 30], [37, 8], [52, 22], [66, 14], [80, 28], [90, 10], [14, 46],
] as const;
const RAIN_SPOTS = [
  [6, 0.0, 1.1], [22, 0.3, 1.3], [38, 0.6, 1.2], [54, 0.15, 1.45], [70, 0.45, 1.15],
  [88, 0.75, 1.3],
] as const;

function MoodBackdrop({ kind }: { kind: 'none' | 'stars' | 'rain' | 'blobs' }) {
  if (kind === 'none') return null;
  return (
    <div className={styles.moodLayer} aria-hidden>
      {kind === 'stars'
        ? STAR_SPOTS.map(([x, y], i) => (
            <i
              key={i}
              className={styles.star}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                animationDuration: `${1.6 + (i % 5) * 0.2}s`,
                animationDelay: `${(i % 4) * 0.35}s`,
              }}
            />
          ))
        : null}
      {kind === 'rain'
        ? RAIN_SPOTS.map(([x, delay, dur], i) => (
            <i
              key={i}
              className={styles.rain}
              style={{
                left: `${x}%`,
                height: `${12 + (i % 3) * 1.5}px`,
                animationDuration: `${dur}s`,
                animationDelay: `-${delay}s`,
              }}
            />
          ))
        : null}
      {kind === 'blobs' ? (
        <>
          <i className={`${styles.blob} ${styles.blobA}`} />
          <i className={`${styles.blob} ${styles.blobB}`} />
          <i className={`${styles.blob} ${styles.blobC}`} />
        </>
      ) : null}
    </div>
  );
}
