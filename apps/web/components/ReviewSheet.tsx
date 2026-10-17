'use client';

// Person-review compose sheet (v0.5b — API.md §1.40, ADR-012). Gated server-
// side on a real listing contact; one review per (listing, reviewer). The copy
// frames it as what it is — safety information for the next stranger — and
// the subject is never pinged about it (PSYCHOLOGY rule 4: they find it on
// their own profile).
import { useEffect, useState } from 'react';
import type { ListingRef, UserLite } from '@socialchat/shared';
import { PERSON_REVIEW_BODY_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { createPersonReview, KIND_EMOJI, markReviewNudgeDone } from '@/lib/listings';
import Avatar from './Avatar';
import { StarPicker } from './Stars';
import bz from './beacons.module.css';
import st from './board.module.css';

export default function ReviewSheet({
  listingRef,
  subject,
  iAmAuthor,
  onClose,
  onDone,
}: {
  /** The listing that brokered the transaction (snapshot — may be gone). */
  listingRef: ListingRef;
  /** The counterparty being reviewed. */
  subject: UserLite;
  /** True when I authored the listing — subject_id must then be sent (§1.40). */
  iAmAuthor: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (rating === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createPersonReview(listingRef.listing_id, {
        subject_id: iAmAuthor ? subject.id : undefined,
        rating,
        body: body.trim(),
      });
      markReviewNudgeDone(listingRef.listing_id);
      onDone?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'review_exists') {
        setError('You already reviewed this one — one review per listing.');
        markReviewNudgeDone(listingRef.listing_id);
      } else if (err instanceof ApiError && err.code === 'review_not_eligible') {
        setError('Reviews open up after a real contact through the listing.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('That listing is gone, so this review window closed with it.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — review limit for this hour.');
      } else {
        setError('Could not save the review — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div
      className={`${bz.sheetBackdrop} ${bz.beaconVars}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bz.sheet} role="dialog" aria-modal="true" aria-label={`Review ${subject.display_name}`}>
        <div className={bz.sheetHead}>
          <h2>How did it go?</h2>
          <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className={st.authorRow} style={{ marginTop: 4 }}>
          <Avatar avatar={subject.avatar} name={subject.display_name} size={36} />
          <span className={st.authorName}>
            <strong>{subject.display_name}</strong>
            <span>
              {KIND_EMOJI[listingRef.kind]} {listingRef.title}
            </span>
          </span>
        </div>

        <div className={bz.sheetLabel}>Your rating</div>
        <StarPicker value={rating} onChange={setRating} />

        <div className={bz.sheetLabel}>Anything the next person should know?</div>
        <textarea
          className="input"
          rows={3}
          placeholder="optional — “showed up on time, easy to deal with”"
          value={body}
          maxLength={PERSON_REVIEW_BODY_MAX_CHARS}
          onChange={(e) => setBody(e.target.value)}
        />

        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className={st.msgBtn}
          style={{ marginTop: 10 }}
          disabled={rating === null || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Save review'}
        </button>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Shows on their profile as safety info for the next person. They won&rsquo;t get a
          notification, and you can only do this once per listing.
        </p>
      </div>
    </div>
  );
}
