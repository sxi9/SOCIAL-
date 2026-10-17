'use client';

// Canvas stories (v0.8b — API.md §1.66, FEATURES #79a, ADR-020). Overlays are
// ATTRIBUTED VECTOR LAYERS over the media — never burned into the image.
// Binding render contract carried here: normalized 0..1 coordinates, every
// overlay wears a username chip and is tappable → highlight + "drawn by @x" →
// profile; the §1.21 doodle brush is the stroke tool; reduced motion disables
// entrance animations (layers simply appear); the client never rasterizes
// overlays into saved/shared media.
import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Story, StoryOverlay, StoryOverlayPayload, UserLite } from '@socialchat/shared';
import { OVERLAYS_PER_USER, OVERLAY_STROKE_POINTS_MAX, OVERLAY_TEXT_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { addOverlay, approveOverlay, canvasBan, removeOverlay } from '@/lib/stories';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useReducedMotion } from '@/lib/useReducedMotion';
import ReportSheet from './ReportSheet';
import cm from './community.module.css';

// The §1.21 doodle palette — the same four pens.
const COLORS = ['#1f2430', '#e4573d', '#2f7de0', '#2fa36b'] as const;
const STROKE_WIDTH = 6; // px at the 512 reference edge
const STAMP_EMOJI = ['😂', '❤️', '🔥', '👀', '✨', '💀', '🫶', '🎉', '🥹', '👻'];
const REF = 512; // stroke coordinate reference edge for the SVG viewBox

type Tool = 'draw' | 'emoji' | 'text' | null;

interface StoryCanvasProps {
  story: Story;
  meId: string;
  /** Tool/chip interactions pause the viewer's auto-advance. */
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

export default function StoryCanvas({ story, meId, onInteracting }: StoryCanvasProps) {
  const reduced = useReducedMotion();
  const isMine = story.author.id === meId;
  const [tool, setToolRaw] = useState<Tool>(null);
  const [color, setColor] = useState<string>(COLORS[1]);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [placing, setPlacing] = useState<'emoji' | 'text' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [reporting, setReporting] = useState<StoryOverlay | null>(null);
  const [busy, setBusy] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<{ x: number; y: number }[]>([]);
  const [livePath, setLivePath] = useState<string>('');

  const setTool = useCallback(
    (t: Tool) => {
      setToolRaw(t);
      setSelected(null);
      setPlacing(t === 'emoji' || t === 'text' ? null : null);
      onInteracting(t !== null);
    },
    [onInteracting]
  );

  // Visible overlays: 'live' for all + my own / the author's 'pending'
  // (the server already serialized only what this viewer may see).
  const overlays = story.overlays.filter((o) => o.status !== 'removed');
  const myCount = overlays.filter((o) => o.author.id === meId).length;
  const canAdd = (story.canvas_mode !== 'off' || isMine) && myCount < OVERLAYS_PER_USER;
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
    void submit({ kind: 'stroke', points, color, width: STROKE_WIDTH });
  }

  // ---- tap-to-place (emoji / text) ----
  function place(e: React.PointerEvent<HTMLDivElement>): void {
    const p = norm(e);
    if (!p) return;
    if (placing === 'emoji' && emoji) {
      void submit({ kind: 'emoji', emoji, x: p.x, y: p.y, scale: 1 });
      setPlacing(null);
      setTool(null);
    } else if (placing === 'text' && text.trim()) {
      void submit({ kind: 'text', text: text.trim(), x: p.x, y: p.y });
      setText('');
      setPlacing(null);
      setTool(null);
    }
  }

