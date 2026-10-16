'use client';

// The Bored Blob — the mascot that makes the auth pages feel alive. Pure SVG
// + CSS + a single rAF spring for eye tracking; no libraries, no assets.
//
// Prop-driven state machine (pages set `state`):
//   idle | watch  ambient: eyes track the pointer, random blinks, and after
//                 10 quiet seconds the blob yawns then goes drowsy-lidded
//                 until activity (it IS Bored Chat).
//   cover         arms rise and hands cover the eyes (password focus).
//   peek          one hand parts and the right eye peeks ("show password").
//   yawn          forced yawn (also fired internally by the idle timer).
//   shake         quick head-shake + brows down (login error). One-shot:
//                 the page flips back to its ambient state after ~900ms.
//   wince         squint + wobbly mouth (username taken). One-shot as above.
//   celebrate     happy bounce, arcs for eyes, arms up (auth success).
//   party         sunglasses drop, arms dance, body bobs (logo easter egg).
//   wave          right arm waves (join page greeter).
//
// Tiny imperative API via ref: `lookAt(point|null)` aims the eyes at a
// viewport coordinate (the focused input's caret) instead of the pointer.
//
// Reduced motion = static mascot: correct pose per state, pupils centered,
// no rAF, no blinks, no idle-yawn sequence; CSS transitions/animations are
// disabled by the module's media query.
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useReducedMotion } from '@/lib/useReducedMotion';
import styles from './mascot.module.css';

export type MascotState =
  | 'idle'
  | 'watch'
  | 'cover'
  | 'peek'
  | 'yawn'
  | 'shake'
  | 'wince'
  | 'celebrate'
  | 'party'
  | 'wave';

export interface MascotHandle {
  /** Aim the eyes at a viewport point (input caret); null resumes pointer tracking. */
  lookAt(point: { x: number; y: number } | null): void;
}

interface MascotProps {
  state?: MascotState;
  /** Rendered width/height in px (viewBox is fixed). */
  size?: number;
  className?: string;
}

type Expression = MascotState | 'drowsy';
type Phase = 'awake' | 'yawning' | 'drowsy';

const IDLE_MS = 10_000;
const YAWN_MS = 1_700;
const GAZE_RADIUS = 3.4; // max pupil offset in SVG user units (capped gaze)

