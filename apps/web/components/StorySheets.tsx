'use client';

// The story viewer's bottom sheets (handoff 2a/2b, 2026-10-28):
//   StoryMoreSheet      — your story's "More": link · share picture · canvas
//                         toggle · who can see this · delete
//   StoryEditSheet      — the "Edit" pill: caption while the story lives
//   StoryActivityDrawer — "Who saw it": faces with what each DID (reacted /
//                         replied / drew) — names, never counts or times
//   StoryFriendMenu     — a friend's story ⋯: share picture · report
// Every sheet portals to body above the viewer (z 70; the viewer is 60) and
// closes on Escape through lib/overlays (topmost only).
import { useEffect, useState } from 'react';
import type { Story, StoryViewsResponse, UserLite } from '@socialchat/shared';
import { STORY_CAPTION_MAX_CHARS } from '@socialchat/shared';
import { confirmDialog } from '@/lib/confirm';
import { useOverlayEscape } from '@/lib/overlays';
import { setCanvasMode, storyViewers, updateStoryCaption } from '@/lib/stories';
import { toast } from '@/lib/toast';
import Avatar from './Avatar';
import Portal from './Portal';
import {
  IcBrush,
  IcCheck,
  IcEye,
  IcFlag,
  IcGroup,
  IcLink,
  IcShare,
  IcTrash,
} from './StoryIcons';
import s from './story.module.css';

const Z = 70;

