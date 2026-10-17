'use client';

// The Feed tab (v0.5a — API.md §1.36, PSYCHOLOGY design rule 5). FINITE by
// construction: keyset pages to a hard "all caught up" end card and STOPS.
// No pull-to-refresh and no infinite loop — refreshing is an explicit, labeled
// tap (slot-machine mechanics are on the never-build list); new posts also
// arrive live via post.new. Reactions render FACES, never counts; comments
// have no counter; nothing here pings anyone (viewers reconcile by looking).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Attachment, Post, PostComment, UploadResponse } from '@socialchat/shared';
import {
  POST_BODY_MAX_CHARS,
  POST_COMMENT_MAX_CHARS,
  POST_MAX_ATTACHMENTS,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { QUICK_REACTIONS } from '@/lib/emoji';
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  listComments,
  loadMoreFeed,
  refetchPost,
  refreshFeed,
  togglePostReaction,
} from '@/lib/feed';
import { formatTime } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import bz from './beacons.module.css';
import st from './social.module.css';

export default function FeedView() {
  const state = useAppState();
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);

  const posts = state.feedPosts;

  useEffect(() => {
    if (state.feedPosts === null && state.authed === true) {
      setLoading(true);
      void refreshFeed()
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }
  }, [state.feedPosts, state.authed]);

  const refresh = useCallback(() => {
    setLoading(true);
    void refreshFeed()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const more = useCallback(() => {
    setMoreBusy(true);
    void loadMoreFeed()
      .catch(() => undefined)
      .finally(() => setMoreBusy(false));
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Feed</h1>
        <button type="button" className="btn btn-ghost" onClick={refresh} disabled={loading}>
          {loading ? 'Checking…' : 'Check for new posts'}
        </button>
      </header>
      <div className={st.feedWrap}>
        <PostComposerCard />
        {posts === null ? (
          <p className="muted small" style={{ textAlign: 'center' }}>
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Loading your people…
          </p>
        ) : posts.length === 0 ? (
          <div className={st.endCard}>
            <span className={st.endEmoji} aria-hidden>
              🫧
            </span>
            <h3>Nothing here yet</h3>
            <p>
              Posts from your friends land here — connect with people from their{' '}
              <Link href="/connections">profiles</Link>, or post something first.
            </p>
          </div>
        ) : (
          <>
            {posts.map((post) => (
              <PostCard key={post.id} post={post} meId={state.me?.id ?? ''} />
            ))}
            {state.feedCursor !== null ? (
              <button type="button" className={st.refreshPill} onClick={more} disabled={moreBusy}>
                {moreBusy ? 'Loading…' : 'Show older posts'}
              </button>
            ) : null}
            {state.feedCaughtUp ? (
              // The HARD end. No wraparound, no "keep scrolling" — a visit has
              // a bottom, and this is it (PSYCHOLOGY rule 5).
              <div className={st.endCard} role="status">
                <span className={st.endEmoji} aria-hidden>
                  🎉
                </span>
                <h3>You&rsquo;re all caught up</h3>
                <p>That&rsquo;s everything from your people. Go make something worth posting.</p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PostComposerCard() {
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function upload(files: FileList | null): Promise<void> {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      if (attachments.length + uploading >= POST_MAX_ATTACHMENTS) {
        setError(`Up to ${POST_MAX_ATTACHMENTS} images per post.`);
        break;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await api.postForm<UploadResponse>('/api/uploads', form);
        setAttachments((prev) =>
          prev.length < POST_MAX_ATTACHMENTS ? [...prev, res.attachment] : prev
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) setError(`${file.name} is too large.`);
        else if (err instanceof ApiError && err.status === 415) setError(`${file.name}: unsupported type.`);
        else setError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function post(): Promise<void> {
    const trimmed = body.trim();
    if (busy || uploading > 0 || (!trimmed && attachments.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      await createPost(trimmed, attachments.map((a) => a.id));
      setBody('');
      setAttachments([]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Easy there — posting limit for this hour.');
      else setError('Could not post — try again.');
    } finally {
      setBusy(false);
    }
  }

  const canPost = !busy && uploading === 0 && (body.trim().length > 0 || attachments.length > 0);

  return (
    <div className={st.composerCard}>
      <textarea
        value={body}
        maxLength={POST_BODY_MAX_CHARS}
        placeholder="What's up? Your friends will see it."
        aria-label="Write a post"
        onChange={(e) => setBody(e.target.value)}
      />
      {attachments.length > 0 ? (
        <div className={`${st.postImages} ${st[`postImages${Math.min(attachments.length, 4)}`]}`} style={{ marginTop: 8 }}>
          {attachments.map((a) => (
            <span key={a.id} style={{ position: 'relative' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.thumb_url ?? a.url} alt="" />
              <button
                type="button"
                className={st.gifToolBtn}
                style={{ position: 'absolute', top: 4, right: 4 }}
                aria-label="Remove image"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className={st.composerFoot}>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept="image/*,video/mp4,video/webm"
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Add images"
          disabled={attachments.length >= POST_MAX_ATTACHMENTS || uploading > 0}
          onClick={() => fileRef.current?.click()}
        >
          📷
        </button>
        {uploading > 0 ? <span className="spinner" /> : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" disabled={!canPost} onClick={() => void post()}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PostCard({ post, meId }: { post: Post; meId: string }) {
  const own = post.author.id === meId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function react(emoji: string): Promise<void> {
    setPickerOpen(false);
    setError(null);
    const chip = post.reactions.find((r) => r.emoji === emoji);
    try {
      await togglePostReaction(post, emoji, chip?.mine ?? false);
    } catch {
      setError('Reaction limit reached (8 per post).');
    }
  }

  async function remove(): Promise<void> {
    setMenuOpen(false);
    if (!window.confirm('Delete this post? Comments and reactions go with it.')) return;
    try {
      await deletePost(post.id);
    } catch {
      setError('Could not delete the post.');
    }
  }

  return (
    <article className={st.postCard}>
      <div className={st.postHead}>
        <Link href={`/u/${encodeURIComponent(post.author.username)}`}>
          <Avatar avatar={post.author.avatar} name={post.author.display_name} size={38} />
        </Link>
        <span className={st.postHeadName}>
          <strong>{post.author.display_name}</strong>
          <span>
            @{post.author.username} · {formatTime(post.created_at)}
          </span>
        </span>
        {own ? (
          <span className={bz.cardRel}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Post options"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen ? (
              <>
                <button type="button" className={bz.menuBackdrop} aria-label="Close menu" onClick={() => setMenuOpen(false)} />
                <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 34 }}>
                  <button type="button" role="menuitem" className={bz.menuDanger} onClick={() => void remove()}>
                    Delete post
                  </button>
                </div>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {post.body ? <p className={st.postBody}>{post.body}</p> : null}
      {post.attachments.length > 0 ? (
        <div className={`${st.postImages} ${st[`postImages${Math.min(post.attachments.length, 4)}`]}`}>
          {post.attachments.map((a) =>
            a.kind === 'video' && a.status === 'ready' ? (
              <video key={a.id} src={a.url} poster={a.thumb_url ?? undefined} controls playsInline preload="metadata" />
            ) : (
              <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.thumb_url ?? a.url} alt="" loading="lazy" />
              </a>
            )
          )}
        </div>
      ) : null}

      {/* FACES, never counts: first reactors as an avatar pile + "…" for more. */}
      <div className={st.postReactRow}>
        {post.reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            className={`${st.faceChip}${r.mine ? ` ${st.faceChipMine}` : ''}`}
            aria-label={`${r.emoji} — ${r.reactors.map((u) => u.display_name).join(', ')}${r.has_more ? ' and more' : ''}${r.mine ? '. You reacted — tap to remove' : '. Tap to react too'}`}
            onClick={() => void react(r.emoji)}
          >
            <span aria-hidden>{r.emoji}</span>
            <span className={st.facePile} aria-hidden>
              {r.reactors.slice(0, 5).map((u) => (
                <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={20} />
              ))}
            </span>
            {r.has_more ? (
              <span className={st.faceMore} aria-hidden>
                &amp; more
              </span>
            ) : null}
          </button>
        ))}
        <span className={bz.cardRel}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="React to this post"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <span aria-hidden>🙂+</span>
          </button>
        </span>
        {pickerOpen ? (
          <>
            <button type="button" className={bz.menuBackdrop} aria-label="Close picker" onClick={() => setPickerOpen(false)} />
            {/* Anchored to the reaction ROW (position:relative), not the tiny
                .cardRel span: the row is as wide as the card, so left:0 +
                bottom:100% always lands inside the viewport. The inline style
                overrides .cardMenu's default top/right anchor — setting all
                four would over-constrain the box and collapse it (v0.6.1). */}
            <div
              className={bz.cardMenu}
              role="menu"
              aria-label="React to this post"
              style={{ left: 0, right: 'auto', top: 'auto', bottom: 'calc(100% + 4px)', display: 'flex', flexWrap: 'wrap', maxWidth: '100%' }}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  // .cardMenu buttons are block/full-width list rows; emoji sit in a compact row
                  style={{ fontSize: 19, width: 'auto', padding: '9px 10px' }}
                  onClick={() => void react(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      <PostComments post={post} meId={meId} />
    </article>
  );
}

// ---------------------------------------------------------------------------

function PostComments({ post, meId }: { post: Post; meId: string }) {
  // Inline: the DTO's latest 3 (ASC) until expanded, then the full paged list.
  const [expanded, setExpanded] = useState<PostComment[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = expanded ?? post.comments;

  async function expand(): Promise<void> {
    try {
      const res = await listComments(post.id, null);
      setExpanded(res.comments);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load comments.');
    }
  }

  async function moreExpanded(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await listComments(post.id, cursor);
      setExpanded((prev) => [...(prev ?? []), ...res.comments]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more comments.');
    }
  }

  async function submit(): Promise<void> {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const comment = await addComment(post.id, body);
      setDraft('');
      if (expanded) setExpanded([...expanded, comment]);
      else await refetchPost(post.id);
    } catch {
      setError('Could not comment — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(comment: PostComment): Promise<void> {
    try {
      await deleteComment(post.id, comment.id);
      if (expanded) setExpanded(expanded.filter((c) => c.id !== comment.id));
      else await refetchPost(post.id);
    } catch {
      setError('Could not delete that comment.');
    }
  }

  return (
    <div>
      {shown.map((c) => (
        <div key={c.id} className={st.commentRow}>
          <Avatar avatar={c.author.avatar} name={c.author.display_name} size={26} />
          <span className={st.commentBubble}>
            <strong>{c.author.display_name}</strong>
            <p>{c.body}</p>
          </span>
          {c.author.id === meId || post.author.id === meId ? (
            <button
              type="button"
              className={st.commentDelete}
              aria-label="Delete comment"
              onClick={() => void removeComment(c)}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      {expanded === null && post.has_more_comments ? (
        <button type="button" className={st.moreComments} onClick={() => void expand()}>
          See earlier comments
        </button>
      ) : null}
      {expanded !== null && cursor !== null ? (
        <button type="button" className={st.moreComments} onClick={() => void moreExpanded()}>
          More comments
        </button>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className={st.commentInputRow}>
        <input
          value={draft}
          maxLength={POST_COMMENT_MAX_CHARS}
          placeholder="Say something back…"
          aria-label="Write a comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={() => void submit()}>
          Reply
        </button>
      </div>
    </div>
  );
}
