'use client';

// Full-screen story viewer (v0.5a — API.md §1.34). Tap-through WITHIN an
// author; between authors advancing is ALWAYS a tap (PSYCHOLOGY never-build
// list: no auto-advancing stories). Hold to pause. Reduced motion = no
// auto-advance at all — every step is a tap. Own stories get the viewers sheet:
// faces ordered by username, NO timestamps (the table stores none).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareLink, Story, StoryAuthorGroup, StoryCanvasMode, UserLite } from '@socialchat/shared';
import { deleteStory, expiresLabel, setCanvasMode, storyViewers, viewStory } from '@/lib/stories';
import { absoluteShareUrl, copyShareLink, revokeShareLink } from '@/lib/share';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useReducedMotion } from '@/lib/useReducedMotion';
import Avatar from './Avatar';
import StoryCanvas from './StoryCanvas';
import sheet from './beacons.module.css';
import st from './social.module.css';

const IMAGE_MS = 5000;
const TAP_MAX_MS = 280;

interface StoryViewerProps {
  groups: StoryAuthorGroup[];
  startGroup: number;
  meId: string;
  onClose: () => void;
}

export default function StoryViewer({ groups, startGroup, meId, onClose }: StoryViewerProps) {
  const state = useAppState();
  const reducedMotion = useReducedMotion();
  const [gi, setGi] = useState(Math.max(0, Math.min(startGroup, groups.length - 1)));
  const [si, setSi] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 for the current story
  const [authorDone, setAuthorDone] = useState(false); // timer hit the end — wait for a tap
  const [viewersOpen, setViewersOpen] = useState(false);
  // v0.8b §1.66: canvas-tool / chip interaction pauses the auto-advance.
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set()); // deleted own stories
  const holdRef = useRef<{ at: number; zone: 'left' | 'right' } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const group = groups[gi];
  const stories = group ? group.stories.filter((s) => !gone.has(s.id)) : [];
  const snapshot: Story | undefined = stories[Math.min(si, Math.max(0, stories.length - 1))];
  // v0.8b §1.66: overlays/canvas_mode change live (story.updated) — prefer
  // the store's fresh DTO over the snapshot captured when the viewer opened.
  const story: Story | undefined = snapshot
    ? (state.stories?.mine.find((s) => s.id === snapshot.id) ??
        state.stories?.groups.flatMap((g) => g.stories).find((s) => s.id === snapshot.id) ??
        snapshot)
    : undefined;
  const isMine = group ? group.author.id === meId : false;
  const isVideo = story?.attachment.kind === 'video';

  // Record the view when a story lands on screen (idempotent; never own).
  useEffect(() => {
    if (story && !isMine) void viewStory(story);
  }, [story, isMine]);

  // Image auto-advance timer — within the author only, and never under
  // reduced motion (each step is then a tap). Elapsed time survives pauses in
  // a ref so holding never restarts the story.
  const elapsedRef = useRef(0);
  useEffect(() => {
    elapsedRef.current = 0;
    setProgress(0);
    setAuthorDone(false);
  }, [gi, si, story?.id]);
  useEffect(() => {
    if (!story || isVideo || reducedMotion || paused || viewersOpen || authorDone || canvasBusy) return;
    const timer = setInterval(() => {
      elapsedRef.current += 100;
      setProgress(Math.min(1, elapsedRef.current / IMAGE_MS));
      if (elapsedRef.current >= IMAGE_MS) {
        clearInterval(timer);
        advanceAuto();
      }
    }, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, si, story?.id, isVideo, reducedMotion, paused, viewersOpen, authorDone, canvasBusy]);

  // Pause/resume the video element with the hold gesture.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused || viewersOpen || canvasBusy) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, viewersOpen, canvasBusy, story?.id]);

  const advanceAuto = useCallback(() => {
    // Timer end: next story of the SAME author, else stop and ask for a tap.
    setSi((cur) => {
      if (cur + 1 < stories.length) return cur + 1;
      setAuthorDone(true);
      return cur;
    });
  }, [stories.length]);

  const nextAuthor = useCallback(() => {
    if (gi + 1 < groups.length) {
      setGi(gi + 1);
      setSi(0);
      setAuthorDone(false);
    } else {
      onClose();
    }
  }, [gi, groups.length, onClose]);

  const tapNext = useCallback(() => {
    if (si + 1 < stories.length) {
      setSi(si + 1);
      setAuthorDone(false);
    } else {
      nextAuthor(); // advancing between authors is a TAP — this is one
    }
  }, [si, stories.length, nextAuthor]);

  const tapPrev = useCallback(() => {
    setAuthorDone(false);
    if (si > 0) {
      setSi(si - 1);
    } else if (gi > 0) {
      const prevLen = groups[gi - 1].stories.length;
      setGi(gi - 1);
      setSi(Math.max(0, prevLen - 1));
    }
  }, [si, gi, groups]);

  // Keyboard: arrows step, Space pauses, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') tapNext();
      else if (e.key === 'ArrowLeft') tapPrev();
      else if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, tapNext, tapPrev]);

  // Hold-to-pause vs tap: a short press steps, a long press pauses.
  const zoneDown = (zone: 'left' | 'right') => {
    holdRef.current = { at: Date.now(), zone };
    setPaused(true);
  };
  const zoneUp = (zone: 'left' | 'right') => {
    const held = holdRef.current;
    holdRef.current = null;
    setPaused(false);
    if (held && held.zone === zone && Date.now() - held.at < TAP_MAX_MS) {
      if (zone === 'left') tapPrev();
      else tapNext();
    }
  };

  async function removeOwn(): Promise<void> {
    if (!story) return;
    try {
      await deleteStory(story.id);
      const left = stories.filter((s) => s.id !== story.id);
      setGone((prev) => new Set(prev).add(story.id));
      if (left.length === 0) onClose();
      else if (si >= left.length) setSi(left.length - 1);
    } catch {
      /* already gone */
    }
  }

  if (!group || !story) {
    onCloseSoon(onClose);
    return null;
  }

  const att = story.attachment;

  return (
    <div className={st.viewerBackdrop} role="dialog" aria-modal="true" aria-label={`Story by ${group.author.display_name}`}>
      <div className={st.viewerStage}>
        <div className={st.progressRow} aria-hidden>
          {stories.map((s, i) => (
            <span key={s.id} className={st.progressSeg}>
              <span
                className={st.progressFill}
                style={{ width: i < si ? '100%' : i === si ? `${Math.round(progress * 100)}%` : '0%' }}
              />
            </span>
          ))}
        </div>
        <div className={st.viewerHead}>
          <Avatar avatar={group.author.avatar} name={group.author.display_name} size={34} />
          <span className={st.viewerHeadName}>
            {isMine ? 'Your story' : group.author.display_name}
            <span className={st.viewerExpiry}>{expiresLabel(story)}</span>
          </span>
          <button type="button" className={st.viewerClose} aria-label="Close stories" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={st.viewerMedia}>
          {/* v0.8b §1.66: attributed vector overlays + canvas tools — painted
              ABOVE the media, never burned into it. */}
          <StoryCanvas story={story} meId={meId} onInteracting={setCanvasBusy} />
          {att.kind === 'video' && att.status === 'ready' ? (
            <video
              ref={videoRef}
              key={story.id}
              src={att.url}
              poster={att.thumb_url ?? undefined}
              autoPlay={!reducedMotion}
              playsInline
              controls={reducedMotion}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) setProgress(v.currentTime / v.duration);
              }}
              onEnded={() => {
                setProgress(1);
                advanceAuto();
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={story.id} src={att.url} alt={story.caption || 'Story'} draggable={false} />
          )}
        </div>

        {/* v0.8b §1.66: when canvas tools are on screen (same condition as
            StoryCanvas's toolbar) the caption lifts above them — both must
            stay legible at 390px. */}
        {story.caption ? (
          <div
            className={
              story.canvas_mode !== 'off' || isMine
                ? `${st.viewerCaption} ${st.viewerCaptionLifted}`
                : st.viewerCaption
            }
          >
            {story.caption}
          </div>
        ) : null}

        <button
          type="button"
          className={`${st.tapZone} ${st.tapZoneLeft}`}
          aria-label="Previous story (hold to pause)"
          onPointerDown={() => zoneDown('left')}
          onPointerUp={() => zoneUp('left')}
          onPointerCancel={() => {
            holdRef.current = null;
            setPaused(false);
          }}
        />
        <button
          type="button"
          className={`${st.tapZone} ${st.tapZoneRight}`}
          aria-label="Next story (hold to pause)"
          onPointerDown={() => zoneDown('right')}
          onPointerUp={() => zoneUp('right')}
          onPointerCancel={() => {
            holdRef.current = null;
            setPaused(false);
          }}
        />

        {authorDone ? (
          <div className={st.viewerHint}>
            <p>
              That&rsquo;s all from {isMine ? 'you' : group.author.display_name} ✨
            </p>
            {gi + 1 < groups.length ? (
              <button type="button" className="btn btn-primary" onClick={nextAuthor}>
                Next: {groups[gi + 1].author.display_name}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                All caught up — back to chats
              </button>
            )}
          </div>
        ) : null}

        {isMine ? (
          <div className={st.viewerFooter}>
            <button type="button" className={st.viewerBtn} onClick={() => setViewersOpen(true)}>
              👀 Viewers
            </button>
            {/* v0.8b §1.66: the author's canvas switch — 'off' keeps existing
                overlays (they were invited); it stops NEW ones. */}
            <CanvasModeButton story={story} />
            {/* v0.8b §1.67: author-initiated "Create share link" ONLY —
                revocable, dies with the story. */}
            <StoryShareButton storyId={story.id} />
            <button type="button" className={st.viewerBtn} onClick={() => void removeOwn()}>
              🗑 Delete
            </button>
          </div>
        ) : null}
      </div>
      {viewersOpen ? <StoryViewersSheet storyId={story.id} onClose={() => setViewersOpen(false)} /> : null}
    </div>
  );
}

