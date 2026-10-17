'use client';

// One-time review nudge in listing DMs (v0.5b — API.md §1.40 UI). After a
// 'listing_contact' DM, once the listing has closed or expired, ask ONCE —
// quietly, inline, dismissible — whether the other party deserves a review.
// Client-side courtesy only: the server never pushes anything about reviews
// (PSYCHOLOGY rule 4), and "not now" is remembered per device, forever.
import { useEffect, useState } from 'react';
import type { ConversationListItem, ListingRef, Message, UserLite } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { getListing, KIND_EMOJI, markReviewNudgeDone, reviewNudgeDone } from '@/lib/listings';
import ReviewSheet from './ReviewSheet';
import st from './board.module.css';

export default function ListingReviewNudge({
  conv,
  messages,
  meId,
}: {
  conv: ConversationListItem;
  messages: Message[];
  meId: string;
}) {
  const [prompt, setPrompt] = useState<{ ref: ListingRef; iAmAuthor: boolean } | null>(null);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // The newest listing-contact context message in this DM (team-up kickoffs
  // live in groups and never nudge — the crew already talked).
  const ref =
    conv.type === 'dm'
      ? [...messages]
          .reverse()
          .find((m) => m.type === 'system' && m.metadata.system?.event === 'listing_contact' && m.metadata.listing_ref)
          ?.metadata.listing_ref ?? null
      : null;
  const listingId = ref?.listing_id ?? null;

  useEffect(() => {
    if (!listingId || !ref) return;
    if (reviewNudgeDone(listingId)) return;
    let cancelled = false;
    void getListing(listingId)
      .then((listing) => {
        if (cancelled) return;
        const expired =
          listing.expires_at !== null && new Date(listing.expires_at).getTime() <= Date.now();
        // Gentle by design: nothing shows while the listing is still live.
        if (listing.status !== 'active' || expired) {
          setPrompt({ ref, iAmAuthor: listing.author.id === meId });
        }
      })
      .catch((err) => {
        // Deleted listing = the review gate is gone with it; never ask.
        if (!cancelled && err instanceof ApiError && err.status === 404) {
          markReviewNudgeDone(listingId);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, meId]);

  if (!prompt || dismissed) return null;

  const peer: UserLite | null = (() => {
    const p = conv.participants.find((x) => x.user.id !== meId && x.left_at === null);
    if (!p) return null;
    const { id, username, display_name, avatar, mood, name_style } = p.user;
    return { id, username, display_name, avatar, mood, name_style, mask_emoji: null };
  })();
  if (!peer) return null;

  return (
    <>
      <div className={st.nudge} role="note">
        <p>
          {KIND_EMOJI[prompt.ref.kind]} “{prompt.ref.title}” has wrapped up. If something actually
          happened with {peer.display_name}, a review helps the next stranger judge — no pressure.
        </p>
        <div className={st.nudgeActions}>
          <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
            Leave a review
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              markReviewNudgeDone(prompt.ref.listing_id);
              setDismissed(true);
            }}
          >
            No thanks
          </button>
        </div>
      </div>
      {composing ? (
        <ReviewSheet
          listingRef={prompt.ref}
          subject={peer}
          iAmAuthor={prompt.iAmAuthor}
          onClose={() => setComposing(false)}
          onDone={() => setDismissed(true)}
        />
      ) : null}
    </>
  );
}
