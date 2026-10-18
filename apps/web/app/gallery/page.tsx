'use client';

// "My gallery" (v1.0a — #94, API.md §1.75-ish, SPECS §v1.0a): a PRIVATE grid
// of my own media — everything I ever sent/posted plus story auto-saves.
// Tap → the #93 pinch-zoom viewer. Saved items (story auto-saves) carry a
// delete; bound media is deleted where it lives, never here.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { GalleryItem, GalleryResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import MediaLightbox from '@/components/MediaLightbox';
import TabPage from '@/components/TabPage';

type Filter = 'all' | 'image' | 'video' | 'saved';

// v2 Royal (proto 41): plain-word chips — no emoji as UI icons.
const CHIPS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'image', label: 'Photos' },
  { key: 'video', label: 'Videos' },
  { key: 'saved', label: 'Saved stories' },
];

export default function GalleryPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<GalleryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean, cur: string | null): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (filter === 'image' || filter === 'video') qs.set('kind', filter);
        if (filter === 'saved') qs.set('saved', '1');
        if (cur) qs.set('cursor', cur);
        const res = await api.get<GalleryResponse>(`/api/users/me/gallery?${qs.toString()}`);
        setItems((prev) => (reset || prev === null ? res.items : [...prev, ...res.items]));
        setCursor(res.next_cursor);
      } catch {
        setError('Could not load your gallery — try again.');
      } finally {
        setBusy(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    setItems(null);
    setCursor(null);
    void load(true, null);
  }, [load]);

  async function removeSave(item: GalleryItem): Promise<void> {
    setItems((prev) => (prev ? prev.filter((i) => i.attachment.id !== item.attachment.id) : prev));
    try {
      await api.del(`/api/users/me/gallery/${item.attachment.id}`);
    } catch {
      /* idempotent; worst case it reappears on the next load */
    }
  }

  return (
    <TabPage active="profile">
      <div className="page">
        <header className="topbar">
          <Link href="/settings/profile" className="btn btn-ghost btn-icon" aria-label="Back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M14.5 5.5 8 12l6.5 6.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <h1 style={{ fontSize: 20 }}>My gallery</h1>
        </header>
        <div className="settings-section" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }} role="group" aria-label="Filter gallery">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`btn${filter === c.key ? ' btn-primary' : ''}`}
                style={{ padding: '7px 13px', fontSize: 13 }}
                aria-pressed={filter === c.key}
                onClick={() => setFilter(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          {items === null ? (
            <p className="muted small" role="status">
              Loading your gallery…
            </p>
          ) : items.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0 }}>Nothing here yet.</p>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                Photos and videos you send, post or put on the board collect here — and{' '}
                <Link href="/feed">stories</Link> save themselves when they expire.
              </p>
            </div>
          ) : (
            // proto 41: a straight 3-across grid, tight gap.
            <div className="galleryGrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {items.map((item) => (
                <span key={item.attachment.id} className="galleryCell">
                  <button
                    type="button"
                    className="galleryTap"
                    aria-label={item.attachment.kind === 'video' ? 'Play video' : 'View photo'}
                    onClick={() => setZoom(item)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.attachment.thumb_url ?? item.attachment.url} alt="" loading="lazy" />
                    {item.attachment.kind === 'video' ? (
                      <span className="galleryBadge" aria-hidden>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8.5 5.8 18.2 12 8.5 18.2 Z" />
                        </svg>
                      </span>
                    ) : null}
                    {item.saved ? (
                      // proto 41: the saved-story star badge.
                      <span className="galleryBadge galleryBadgeLeft" aria-hidden title="Saved story">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M12 4.2 l2.3 4.7 5.2 0.75 -3.75 3.66 0.88 5.15 L12 16 l-4.63 2.46 0.88 -5.15 L4.5 9.65 l5.2 -0.75 Z"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                  {item.saved ? (
                    <button
                      type="button"
                      className="galleryDelete"
                      aria-label="Delete from gallery"
                      onClick={() => void removeSave(item)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="M5 7 h14 M10 7 V5.2 a1 1 0 0 1 1 -1 h2 a1 1 0 0 1 1 1 V7 M7.5 7 l0.8 12 a1.4 1.4 0 0 0 1.4 1.3 h4.6 a1.4 1.4 0 0 0 1.4 -1.3 L16.5 7 M10.2 10.5 v6 M13.8 10.5 v6"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          )}
          {cursor ? (
            <button
              type="button"
              className="btn"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() => void load(false, cursor)}
            >
              {busy ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
          <p className="muted small" style={{ margin: '12px 0 0' }}>
            Everything you’ve shared, in one private place — only you see this. Stories land here
            automatically when they expire.
          </p>
        </div>
      </div>
      {zoom ? (
        zoom.attachment.kind === 'video' ? (
          <VideoLightbox url={zoom.attachment.url} onClose={() => setZoom(null)} />
        ) : (
          <MediaLightbox
            src={zoom.attachment.url}
            alt={zoom.attachment.file_name ?? 'Photo'}
            onClose={() => setZoom(null)}
          />
        )
      ) : null}
    </TabPage>
  );
}

/** Minimal full-screen video player for gallery videos. */
function VideoLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="galleryVideoBackdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Video"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src={url} controls autoPlay playsInline />
      <button type="button" className="galleryVideoClose" aria-label="Close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