function Shell({
  label,
  onClose,
  children,
  zIndex = Z,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  zIndex?: number;
}) {
  useOverlayEscape(onClose);
  return (
    <Portal>
      <div
        className={s.sheetBackdrop}
        style={{ zIndex }}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={s.sheet} role="dialog" aria-modal="true" aria-label={label}>
          <div className={s.handle} aria-hidden />
          {children}
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------

export function StoryMoreSheet({
  story,
  onClose,
  onShareLink,
  onSharePicture,
  onDraw,
  onDelete,
}: {
  story: Story;
  onClose: () => void;
  onShareLink: () => void;
  onSharePicture: () => void;
  onDraw: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const canvasOn = story.canvas_mode !== 'off';
  return (
    <Shell label="More for your story" onClose={onClose}>
      <button type="button" className={s.row} onClick={onShareLink}>
        <span className={s.rowIcon}>
          <IcLink />
        </span>
        <span className={s.rowText}>
          Share link
          <small>A revocable link; dies with the story</small>
        </span>
      </button>
      <button type="button" className={s.row} onClick={onSharePicture}>
        <span className={s.rowIcon}>
          <IcShare />
        </span>
        <span className={s.rowText}>Share the picture…</span>
      </button>
      <button type="button" className={s.row} onClick={onDraw}>
        <span className={s.rowIcon}>
          <IcBrush />
        </span>
        <span className={s.rowText}>Draw on it</span>
      </button>
      <button
        type="button"
        className={s.row}
        role="switch"
        aria-checked={canvasOn}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void setCanvasMode(story.id, canvasOn ? 'off' : 'open')
            .then((n) => toast(n.canvas_mode === 'off' ? 'Canvas closed — what’s drawn stays' : 'Canvas open — friends can draw'))
            .catch(() => toast('Could not change the canvas'))
            .finally(() => setBusy(false));
        }}
      >
        <span className={s.rowIcon}>
          <IcGroup />
        </span>
        <span className={s.rowText}>
          Canvas
          <small>
            {canvasOn
              ? story.canvas_mode === 'approve'
                ? 'Friends can draw on it — you approve first'
                : 'Friends can draw on it'
              : 'Only you can draw on it'}
          </small>
        </span>
        <span className={`${s.toggle}${canvasOn ? ` ${s.toggleOn}` : ''}`} aria-hidden />
      </button>
      {canvasOn ? (
        <button
          type="button"
          className={s.row}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void setCanvasMode(story.id, story.canvas_mode === 'approve' ? 'open' : 'approve')
              .catch(() => toast('Could not change the canvas'))
              .finally(() => setBusy(false));
          }}
        >
          <span className={s.rowIcon}>
            <IcCheck />
          </span>
          <span className={s.rowText}>Approve drawings first</span>
          <span className={`${s.toggle}${story.canvas_mode === 'approve' ? ` ${s.toggleOn}` : ''}`} aria-hidden />
        </button>
      ) : null}
      <div className={s.row} role="note" style={{ cursor: 'default' }}>
        <span className={s.rowIcon}>
          <IcEye />
        </span>
        <span className={s.rowText}>Who can see this</span>
        <span className={s.rowValue}>Connections</span>
      </div>
      <div className={s.divider} />
      <button
        type="button"
        className={`${s.row} ${s.rowDanger}`}
        disabled={busy}
        onClick={() => {
          void (async () => {
            if (!(await confirmDialog('Delete this story? Views and drawings go with it.', { confirmLabel: 'Delete', danger: true, zIndex: Z }))) return;
            setBusy(true);
            try {
              if (await onDelete()) onClose();
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <span className={s.rowIcon}>
          <IcTrash />
        </span>
        <span className={s.rowText}>Delete story</span>
      </button>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

export function StoryEditSheet({ story, onClose }: { story: Story; onClose: () => void }) {
  const [caption, setCaption] = useState(story.caption);
  const [busy, setBusy] = useState(false);
  return (
    <Shell label="Edit your story" onClose={onClose}>
      <h2 className={s.sheetTitle}>Edit</h2>
      <textarea
        className={s.captionBox}
        value={caption}
        maxLength={STORY_CAPTION_MAX_CHARS}
        placeholder="Say something about it…"
        aria-label="Caption"
        autoFocus
        onChange={(e) => setCaption(e.target.value)}
      />
      <p className={s.counter}>
        {caption.length}/{STORY_CAPTION_MAX_CHARS}
      </p>
      <button
        type="button"
        className="btn btn-primary"
        style={{ width: '100%' }}
        disabled={busy || caption.trim() === story.caption}
        onClick={() => {
          setBusy(true);
          void updateStoryCaption(story.id, caption.trim())
            .then(() => {
              toast('Caption updated');
              onClose();
            })
            .catch(() => toast('Could not save the caption'))
            .finally(() => setBusy(false));
        }}
      >
        Save
      </button>
      <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={onClose}>
        Cancel
      </button>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

type ActivityLine = { user: UserLite; line: string | null };

/** The author's named list. A viewer with no activity row simply saw it. */
export function activityLines(res: StoryViewsResponse): ActivityLine[] {
  const act = new Map(res.activity.map((a) => [a.user_id, a]));
  return res.viewers.map((user) => {
    const a = act.get(user.id);
    if (!a) return { user, line: null };
    const parts: string[] = [];
    if (a.emoji) parts.push(`Reacted ${a.emoji}`);
    if (a.replied) parts.push('Replied in chat');
    if (a.drew) parts.push('Drew on your canvas');
    return { user, line: parts.join(' · ') || null };
  });
}

export function StoryActivityDrawer({
  story,
  initial,
  onLoaded,
  onClose,
  onShareLink,
  onSharePicture,
  onDraw,
  onDelete,
}: {
  story: Story;
  initial: StoryViewsResponse | null;
  /** The fresher list goes back to the viewer's Viewers pill. */
  onLoaded: (res: StoryViewsResponse) => void;
  onClose: () => void;
  onShareLink: () => void;
  onSharePicture: () => void;
  onDraw: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const [data, setData] = useState<StoryViewsResponse | null>(initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void storyViewers(story.id)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        onLoaded(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // One fetch per story — `initial` only seeds the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id]);
  const lines = data ? activityLines(data) : null;
  return (
    <Shell label="Who saw your story" onClose={onClose}>
      <div className={s.iconRow}>
        <button type="button" className={s.iconBtn} onClick={onShareLink}>
          <span>
            <IcLink />
          </span>
          Link
        </button>
        <button type="button" className={s.iconBtn} onClick={onSharePicture}>
          <span>
            <IcSend />
          </span>
          Send
        </button>
        <button type="button" className={s.iconBtn} onClick={onDraw}>
          <span>
            <IcBrush />
          </span>
          Canvas
        </button>
        <button
          type="button"
          className={`${s.iconBtn} ${s.iconBtnDanger}`}
          onClick={() => {
            void (async () => {
              if (!(await confirmDialog('Delete this story? Views and drawings go with it.', { confirmLabel: 'Delete', danger: true, zIndex: Z }))) return;
              if (await onDelete()) onClose();
            })();
          }}
        >
          <span>
            <IcTrash />
          </span>
          Delete
        </button>
      </div>
      <h2 className={s.sheetTitle}>Who saw it</h2>
      {error && lines === null ? (
        <p className="error-text">Could not load who saw it.</p>
      ) : lines === null ? (
        <p className={s.empty}>
          <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
          Checking…
        </p>
      ) : lines.length === 0 ? (
        <p className={s.empty}>No one yet — stories are a slow burn.</p>
      ) : (
        lines.map(({ user, line }) => (
          <div key={user.id} className={s.who}>
            <Avatar avatar={user.avatar} name={user.display_name} size={38} />
            <span className={s.whoText}>
              <strong>{user.display_name}</strong>
              <span>{line ?? `@${user.username}`}</span>
            </span>
          </div>
        ))
      )}
      {/* No timestamps and no totals by design — a view is a face. */}
    </Shell>
  );
}

// ---------------------------------------------------------------------------

export function StoryFriendMenu({
  story,
  onClose,
  onSharePicture,
  onReport,
}: {
  story: Story;
  onClose: () => void;
  onSharePicture: () => void;
  onReport: () => void;
}) {
  return (
    <Shell label={`More about ${story.author.display_name}’s story`} onClose={onClose}>
      <button type="button" className={s.row} onClick={onSharePicture}>
        <span className={s.rowIcon}>
          <IcShare />
        </span>
        <span className={s.rowText}>Share the picture…</span>
      </button>
      <button type="button" className={`${s.row} ${s.rowDanger}`} onClick={onReport}>
        <span className={s.rowIcon}>
          <IcFlag />
        </span>
        <span className={s.rowText}>Report story</span>
      </button>
    </Shell>
  );
}

function IcSend({ size }: { size?: number }) {
  return (
    <svg width={size ?? 20} height={size ?? 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 11.5 20 4.5l-5 15.5-3.3-6.2L4.5 11.5Z" />
      <path d="M11.7 13.8 20 4.5" />
    </svg>
  );
}
