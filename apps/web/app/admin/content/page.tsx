'use client';

// Admin content moderation tab (v0.8b — API.md §1.69 #81a). PUBLIC surfaces
// ONLY: public posts, public beacons, board listings — things any member can
// already read, so excerpts here cross no privacy line. Private chats and
// friends-only content are structurally unrepresentable in this endpoint.
// Takedown requires a reason; the author gets ONE neutral Support-conversation
// notice and the action is ring-logged.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminContentRow, AdminContentType } from '@socialchat/shared';
import { TAKEDOWN_REASON_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { adminContent, adminTakedown } from '@/lib/admin';
import { formatTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import ad from '@/components/admin.module.css';

const TYPE_EMOJI: Record<AdminContentType, string> = { post: '📝', beacon: '🔥', listing: '📋' };

export default function AdminContentPage() {
  const [type, setType] = useState<AdminContentType | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState(''); // submitted search
  const [items, setItems] = useState<AdminContentRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = (fetchSeq.current += 1);
    setError(null);
    try {
      const res = await adminContent(type, query, null);
      if (fetchSeq.current !== seq) return;
      setItems(res.items);
      setCursor(res.next_cursor);
    } catch {
      if (fetchSeq.current === seq) setError('Could not load public content.');
    }
  }, [type, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function more(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await adminContent(type, query, cursor);
      setItems((prev) => [...(prev ?? []), ...res.items]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    }
  }

  return (
    <div>
      <h2>Public content</h2>
      <p className={ad.note}>
        Everything here is PUBLIC already — public posts, public beacons and board listings.
        Private chats never appear anywhere in admin; moderation of private content goes through
        reports, where the reporter consented. Takedowns notify the author neutrally (never a named
        admin) and are logged.
      </p>
      <div className={ad.levelChips} role="radiogroup" aria-label="Type filter">
        {(
          [
            { v: null, label: 'All' },
            { v: 'post', label: 'Posts' },
            { v: 'beacon', label: 'Beacons' },
            { v: 'listing', label: 'Listings' },
          ] as const
        ).map((f) => (
          <button
            key={f.label}
            type="button"
            role="radio"
            aria-checked={type === f.v}
            className={`btn${type === f.v ? ' btn-primary' : ''}`}
            onClick={() => setType(f.v)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <form
        style={{ display: 'flex', gap: 8, margin: '10px 0' }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input
          className="input"
          style={{ flex: 1, fontSize: 16 }}
          placeholder="Search title & body…"
          aria-label="Search public content"
          value={q}
          maxLength={80}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {error ? <p className="error-text">{error}</p> : null}

      {items === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="muted small">Nothing public matches.</p>
      ) : (
        <>
          {items.map((row) => (
            <ContentRow
              key={`${row.type}:${row.id}`}
              row={row}
              onRemoved={() =>
                setItems((prev) => (prev ? prev.filter((x) => !(x.type === row.type && x.id === row.id)) : prev))
              }
            />
          ))}
          {cursor !== null ? (
            <button type="button" className="btn" onClick={() => void more()}>
              Load more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ContentRow({ row, onRemoved }: { row: AdminContentRow; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function takedown(): Promise<void> {
    const text = reason.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminTakedown(row.type, row.id, text);
      toast('Removed — the author got a neutral notice');
      onRemoved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_admin_target') {
        setError("That's an admin's own content — demote them first (the §1.41 rule).");
      } else if (err instanceof ApiError && err.status === 404) {
        setError('Already gone.');
      } else {
        setError('Could not remove it.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={ad.reportCard}>
      <div className={ad.reportHead}>
        <span className={ad.flag}>
          {TYPE_EMOJI[row.type]} {row.type}
        </span>
        <span className={ad.flag}>{row.status}</span>
        <span>
          by{' '}
          {row.author ? (
            <strong>@{row.author.username}</strong>
          ) : (
            <span className={ad.dim}>account deleted</span>
          )}
        </span>
        <span className={ad.dim}>{formatTime(row.created_at)}</span>
      </div>
      <p className={ad.reportReason}>
        {row.title ? <strong>{row.title} — </strong> : null}
        {row.excerpt || <span className={ad.dim}>no text</span>}
      </p>
      {asking ? (
        <div className={ad.closeRow}>
          <input
            className="input"
            placeholder="Reason (required — the author sees it)"
            value={reason}
            maxLength={TAKEDOWN_REASON_MAX_CHARS}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          <button type="button" className="btn" disabled={busy} onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => void takedown()}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ) : (
        <div className={ad.closeRow}>
          <button type="button" className="btn btn-danger" onClick={() => setAsking(true)}>
            Remove with reason…
          </button>
        </div>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </article>
  );
}
