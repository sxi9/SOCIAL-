'use client';

// Shared LIVING scenery for /login, /register and /join/:token — animated
// gradient, a pointer-reactive mesh (two blurred radial layers), the floating
// blob/avatar cluster, a rotating-tagline brand block, a gently 3D-tilting
// frosted card, and a 5-taps-on-the-logo party mode. Pure CSS/SVG/WAAPI, no
// assets. All of it is behind prefers-reduced-motion (reduced = static scene,
// no parallax, instant transitions) and every listener is passive, rAF-
// throttled and torn down on unmount.
//
// Pages drive page-level effects through useAuthFx(): `party` (logo easter
// egg — mascots should switch to their party state), `burst()` (confetti from
// the card on register success), `lift()` (the card floats away as the app
// routes in) and `reducedMotion` (so pages can route instantly instead).
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

// v1.1 Royal: taglines are MOOD-SYNCED — one per wordmark word, flipped on
// the same clock (index 0 = Bored doubles as the SSR text, so hydration
// always matches).
const WORD_TAGLINE: Record<(typeof WORDMARK_WORDS)[number], string> = {
  Bored: 'chat for when the group chat is dead',
  Happy: 'good vibes travel fast',
  Sad: 'rain check? we got you',
  Drunk: 'maybe text the group first',
};

function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 11) return 'good morning — the blob woke up before you did';
  if (hour >= 11 && hour < 17) return 'good afternoon — procrastinate responsibly';
  if (hour >= 17 && hour < 23) return 'good evening — prime lurking hours';
  return 'good 3am, insomniac — the blob never sleeps either';
}

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
// Excited = bounce (celebrate), Happy = smile, Lonely = look around,
// Hyped = party. State changes ride the same tick as the roll.
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

