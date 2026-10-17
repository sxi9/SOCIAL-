'use client';

// Profile trust panel (v0.5b — API.md §1.40, ADR-012). The ONE place a number
// attaches to a person, and it is safety information for strangers about
// transacting — not social approval: the average hides under
// TRUST_AVG_MIN_REVIEWS, reviews are named (never anonymous scores), and
// nothing anywhere ranks or sorts people by rating.
import { useState } from 'react';
import Link from 'next/link';
import type { PersonReview, Trust } from '@socialchat/shared';
import { TRUST_AVG_MIN_REVIEWS } from '@socialchat/shared';
import { formatTime } from '@/lib/format';
import { KIND_LABEL, listPersonReviews } from '@/lib/listings';
import Avatar from './Avatar';
import Stars from './Stars';
import st from './board.module.css';

export default function TrustPanel({ username, trust }: { username: string; trust: Trust }) {
  const [expanded, setExpanded] = useState<PersonReview[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No reviews → no panel. An empty trust section would read like a demerit.
  if (trust.review_count === 0) return null;

  const shown = expanded ?? trust.recent;

  async function loadAll(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await listPersonReviews(username, null);
      setExpanded(res.reviews);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load the reviews.');
    } finally {
      setBusy(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (busy || !cursor) return;
    setBusy(true);
    try {
      const res = await listPersonReviews(username, cursor);
      setExpanded((prev) => [...(prev ?? []), ...res.reviews]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>🛟 Marketplace trust</h3>
      <div className={st.trustHead}>
        {trust.avg_rating !== null ? (
          <>
            <span className={st.trustAvg}>{trust.avg_rating.toFixed(1)}</span>
            <Stars value={trust.avg_rating} label={`${trust.avg_rating.toFixed(1)} out of 5 average`} />
          </>
        ) : null}
        <span className={st.trustCount}>
          {trust.review_count} {trust.review_count === 1 ? 'review' : 'reviews'} from board deals
          {trust.avg_rating === null && trust.review_count < TRUST_AVG_MIN_REVIEWS
            ? ` · average shows from ${TRUST_AVG_MIN_REVIEWS}`
            : ''}
        </span>
      </div>

      <div style={{ marginTop: 8 }}>
        {shown.map((r) => (
          <div key={r.id} className={st.reviewRow}>
            <Link href={`/u/${encodeURIComponent(r.reviewer.username)}`}>
              <Avatar avatar={r.reviewer.avatar} name={r.reviewer.display_name} size={30} />
            </Link>
            <div className={st.reviewBody}>
              <div className={st.reviewTop}>
                <strong>{r.reviewer.display_name}</strong>
                <Stars value={r.rating} />
                <span className={st.reviewKind}>
                  {KIND_LABEL[r.listing_kind].toLowerCase()} · {formatTime(r.created_at)}
                </span>
              </div>
              {r.body ? <p className={st.reviewText}>{r.body}</p> : null}
            </div>
          </div>
        ))}
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {expanded === null && trust.review_count > trust.recent.length ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void loadAll()}>
          {busy ? 'Loading…' : 'See all reviews'}
        </button>
      ) : null}
      {expanded !== null && cursor !== null ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void loadMore()}>
          {busy ? 'Loading…' : 'More'}
        </button>
      ) : null}
      <p className="muted small" style={{ margin: '8px 0 0' }}>
        Reviews come only from people who dealt with {`@${username}`} through a board listing.
      </p>
    </div>
  );
}
