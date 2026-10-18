'use client';

// The Bored Blob (Royal v2) — the armless ivory face from the design
// prototype. Pure SVG + CSS + a single rAF spring for eye tracking; no
// libraries, no assets. Geometry is the prototype's exactly: viewBox
// "0 0 92 76", flat #f3f5f9 body, solid ink dot eyes (r=4 at 35/57, cy 38),
// per-mood brow + mouth stroke paths (#12141c, 2.5, round caps).
//
// Prop-driven state machine (pages set `state`):
//   idle | watch  ambient: eyes track the pointer, random blinks, and after
//                 10 quiet seconds the blob yawns then goes drowsy-lidded
//                 until activity (it IS Bored Chat). Bored face row.
//   cover         both eyes become closed arcs (password focus — no arms to
//                 cover with any more).
//   peek          left eye closed, right eye peeks ("show password").
//   yawn          forced yawn (also fired internally by the idle timer).
//   shake         quick head-shake + sad-slant brows (login error). One-shot:
//                 the page flips back to its ambient state after ~900ms.
//   wince         squint + squiggle mouth (username taken). One-shot as above.
//   celebrate     happy brows + big grin + blush + bounce (auth success).
//   party         sunglasses drop + grin + blush, body bobs (logo easter egg).
//   wave          greeter (join page) — renders as the happy row.
//   droop         sad row: slanted brows, frown, the tear.
//   happy         happy row: curved brows + smile, hopUp bob.
//   lookaround    bored row, eyes darting (Lonely).
//   drunk         wonky brows + squiggle mouth + blush + wobble.
//
// Tiny imperative API via ref: `lookAt(point|null)` aims the eyes at a
// viewport coordinate (the focused input's caret) instead of the pointer.
//
// Reduced motion = static mascot: correct pose per state, eyes centered,
// no rAF, no blinks, no idle-yawn sequence; CSS animations are disabled by
// the module's media query.
import {
  forwardRef,
  useEffect,
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
  | 'wave'
  // v0.7 (§1.54) wordmark reactions: Sad = droop, Happy = smile, Lonely =
  // look around (Excited reuses 'celebrate', Hyped reuses 'party').
  | 'droop'
  | 'happy'
  | 'lookaround'
  // v1.1 Royal login mood: squiggle mouth + blush + wobble (reduced: static).
  | 'drunk';

export interface MascotHandle {
  /** Aim the eyes at a viewport point (input caret); null resumes pointer tracking. */
  lookAt(point: { x: number; y: number } | null): void;
}

interface MascotProps {
  state?: MascotState;
  /** Rendered width in px (height follows the prototype's 86:72 ratio). */
  size?: number;
  className?: string;
}

type Expression = MascotState | 'drowsy';
type Phase = 'awake' | 'yawning' | 'drowsy';

const IDLE_MS = 10_000;
const YAWN_MS = 1_700;
const GAZE_RADIUS = 3; // max eye offset in SVG user units (capped gaze)
const EYE_LINE = 38 / 76; // eye row as a fraction of the viewBox height

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

// ---- the prototype's face tables (exact paths) ----

const BROWS = {
  bored: 'M28 28 h12 M52 28 h12',
  happy: 'M28 27 q6 -4 12 0 M52 27 q6 -4 12 0',
  sad: 'M28 30 L40 26 M64 30 L52 26',
  drunk: 'M28 26 q6 4 12 -2 M52 25 q6 5 12 -1',
} as const;

type Mouth = 'flat' | 'smile' | 'grin' | 'frown' | 'squiggle' | 'o' | 'yawn';
type EyeMode = 'open' | 'closed' | 'peek';

const MOUTH_PATHS: Record<Exclude<Mouth, 'o' | 'yawn'>, string> = {
  flat: 'M39 53 h14',
  smile: 'M37 50 q9 10 18 0',
  grin: 'M37 50 q9 12 18 0',
  frown: 'M38 57 q8 -8 16 0',
  squiggle: 'M37 53 q4 4 8 0 q4 -4 8 0',
};

// Closed-eye arcs (there are no hands to cover with any more).
const ARC_L = 'M31 39 q4 3 8 0';
const ARC_R = 'M53 39 q4 3 8 0';

interface Face {
  brow: string;
  mouth: Mouth;
  eyes: EyeMode;
}

const FACES: Record<Expression, Face> = {
  idle: { brow: BROWS.bored, mouth: 'flat', eyes: 'open' },
  watch: { brow: BROWS.bored, mouth: 'flat', eyes: 'open' },
  lookaround: { brow: BROWS.bored, mouth: 'flat', eyes: 'open' },
  drowsy: { brow: BROWS.bored, mouth: 'flat', eyes: 'open' }, // + CSS half-squash
  yawn: { brow: BROWS.bored, mouth: 'yawn', eyes: 'closed' },
  cover: { brow: BROWS.bored, mouth: 'o', eyes: 'closed' },
  peek: { brow: BROWS.bored, mouth: 'o', eyes: 'peek' },
  happy: { brow: BROWS.happy, mouth: 'smile', eyes: 'open' },
  wave: { brow: BROWS.happy, mouth: 'smile', eyes: 'open' },
  celebrate: { brow: BROWS.happy, mouth: 'grin', eyes: 'open' },
  party: { brow: BROWS.happy, mouth: 'grin', eyes: 'open' },
  droop: { brow: BROWS.sad, mouth: 'frown', eyes: 'open' },
  shake: { brow: BROWS.sad, mouth: 'frown', eyes: 'open' },
  wince: { brow: BROWS.sad, mouth: 'squiggle', eyes: 'open' },
  drunk: { brow: BROWS.drunk, mouth: 'squiggle', eyes: 'open' },
};

const Mascot = forwardRef<MascotHandle, MascotProps>(function Mascot(
  { state = 'idle', size = 86, className },
  ref,
) {
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const faceRef = useRef<SVGGElement | null>(null);
  const gazeLRef = useRef<SVGGElement | null>(null);
  const gazeRRef = useRef<SVGGElement | null>(null);
  const eyeLRef = useRef<SVGCircleElement | null>(null);
  const eyeRRef = useRef<SVGCircleElement | null>(null);
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

  // ---- random blinks (ambient + awake only): brief scaleY squash of the
  // ink dots (transform-box fill-box, origin center — set in the module) ----
  useEffect(() => {
    if (reduced || !ambient || phase !== 'awake') return;
    let t: ReturnType<typeof setTimeout>;
    const blink = (): void => {
      for (const el of [eyeLRef.current, eyeRRef.current]) {
        el?.animate(
          [
            { transform: 'scaleY(1)' },
            { transform: 'scaleY(0.12)', offset: 0.45 },
            { transform: 'scaleY(1)' },
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

  // ---- eye tracking: pointer (or caret override) → spring-eased eyes ----
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
      if (gazeLRef.current) gazeLRef.current.style.transform = t;
      if (gazeRRef.current) gazeRRef.current.style.transform = t;
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
        const cy = rect.top + rect.height * EYE_LINE;
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
      if (gazeLRef.current) gazeLRef.current.style.transform = '';
      if (gazeRRef.current) gazeRRef.current.style.transform = '';
      if (faceRef.current) faceRef.current.style.transform = '';
    };
  }, [reduced]);

  const face = FACES[expr];
  const leftClosed = face.eyes !== 'open';
  const rightClosed = face.eyes === 'closed';

  return (
    <svg
      ref={svgRef}
      className={`${styles.root} ${styles[expr] ?? ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={Math.round(size * (72 / 86))}
      viewBox="0 0 92 76"
      aria-hidden
      focusable="false"
    >
      <g className={styles.inner}>
        {/* The armless ivory blob — flat fill, no gradient, no highlight. */}
        <path
          className={styles.bodyBlob}
          d="M46 6 C69 6 85 21 85 42 C85 61 69 71 46 71 C23 71 7 61 7 42 C7 21 23 6 46 6 Z"
        />
        <g ref={faceRef}>
          <path className={styles.brow} d={face.brow} />
          {leftClosed ? (
            <path className={styles.eyeArc} d={ARC_L} />
          ) : (
            <g ref={gazeLRef} className={styles.eyeWrap}>
              <circle ref={eyeLRef} className={styles.eyeDot} cx="35" cy="38" r="4" />
            </g>
          )}
          {rightClosed ? (
            <path className={styles.eyeArc} d={ARC_R} />
          ) : (
            <g ref={gazeRRef} className={styles.eyeWrap}>
              <circle ref={eyeRRef} className={styles.eyeDot} cx="57" cy="38" r="4" />
            </g>
          )}
          {/* Blush (drunk / party / celebrate — via CSS opacity). */}
          <circle className={styles.blush} cx="30" cy="48" r="4" />
          <circle className={styles.blush} cx="62" cy="48" r="4" />
          {expr === 'droop' ? (
            /* The sad tear (#8fb7e8), slow drip under reduced-motion-safe CSS. */
            <ellipse className={styles.tear} cx="63" cy="47" rx="2.5" ry="4" />
          ) : null}
          <g className={styles.mouth} key={face.mouth}>
            {face.mouth === 'o' ? (
              <circle className={styles.mouthFill} cx="46" cy="54" r="2.6" />
            ) : face.mouth === 'yawn' ? (
              <ellipse className={styles.mouthFill} cx="46" cy="55" rx="4" ry="5.5" />
            ) : (
              <path className={styles.mouthStroke} d={MOUTH_PATHS[face.mouth]} />
            )}
          </g>
          {/* Party sunglasses, scaled to the new geometry. */}
          <g className={styles.shades}>
            <rect x="27" y="33" width="16" height="10" rx="3.5" />
            <rect x="49" y="33" width="16" height="10" rx="3.5" />
            <path className={styles.shadeBridge} d="M43 36.5 q3 -2 6 0" />
            <path className={styles.shadeArms} d="M27 36 L22 33.5 M65 36 L70 33.5" />
            <path className={styles.shadeSheen} d="M30 36 h6 M52 36 h6" />
          </g>
        </g>
      </g>
    </svg>
  );
});

export default Mascot;
