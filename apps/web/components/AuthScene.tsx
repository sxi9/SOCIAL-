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
import { useReducedMotion } from '@/lib/useReducedMotion';
import styles from './auth.module.css';

export interface AuthFx {
  party: boolean;
  reducedMotion: boolean;
  /** Confetti burst of tiny CSS blobs from the card (no-op under reduced motion). */
  burst: () => void;
  /** Lift the card away ahead of routing (no-op under reduced motion). */
  lift: () => void;
}

const noop = (): void => undefined;
const AuthFxContext = createContext<AuthFx>({
  party: false,
  reducedMotion: false,
  burst: noop,
  lift: noop,
});

export function useAuthFx(): AuthFx {
  return useContext(AuthFxContext);
}

// One per mount; index 0 doubles as the SSR text so hydration always matches.
const TAGLINES = [
  'for when the group chat is dead',
  'your thumb is tired of scrolling',
  'professionally unproductive since day one',
  'where lurkers become legends',
  'doomscrolling, but make it mutual',
  'your notifications called — they miss you',
  'big yawn energy, great conversations',
  'the fun is mandatory (it is not)',
];

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
  const [tagline, setTagline] = useState(TAGLINES[0]);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [party, setParty] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [pieces, setPieces] = useState<ConfettiPiece[] | null>(null);
  const [tiltReady, setTiltReady] = useState(false);
  const [tiltOn, setTiltOn] = useState(false);
  const tapsRef = useRef<number[]>([]);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tagline + time-aware greeting: client-side after mount (no hydration
  // mismatch — the server always renders TAGLINES[0] and a blank greeting).
  useEffect(() => {
    setTagline(TAGLINES[Math.floor(Math.random() * TAGLINES.length)]);
    setGreeting(greetingFor(new Date().getHours()));
  }, []);

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
    () => ({ party, reducedMotion: reduced, burst, lift }),
    [party, reduced, burst, lift],
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
          <FloatingFace className={`${styles.face} ${styles.f1}`} hue="#6f8cff" />
          <FloatingFace className={`${styles.face} ${styles.f2}`} hue="#4cd4a0" />
          <FloatingFace className={`${styles.face} ${styles.f3}`} hue="#ff6b96" />
        </div>
        <div className={styles.content}>
          <header className={styles.brand}>
            <h1 className={styles.title}>
              <button type="button" className={styles.logoBtn} onClick={onLogoTap}>
                Bored Chat
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