  async function remove(o: StoryOverlay): Promise<void> {
    try {
      await removeOverlay(story.id, o.id);
      dropOverlay(story, o.id);
      setSelected(null);
      toast('Removed');
    } catch {
      toast('Could not remove it');
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
    if (!window.confirm(`Ban ${user.display_name} from ALL your canvases, now and future? They won't be told.`)) return;
    try {
      await canvasBan(user.id);
      toast('Banned from your canvases');
      setSelected(null);
    } catch {
      toast('Could not ban them');
    }
  }

  const selectedOverlay = selected ? overlays.find((o) => o.id === selected) ?? null : null;
  const toolsOpen = tool !== null;

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
            <path d={livePath} stroke={color} strokeWidth={STROKE_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
            🎨 drawn by{' '}
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
                onInteracting(tool !== null);
              }}
            >
              ×
            </button>
          </span>
        ) : null}
      </div>

      {/* ---- the contributor strip ("🎨 maya, arjun +3") ---- */}
      {contributors.length > 0 ? (
        <span className={cm.contribStrip} aria-label="Canvas contributors">
          🎨{' '}
          {contributors
            .slice(0, 2)
            .map((u) => u.display_name)
            .join(', ')}
          {contributors.length > 2 ? ` +${contributors.length - 2}` : ''}
        </span>
      ) : null}

      {/* ---- tools (viewers when invited; the author always) ---- */}
      {story.canvas_mode !== 'off' || isMine ? (
        <div className={cm.canvasBar} role="toolbar" aria-label="Canvas tools">
          <button
            type="button"
            className={`${cm.canvasTool}${tool === 'draw' ? ` ${cm.canvasToolOn}` : ''}`}
            disabled={!canAdd && tool !== 'draw'}
            aria-pressed={tool === 'draw'}
            onClick={() => setTool(tool === 'draw' ? null : 'draw')}
          >
            ✏️ Draw
          </button>
          <button
            type="button"
            className={`${cm.canvasTool}${tool === 'emoji' ? ` ${cm.canvasToolOn}` : ''}`}
            disabled={!canAdd && tool !== 'emoji'}
            aria-pressed={tool === 'emoji'}
            onClick={() => setTool(tool === 'emoji' ? null : 'emoji')}
          >
            😀 Emoji
          </button>
          <button
            type="button"
            className={`${cm.canvasTool}${tool === 'text' ? ` ${cm.canvasToolOn}` : ''}`}
            disabled={!canAdd && tool !== 'text'}
            aria-pressed={tool === 'text'}
            onClick={() => setTool(tool === 'text' ? null : 'text')}
          >
            💬 Note
          </button>
          {tool === 'draw'
            ? COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${cm.canvasColor}${color === c ? ` ${cm.canvasColorOn}` : ''}`}
                  style={{ background: c }}
                  aria-label={`Pen color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                />
              ))
            : null}
          {isMine && pending.length > 0 ? (
            <button
              type="button"
              className={`${cm.canvasTool}${queueOpen ? ` ${cm.canvasToolOn}` : ''}`}
              onClick={() => {
                setQueueOpen((v) => !v);
                onInteracting(true);
              }}
            >
              ✅ Approve ({pending.length})
            </button>
          ) : null}
        </div>
      ) : null}

      {!canAdd && toolsOpen ? (
        <p className={cm.canvasHint}>You&rsquo;ve added your {OVERLAYS_PER_USER} — remove one of yours to add more.</p>
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
              <path d={livePath} stroke={color} strokeWidth={STROKE_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </svg>
        </div>
      ) : null}

      {/* emoji pick → tap to place */}
      {tool === 'emoji' && canAdd ? (
        placing === 'emoji' && emoji ? (
          <>
            <div ref={surfaceRef} className={cm.drawSurface} aria-label="Tap where the emoji should land" onPointerDown={place} />
            <p className={cm.canvasHint}>Tap the story where {emoji} should land</p>
          </>
        ) : (
          <div className={cm.emojiPickRow} role="menu" aria-label="Pick an emoji stamp">
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

      {/* text input → tap to place */}
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
            <button type="button" className={cm.canvasTool} disabled={!text.trim()} onClick={() => setPlacing('text')}>
              Place →
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
                  {o.payload.kind === 'stroke' ? '✏️ a doodle' : o.payload.kind === 'emoji' ? `😀 ${o.payload.emoji}` : `💬 “${o.payload.text}”`}{' '}
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

      {reporting ? (
        <ReportSheet
          target={{ kind: 'story_overlay', story_id: story.id, overlay_id: reporting.id }}
          onClose={() => setReporting(null)}
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
