'use client';

// Full-screen story viewer (v0.5a — API.md §1.34). Tap-through WITHIN an
// author; between authors advancing is ALWAYS a tap (PSYCHOLOGY never-build
// list: no auto-advancing stories). Hold to pause. Reduced motion = no
// auto-advance at all — every step is a tap.
//
// Handoff "Gallery and post layouts" (2026-10-28), story layouts 2a–2d:
//   2a your story      — three actions: Viewers (faces) · Edit · More; the
//                        rest (link, share, canvas, audience, delete) sits in
//                        the More sheet. Icons, never emoji.
//   2b activity drawer — Viewers shrinks the story to a card and lists WHO
//                        saw it with what they did (reacted / replied / drew).
//                        Names, never counts or times.
//   2c canvas state    — Draw opens the canvas as its own state; the viewer
//                        chrome steps out (StoryCanvas owns the tools).
//   2d friend's story  — reply first: reaction row, "Reply to <name>…" pill,
//                        hold-to-record Voice (StoryReplyBar); ⋯ holds share
//                        and report.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Story, StoryAuthorGroup, StoryViewsResponse } from '@socialchat/shared';
import { canOsShare, saveAttachment, shareAttachment } from '@/lib/osShare';
import { deleteStory, expiresLabel, storyViewers, viewStory } from '@/lib/stories';
import ShareSheet from './ShareSheet';
import ReportSheet from './ReportSheet';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useReducedMotion } from '@/lib/useReducedMotion';
import Avatar from './Avatar';
import StoryCanvas from './StoryCanvas';
import StoryReplyBar from './StoryReplyBar';
import { StoryActivityDrawer, StoryEditSheet, StoryFriendMenu, StoryMoreSheet } from './StorySheets';
import { IcClose, IcEdit, IcMore } from './StoryIcons';
import st from './social.module.css';
import sy from './story.module.css';

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
  const [moreOpen, setMoreOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // §1b ShareSheet opened from the viewer: owned HERE (not inside a
  // ShareButton) so the timer, the video and the arrow keys know a sheet is
  // up — otherwise the story advances underneath and the sheet keeps the
  // previous story's link (Slice C review, 2026-10-27).
  const [shareOpen, setShareOpen] = useState(false);
  // Wave 1 §1.5: the target is captured at tap time — the viewer may step
  // on underneath, the report never swaps to another story.
  const [reportTarget, setReportTarget] = useState<{ story_id: string; author_id: string } | null>(null);
  const reportOpen = reportTarget !== null;
  // v0.8b §1.66 / handoff 2c: the canvas is its own state; chip taps outside
  // it still pause the auto-advance.
  const [canvasActive, setCanvasActive] = useState(false);
  const [canvasBusy, setCanvasBusy] = useState(false);
  // 2d: the reply composer / recorder has the user.
  const [replyBusy, setReplyBusy] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set()); // deleted own stories
  // 2a: the Viewers pill shows faces — fetched once per own story.
  const [peek, setPeek] = useState<StoryViewsResponse | null>(null);
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
  const sheetUp = viewersOpen || shareOpen || reportOpen || moreOpen || editOpen || menuOpen;
  const held = sheetUp || canvasActive || canvasBusy || replyBusy;

  // Phase 4: OS share of the story's own media (the share-page LINK stays
  // author-minted, §1.67); falls back to Save on platforms without file share.
  const shareOut = async (): Promise<void> => {
    if (!story) return;
    const wasPaused = paused;
    setPaused(true);
    const outcome = canOsShare()
      ? await shareAttachment(story.attachment, story.caption || null)
      : 'unsupported';
    if (outcome === 'unsupported') {
      saveAttachment(story.attachment);
      toast('Saved — this browser cannot share files; share the saved copy');
    } else if (outcome === 'failed') {
      saveAttachment(story.attachment);
      toast('Could not share directly — saved it instead');
    }
    setPaused(wasPaused);
  };
  const isVideo = story?.attachment.kind === 'video';

  // Record the view when a story lands on screen (idempotent; never own).
  useEffect(() => {
    if (story && !isMine) void viewStory(story);
  }, [story, isMine]);

  // 2a: the faces in the Viewers pill (own stories only; refreshed by the drawer).
  const storyId = story?.id;
  useEffect(() => {
    setPeek(null);
    if (!storyId || !isMine) return;
    let cancelled = false;
    void storyViewers(storyId)
      .then((res) => {
        if (!cancelled) setPeek(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storyId, isMine]);

  // Image auto-advance timer — within the author only, and never under
  // reduced motion (each step is then a tap). Elapsed time survives pauses in
  // a ref so holding never restarts the story.
  const elapsedRef = useRef(0);
  useEffect(() => {
    elapsedRef.current = 0;
    setProgress(0);
    setAuthorDone(false);
    setCanvasActive(false);
    // A chip tapped on the previous story (canvasBusy) or a send in flight
    // (replyBusy) must not hold the next one.
    setCanvasBusy(false);
    setReplyBusy(false);
  }, [gi, si, story?.id]);
  useEffect(() => {
    if (!story || isVideo || reducedMotion || paused || held || authorDone) return;
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
  }, [gi, si, story?.id, isVideo, reducedMotion, paused, held, authorDone]);

  // Pause/resume the video element with the hold gesture (and under any sheet).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused || held) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, held, story?.id]);

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

  // Keyboard: arrows step, Space pauses, Escape closes — all of it yields
  // while a sheet is up (its own Escape is handled topmost-only by
  // lib/overlays before this bubble listener ever sees it) or the canvas is
  // open (Escape then leaves the canvas), and Space never steals a keystroke
  // from a text field (the reply composer, the chat picker's search box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheetUp) return;
      if (canvasActive) {
        if (e.key === 'Escape') setCanvasActive(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && !typing) tapNext();
      else if (e.key === 'ArrowLeft' && !typing) tapPrev();
      else if (e.key === ' ' && !typing) {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, tapNext, tapPrev, sheetUp, canvasActive]);

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

  /** True when the story is gone (deleted now, or already); false = keep
   * the sheet open, the user was told. */
  async function removeOwn(): Promise<boolean> {
    if (!story) return true;
    try {
      await deleteStory(story.id); // ignores 404 itself
    } catch {
      toast('Could not delete — try again');
      return false;
    }
    const left = stories.filter((s) => s.id !== story.id);
    setGone((prev) => new Set(prev).add(story.id));
    if (left.length === 0) onClose();
    else if (si >= left.length) setSi(left.length - 1);
    return true;
  }

  const openCanvas = useCallback(() => {
    setMoreOpen(false);
    setViewersOpen(false);
    setAuthorDone(false); // the "that's all" hint would sit over the draw surface
    setCanvasActive(true);
  }, []);

  if (!group || !story) {
    onCloseSoon(onClose);
    return null;
  }

  const att = story.attachment;
  const mood = group.author.mood;
  const subline = `${expiresLabel(story)}${mood ? ` · Feeling ${mood.label.toLowerCase()}` : ''}`;
  const faces = peek?.viewers.slice(0, 3) ?? [];
  const seenBy =
    peek === null
      ? 'Viewers'
      : peek.viewers.length === 0
        ? 'No views yet'
        : `Seen by ${peek.viewers
            .slice(0, 2)
            .map((u) => u.display_name)
            .join(', ')}${peek.viewers.length > 2 ? '…' : ''}`;

  return (
    <div className={st.viewerBackdrop} role="dialog" aria-modal="true" aria-label={`Story by ${group.author.display_name}`}>
      <div
        className={`${st.viewerStage}${canvasActive ? ` ${st.viewerChromeHidden}` : ''}${viewersOpen ? ` ${sy.stageShrunk}` : ''}`}
      >
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
          {/* Phase 4 (§3.3): the face and the name are the author's door. */}
          <Link
            href={`/u/${encodeURIComponent(group.author.username)}`}
            onClick={onClose}
            style={{ display: 'contents', color: 'inherit', textDecoration: 'none' }}
          >
            {isMine ? (
              <Avatar avatar={group.author.avatar} name={group.author.display_name} size={36} />
            ) : (
              <span className={sy.ring}>
                <Avatar avatar={group.author.avatar} name={group.author.display_name} size={32} />
              </span>
            )}
            <span className={st.viewerHeadName}>
              {isMine ? 'Your story' : group.author.display_name}
              <span className={st.viewerExpiry}>{subline}</span>
            </span>
          </Link>
          {!isMine ? (
            <button type="button" className={st.viewerClose} aria-label="More" onClick={() => setMenuOpen(true)}>
              <IcMore size={18} />
            </button>
          ) : null}
          <button type="button" className={st.viewerClose} aria-label="Close stories" onClick={onClose}>
            <IcClose size={18} />
          </button>
        </div>

        <div className={st.viewerMedia}>
          {/* v0.8b §1.66: attributed vector overlays + canvas tools — painted
              ABOVE the media, never burned into it. */}
          <StoryCanvas
            story={story}
            meId={meId}
            active={canvasActive}
            onDone={() => setCanvasActive(false)}
            onInteracting={setCanvasBusy}
          />
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

        {/* The caption sits ABOVE the action bar — never under it. */}
        {story.caption ? (
          <div className={isMine ? st.viewerCaption : `${st.viewerCaption} ${st.viewerCaptionLifted}`}>{story.caption}</div>
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
          // 2a: three actions. Everything else lives behind More.
          <div className={st.viewerFooter}>
            <button type="button" className={`${sy.pill} ${sy.pillGrow}`} onClick={() => setViewersOpen(true)}>
              {faces.length > 0 ? (
                <span className={sy.facePile} aria-hidden>
                  {faces.map((u) => (
                    <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={22} />
                  ))}
                </span>
              ) : null}
              <span>{seenBy}</span>
            </button>
            <button type="button" className={sy.pill} onClick={() => setEditOpen(true)}>
              <IcEdit size={17} /> Edit
            </button>
            <button type="button" className={`${sy.circle} ${sy.circleSm}`} aria-label="More" onClick={() => setMoreOpen(true)}>
              <IcMore size={18} />
            </button>
          </div>
        ) : !canvasActive ? (
          // 2d: reply first. Share and report sit behind the header's ⋯.
          <StoryReplyBar
            key={story.id}
            story={story}
            onBusy={setReplyBusy}
            canDraw={story.canvas_mode !== 'off'}
            onDraw={openCanvas}
          />
        ) : null}
        {reportTarget ? (
          <ReportSheet
            key={reportTarget.story_id}
            target={{ kind: 'story', object_id: reportTarget.story_id, user_id: reportTarget.author_id }}
            onClose={() => setReportTarget(null)}
            zIndex={61}
          />
        ) : null}
      </div>

      {viewersOpen ? (
        <StoryActivityDrawer
          key={story.id}
          story={story}
          initial={peek}
          onLoaded={setPeek}
          onClose={() => setViewersOpen(false)}
          onShareLink={() => {
            setViewersOpen(false);
            setShareOpen(true);
          }}
          onSharePicture={() => {
            setViewersOpen(false);
            void shareOut();
          }}
          onDraw={openCanvas}
          onDelete={removeOwn}
        />
      ) : null}
      {moreOpen ? (
        <StoryMoreSheet
          key={story.id}
          story={story}
          onClose={() => setMoreOpen(false)}
          onShareLink={() => {
            setMoreOpen(false);
            setShareOpen(true);
          }}
          onSharePicture={() => {
            setMoreOpen(false);
            void shareOut();
          }}
          onDraw={openCanvas}
          onDelete={removeOwn}
        />
      ) : null}
      {editOpen ? <StoryEditSheet key={story.id} story={story} onClose={() => setEditOpen(false)} /> : null}
      {menuOpen ? (
        <StoryFriendMenu
          key={story.id}
          story={story}
          onClose={() => setMenuOpen(false)}
          onSharePicture={() => {
            setMenuOpen(false);
            void shareOut();
          }}
          onReport={() => {
            setMenuOpen(false);
            setReportTarget({ story_id: story.id, author_id: story.author.id });
          }}
        />
      ) : null}
      {/* keyed by story so a step to another story remounts (fresh mint).
          zIndex 61 clears the viewer's own z 60 backdrop (picker 62, confirm
          63) while staying UNDER the call planes — 69 pill, 70 incoming ring,
          72 match moment (globals.css ladder) — so a call can still be
          answered over an open share sheet. */}
      {shareOpen ? (
        <ShareSheet key={story.id} type="story" id={story.id} zIndex={61} onClose={() => setShareOpen(false)} />
      ) : null}
    </div>
  );
}

// Close after render when the current group emptied (deleted/expired away).
function onCloseSoon(onClose: () => void): void {
  setTimeout(onClose, 0);
}
