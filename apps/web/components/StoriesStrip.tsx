'use client';

// Story tray (v0.5a — API.md §1.34): avatar rings at the top of the chat list.
// Unviewed authors glow first, then all-viewed — each bucket by USERNAME, never
// recency: a finite tray, not a feed. Expired cards drop locally between GETs.
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { StoryAuthorGroup, StoryCanvasMode, UploadResponse, UserLite } from '@socialchat/shared';
import { STORY_CANVAS_MODES, STORY_CAPTION_MAX_CHARS } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import ImageEditSheet from './ImageEditSheet';
import { createStory, refreshStories } from '@/lib/stories';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import StoryViewer from './StoryViewer';
import sheet from './beacons.module.css';
import li from './list.module.css';
import st from './social.module.css';

export default function StoriesStrip() {
  const state = useAppState();
  const router = useRouter();
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

  // Phase 4 (§3.3): `/?story=<username>` — the story share page's deep link
  // back (and the OS-shared link) opens that author's stories once the tray
  // has loaded; an author with nothing live for me reads as "none right now"
  // (the audience-filtered list is the §1.14 shape).
  const openByUsername = (username: string): void => {
    const all: StoryAuthorGroup[] = [
      ...(mine.length > 0 ? [{ author: meLite, stories: mine }] : []),
      ...groups,
    ];
    const start = all.findIndex((g) => g.author.username === username);
    if (start !== -1) {
      setViewer({ groups: all, start });
      return;
    }
    // Stories are friends-of scoped: someone who followed a story link in
    // from outside lands on the author's door instead (Connect lives there).
    toast(`No stories from @${username} for you right now — here is their profile.`);
    router.replace(`/u/${encodeURIComponent(username)}`);
  };

  // Nothing to show and nothing to post against? The strip still offers "Your
  // story" — stories are user-pulled, never a nag.
  return (
    <>
      <div className={`${st.storiesStrip} ${li.storiesBlock}`} role="list" aria-label="Stories">
        <button
          type="button"
          role="listitem"
          className={`${st.storyItem} ${li.item66}`}
          onClick={() => (mine.length > 0 ? openViewer(me.id) : setComposerOpen(true))}
          aria-label={mine.length > 0 ? 'Your story — tap to watch' : 'Add to your story'}
        >
          {mine.length > 0 ? (
            // A posted story: the avatar in a quiet ring, + badge to add more.
            <span className={`${st.storyRing} ${li.ring66}`}>
              <Avatar avatar={me.avatar} name={me.display_name} size={61} />
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
          ) : (
            // Royal v2: nothing posted = the dashed invite with a centered +.
            <span className={`${st.storyRing} ${st.ringMine} ${li.ring66} ${li.ringEmpty}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 5 V19 M5 12 H19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
          )}
          <span className={`${st.storyName} ${li.name66}`}>Your story</span>
        </button>
        {groups.map((g) => {
          const unviewed = g.stories.some((s) => !s.viewed);
          return (
            <button
              key={g.author.id}
              type="button"
              role="listitem"
              className={`${st.storyItem} ${li.item66}`}
              onClick={() => openViewer(g.author.id)}
              aria-label={`${g.author.display_name}'s story${unviewed ? ' — new' : ''}`}
            >
              <span className={`${st.storyRing} ${li.ring66}${unviewed ? ` ${st.ringUnviewed}` : ''}`}>
                <Avatar avatar={g.author.avatar} name={g.author.display_name} size={61} />
              </span>
              <span className={`${st.storyName} ${li.name66}${unviewed ? ` ${st.storyNameNew}` : ''}`}>
                {g.author.display_name}
              </span>
            </button>
          );
        })}
      </div>
      <Suspense fallback={null}>
        <StoryDeepLink loaded={state.stories !== null} onOpen={openByUsername} />
      </Suspense>
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
  const [editFile, setEditFile] = useState<File | null>(null); // v1.0a #92

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
      const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      const form = new FormData();
      form.append('file', up, up.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.kind !== 'image' && res.attachment.kind !== 'video') {
        setError('Stories take a photo or a video.');
      } else {
        setAttachment(res.attachment);
      }
    } catch (err) {
      if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setError('That file is too large.');
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
            // v1.0a (#92): a static photo opens the crop editor first;
            // GIFs/videos go straight through (canvas would flatten them).
            if (f && ['image/jpeg', 'image/png'].includes(f.type)) setEditFile(f);
            else if (f) void pick(f);
            e.target.value = '';
          }}
        />
        {editFile ? (
          <ImageEditSheet
            source={editFile}
            fileName={editFile.name}
            onCancel={() => {
              const f = editFile;
              setEditFile(null);
              void pick(f); // skip editing ≠ skip the story — upload as-is
            }}
            onDone={(file) => {
              setEditFile(null);
              void pick(file);
            }}
          />
        ) : null}
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

/** Reads `?story=<username>` once the tray is loaded, opens the viewer and
 * strips the query (native history API — the tab must not remount). */
function StoryDeepLink({ loaded, onOpen }: { loaded: boolean; onOpen: (username: string) => void }) {
  const params = useSearchParams();
  const wanted = params.get('story');
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || !loaded || handled.current === wanted) return;
    handled.current = wanted;
    onOpen(wanted);
    window.history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, loaded]);
  return null;
}
