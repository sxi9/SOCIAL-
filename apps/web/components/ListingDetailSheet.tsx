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
import { formatTime } from '@/lib/format';
import {
  closeListing,
  contactListing,
  deleteListing,
  expiryLine,
  KIND_LABEL,
} from '@/lib/listings';
import { copyShareLink } from '@/lib/share';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import MediaLightbox from './MediaLightbox';
import ListingEditSheet from './ListingEditSheet';
import { LocationChip } from './LocationPicker';
import Portal from './Portal';
import ReportSheet from './ReportSheet';
import Stars from './Stars';
import TeamUpSheet from './TeamUpSheet';
import bz from './beacons.module.css';
import st from './board.module.css';
import { confirmDialog } from '@/lib/confirm';

/** Originals every mainstream browser decodes (pre-HEIC-fix uploads aren't). */
const BROWSER_SAFE_IMAGE = /^image\/(jpeg|png|webp|gif)$/i;

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
  const [zoomPhoto, setZoomPhoto] = useState<string | null>(null); // v1.0a #93
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [teamUpOpen, setTeamUpOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Photos uploaded before the HEIC fix have thumb_url null and an original
  // most browsers can't decode. Render a tile only when we have a worker thumb
  // or a browser-safe original, and onError-hide any that still fail to load —
  // a broken "?" glyph never ships. All filtered out → no photo strip at all.
  const [badPhotos, setBadPhotos] = useState<Set<string>>(new Set());
  const photos = listing.photos.filter(
    (p) =>
      !badPhotos.has(p.id) &&
      (p.thumb_url !== null || BROWSER_SAFE_IMAGE.test(p.mime))
  );

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
    if (!(await confirmDialog('Close this listing? It leaves the board quietly; your chats stay.'))) return;
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
    if (!(await confirmDialog('Delete this listing for good? This cannot be undone.'))) return;
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

  // Royal v2 (ref 37): the first good photo becomes the full-bleed header;
  // the rest keep the grid below.
  const hero = photos[0] ?? null;
  const gridPhotos = hero ? photos.slice(1) : photos;

  const listingMenu = (
    <>
      <button type="button" className={bz.menuBackdrop} aria-label="Close menu" onClick={() => setMenu(false)} />
      <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 40 }}>
        {mine && listing.status === 'active' ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setEditOpen(true);
            }}
          >
            Edit listing
          </button>
        ) : null}
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
  );

  return (
    // v0.6.1 rule: every sheet renders through Portal into <body>.
    <Portal>
    <div
      className={`${bz.sheetBackdrop} ${bz.beaconVars}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bz.sheet} role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[listing.kind]} listing`}>
        {hero ? (
          // Royal v2 (ref 37): full-bleed photo header when photos exist;
          // back + ··· float on the photo, the tag + serif title sit below.
          <div className={st.heroWrap}>
            <button
              type="button"
              aria-label="View photo full screen"
              onClick={() =>
                setZoomPhoto(BROWSER_SAFE_IMAGE.test(hero.mime) ? hero.url : (hero.thumb_url ?? hero.url))
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={hero.thumb_url ?? hero.url}
                alt=""
                onError={() => setBadPhotos((prev) => new Set(prev).add(hero.id))}
              />
            </button>
            <div className={st.heroTop}>
              <button type="button" className={st.heroBtn} aria-label="Close" onClick={onClose}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M14.5 5.5 L8 12 L14.5 18.5"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <div className={bz.cardRel}>
                <button
                  type="button"
                  className={st.heroBtn}
                  aria-label="Listing options"
                  onClick={() => setMenu((v) => !v)}
                >
                  ⋯
                </button>
                {menu ? listingMenu : null}
              </div>
            </div>
          </div>
        ) : (
          <div className={bz.sheetHead}>
            <h2>{listing.title}</h2>
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
              {menu ? listingMenu : null}
            </div>
            <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        )}
        {report ? (
          <ReportSheet target={{ kind: 'user', user_id: listing.author.id }} onClose={() => setReport(false)} />
        ) : null}

        {/* Royal v2 (ref 37): "RIDE · 2 SEATS" letterspaced tag + serif title. */}
        <span className={st.detailTag}>
          {KIND_LABEL[listing.kind]}
          {listing.kind === 'ride'
            ? ` · ${listing.details.seats} ${listing.details.seats === 1 ? 'seat' : 'seats'}`
            : ''}
        </span>
        {hero ? <h2 className={st.detailTitle}>{listing.title}</h2> : null}

        <div className={st.authorRow}>
          <Link href={`/u/${encodeURIComponent(listing.author.username)}`}>
            <Avatar avatar={listing.author.avatar} name={listing.author.display_name} size={40} />
            <span className={st.authorName}>
              <strong>{mine ? 'You' : listing.author.display_name}</strong>
              <span>
                {listing.area} · listed {formatTime(listing.created_at)}
                {live && expiry ? ` · ${expiry}` : ''}
              </span>
            </span>
          </Link>
          <span style={{ flex: 1 }} />
          {!live ? (
            <span className={st.statusTag}>{listing.status === 'closed' ? 'closed' : 'expired'}</span>
          ) : !mine ? (
            <Link href={`/u/${encodeURIComponent(listing.author.username)}`} className={st.profilePill}>
              Profile
            </Link>
          ) : null}
        </div>

        {listing.kind === 'place_review' ? (
          // Royal v2 (ref 40): the big serif rating + silver stars.
          <div className={st.ratingRow}>
            <span className={st.ratingNum}>{listing.details.rating}</span>
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
          {/* v0.7 §1.52: the place chip — a LINK out, never a tile embed. */}
          {listing.location ? (
            <div className={st.factRow}>
              <dt>Place</dt>
              <dd>
                <LocationChip location={listing.location} />
              </dd>
            </div>
          ) : null}
          {listing.edited_at ? (
            <div className={st.factRow}>
              <dt>Edited</dt>
              <dd className="muted">{new Date(listing.edited_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd>
            </div>
          ) : null}
        </dl>

        {gridPhotos.length > 0 ? (
          <div className={st.detailPhotos}>
            {gridPhotos.map((p) => (
              /* v1.0a (#93): tap opens the pinch-zoom viewer — on the best
                 source the browser can actually decode. */
              <button
                key={p.id}
                type="button"
                className="avatarZoomTap"
                aria-label="View photo full screen"
                onClick={() =>
                  setZoomPhoto(BROWSER_SAFE_IMAGE.test(p.mime) ? p.url : (p.thumb_url ?? p.url))
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.thumb_url ?? p.url}
                  alt=""
                  loading="lazy"
                  onError={() => setBadPhotos((prev) => new Set(prev).add(p.id))}
                />
              </button>
            ))}
          </div>
        ) : null}
        {zoomPhoto !== null ? (
          <MediaLightbox src={zoomPhoto} alt="Listing photo" onClose={() => setZoomPhoto(null)} />
        ) : null}

        {/* Gated on real content — a whitespace-only body never renders a
            stray empty block above the safety note. */}
        {listing.body && listing.body.trim() !== '' ? (
          <p className={st.detailBody}>{listing.body}</p>
        ) : null}

        {showSafetyNote ? (
          <div className={st.safetyNote} role="note">
            <span>{LISTING_SAFETY_NOTE}</span>
          </div>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}

        {/* v0.8b §1.67: PUBLIC listings get the one stable share link —
            area-only listings never get a URL. */}
        {listing.is_public && live ? (
          <button
            type="button"
            className="btn"
            style={{ width: '100%', margin: '8px 0' }}
            onClick={() => void copyShareLink('listing', listing.id)}
          >
            Copy a public link
          </button>
        ) : null}

        <div className={st.ctaCol}>
          {mine ? (
            <>
              {listing.status === 'active' ? (
                <button type="button" className="btn" disabled={busy} onClick={() => setEditOpen(true)}>
                  Edit listing
                </button>
              ) : null}
              {listing.kind === 'gig' ? (
                listing.conversation_id ? (
                  <button type="button" className={st.msgBtn} onClick={() => void openConversation(listing.conversation_id as string)}>
                    Open the project chat →
                  </button>
                ) : (
                  // Royal v2 (ref 37): the team-up entry card into the picker.
                  <button type="button" className={st.teamUpEntry} disabled={busy} onClick={() => setTeamUpOpen(true)}>
                    <span className={st.teamUpText}>
                      <strong>Team up</strong>
                      <span>pick people who messaged — you all land in a project chat</span>
                    </span>
                    <span className={st.teamUpChev} aria-hidden>
                      ›
                    </span>
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
        {editOpen ? (
          <ListingEditSheet
            listing={listing}
            onClose={() => setEditOpen(false)}
            onSaved={(updated) => {
              setListing(updated);
              onChanged?.(updated);
            }}
          />
        ) : null}
      </div>
    </div>
    </Portal>
  );
}