// Close after render when the current group emptied (deleted/expired away).
function onCloseSoon(onClose: () => void): void {
  setTimeout(onClose, 0);
}

/** v0.8b §1.66: the author's canvas-mode cycle (off → open → approve). */
function CanvasModeButton({ story }: { story: Story }) {
  const [busy, setBusy] = useState(false);
  const NEXT: Record<StoryCanvasMode, StoryCanvasMode> = {
    off: 'open',
    open: 'approve',
    approve: 'off',
  };
  const LABEL: Record<StoryCanvasMode, string> = {
    off: '🎨 Canvas: off',
    open: '🎨 Canvas: open',
    approve: '🎨 Canvas: approve-first',
  };
  return (
    <button
      type="button"
      className={st.viewerBtn}
      disabled={busy}
      aria-label={`${LABEL[story.canvas_mode]} — tap to change`}
      onClick={() => {
        setBusy(true);
        void setCanvasMode(story.id, NEXT[story.canvas_mode])
          .then((s) =>
            toast(
              s.canvas_mode === 'off'
                ? 'Canvas closed — what’s drawn stays'
                : s.canvas_mode === 'open'
                  ? 'Canvas open — friends can draw'
                  : 'Canvas set to approve-first'
            )
          )
          .catch(() => toast('Could not change the canvas'))
          .finally(() => setBusy(false));
      }}
    >
      {LABEL[story.canvas_mode]}
    </button>
  );
}

