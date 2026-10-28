'use client';

// Canvas stories (v0.8b — API.md §1.66, FEATURES #79a, ADR-020). Overlays are
// ATTRIBUTED VECTOR LAYERS over the media — never burned into the image.
// Binding render contract carried here: normalized 0..1 coordinates, every
// overlay wears a username chip and is tappable → highlight + "drawn by @x" →
// profile; the §1.21 doodle brush is the stroke tool; reduced motion disables
// entrance animations (layers simply appear); the client never rasterizes
// overlays into saved/shared media.
//
// Handoff 2c (2026-10-28): canvas mode is its OWN STATE. Nothing but the
// layers renders until the viewer opens it (`active`); then the viewer chrome
// steps out and the tools come in — Undo · "<name> is drawing too" · Done on
// top, a Draw / Sticker / Note rail on the right, colour dots on the left, a
// brush slider at the bottom.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Story, StoryOverlay, StoryOverlayPayload, UserLite } from '@socialchat/shared';
import { OVERLAYS_PER_USER, OVERLAY_STROKE_POINTS_MAX, OVERLAY_TEXT_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { addOverlay, approveOverlay, canvasBan, removeOverlay } from '@/lib/stories';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useReducedMotion } from '@/lib/useReducedMotion';
import ReportSheet from './ReportSheet';
import { IcBrush, IcCheck, IcNote, IcSticker, IcUndo } from './StoryIcons';
import cm from './community.module.css';
import { confirmDialog } from '@/lib/confirm';

// Handoff palette: coral · white · straw · mint · sky.
const COLORS = ['#ff6b6b', '#ffffff', '#f2c76b', '#8ee6c2', '#9ec3ff'] as const;
const STAMP_EMOJI = ['😂', '❤️', '🔥', '👀', '✨', '💀', '🫶', '🎉', '🥹', '👻'];
const REF = 512; // stroke coordinate reference edge for the SVG viewBox
const DRAWING_TOO_MS = 20_000; // a fresh overlay by someone else = "is drawing too"

type Tool = 'draw' | 'emoji' | 'text';

interface StoryCanvasProps {
  story: Story;
  meId: string;
  /** The viewer opened the canvas (handoff 2c state). */
  active: boolean;
  /** Done / Escape — the viewer takes its chrome back. */
  onDone: () => void;
  /** Chip interactions outside canvas mode still pause the auto-advance. */
  onInteracting: (active: boolean) => void;
}

/** Patch the live story in the store with a fresh overlay (optimistic; the
 * story.updated frame confirms with the server's serialization). */
function injectOverlay(story: Story, overlay: StoryOverlay): void {
  const existing = story.overlays.filter((o) => o.id !== overlay.id);
  store.replaceStoryLocal({ ...story, overlays: [...existing, overlay] });
}

function dropOverlay(story: Story, overlayId: string): void {
  store.replaceStoryLocal({ ...story, overlays: story.overlays.filter((o) => o.id !== overlayId) });
}

