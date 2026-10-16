'use client';

// Doodle composer (v0.4 — API.md §1.21). A full-screen canvas with 4 colors,
// an eraser and undo; exports a PNG ≤ DOODLE_CANVAS_MAX_PX and sends it through
// the ordinary image pipeline with metadata.doodle: true — the only "sticker"
// machinery in this self-hosted app is the user's own hand.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadResponse } from '@socialchat/shared';
import { DOODLE_CANVAS_MAX_PX } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

const PAPER = '#fffdf5';
const COLORS = [
  { value: '#1f2430', label: 'Ink' },
  { value: '#e4573d', label: 'Coral' },
  { value: '#2f7de0', label: 'Blue' },
  { value: '#2fa36b', label: 'Green' },
] as const;

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  color: string; // PAPER = eraser
  width: number;
  points: Point[];
}

interface DoodleSheetProps {
  title?: string;
  sendLabel?: string;
  onClose: () => void;
  /** Called with the uploaded attachment id; the caller sends the message. */
  onSend: (attachmentId: string) => Promise<void>;
}

export default function DoodleSheet({ title = 'Doodle', sendLabel = 'Send doodle', onClose, onSend }: DoodleSheetProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [eraser, setEraser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const size = DOODLE_CANVAS_MAX_PX; // backing-store pixels (square)

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...strokesRef.current, ...(activeRef.current ? [activeRef.current] : [])]) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (s.points.length === 1) {
        // A tap leaves a dot.
        ctx.lineTo(s.points[0].x + 0.1, s.points[0].y + 0.1);
      }
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size,
      y: ((e.clientY - rect.top) / rect.height) * size,
    };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    activeRef.current = {
      color: eraser ? PAPER : color,
      width: eraser ? 36 : 7,
      points: [canvasPoint(e)],
    };
    redraw();
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!activeRef.current) return;
    activeRef.current.points.push(canvasPoint(e));
    redraw();
  }

  function up(): void {
    if (!activeRef.current) return;
    strokesRef.current = [...strokesRef.current, activeRef.current];
    activeRef.current = null;
    setStrokeCount(strokesRef.current.length);
    redraw();
  }

  function undo(): void {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    redraw();
  }

  async function send(): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas || busy || strokesRef.current.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('export failed');
      const form = new FormData();
      form.append('file', new File([blob], 'doodle.png', { type: 'image/png' }));
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      await onSend(res.attachment.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? 'Upload failed — try again.' : 'Could not send the doodle.');
      setBusy(false);
    }
  }

  return (
    <div
      className={sheetStyles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={sheetStyles.sheetHead}>
          <h2>{title}</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={exp.doodleSheet}>
          <div className={exp.doodleCanvasWrap} style={{ aspectRatio: '1 / 1' }}>
            <canvas
              ref={canvasRef}
              width={size}
              height={size}
              aria-label="Drawing canvas"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            />
          </div>

          <div className={exp.doodleTools} role="toolbar" aria-label="Doodle tools">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`${exp.doodleColor}${!eraser && color === c.value ? ` ${exp.doodleColorOn}` : ''}`}
                style={{ background: c.value }}
                aria-label={`${c.label} pen`}
                aria-pressed={!eraser && color === c.value}
                onClick={() => {
                  setColor(c.value);
                  setEraser(false);
                }}
              />
            ))}
            <button
              type="button"
              className={`${exp.doodleTool}${eraser ? ` ${exp.doodleToolOn}` : ''}`}
              aria-pressed={eraser}
              onClick={() => setEraser((v) => !v)}
            >
              Eraser
            </button>
            <button type="button" className={exp.doodleTool} disabled={strokeCount === 0} onClick={undo}>
              Undo
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || strokeCount === 0}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