/** v0.8b §1.67: author-only share link — mint-or-return + copy, revocable.
 * The page (and its gated media) dies with the story, or on revoke. */
function StoryShareButton({ storyId }: { storyId: string }) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);

  async function mint(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const got = await copyShareLink('story', storyId);
    if (got) setLink(got);
    setBusy(false);
  }

  async function revoke(): Promise<void> {
    if (!link || busy) return;
    setBusy(true);
    try {
      await revokeShareLink(link.token);
      setLink(null);
      toast('Share link revoked — the page is gone');
    } catch {
      toast('Could not revoke the link');
    } finally {
      setBusy(false);
    }
  }

  return link ? (
    <button type="button" className={st.viewerBtn} disabled={busy} onClick={() => void revoke()}>
      🔗 Revoke link
    </button>
  ) : (
    <button
      type="button"
      className={st.viewerBtn}
      disabled={busy}
      title={link ? absoluteShareUrl(link) : undefined}
      onClick={() => void mint()}
    >
      🔗 Share link
    </button>
  );
}

/** Author-only viewer list: faces by username — NO timestamps, no count copy. */
function StoryViewersSheet({ storyId, onClose }: { storyId: string; onClose: () => void }) {
  const [viewers, setViewers] = useState<UserLite[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storyViewers(storyId)
      .then((res) => {
        if (!cancelled) setViewers(res.viewers);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={sheet.sheetBackdrop}
      role="presentation"
      style={{ zIndex: 70 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Story viewers">
        <div className={sheet.sheetHead}>
          <h2>Seen by</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {error ? (
          <p className="error-text">Could not load viewers.</p>
        ) : viewers === null ? (
          <p className="muted small">
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Checking…
          </p>
        ) : viewers.length === 0 ? (
          <p className="muted small">No views yet — stories are a slow burn.</p>
        ) : (
          viewers.map((u) => (
            <div key={u.id} className={st.connRow}>
              <Avatar avatar={u.avatar} name={u.display_name} size={34} />
              <span className={st.connName}>
                <strong>{u.display_name}</strong>
                <span>@{u.username}</span>
              </span>
            </div>
          ))
        )}
        {/* No timestamps by design — a view is a face, not a deadline. */}
      </div>
    </div>
  );
}
