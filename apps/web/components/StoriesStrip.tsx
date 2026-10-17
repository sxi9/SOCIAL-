'use client';

// Story tray (v0.5a — API.md §1.34): avatar rings at the top of the chat list.
// Unviewed authors glow first, then all-viewed — each bucket by USERNAME, never
// recency: a finite tray, not a feed. Expired cards drop locally between GETs.
import { useEffect, useRef, useState } from 'react';
import type { StoryAuthorGroup, StoryCanvasMode, UploadResponse, UserLite } from '@socialchat/shared';
import { STORY_CANVAS_MODES, STORY_CAPTION_MAX_CHARS } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { createStory, refreshStories } from '@/lib/stories';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import StoryViewer from './StoryViewer';
import sheet from './beacons.module.css';
import st from './social.module.css';

export default function StoriesStrip() {
  const state = useAppState();
  const now = useNow(60_000);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewer, setViewer] = useState<{ groups: StoryAuthorGroup[]; start: number } | null>(null);

  useEffect(() => {
    void refreshStories();
  }, []);

  // Expiry housekeeping (no fan-out exists for expiry, §1.34).
  useEffect(() => {
    store.sweepStories();
  }, [now]);

  const me = state.me;
  if (!me) return null;

  const mine = state.stories?.mine ?? [];
  const groups = state.stories?.groups ?? [];

  const meLite: UserLite = {
    id: me.id,
    username: me.username,
    display_name: me.display_name,
    avatar: me.avatar,
    mood: me.mood,
    name_style: me.name_style,
    mask_emoji: null,
  };

  const openViewer = (startAuthorId: string) => {
    const all: StoryAuthorGroup[] = [
      ...(mine.length > 0 ? [{ author: meLite, stories: mine }] : []),
      ...groups,
    ];
    const start = all.findIndex((g) => g.author.id === startAuthorId);
    if (start !== -1) setViewer({ groups: all, start });
  };

  // Nothing to show and nothing to post against? The strip still offers "Your
  // story" — stories are user-pulled, never a nag.
  return (
    <>
      <div className={st.storiesStrip} role="list" aria-label="Stories">
        <button
          type="button"
          role="listitem"
          className={st.storyItem}
          onClick={() => (mine.length > 0 ? openViewer(me.id) : setComposerOpen(true))}
          aria-label={mine.length > 0 ? 'Your story — tap to watch' : 'Add to your story'}
        >
          <span className={`${st.storyRing} ${st.ringMine}`}>
            <Avatar avatar={me.avatar} name={me.display_name} size={50} />
            <span
              className={st.storyAdd}
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                setComposerOpen(true);
              }}
            >
              +
            </span>
          </span>
          <span className={st.storyName}>Your story</span>
        </button>
        {groups.map((g) => {
          const unviewed = g.stories.some((s) => !s.viewed);
          return (
            <button
              key={g.author.id}
              type="button"
              role="listitem"
              className={st.storyItem}
              onClick={() => openViewer(g.author.id)}
              aria-label={`${g.author.display_name}'s story${unviewed ? ' — new' : ''}`}
            >
              <span className={`${st.storyRing}${unviewed ? ` ${st.ringUnviewed}` : ''}`}>
                <Avatar avatar={g.author.avatar} name={g.author.display_name} size={50} />
              </span>
              <span className={st.storyName}>{g.author.display_name}</span>
            </button>
          );
        })}
      </div>
      {composerOpen ? <StoryComposerSheet onClose={() => setComposerOpen(false)} /> : null}
      {viewer ? (
        <StoryViewer
          groups={viewer.groups}
          startGroup={viewer.start}
          meId={me.id}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
}

/** Post-story flow: camera-roll upload + caption (≤140). Rides §1.6 uploads. */
export function StoryComposerSheet({ onClose }: { onClose: () => void }) {
  const [attachment, setAttachment] = useState<UploadResponse['attachment'] | null>(null);
  const [caption, setCaption] = useState('');
  // v0.8b §1.66: the canvas invitation — DEFAULT OFF ('just viewing');
  // being drawable is always the author's choice.
  const [canvasMode, setCanvasMode] = useState<StoryCanvasMode>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function pick(file: File): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.kind !== 'image' && res.attachment.kind !== 'video') {
        setError('Stories take a photo or a video.');
      } else {
        setAttachment(res.attachment);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) setError('That file is too large.');
      else if (err instanceof ApiError && err.status === 415) setError('Unsupported file type.');
      else setError('Upload failed — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function post(): Promise<void> {
    if (!attachment || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createStory(attachment.id, caption.trim(), canvasMode);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Easy there — story limit for this hour.');
      else setError('Could not post the story.');
      setBusy(false);
    }
  }

  return (
    <div
      className={sheet.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Add to your story">
        <div className={sheet.sheetHead}>
          <h2>Add to your story</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Friends see it for 24 hours, then it&rsquo;s gone for good. You&rsquo;ll see who watched —
          names only, never a count.
        </p>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/*,video/mp4,video/webm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = '';
          }}
        />
        {attachment ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            {attachment.thumb_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachment.thumb_url}
                alt=""
                style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 12 }}
              />
            ) : (
              <span className="chip">{attachment.kind === 'video' ? '🎬 Video' : '🖼 Photo'}</span>
            )}
            <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              Swap
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            style={{ width: '100%', marginBottom: 12 }}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Uploading…' : '📷 Pick a photo or video'}
          </button>
        )}
        <div className="field">
          <label htmlFor="story-caption">Caption (optional)</label>
          <input
            id="story-caption"
            className="input"
            value={caption}
            maxLength={STORY_CAPTION_MAX_CHARS}
            placeholder="say something…"
            onChange={(e) => setCaption(e.target.value)}
          />
        </div>
        {/* v0.8b §1.66: the canvas choice — off / open / approve-first. */}
        <div className={sheet.sheetLabel}>Canvas</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Can friends draw on this story?">
          {STORY_CANVAS_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={canvasMode === m}
              className={`btn${canvasMode === m ? ' btn-primary' : ''}`}
              onClick={() => setCanvasMode(m)}
            >
              {m === 'off' ? '🖼 Just viewing' : m === 'open' ? '🎨 Open canvas' : '✅ Approve first'}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: '6px 0 12px' }}>
          {canvasMode === 'off'
            ? 'Nobody can draw on it — the default.'
            : canvasMode === 'open'
              ? 'Friends can add doodles, emoji and little notes — each one signed, each one removable by you.'
              : 'Friends can draw, but nothing shows until you approve it.'}
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={!attachment || busy}
          onClick={() => void post()}
        >
          {busy ? 'Posting…' : 'Post story'}
        </button>
      </div>
    </div>
  );
}
