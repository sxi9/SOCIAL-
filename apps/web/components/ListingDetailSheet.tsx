'use client';

// Listing detail sheet (v0.5b — API.md §1.38/§1.39). Carries the verbatim
// bulletin-board safety note on gig/ride/room (FEATURES #45) and the board's
// one CTA: "Message <author>" → the §1.4 DM with a listing_ref context message.
// Authors get close/delete and, on gigs, the team-up picker (§1.39).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Conversation, ConversationResponse, Listing } from '@socialchat/shared';
import { LISTING_SAFETY_NOTE, LISTING_SAFETY_NOTE_KINDS } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import {
  closeListing,
  contactListing,
  deleteListing,
  expiryLine,
  KIND_EMOJI,
  KIND_LABEL,
} from '@/lib/listings';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import ReportSheet from './ReportSheet';
import Stars from './Stars';
import TeamUpSheet from './TeamUpSheet';
import bz from './beacons.module.css';
import st from './board.module.css';

export default function ListingDetailSheet({
  listing: initial,
  onClose,
  onChanged,
  onDeleted,
}: {
  listing: Listing;
  onClose: () => void;
  /** Close (status flip) — the board list patches its copy. */
  onChanged?: (listing: Listing) => void;
  onDeleted?: (id: string) => void;
}) {
  const state = useAppState();
  const router = useRouter();
  const now = useNow(30_000);
  const [listing, setListing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [teamUpOpen, setTeamUpOpen] = useState(false);

  const mine = state.me?.id === listing.author.id;
  const expired =
    listing.expires_at !== null && new Date(listing.expires_at).getTime() <= now;
  const live = listing.status === 'active' && !expired;
  const showSafetyNote = (LISTING_SAFETY_NOTE_KINDS as readonly string[]).includes(listing.kind);
  const expiry = expiryLine(listing, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function openConversation(conversationId: string): Promise<void> {
    if (!state.conversations.has(conversationId)) {
      try {
        const res = await api.get<{ conversation: Conversation }>(
          `/api/conversations/${conversationId}`
        );
        upsertConversation(res.conversation);
      } catch {
        /* the conv.new frame (or /sync) will carry it */
      }
    }
    router.push(`/c/${conversationId}`);
  }

  /** "Message me" — idempotent: a re-tap lands in the same DM (§1.39). */
  async function message(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Already contacted → the DM with the author exists; reopen it locally
    // rather than re-POSTing (a closed listing 410s new contacts, but the
    // conversation is forever ours).
    if (listing.my_contacted) {
      const existing = [...state.conversations.values()].find(
        (c) =>
          c.type === 'dm' &&
          c.participants.some((p) => p.user.id === listing.author.id && p.left_at === null)
      );
      if (existing) {
        router.push(`/c/${existing.id}`);
        return;
      }
    }
    try {
      const conversationId = await contactListing(listing.id);
      await openConversation(conversationId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'listing_closed') {
        setError('This one just closed — too slow this time.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('This listing is gone.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — contact limit for this hour.');
      } else {
        setError('Could not open a chat — try again.');
      }
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    setMenu(false);
    if (busy) return;
    if (!window.confirm('Close this listing? It leaves the board quietly; your chats stay.')) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await closeListing(listing.id);
      setListing(updated);
      onChanged?.(updated);
    } catch {
      setError('Could not close it — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setMenu(false);
    if (busy) return;
    if (!window.confirm('Delete this listing for good? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteListing(listing.id);
      onDeleted?.(listing.id);
      onClose();
    } catch {
      setError('Could not delete it — try again.');
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
      <div className={bz.sheet} role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[listing.kind]} listing`}>
        <div className={bz.sheetHead}>
          <h2>
            <span aria-hidden>{KIND_EMOJI[listing.kind]}</span> {listing.title}
          </h2>
          <div className={bz.cardRel}>
            <button
              type="button"
              className={bz.cardKebab}
              aria-label="Listing options"
              style={{ position: 'static' }}
              onClick={() => setMenu((v) => !v)}
            >
              ⋯
            </button>
            {menu ? (
              <>
                <button type="button" className={bz.menuBackdrop} aria-label="Close menu" onClick={() => setMenu(false)} />
                <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 30 }}>
                  {mine && listing.status === 'active' ? (
                    <button type="button" role="menuitem" onClick={() => void close()}>
                      Close listing
                    </button>
                  ) : null}
                  {mine ? (
                    <button type="button" role="menuitem" className={bz.menuDanger} onClick={() => void remove()}>
                      Delete listing
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        setReport(true);
                      }}
                    >
                      Report @{listing.author.username}
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </div>
          <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {report ? (
          <ReportSheet target={{ kind: 'user', user_id: listing.author.id }} onClose={() => setReport(false)} />
        ) : null}

        <div className={st.authorRow}>
          <Link href={`/u/${encodeURIComponent(listing.author.username)}`}>
            <Avatar avatar={listing.author.avatar} name={listing.author.display_name} size={36} />
            <span className={st.authorName}>
              <strong>{mine ? 'You' : listing.author.display_name}</strong>
              <span>@{listing.author.username}</span>
            </span>
          </Link>
          <span style={{ flex: 1 }} />
          {!live ? (
            <span className={st.statusTag}>{listing.status === 'closed' ? 'closed' : 'expired'}</span>
          ) : expiry ? (
            <span className={st.lExpiry}>{expiry}</span>
          ) : null}
        </div>

        {listing.kind === 'place_review' ? (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Stars value={listing.details.rating} />
            {/* Fixer r1 (parity with the board card): no doubled place name. */}
            {listing.details.place_name !== listing.title ? <strong>{listing.details.place_name}</strong> : null}
          </div>
        ) : null}

        <dl className={st.detailFacts}>
          {listing.kind === 'gig' ? (
            <>
              <div className={st.factRow}>
                <dt>Looking</dt>
                <dd>{listing.details.direction === 'offering' ? 'Offering work / hire me' : 'Looking for people'}</dd>
              </div>
              {listing.details.tags.length > 0 ? (
                <div className={st.factRow}>
                  <dt>Tags</dt>
                  <dd>
                    <span className={st.tagRow}>
                      {listing.details.tags.map((t) => (
                        <span key={t} className={st.tag}>
                          {t}
                        </span>
                      ))}
                    </span>
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          {listing.kind === 'ride' ? (
            <>
              <div className={st.factRow}>
                <dt>Route</dt>
                <dd>
                  {listing.details.from_text} → {listing.details.to_text}
                </dd>
              </div>
              <div className={st.factRow}>
                <dt>Departs</dt>
                <dd>{new Date(listing.details.departs_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd>
              </div>
              <div className={st.factRow}>
                <dt>Seats</dt>
                <dd>{listing.details.seats}</dd>
              </div>
            </>
          ) : null}
          {listing.kind === 'room' ? (
            <>
              {listing.details.monthly_price_text ? (
                <div className={st.factRow}>
                  <dt>Price</dt>
                  <dd>
                    <span className={st.priceTag}>{listing.details.monthly_price_text}</span>
                  </dd>
                </div>
              ) : null}
              {listing.details.available_from ? (
                <div className={st.factRow}>
                  <dt>From</dt>
                  <dd>{listing.details.available_from}</dd>
                </div>
              ) : null}
            </>
          ) : null}
          {listing.kind !== 'room' && listing.price_text ? (
            <div className={st.factRow}>
              <dt>Price</dt>
              <dd>
                <span className={st.priceTag}>{listing.price_text}</span>
              </dd>
            </div>
          ) : null}
          <div className={st.factRow}>
            <dt>Area</dt>
            <dd>
              {listing.area}
              {listing.is_public ? ' · visible everywhere' : ''}
            </dd>
          </div>
        </dl>

        {listing.photos.length > 0 ? (
          <div className={st.detailPhotos}>
            {listing.photos.map((p) => (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.thumb_url ?? p.url} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        ) : null}

        {listing.body ? <p className={st.detailBody}>{listing.body}</p> : null}

        {showSafetyNote ? (
          <div className={st.safetyNote} role="note">
            <span aria-hidden>🛟</span>
            <span>{LISTING_SAFETY_NOTE}</span>
          </div>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}

        <div className={st.ctaCol}>
          {mine ? (
            <>
              {listing.kind === 'gig' ? (
                listing.conversation_id ? (
                  <button type="button" className={st.msgBtn} onClick={() => void openConversation(listing.conversation_id as string)}>
                    Open the project chat →
                  </button>
                ) : (
                  <button type="button" className={st.msgBtn} disabled={busy} onClick={() => setTeamUpOpen(true)}>
                    Team up 🙌
                  </button>
                )
              ) : null}
              {listing.status === 'active' ? (
                <button type="button" className="btn" disabled={busy} onClick={() => void close()}>
                  Close listing
                </button>
              ) : null}
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            </>
          ) : listing.my_contacted ? (
            <button type="button" className={st.msgBtn} disabled={busy} onClick={() => void message()}>
              {busy ? 'Opening…' : 'Open your chat →'}
            </button>
          ) : live ? (
            <button type="button" className={st.msgBtn} disabled={busy} onClick={() => void message()}>
              {busy ? 'Opening…' : `Message ${listing.author.display_name}`}
            </button>
          ) : (
            <button type="button" className={st.msgBtn} disabled>
              {listing.status === 'closed' ? 'Closed' : 'Expired'}
            </button>
          )}
        </div>

        {teamUpOpen ? (
          <TeamUpSheet
            listing={listing}
            onClose={() => setTeamUpOpen(false)}
            onCreated={(conversationId) => {
              setListing((l) => ({ ...l, conversation_id: conversationId }));
              void openConversation(conversationId);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