/** Approximate caret position of a text input, in viewport coordinates. */
export function caretPoint(input: HTMLInputElement): { x: number; y: number } {
  const rect = input.getBoundingClientRect();
  let caret = input.value.length;
  try {
    // type="email" inputs return null / throw in some engines.
    const s = input.selectionStart;
    if (s != null) caret = s;
  } catch {
    /* keep end-of-value */
  }
  let text = input.value.slice(0, caret);
  if (input.type === 'password') text = '•'.repeat(text.length);
  let width = text.length * 8; // fallback estimate
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) {
      const cs = getComputedStyle(input);
      measureCtx.font = cs.font && cs.font.length > 0 ? cs.font : `${cs.fontSize} ${cs.fontFamily}`;
      width = measureCtx.measureText(text).width;
    }
  } catch {
    /* keep estimate */
  }
  return {
    x: Math.min(rect.left + 13 + width, rect.right - 10),
    y: rect.top + rect.height / 2,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;

const Mascot = forwardRef<MascotHandle, MascotProps>(function Mascot(
  { state = 'idle', size = 120, className },
  ref,
) {
  const reduced = useReducedMotion();
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const faceRef = useRef<SVGGElement | null>(null);
  const pupilLRef = useRef<SVGCircleElement | null>(null);
  const pupilRRef = useRef<SVGCircleElement | null>(null);
  const lidLRef = useRef<SVGRectElement | null>(null);
  const lidRRef = useRef<SVGRectElement | null>(null);
  const overrideRef = useRef<{ x: number; y: number } | null>(null);
  const kickRef = useRef<(() => void) | null>(null);

  const ambient = state === 'idle' || state === 'watch';
  const [phase, setPhase] = useState<Phase>('awake');

  useImperativeHandle(
    ref,
    () => ({
      lookAt(point) {
        overrideRef.current = point;
        kickRef.current?.();
      },
    }),
    [],
  );

  // ---- idle boredom: 10 quiet seconds → yawn → drowsy until activity ----
  useEffect(() => {
    if (reduced || !ambient) {
      setPhase('awake');
      return;
    }
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const quiet = Date.now() - last;
      if (quiet >= IDLE_MS) {
        setPhase((p) => (p === 'awake' ? 'yawning' : p));
        timer = setTimeout(check, IDLE_MS);
      } else {
        timer = setTimeout(check, IDLE_MS - quiet + 20);
      }
    };
    const activity = (): void => {
      last = Date.now();
      setPhase('awake');
    };
    window.addEventListener('pointermove', activity, { passive: true });
    window.addEventListener('pointerdown', activity, { passive: true });
    window.addEventListener('keydown', activity, { passive: true });
    timer = setTimeout(check, IDLE_MS);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointermove', activity);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, [reduced, ambient]);

  // Yawn runs its course, then half-lids.
  useEffect(() => {
    if (phase !== 'yawning') return;
    const t = setTimeout(() => setPhase((p) => (p === 'yawning' ? 'drowsy' : p)), YAWN_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const expr: Expression = ambient
    ? phase === 'yawning'
      ? 'yawn'
      : phase === 'drowsy'
        ? 'drowsy'
        : state
    : state;

  // ---- random blinks (ambient + awake only) ----
  useEffect(() => {
    if (reduced || !ambient || phase !== 'awake') return;
    let t: ReturnType<typeof setTimeout>;
    const blink = (): void => {
      for (const el of [lidLRef.current, lidRRef.current]) {
        el?.animate(
          [
            { transform: 'translateY(0px)' },
            { transform: 'translateY(20px)', offset: 0.45 },
            { transform: 'translateY(0px)' },
          ],
          { duration: 150, easing: 'ease-in-out' },
        );
      }
    };
    const schedule = (): void => {
      t = setTimeout(() => {
        blink();
        schedule();
      }, 2600 + Math.random() * 3400);
    };
    schedule();
    return () => clearTimeout(t);
  }, [reduced, ambient, phase]);

  // ---- eye tracking: pointer (or caret override) → spring-eased pupils ----
  useEffect(() => {
    if (reduced) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pointer = { x: 0, y: 0 };
    let hasPointer = false;
    const pos = { x: 0, y: 0 };
    const vel = { x: 0, y: 0 };
    let rect: DOMRect | null = null;
    let raf: number | null = null;
    let prev = 0;

    const refreshRect = (): void => {
      rect = svg.getBoundingClientRect();
    };

    const apply = (): void => {
      const t = `translate(${pos.x.toFixed(2)}px, ${pos.y.toFixed(2)}px)`;
      if (pupilLRef.current) pupilLRef.current.style.transform = t;
      if (pupilRRef.current) pupilRRef.current.style.transform = t;
      if (faceRef.current) {
        faceRef.current.style.transform = `translate(${(pos.x * 0.45).toFixed(2)}px, ${(pos.y * 0.45).toFixed(2)}px)`;
      }
    };

    const tick = (now: number): void => {
      const dt = Math.min(0.033, (now - prev) / 1000) || 0.016;
      prev = now;
      let tx = 0;
      let ty = 0;
      const focus = overrideRef.current ?? (hasPointer ? pointer : null);
      if (focus && rect && rect.width > 0) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height * 0.43; // eye line
        const dx = focus.x - cx;
        const dy = focus.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > 1) {
          const mag = Math.min(1, dist / 200) * GAZE_RADIUS;
          tx = (dx / dist) * mag;
          ty = (dy / dist) * mag;
        }
      }
      // Slightly underdamped spring for that springy, organic catch-up.
      const k = 170;
      const c = 16;
      vel.x += (k * (tx - pos.x) - c * vel.x) * dt;
      vel.y += (k * (ty - pos.y) - c * vel.y) * dt;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      const settled =
        Math.abs(tx - pos.x) < 0.03 &&
        Math.abs(ty - pos.y) < 0.03 &&
        Math.abs(vel.x) < 0.1 &&
        Math.abs(vel.y) < 0.1;
      if (settled) {
        pos.x = tx;
        pos.y = ty;
        vel.x = 0;
        vel.y = 0;
      }
      apply();
      raf = settled ? null : requestAnimationFrame(tick);
    };

    const kick = (): void => {
      if (raf != null) return;
      prev = performance.now();
      refreshRect();
      raf = requestAnimationFrame(tick);
    };
    kickRef.current = kick;

    const onMove = (e: PointerEvent): void => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      hasPointer = true;
      kick();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', refreshRect, { passive: true });
    window.addEventListener('scroll', refreshRect, { passive: true });
    return () => {
      kickRef.current = null;
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('scroll', refreshRect);
      if (pupilLRef.current) pupilLRef.current.style.transform = '';
      if (pupilRRef.current) pupilRRef.current.style.transform = '';
      if (faceRef.current) faceRef.current.style.transform = '';
    };
  }, [reduced]);

  const happyEyes = expr === 'celebrate';
  const mouth: 'smile' | 'o' | 'yawn' | 'flat' | 'frown' | 'wobble' | 'grin' =
    expr === 'yawn'
      ? 'yawn'
      : expr === 'drowsy'
        ? 'flat'
        : expr === 'shake'
          ? 'frown'
          : expr === 'wince'
            ? 'wobble'
            : expr === 'celebrate' || expr === 'party' || expr === 'wave'
              ? 'grin'
              : expr === 'cover' || expr === 'peek'
                ? 'o'
                : 'smile';

  return (
    <svg
      ref={svgRef}
      className={`${styles.root} ${styles[expr] ?? ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden
      focusable="false"
    >
      <defs>
        <radialGradient id={`${gid}bg`} cx="38%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#97aaff" />
          <stop offset="55%" stopColor="#6f8cff" />
          <stop offset="100%" stopColor="#5367ef" />
        </radialGradient>
        <clipPath id={`${gid}el`}>
          <ellipse cx="44" cy="52" rx="8" ry="9" />
        </clipPath>
        <clipPath id={`${gid}er`}>
          <ellipse cx="76" cy="52" rx="8" ry="9" />
        </clipPath>
      </defs>
      <g className={styles.inner}>
        <path
          className={styles.bodyBlob}
          d="M60 16 C84 16 102 32 103 58 C104 86 88 106 60 106 C32 106 16 86 17 58 C18 32 36 16 60 16 Z"
          fill={`url(#${gid}bg)`}
        />
        <path
          d="M38 30 Q50 20 66 24"
          stroke="rgba(255,255,255,0.35)"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
        />
        <g ref={faceRef}>
          <path className={`${styles.brow} ${styles.browL}`} d="M36 39 Q44 34 52 38" />
          <path className={`${styles.brow} ${styles.browR}`} d="M68 38 Q76 34 84 39" />
          {happyEyes ? (
            <>
              <path className={styles.happyEye} d="M36 54 Q44 45 52 54" />
              <path className={styles.happyEye} d="M68 54 Q76 45 84 54" />
            </>
          ) : (
            <>
              <g clipPath={`url(#${gid}el)`}>
                <ellipse className={styles.eyeWhite} cx="44" cy="52" rx="8" ry="9" />
                <circle ref={pupilLRef} className={styles.pupil} cx="44" cy="53" r="3.6" />
                <rect
                  ref={lidLRef}
                  className={`${styles.lid} ${styles.lidL}`}
                  x="34"
                  y="16"
                  width="20"
                  height="26"
                />
              </g>
              <g clipPath={`url(#${gid}er)`}>
                <ellipse className={styles.eyeWhite} cx="76" cy="52" rx="8" ry="9" />
                <circle ref={pupilRRef} className={styles.pupil} cx="76" cy="53" r="3.6" />
                <rect
                  ref={lidRRef}
                  className={`${styles.lid} ${styles.lidR}`}
                  x="66"
                  y="16"
                  width="20"
                  height="26"
                />
              </g>
            </>
          )}
          <ellipse className={styles.blush} cx="34" cy="63" rx="5" ry="3" />
          <ellipse className={styles.blush} cx="86" cy="63" rx="5" ry="3" />
          <g className={styles.mouth} key={mouth}>
            {mouth === 'smile' ? (
              <path className={styles.mouthStroke} d="M49 75 Q60 84 71 75" />
            ) : mouth === 'grin' ? (
              <path className={styles.mouthFill} d="M47 74 Q60 92 73 74 Z" />
            ) : mouth === 'yawn' ? (
              <ellipse className={styles.mouthFill} cx="60" cy="79" rx="9" ry="12" />
            ) : mouth === 'flat' ? (
              <path className={styles.mouthStroke} d="M53 78 L67 78" />
            ) : mouth === 'frown' ? (
              <path className={styles.mouthStroke} d="M49 81 Q60 73 71 81" />
            ) : mouth === 'wobble' ? (
              <path className={styles.mouthStroke} d="M48 79 q6 -5 12 0 q6 5 12 0" />
            ) : (
              <circle className={styles.mouthFill} cx="60" cy="78" r="3.5" />
            )}
          </g>
          <g className={styles.shades}>
            <rect x="33" y="44" width="22" height="14" rx="6" fill="#131726" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" />
            <rect x="65" y="44" width="22" height="14" rx="6" fill="#131726" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" />
            <path d="M55 49 Q60 45 65 49" stroke="#131726" strokeWidth="3" fill="none" />
            <path d="M33 49 L25 46 M87 49 L95 46" stroke="#131726" strokeWidth="3" strokeLinecap="round" fill="none" />
            <path d="M37 48 L43 48 M69 48 L75 48" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" />
          </g>
        </g>
        <g transform="translate(32 80)">
          <g className={styles.armL}>
            <path className={styles.limb} d="M0 0 Q-7 10 -5 21" />
            <circle className={styles.hand} cx="-5" cy="23" r="8" />
          </g>
        </g>
        <g transform="translate(88 80)">
          <g className={styles.armR}>
            <path className={styles.limb} d="M0 0 Q7 10 5 21" />
            <circle className={styles.hand} cx="5" cy="23" r="8" />
          </g>
        </g>
      </g>
    </svg>
  );
});

export default Mascot;
