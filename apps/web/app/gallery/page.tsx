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

const CHIPS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'image', label: '📷 Photos' },
  { key: 'video', label: '🎞 Videos' },
  { key: 'saved', label: '⭐ Saved stories' },
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
        <div className="settings-section">
          <h1 style={{ margin: 0 }}>My gallery</h1>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>
            Everything you’ve shared, in one private place — only you see this. Stories land here
            automatically when they expire.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }} role="group" aria-label="Filter gallery">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`btn${filter === c.key ? ' btn-primary' : ''}`}
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
            <div className="galleryGrid">
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
                        ▶
                      </span>
                    ) : null}
                    {item.saved ? (
                      <span className="galleryBadge galleryBadgeLeft" aria-hidden title="Saved story">
                        ⭐
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
                      🗑
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
