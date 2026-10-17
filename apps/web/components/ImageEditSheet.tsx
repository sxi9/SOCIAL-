'use client';

// v1.0a (#92): edit-before-upload — crop (drag box + corner handles), rotate
// 90°, aspect presets (free / 1:1 / 4:5 / 16:9). Pure canvas, no deps. Takes
// a source (local File or same-origin attachment URL), returns a re-encoded
// JPEG File via onDone. Portals to body like every sheet; reduced-motion
// safe (no decorative animation at all). Animated sources must not pass
// through here (canvas flattens them) — callers gate on static image types.
import { useCallback, useEffect, useRef, useState } from 'react';
import Portal from './Portal';
import st from './imageedit.module.css';

type Aspect = { label: string; ratio: number | null };
const ASPECTS: Aspect[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '16:9', ratio: 16 / 9 },
];

interface Crop {
  x: number; // all in displayed-image coordinates (CSS px)
  y: number;
  w: number;
  h: number;
}

export default function ImageEditSheet({
  source,
  fileName,
  lockedAspect,
  onDone,
  onCancel,
}: {
  /** A local File or a same-origin URL (the auth cookie rides along). */
  source: File | string;
  fileName: string;
  /** Lock the aspect (e.g. 1 for avatars) — hides the preset row. */
  lockedAspect?: number;
  onDone: (file: File) => void;
  onCancel: () => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState(false);
  const [rotation, setRotation] = useState(0); // 0/90/180/270
  const [aspect, setAspect] = useState<number | null>(lockedAspect ?? null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se';
    startX: number;
    startY: number;
    orig: Crop;
  } | null>(null);

  // Load the source into an <img> element.
  useEffect(() => {
    let revoke: string | null = null;
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setError(true);
    if (typeof source === 'string') {
      el.src = source;
    } else {
      revoke = URL.createObjectURL(source);
      el.src = revoke;
    }
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Displayed (CSS) size of the rotated image inside the frame.
  const display = useCallback((): { w: number; h: number } | null => {
    const frame = frameRef.current;
    if (!img || !frame) return null;
    const rotated = rotation % 180 !== 0;
    const iw = rotated ? img.naturalHeight : img.naturalWidth;
    const ih = rotated ? img.naturalWidth : img.naturalHeight;
    const maxW = frame.clientWidth;
    const maxH = frame.clientHeight;
    const k = Math.min(maxW / iw, maxH / ih, 1);
    return { w: iw * k, h: ih * k };
  }, [img, rotation]);

  // (Re)initialize the crop to the full image when image/rotation changes.
  useEffect(() => {
    if (!img) return;
    const t = setTimeout(() => {
      const d = display();
      if (d) setCrop(fitAspect({ x: 0, y: 0, w: d.w, h: d.h }, aspect, d));
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, rotation, aspect]);

  function fitAspect(c: Crop, ratio: number | null, bounds: { w: number; h: number }): Crop {
    if (ratio === null) return c;
    let w = c.w;
    let h = w / ratio;
    if (h > bounds.h) {
      h = bounds.h;
      w = h * ratio;
    }
    return {
      x: Math.min(c.x, bounds.w - w),
      y: Math.min(c.y, bounds.h - h),
      w,
      h,
    };
  }

  function onPointerDown(e: React.PointerEvent, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    if (!crop) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: crop };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const bounds = display();
    if (!d || !bounds) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const MIN = 32;
    let { x, y, w, h } = d.orig;
    if (d.mode === 'move') {
      x = Math.max(0, Math.min(bounds.w - w, d.orig.x + dx));
      y = Math.max(0, Math.min(bounds.h - h, d.orig.y + dy));
    } else {
      // Corner resize; aspect lock resolves via width.
      const left = d.mode === 'nw' || d.mode === 'sw';
      const top = d.mode === 'nw' || d.mode === 'ne';
      if (left) {
        const nx = Math.max(0, Math.min(d.orig.x + d.orig.w - MIN, d.orig.x + dx));
        w = d.orig.w + (d.orig.x - nx);
        x = nx;
      } else {
        w = Math.max(MIN, Math.min(bounds.w - d.orig.x, d.orig.w + dx));
      }
      if (aspect !== null) {
        h = w / aspect;
        if (top) y = Math.max(0, d.orig.y + d.orig.h - h);
        if (y + h > bounds.h) {
          h = bounds.h - y;
          w = h * aspect;
          if (left) x = d.orig.x + d.orig.w - w;
        }
      } else if (top) {
        const ny = Math.max(0, Math.min(d.orig.y + d.orig.h - MIN, d.orig.y + dy));
        h = d.orig.h + (d.orig.y - ny);
        y = ny;
      } else {
        h = Math.max(MIN, Math.min(bounds.h - d.orig.y, d.orig.h + dy));
      }
    }
    setCrop({ x, y, w, h });
  }

  function onPointerUp() {
    drag.current = null;
  }

  async function apply(): Promise<void> {
    const bounds = display();
    if (!img || !crop || !bounds || busy) return;
    setBusy(true);
    try {
      // Map the displayed crop back to source pixels (account for rotation).
      const rotated = rotation % 180 !== 0;
      const srcW = rotated ? img.naturalHeight : img.naturalWidth;
      const k = srcW / bounds.w; // uniform scale
      const sx = crop.x * k;
      const sy = crop.y * k;
      const sw = crop.w * k;
      const sh = crop.h * k;

      // Draw the FULL rotated image once, then cut the crop from it.
      const full = document.createElement('canvas');
      full.width = rotated ? img.naturalHeight : img.naturalWidth;
      full.height = rotated ? img.naturalWidth : img.naturalHeight;
      const fctx = full.getContext('2d');
      if (!fctx) throw new Error('canvas');
      fctx.translate(full.width / 2, full.height / 2);
      fctx.rotate((rotation * Math.PI) / 180);
      fctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(sw));
      out.height = Math.max(1, Math.round(sh));
      const octx = out.getContext('2d');
      if (!octx) throw new Error('canvas');
      octx.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, 'image/jpeg', 0.92),
      );
      if (!blob) throw new Error('encode');
      const base = fileName.replace(/\.[a-z0-9]+$/i, '') || 'photo';
      onDone(new File([blob], `${base}.jpg`, { type: 'image/jpeg' }));
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  const d = display();
  return (
    <Portal>
      <div className={st.backdrop} role="dialog" aria-modal="true" aria-label="Edit photo">
        <div className={st.topRow}>
          <button type="button" className={st.ghostBtn} onClick={onCancel}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={st.ghostBtn}
            aria-label="Rotate 90 degrees"
            onClick={() => setRotation((r) => (r + 90) % 360)}
          >
            ⟳ Rotate
          </button>
        </div>

        <div className={st.frame} ref={frameRef}>
          {error ? (
            <p className={st.err}>Could not load this photo for editing.</p>
          ) : img && d ? (
            <div
              className={st.stage}
              style={{ width: d.w, height: d.h }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.src}
                alt=""
                draggable={false}
                className={st.photo}
                style={{
                  width: rotation % 180 !== 0 ? d.h : d.w,
                  height: rotation % 180 !== 0 ? d.w : d.h,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
              />
              {crop ? (
                <div
                  className={st.cropBox}
                  style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}
                  onPointerDown={(e) => onPointerDown(e, 'move')}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                    <span
                      key={c}
                      className={`${st.handle} ${st[`h_${c}`]}`}
                      onPointerDown={(e) => onPointerDown(e, c)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <span className="spinner" />
          )}
        </div>

        {lockedAspect === undefined ? (
          <div className={st.aspectRow} role="radiogroup" aria-label="Aspect ratio">
            {ASPECTS.map((a) => (
              <button
                key={a.label}
                type="button"
                role="radio"
                aria-checked={aspect === a.ratio}
                className={`${st.ghostBtn}${aspect === a.ratio ? ` ${st.ghostOn}` : ''}`}
                onClick={() => setAspect(a.ratio)}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className={st.bottomRow}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={!crop || busy || error}
            onClick={() => void apply()}
          >
            {busy ? 'Saving…' : 'Done'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
