'use client';

// v1.0a (#93): full-screen pinch-zoom media viewer. Pure client, no deps:
// two-pointer pinch + drag pan (Pointer Events), wheel zoom on desktop,
// double-tap to toggle 1x/2.5x, Escape / backdrop tap / ✕ to close. Portals
// to body (the position:fixed-inside-transform gotcha) and unmounts when
// closed (never opacity:0). Reduced-motion: transitions collapse via the
// global media query — transform math itself is motionless state.
import { useCallback, useEffect, useRef, useState } from 'react';
import Portal from './Portal';
import st from './lightbox.module.css';

const MAX_SCALE = 6;
const MIN_SCALE = 1;

export default function MediaLightbox({
  src,
  alt,
  originalUrl,
  onClose,
}: {
  src: string;
  alt: string;
  /** Full-resolution URL for the "open original" affordance (defaults to src). */
  originalUrl?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startDist: number;
    startScale: number;
    startTx: number;
    startTy: number;
    startMidX: number;
    startMidY: number;
    lastTap: number;
  }>({ startDist: 0, startScale: 1, startTx: 0, startTy: 0, startMidX: 0, startMidY: 0, lastTap: 0 });
  const moved = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Lock page scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const clamp = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), []);

  function midAndDist() {
    const pts = [...pointers.current.values()];
    const [a, b] = pts;
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const { midX, midY, dist } = midAndDist();
      g.startDist = dist;
      g.startScale = scale;
      g.startTx = tx;
      g.startTy = ty;
      g.startMidX = midX;
      g.startMidY = midY;
    } else if (pointers.current.size === 1) {
      g.startTx = tx;
      g.startTy = ty;
      g.startMidX = e.clientX;
      g.startMidY = e.clientY;
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      // Pinch: scale around the gesture midpoint.
      const { midX, midY, dist } = midAndDist();
      const next = clamp((g.startScale * dist) / Math.max(1, g.startDist));
      const k = next / g.startScale;
      setScale(next);
      setTx(midX - (g.startMidX - g.startTx) * k);
      setTy(midY - (g.startMidY - g.startTy) * k);
      moved.current = true;
    } else if (pointers.current.size === 1 && scale > 1) {
      // Pan when zoomed in.
      const dx = e.clientX - g.startMidX;
      const dy = e.clientY - g.startMidY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
      setTx(g.startTx + dx);
      setTy(g.startTy + dy);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0 && !moved.current) {
      const now = e.timeStamp;
      if (now - g.lastTap < 300) {
        // Double-tap: toggle zoom around the tap point.
        if (scale > 1) {
          setScale(1);
          setTx(0);
          setTy(0);
        } else {
          const next = 2.5;
          setScale(next);
          setTx(e.clientX - (e.clientX - tx) * (next / 1));
          setTy(e.clientY - (e.clientY - ty) * (next / 1));
        }
        g.lastTap = 0;
      } else {
        g.lastTap = now;
      }
    }
    if (scale <= 1.02 && pointers.current.size === 0) {
      setScale(1);
      setTx(0);
      setTy(0);
    }
  }

  function onWheel(e: React.WheelEvent) {
    const next = clamp(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    const k = next / scale;
    setScale(next);
    setTx(e.clientX - (e.clientX - tx) * k);
    setTy(e.clientY - (e.clientY - ty) * k);
  }

  return (
    <Portal>
      <div
        className={st.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label={alt}
        onClick={(e) => {
          // Backdrop tap closes only when not zoomed/panning.
          if (e.target === e.currentTarget && scale === 1) onClose();
        }}
      >
        <div
          className={st.stage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {/* The transform layer spans the viewport (layout origin 0,0), so
              zoom-around-point math is exact: screen = t + s·p. */}
          <div
            className={st.canvas}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} className={st.img} draggable={false} />
          </div>
        </div>
        <div className={st.topBar}>
          <a className={st.barBtn} href={originalUrl ?? src} target="_blank" rel="noreferrer">
            Open original
          </a>
          <button type="button" className={st.barBtn} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
    </Portal>
  );
}