function FloatingFace({ className, hue }: { className: string; hue: string }) {
  return (
    <svg className={className} width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden>
      <circle cx="27" cy="27" r="25" fill={hue} opacity="0.28" />
      <circle cx="27" cy="27" r="25" stroke={hue} strokeWidth="1.6" opacity="0.55" />
      <circle cx="19.5" cy="23" r="2.6" fill={hue} />
      <circle cx="34.5" cy="23" r="2.6" fill={hue} />
      <path d="M18 33 a9.5 9.5 0 0 0 18 0" stroke={hue} strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export default function AuthScene({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [tagline, setTagline] = useState(WORD_TAGLINE.Bored);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [party, setParty] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [word, setWord] = useState<(typeof WORDMARK_WORDS)[number]>('Bored');
  const [pieces, setPieces] = useState<ConfettiPiece[] | null>(null);
  const [tiltReady, setTiltReady] = useState(false);
  const [tiltOn, setTiltOn] = useState(false);
  const tapsRef = useRef<number[]>([]);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tagline + time-aware greeting: client-side after mount (no hydration
  // mismatch — the server always renders TAGLINES[0] and a blank greeting).
  useEffect(() => {
    setGreeting(greetingFor(new Date().getHours()));
  }, []);

  // v1.1 Royal: the tagline rides the mood clock (same tick as the word).
  useEffect(() => {
    setTagline(WORD_TAGLINE[word]);
  }, [word]);

  // Pointer-reactive mesh + card tilt: one passive pointermove listener feeds
  // a normalized target; a self-stopping rAF loop eases --mx/--my on the
  // scene element (transform-only consumers in CSS). Optional devicemotion
  // tilt joins the same target once the visitor opts in.
  useEffect(() => {
    if (reduced) return;
    const el = sceneRef.current;
    if (!el) return;
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    let raf: number | null = null;
    let baseBeta: number | null = null;

    const apply = (): void => {
      el.style.setProperty('--mx', cur.x.toFixed(4));
      el.style.setProperty('--my', cur.y.toFixed(4));
    };
    const tick = (): void => {
      cur.x += (target.x - cur.x) * 0.12;
      cur.y += (target.y - cur.y) * 0.12;
      if (Math.abs(target.x - cur.x) < 0.002 && Math.abs(target.y - cur.y) < 0.002) {
        cur.x = target.x;
        cur.y = target.y;
        apply();
        raf = null;
        return;
      }
      apply();
      raf = requestAnimationFrame(tick);
    };
    const kick = (): void => {
      if (raf == null) raf = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent): void => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
      kick();
    };
    const onOrient = (e: DeviceOrientationEvent): void => {
      if (e.gamma == null || e.beta == null) return;
      if (baseBeta == null) baseBeta = e.beta;
      target.x = Math.max(-1, Math.min(1, e.gamma / 24));
      target.y = Math.max(-1, Math.min(1, (e.beta - baseBeta) / 24));
      kick();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    if (tiltOn) window.addEventListener('deviceorientation', onOrient);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      if (tiltOn) window.removeEventListener('deviceorientation', onOrient);
      el.style.removeProperty('--mx');
      el.style.removeProperty('--my');
    };
  }, [reduced, tiltOn]);

  // Offer the (permission-gated, optional) device-tilt toggle only on
  // coarse-pointer devices that expose orientation events.
  useEffect(() => {
    if (reduced) return;
    if (typeof window.DeviceOrientationEvent === 'undefined') return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    setTiltReady(true);
  }, [reduced]);

  const enableTilt = useCallback(async (): Promise<void> => {
    try {
      const DOE = (
        window as unknown as {
          DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
        }
      ).DeviceOrientationEvent;
      if (DOE?.requestPermission) {
        const verdict = await DOE.requestPermission();
        if (verdict !== 'granted') {
          setTiltReady(false);
          return;
        }
      }
      setTiltOn(true);
    } catch {
      /* declined or unsupported — stay pointer-only */
    }
    setTiltReady(false);
  }, []);

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

  return (
    <AuthFxContext.Provider value={fx}>
      <div ref={sceneRef} className={`${styles.scene}${party ? ` ${styles.party}` : ''}`}>
        <div className={styles.mesh} aria-hidden>
          <span className={styles.meshA} />
          <span className={styles.meshB} />
        </div>
        <div className={styles.blobs} aria-hidden>
          <span className={`${styles.blob} ${styles.b1}`} />
          <span className={`${styles.blob} ${styles.b2}`} />
          <span className={`${styles.blob} ${styles.b3}`} />
          <FloatingFace className={`${styles.face} ${styles.f1}`} hue="#c7cdda" />
          <FloatingFace className={`${styles.face} ${styles.f2}`} hue="#8f96a8" />
          <FloatingFace className={`${styles.face} ${styles.f3}`} hue="#e4e8f1" />
        </div>
        {/* v1.1 Royal: per-mood ambient layer — none under reduced motion. */}
        {!reduced ? <MoodBackdrop kind={WORD_BG[word]} /> : null}
        <div className={styles.content}>
          <header className={styles.brand}>
            <h1 className={styles.title}>
              {/* v1.1 Royal (§1.54 machinery kept): "{mood}." — the word
                  rolls on the mood clock, the dot never moves (fixed-width
                  slot); static "Bored." under reduced motion and in SSR. */}
              <button type="button" className={styles.logoBtn} onClick={onLogoTap}>
                <Wordmark onWordChange={setWord} />
                <span className={styles.logoDot}>.</span>
              </button>
            </h1>
            <p className={styles.pitch}>{tagline}</p>
            <p className={styles.greeting}>{greeting ?? ' '}</p>
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
        </div>
        {tiltReady && !tiltOn ? (
          <button type="button" className={styles.tiltBtn} onClick={() => void enableTilt()}>
            tilt to move the background
          </button>
        ) : null}
      </div>
    </AuthFxContext.Provider>
  );
}


/* v1.1 Royal: the mood backdrop — absolutely positioned, pointer-events
 * none; stars twinkle, rain falls, drunk blobs drift. Deterministic layout
 * (no Math.random at render — fixed tables keep SSR/hydration content-free
 * since this renders client-side only anyway, but determinism keeps renders
 * stable). */
const STAR_SPOTS = [
  [8, 12], [22, 30], [37, 8], [52, 22], [66, 14], [80, 28], [90, 10], [14, 46], [72, 42], [45, 38],
] as const;
const RAIN_SPOTS = [
  [6, 0.0, 1.1], [18, 0.3, 1.3], [29, 0.6, 1.2], [41, 0.15, 1.45], [53, 0.45, 1.15],
  [64, 0.75, 1.3], [75, 0.2, 1.25], [86, 0.55, 1.4], [94, 0.9, 1.2],
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