export default function StoryCanvas({ story, meId, active, onDone, onInteracting }: StoryCanvasProps) {
  const reduced = useReducedMotion();
  const isMine = story.author.id === meId;
  const [tool, setToolRaw] = useState<Tool>('draw');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [width, setWidth] = useState(6); // px at the 512 reference edge (1..24)
  const [emoji, setEmoji] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [placing, setPlacing] = useState<'emoji' | 'text' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [reporting, setReporting] = useState<StoryOverlay | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<{ x: number; y: number }[]>([]);
  const [livePath, setLivePath] = useState<string>('');

  const setTool = useCallback((t: Tool) => {
    setToolRaw(t);
    setSelected(null);
    setPlacing(null);
  }, []);

  // Leaving canvas mode resets the transient tool state.
  useEffect(() => {
    if (active) return;
    setPlacing(null);
    setQueueOpen(false);
    setText('');
    setEmoji(null);
    setLivePath('');
    strokeRef.current = [];
  }, [active]);

  // "<name> is drawing too" needs a clock while the canvas is open.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 4000);
    return () => clearInterval(t);
  }, [active]);

  // Visible overlays: 'live' for all + my own / the author's 'pending'
  // (the server already serialized only what this viewer may see).
  const overlays = story.overlays.filter((o) => o.status !== 'removed');
  const mine = overlays.filter((o) => o.author.id === meId);
  const canAdd = (story.canvas_mode !== 'off' || isMine) && mine.length < OVERLAYS_PER_USER;
  const pending = overlays.filter((o) => o.status === 'pending');

  // Contributor strip — FACES/names derived client-side from overlays; no
  // counter is ever serialized alone (PSYCHOLOGY rule 3).
  const contributors = useMemo(() => {
    const seen = new Map<string, UserLite>();
    for (const o of overlays) {
      if (o.author.id !== story.author.id && !seen.has(o.author.id)) seen.set(o.author.id, o.author);
    }
    return [...seen.values()];
  }, [overlays, story.author.id]);

  // Someone else's overlay that landed in the last DRAWING_TOO_MS — derived
  // from the story.updated stream, no extra presence protocol.
  const drawingToo = useMemo(() => {
    const recent = overlays
      .filter((o) => o.author.id !== meId && now - new Date(o.created_at).getTime() < DRAWING_TOO_MS)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return recent[0]?.author ?? null;
  }, [overlays, meId, now]);

  async function submit(payload: StoryOverlayPayload): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const overlay = await addOverlay(story.id, payload);
      injectOverlay(story, overlay);
      if (overlay.status === 'pending') toast('Sent — shows once the author approves it');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'overlay_limit') {
        toast(`That's your ${OVERLAYS_PER_USER} on this one — remove one first`);
      } else if (err instanceof ApiError && err.status === 403) {
        // canvas_closed — byte-identical for 'off' and a canvas ban (§1.66).
        toast('This canvas is closed');
      } else if (err instanceof ApiError && err.status === 429) {
        toast('Easy there — drawing limit for this hour');
      } else {
        toast('Could not add that — try again');
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- stroke capture (the §1.21 brush, as normalized points) ----
  function norm(e: React.PointerEvent): { x: number; y: number } | null {
    const el = surfaceRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function strokePath(points: { x: number; y: number }[]): string {
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * REF).toFixed(1)} ${(p.y * REF).toFixed(1)}`)
      .join(' ');
  }

  function downDraw(e: React.PointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = norm(e);
    if (!p) return;
    strokeRef.current = [p];
    setLivePath(strokePath(strokeRef.current));
  }

  function moveDraw(e: React.PointerEvent<HTMLDivElement>): void {
    if (strokeRef.current.length === 0) return;
    const p = norm(e);
    if (!p) return;
    strokeRef.current.push(p);
    setLivePath(strokePath(strokeRef.current));
  }

  function upDraw(): void {
    const raw = strokeRef.current;
    strokeRef.current = [];
    setLivePath('');
    if (raw.length < 2) return;
    // Downsample evenly to the contract cap.
    let points = raw;
    if (points.length > OVERLAY_STROKE_POINTS_MAX) {
      const step = points.length / OVERLAY_STROKE_POINTS_MAX;
      points = Array.from({ length: OVERLAY_STROKE_POINTS_MAX }, (_, i) => raw[Math.floor(i * step)]);
    }
    void submit({ kind: 'stroke', points, color, width });
  }

  // ---- tap-to-place (emoji / text) ----
  function place(e: React.PointerEvent<HTMLDivElement>): void {
    const p = norm(e);
    if (!p) return;
    if (placing === 'emoji' && emoji) {
      void submit({ kind: 'emoji', emoji, x: p.x, y: p.y, scale: 1 });
      setPlacing(null);
      setTool('draw');
    } else if (placing === 'text' && text.trim()) {
      void submit({ kind: 'text', text: text.trim(), x: p.x, y: p.y });
      setText('');
      setPlacing(null);
      setTool('draw');
    }
  }

  async function remove(o: StoryOverlay): Promise<void> {
    try {
      await removeOverlay(story.id, o.id);
      dropOverlay(story, o.id);
      setSelected(null);
    } catch {
      toast('Could not remove it');
    }
  }

  /** Undo = remove MY latest layer on this story (the server keeps the
   * tombstone; attribution never changes hands). */
  async function undo(): Promise<void> {
    const last = [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!last || busy) return;
    setBusy(true);
    try {
      await remove(last);
    } finally {
      setBusy(false);
    }
  }

  async function approve(o: StoryOverlay): Promise<void> {
    try {
      const fresh = await approveOverlay(story.id, o.id);
      injectOverlay(story, fresh);
    } catch {
      toast('Could not approve it');
    }
  }

  async function ban(user: UserLite): Promise<void> {
    if (!(await confirmDialog(`Ban ${user.display_name} from ALL your canvases, now and future? They won't be told.`, { zIndex: 61 }))) return;
    try {
      await canvasBan(user.id);
      toast('Banned from your canvases');
      setSelected(null);
    } catch {
      toast('Could not ban them');
    }
  }

  const selectedOverlay = selected ? overlays.find((o) => o.id === selected) ?? null : null;

  return (
    <>
      {/* ---- the overlay layer (paint order = created_at ASC, server-sorted) ---- */}
      <div className={cm.overlayLayer} aria-label="Canvas layers">
        <svg viewBox={`0 0 ${REF} ${REF}`} preserveAspectRatio="none" aria-hidden>
          {overlays
            .filter((o) => o.payload.kind === 'stroke')
            .map((o) => {
              const p = o.payload;
              if (p.kind !== 'stroke') return null;
              return (
                <path
                  key={o.id}
                  d={strokePath(p.points)}
                  stroke={p.color}
                  strokeWidth={p.width}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={reduced ? undefined : cm.overlayEnter}
                  opacity={o.status === 'pending' ? 0.55 : 1}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={() => {
                    setSelected((cur) => (cur === o.id ? null : o.id));
                    onInteracting(true);
                  }}
                />
              );
            })}
          {livePath ? (
            <path d={livePath} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
        </svg>
        {overlays.map((o) => {
          const p = o.payload;
          if (p.kind === 'emoji') {
            return (
              <button
                key={o.id}
                type="button"
                className={`${cm.overlayEmoji}${reduced ? '' : ` ${cm.overlayEnter}`}${o.status === 'pending' ? ` ${cm.overlayPending}` : ''}${selected === o.id ? ` ${cm.overlayHighlight}` : ''}`}
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, fontSize: `${Math.round(34 * p.scale)}px` }}
                aria-label={`Emoji by ${o.author.display_name} — tap for details`}
                onClick={() => {
                  setSelected((cur) => (cur === o.id ? null : o.id));
                  onInteracting(true);
                }}
              >
                {p.emoji}
              </button>
            );
          }
          if (p.kind === 'text') {
            return (
              <button
                key={o.id}
                type="button"
                className={`${cm.overlayText}${reduced ? '' : ` ${cm.overlayEnter}`}${o.status === 'pending' ? ` ${cm.overlayPending}` : ''}${selected === o.id ? ` ${cm.overlayHighlight}` : ''}`}
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                aria-label={`Note by ${o.author.display_name} — tap for details`}
                onClick={() => {
                  setSelected((cur) => (cur === o.id ? null : o.id));
                  onInteracting(true);
                }}
              >
                {p.text}
              </button>
            );
          }
          return null;
        })}

        {/* The "drawn by @x" chip: highlight + profile + author tools. */}
        {selectedOverlay ? (
          <span
            className={cm.overlayChip}
            style={chipPosition(selectedOverlay)}
            role="group"
            aria-label={`Drawn by ${selectedOverlay.author.display_name}`}
          >
            drawn by{' '}
            <Link href={`/u/${encodeURIComponent(selectedOverlay.author.username)}`}>
              @{selectedOverlay.author.username}
            </Link>
            {selectedOverlay.status === 'pending' ? <em>· pending</em> : null}
            {isMine || selectedOverlay.author.id === meId ? (
              <button type="button" className={cm.overlayChipBtn} onClick={() => void remove(selectedOverlay)}>
                remove
              </button>
            ) : null}
            {isMine && selectedOverlay.status === 'pending' ? (
              <button
                type="button"
                className={cm.overlayChipBtn}
                style={{ color: 'var(--ok)' }}
                onClick={() => void approve(selectedOverlay)}
              >
                approve
              </button>
            ) : null}
            {isMine && selectedOverlay.author.id !== meId ? (
              <button type="button" className={cm.overlayChipBtn} onClick={() => void ban(selectedOverlay.author)}>
                ban
              </button>
            ) : null}
            {selectedOverlay.author.id !== meId ? (
              <button type="button" className={cm.overlayChipBtn} onClick={() => setReporting(selectedOverlay)}>
                report
              </button>
            ) : null}
            <button
              type="button"
              className={cm.overlayChipBtn}
              style={{ color: '#fff' }}
              aria-label="Close"
              onClick={() => {
                setSelected(null);
                onInteracting(false);
              }}
            >
              ×
            </button>
          </span>
        ) : null}
      </div>

      {/* ---- the contributor strip ("maya, arjun +3") — outside canvas mode ---- */}
      {!active && contributors.length > 0 ? (
        <span className={`${cm.contribStrip}${isMine ? '' : ` ${cm.contribStripLifted}`}`} aria-label="Canvas contributors">
          <IcBrush size={14} />{' '}
          {contributors
            .slice(0, 2)
            .map((u) => u.display_name)
            .join(', ')}
          {contributors.length > 2 ? ` +${contributors.length - 2}` : ''}
        </span>
      ) : null}

      {active ? (
        <>
          {/* top row: Undo · "<name> is drawing too" · Done */}
          <div className={cm.cvTop}>
            <button type="button" className={cm.cvPill} disabled={mine.length === 0 || busy} onClick={() => void undo()}>
              <IcUndo size={16} /> Undo
            </button>
            <span className={cm.cvLive} aria-live="polite">
              {drawingToo ? `${drawingToo.display_name} is drawing too` : ''}
            </span>
            <button type="button" className={`${cm.cvPill} ${cm.cvPillPrimary}`} onClick={onDone}>
              Done
            </button>
          </div>

          {/* right rail: the tools (+ the author's approve queue) */}
          <div className={cm.cvRail} role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
            <button
              type="button"
              className={`${cm.cvTool}${tool === 'draw' ? ` ${cm.cvToolOn}` : ''}`}
              aria-pressed={tool === 'draw'}
              aria-label="Draw"
              onClick={() => setTool('draw')}
            >
              <IcBrush />
            </button>
            <button
              type="button"
              className={`${cm.cvTool}${tool === 'emoji' ? ` ${cm.cvToolOn}` : ''}`}
              aria-pressed={tool === 'emoji'}
              aria-label="Sticker"
              onClick={() => setTool('emoji')}
            >
              <IcSticker />
            </button>
            <button
              type="button"
              className={`${cm.cvTool}${tool === 'text' ? ` ${cm.cvToolOn}` : ''}`}
              aria-pressed={tool === 'text'}
              aria-label="Note"
              onClick={() => setTool('text')}
            >
              <IcNote />
            </button>
            {isMine && pending.length > 0 ? (
              <button
                type="button"
                className={`${cm.cvTool}${queueOpen ? ` ${cm.cvToolOn}` : ''}`}
                aria-label={`Approve drawings (${pending.length} waiting)`}
                aria-pressed={queueOpen}
                onClick={() => setQueueOpen((v) => !v)}
              >
                <IcCheck />
                <i className={cm.cvDot} aria-hidden />
              </button>
            ) : null}
          </div>

          {/* left: colour dots (draw only) */}
          {tool === 'draw' ? (
            <div className={cm.cvColors} role="radiogroup" aria-label="Pen colour">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={`Pen colour ${c}`}
                  className={`${cm.cvColor}${color === c ? ` ${cm.cvColorOn}` : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          ) : null}

          {/* bottom: brush slider (draw only) */}
          {tool === 'draw' && canAdd ? (
            <label className={cm.cvBrush}>
              <span>Brush</span>
              <input
                type="range"
                min={1}
                max={24}
                step={1}
                value={width}
                aria-label="Brush size"
                onChange={(e) => setWidth(Number(e.target.value))}
              />
              <i style={{ width: Math.max(4, width), height: Math.max(4, width), background: color }} aria-hidden />
            </label>
          ) : null}

          {!canAdd ? (
            <p className={cm.canvasHint}>
              {story.canvas_mode === 'off' && !isMine
                ? 'This canvas is closed'
                : `You’ve added your ${OVERLAYS_PER_USER} — undo one to add more.`}
            </p>
          ) : null}

          {/* draw surface */}
          {tool === 'draw' && canAdd ? (
            <div
              ref={surfaceRef}
              className={cm.drawSurface}
              aria-label="Drawing surface"
              onPointerDown={downDraw}
              onPointerMove={moveDraw}
              onPointerUp={upDraw}
              onPointerCancel={upDraw}
            >
              <svg viewBox={`0 0 ${REF} ${REF}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }} aria-hidden>
                {livePath ? (
                  <path d={livePath} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                ) : null}
              </svg>
            </div>
          ) : null}

          {/* sticker pick → tap to place */}
          {tool === 'emoji' && canAdd ? (
            placing === 'emoji' && emoji ? (
              <>
                <div ref={surfaceRef} className={cm.drawSurface} aria-label="Tap where the sticker should land" onPointerDown={place} />
                <p className={cm.canvasHint}>Tap the story where {emoji} should land</p>
              </>
            ) : (
              <div className={cm.emojiPickRow} role="menu" aria-label="Pick a sticker">
                {STAMP_EMOJI.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setEmoji(e);
                      setPlacing('emoji');
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )
          ) : null}

          {/* note input → tap to place */}
          {tool === 'text' && canAdd ? (
            placing === 'text' && text.trim() ? (
              <>
                <div ref={surfaceRef} className={cm.drawSurface} aria-label="Tap where the note should land" onPointerDown={place} />
                <p className={cm.canvasHint}>Tap the story where the note should land</p>
              </>
            ) : (
              <div className={cm.canvasTextRow}>
                <input
                  value={text}
                  maxLength={OVERLAY_TEXT_MAX_CHARS}
                  placeholder="A short note…"
                  aria-label="Note text"
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && text.trim()) {
                      e.preventDefault();
                      setPlacing('text');
                    }
                  }}
                />
                <button type="button" className={cm.cvPill} disabled={!text.trim()} onClick={() => setPlacing('text')}>
                  Place
                </button>
              </div>
            )
          ) : null}

          {/* the author's approve queue */}
          {queueOpen && isMine ? (
            <div className={cm.pendingQueue} role="dialog" aria-label="Waiting for your approval">
              {pending.length === 0 ? (
                <p style={{ margin: 0 }}>All caught up — nothing waiting.</p>
              ) : (
                pending.map((o) => (
                  <div key={o.id} className={cm.pendingRow}>
                    <span className="grow">
                      {o.payload.kind === 'stroke' ? 'a doodle' : o.payload.kind === 'emoji' ? `${o.payload.emoji} sticker` : `“${o.payload.text}”`}{' '}
                      by @{o.author.username}
                    </span>
                    <button type="button" className={cm.pendingBtn} style={{ borderColor: 'var(--ok)' }} onClick={() => void approve(o)}>
                      Approve
                    </button>
                    <button type="button" className={cm.pendingBtn} onClick={() => void remove(o)}>
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {reporting ? (
        <ReportSheet
          target={{ kind: 'story_overlay', story_id: story.id, overlay_id: reporting.id }}
          onClose={() => setReporting(null)}
          zIndex={61}
        />
      ) : null}
    </>
  );
}

function chipPosition(o: StoryOverlay): React.CSSProperties {
  const p = o.payload;
  const at = p.kind === 'stroke' ? p.points[0] : { x: p.x, y: p.y };
  return { left: `${Math.min(0.85, Math.max(0.15, at.x)) * 100}%`, top: `${Math.min(0.9, at.y) * 100}%` };
}
