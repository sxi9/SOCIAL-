'use client';

// Post-to-the-board sheet (v0.5b — API.md §1.38). Kind picker → per-kind form.
// Prices are display text only — the form says so out loud; no payment
// machinery exists anywhere (FEATURES #45). Room photos ride the EXISTING
// §1.6 upload pipeline (kind image), bound server-side via details.attachment_ids.
import { useEffect, useRef, useState } from 'react';
import type { Attachment, CreateListingRequest, Listing, ListingKind, Location, UploadResponse } from '@socialchat/shared';
import {
  AREA_MAX_CHARS,
  LISTING_ACTIVE_MAX_PER_USER,
  LISTING_BODY_MAX_CHARS,
  LISTING_GIG_TAG_MAX_CHARS,
  LISTING_GIG_TAGS_MAX,
  LISTING_PLACE_NAME_MAX_CHARS,
  LISTING_PRICE_TEXT_MAX_CHARS,
  LISTING_RIDE_LEG_MAX_CHARS,
  LISTING_RIDE_SEATS_MAX,
  LISTING_RIDE_SEATS_MIN,
  LISTING_PHOTOS_MAX,
  LISTING_TITLE_MAX_CHARS,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import ImageEditSheet from './ImageEditSheet';
import { createListing, KIND_EMOJI } from '@/lib/listings';
import { isSelfDrunk } from '@/lib/mood';
import { setMe } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import type { UpdateMeResponse } from '@socialchat/shared';
import DrunkConfirmSheet from './DrunkConfirmSheet';
import { LocationField } from './LocationPicker';
import Portal from './Portal';
import { StarPicker } from './Stars';
import bz from './beacons.module.css';
import st from './board.module.css';

const KIND_PICKS: { kind: ListingKind; title: string; sub: string }[] = [
  { kind: 'gig', title: 'Gig', sub: 'work together / hire me' },
  { kind: 'ride', title: 'Ride', sub: 'offer seats on a route' },
  { kind: 'room', title: 'Room', sub: 'space to share or sublet' },
  { kind: 'place_review', title: 'Place', sub: 'review a spot you went' },
];

export default function ListingCreateSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (listing: Listing) => void;
}) {
  const state = useAppState();
  const me = state.me;

  const [kind, setKind] = useState<ListingKind | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priceText, setPriceText] = useState('');
  const [area, setArea] = useState(me?.area ?? '');
  const [isPublic, setIsPublic] = useState(false);
  const [location, setLocation] = useState<Location | null>(null); // v0.7 §1.52
  // gig
  const [direction, setDirection] = useState<'offering' | 'seeking'>('offering');
  const [tagsDraft, setTagsDraft] = useState('');
  // ride
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [departsAt, setDepartsAt] = useState('');
  const [seats, setSeats] = useState(2);
  // room
  const [availableFrom, setAvailableFrom] = useState('');
  const [photos, setPhotos] = useState<Attachment[]>([]);
  const [editingPhoto, setEditingPhoto] = useState<Attachment | null>(null); // v1.0a #92
  const [uploading, setUploading] = useState(0);
  // place review
  const [placeName, setPlaceName] = useState('');
  const [rating, setRating] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // v0.8a §1.57: pending drunk-mode "you sure?" — a listing is a public write.
  const [drunkAsk, setDrunkAsk] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function uploadPhotos(files: FileList | null): Promise<void> {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      if (photos.length + uploading >= LISTING_PHOTOS_MAX) {
        setError(`Up to ${LISTING_PHOTOS_MAX} photos per listing.`);
        break;
      }
      setUploading((n) => n + 1);
      try {
        const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
        const form = new FormData();
        form.append('file', up, up.name);
        const res = await api.postForm<UploadResponse>('/api/uploads', form);
        if (res.attachment.kind !== 'image') {
          setError('Listing photos must be images.');
        } else {
          setPhotos((prev) =>
            prev.length < LISTING_PHOTOS_MAX ? [...prev, res.attachment] : prev
          );
        }
      } catch (err) {
        if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setError(`${file.name} is too large.`);
        else if (err instanceof ApiError && err.status === 415) setError(`${file.name}: unsupported type.`);
        else setError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function parsedTags(): string[] {
    return tagsDraft
      .split(',')
      .map((t) => t.trim().slice(0, LISTING_GIG_TAG_MAX_CHARS))
      .filter((t) => t.length > 0)
      .slice(0, LISTING_GIG_TAGS_MAX);
  }

  function buildRequest(): CreateListingRequest | null {
    if (!kind) return null;
    const base = {
      title: title.trim(),
      body: body.trim(),
      price_text: priceText.trim() ? priceText.trim() : null,
      area: area.trim() ? area.trim() : undefined,
      is_public: isPublic,
      ...(location ? { location } : {}),
    };
    switch (kind) {
      case 'gig':
        return {
          ...base,
          kind,
          details: { direction, tags: parsedTags(), attachment_ids: photos.map((p) => p.id) },
        };
      case 'ride': {
        if (!departsAt) return null;
        const iso = new Date(departsAt).toISOString();
        return {
          ...base,
          kind,
          details: {
            from_text: fromText.trim(),
            to_text: toText.trim(),
            departs_at: iso,
            seats,
            attachment_ids: photos.map((p) => p.id),
          },
        };
      }
      case 'room':
        return {
          ...base,
          kind,
          price_text: null, // the monthly price in details is the room's price line
          details: {
            monthly_price_text: priceText.trim() ? priceText.trim() : null,
            available_from: availableFrom || null,
            attachment_ids: photos.map((p) => p.id),
          },
        };
      case 'place_review':
        if (rating === null) return null;
        return {
          ...base,
          kind,
          price_text: null,
          details: { place_name: placeName.trim(), rating, attachment_ids: photos.map((p) => p.id) },
        };
    }
  }

  const ready = ((): boolean => {
    if (!kind || !title.trim() || busy || uploading > 0) return false;
    if (kind === 'ride') return Boolean(fromText.trim() && toText.trim() && departsAt);
    if (kind === 'place_review') return Boolean(placeName.trim()) && rating !== null;
    return true;
  })();

  async function post(force = false): Promise<void> {
    const req = buildRequest();
    if (!req || busy) return;
    // v0.8a §1.57 drunk guardrail: the board is a public write — ask first
    // while drunk (client-side only; nothing recorded about hesitation).
    if (!force && isSelfDrunk()) {
      setDrunkAsk(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Remember a freshly typed area as my profile area (the §1.15 pattern) —
      // the create itself also snapshots it, but `area` defaulting elsewhere
      // (board reads, next listing) needs users.area set.
      const typed = area.trim();
      if (typed && me && me.area?.toLowerCase() !== typed.toLowerCase()) {
        try {
          const res = await api.patch<UpdateMeResponse>('/api/users/me', { area: typed });
          setMe(res.user);
        } catch {
          /* the request's own area still applies */
        }
      }
      const listing = await createListing(req);
      toast('Posted to the board'); // v0.7.1 §1.56: the shared confirmation toast
      onCreated(listing);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'listing_limit') {
        setError(`You already have ${LISTING_ACTIVE_MAX_PER_USER} live posts — close one first.`);
      } else if (err instanceof ApiError && err.code === 'area_required') {
        setError('Set an area — a card has to say where it applies.');
      } else if (err instanceof ApiError && err.code === 'departs_at_past') {
        setError('That departure time already passed.');
      } else if (err instanceof ApiError && err.code === 'bad_attachment') {
        setError('One of the photos could not be attached — remove it and try again.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — posting limit for this hour.');
      } else {
        setError('Could not post it. Check your connection and try again.');
      }
      setBusy(false);
    }
  }

  const priceLabel =
    kind === 'room' ? 'Monthly price (just text — e.g. “₹9k / month”)' : 'Price (just text — e.g. “₹500”, “free”, “split petrol”)';

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
      <div className={bz.sheet} role="dialog" aria-modal="true" aria-label="Post to the board">
        <div className={bz.sheetHead}>
          <h2>{kind ? `${KIND_EMOJI[kind]} New ${KIND_PICKS.find((k) => k.kind === kind)?.title.toLowerCase()}` : 'Post to the board'}</h2>
          <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {kind === null ? (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              A card on the local board. People answer by messaging you — money (if any) settles
              outside the app.
            </p>
            <div className={st.kindPickGrid}>
              {KIND_PICKS.map((k) => (
                <button key={k.kind} type="button" className={st.kindPick} onClick={() => setKind(k.kind)}>
                  <span className={st.kindPickEmoji} aria-hidden>
                    {KIND_EMOJI[k.kind]}
                  </span>
                  <strong>{k.title}</strong>
                  <span>{k.sub}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className={bz.sheetLabel}>Title</div>
            <input
              className="input"
              placeholder={
                kind === 'gig'
                  ? '“Need a second pair of hands for a weekend build”'
                  : kind === 'ride'
                    ? '“City → airport, Friday evening”'
                    : kind === 'room'
                      ? '“Sunny room near the metro”'
                      : '“The chai place behind the park”'
              }
              value={title}
              maxLength={LISTING_TITLE_MAX_CHARS}
              onChange={(e) => setTitle(e.target.value)}
            />

            {kind === 'gig' ? (
              <>
                <div className={bz.sheetLabel}>Which way round?</div>
                <div className={bz.segRow} role="radiogroup" aria-label="Direction">
                  {(
                    [
                      { v: 'offering', label: 'Offering work' },
                      { v: 'seeking', label: 'Looking for people' },
                    ] as const
                  ).map((d) => (
                    <button
                      key={d.v}
                      type="button"
                      role="radio"
                      aria-checked={direction === d.v}
                      className={`${bz.segBtn}${direction === d.v ? ` ${bz.segOn}` : ''}`}
                      onClick={() => setDirection(d.v)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <div className={bz.sheetLabel}>Tags (comma-separated, up to {LISTING_GIG_TAGS_MAX})</div>
                <input
                  className="input"
                  placeholder="design, carpentry, react"
                  value={tagsDraft}
                  onChange={(e) => setTagsDraft(e.target.value)}
                />
              </>
            ) : null}

            {kind === 'ride' ? (
              <>
                <div className={st.formGrid2}>
                  <div>
                    <div className={bz.sheetLabel}>From</div>
                    <input
                      className="input"
                      placeholder="Indiranagar"
                      value={fromText}
                      maxLength={LISTING_RIDE_LEG_MAX_CHARS}
                      onChange={(e) => setFromText(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className={bz.sheetLabel}>To</div>
                    <input
                      className="input"
                      placeholder="Airport"
                      value={toText}
                      maxLength={LISTING_RIDE_LEG_MAX_CHARS}
                      onChange={(e) => setToText(e.target.value)}
                    />
                  </div>
                </div>
                <div className={bz.sheetLabel}>Departs</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={departsAt}
                  onChange={(e) => setDepartsAt(e.target.value)}
                />
                <div className={bz.sheetLabel}>Seats</div>
                <div className={bz.stepper}>
                  <button
                    type="button"
                    className={bz.stepBtn}
                    aria-label="Fewer seats"
                    disabled={seats <= LISTING_RIDE_SEATS_MIN}
                    onClick={() => setSeats((n) => Math.max(LISTING_RIDE_SEATS_MIN, n - 1))}
                  >
                    −
                  </button>
                  <span className={bz.stepVal} aria-live="polite">
                    {seats} {seats === 1 ? 'seat' : 'seats'}
                  </span>
                  <button
                    type="button"
                    className={bz.stepBtn}
                    aria-label="More seats"
                    disabled={seats >= LISTING_RIDE_SEATS_MAX}
                    onClick={() => setSeats((n) => Math.min(LISTING_RIDE_SEATS_MAX, n + 1))}
                  >
                    +
                  </button>
                </div>
              </>
            ) : null}

            {kind === 'room' ? (
              <>
                <div className={bz.sheetLabel}>Available from</div>
                <input
                  className="input"
                  type="date"
                  value={availableFrom}
                  onChange={(e) => setAvailableFrom(e.target.value)}
                />
              </>
            ) : null}

            {/* v1.0a (#91): photos on EVERY kind, not just rooms. */}
            <div className={bz.sheetLabel}>Photos (up to {LISTING_PHOTOS_MAX})</div>
            <div className={st.photoRow}>
              {photos.map((p) => (
                <span key={p.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumb_url ?? p.url} alt="" />
                  <button
                    type="button"
                    className={st.photoRemove}
                    aria-label="Remove photo"
                    onClick={() => setPhotos((prev) => prev.filter((x) => x.id !== p.id))}
                  >
                    ×
                  </button>
                  {/* v1.0a (#92): crop/rotate before it goes on the board. */}
                  <button
                    type="button"
                    className={st.photoEdit}
                    aria-label="Edit photo"
                    onClick={() => setEditingPhoto(p)}
                  >
                    ✏️
                  </button>
                </span>
              ))}
              {photos.length < LISTING_PHOTOS_MAX ? (
                <button
                  type="button"
                  className={st.photoAdd}
                  aria-label="Add photo"
                  disabled={uploading > 0}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading > 0 ? '…' : '+'}
                </button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept="image/*"
              onChange={(e) => {
                void uploadPhotos(e.target.files);
                e.target.value = '';
              }}
            />
            {editingPhoto ? (
              <ImageEditSheet
                source={editingPhoto.url}
                fileName={editingPhoto.file_name ?? 'photo.jpg'}
                onCancel={() => setEditingPhoto(null)}
                onDone={(file) => {
                  const target = editingPhoto;
                  setEditingPhoto(null);
                  void (async () => {
                    setUploading((n) => n + 1);
                    try {
                      const form = new FormData();
                      form.append('file', file, file.name);
                      const res = await api.postForm<UploadResponse>('/api/uploads', form);
                      setPhotos((prev) => prev.map((x) => (x.id === target.id ? res.attachment : x)));
                    } catch {
                      setError('Could not save the edited photo.');
                    } finally {
                      setUploading((n) => n - 1);
                    }
                  })();
                }}
              />
            ) : null}

            {kind === 'place_review' ? (
              <>
                <div className={bz.sheetLabel}>Place name</div>
                <input
                  className="input"
                  placeholder="The place itself — not a person"
                  value={placeName}
                  maxLength={LISTING_PLACE_NAME_MAX_CHARS}
                  onChange={(e) => setPlaceName(e.target.value)}
                />
                <div className={bz.sheetLabel}>How was it?</div>
                <StarPicker value={rating} onChange={setRating} />
              </>
            ) : null}

            {kind !== 'place_review' ? (
              <>
                <div className={bz.sheetLabel}>{priceLabel}</div>
                <input
                  className="input"
                  placeholder="optional"
                  value={priceText}
                  maxLength={LISTING_PRICE_TEXT_MAX_CHARS}
                  onChange={(e) => setPriceText(e.target.value)}
                />
              </>
            ) : null}

            <div className={bz.sheetLabel}>{kind === 'place_review' ? 'Your review' : 'Details'}</div>
            <textarea
              className="input"
              rows={3}
              placeholder={kind === 'place_review' ? 'What made it good (or not)?' : 'Anything people should know before messaging you.'}
              value={body}
              maxLength={LISTING_BODY_MAX_CHARS}
              onChange={(e) => setBody(e.target.value)}
            />

            <div className={bz.sheetLabel}>Area</div>
            <input
              className="input"
              placeholder="e.g. Indiranagar — where this card applies"
              value={area}
              maxLength={AREA_MAX_CHARS}
              onChange={(e) => setArea(e.target.value)}
            />

            <div className={bz.sheetLabel}>Place chip (optional)</div>
            <LocationField value={location} onChange={setLocation} />

            <div className={st.toggleRow}>
              <div>
                <label htmlFor="listing-public">Show outside my area</label>
                <p>Off: only people whose area matches “{area.trim() || '…'}” see it.</p>
              </div>
              <input
                id="listing-public"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
              />
            </div>

            {error ? <p className="error-text">{error}</p> : null}
            <button type="button" className={st.msgBtn} disabled={!ready} onClick={() => void post()}>
              {busy ? 'Posting…' : 'Put it on the board'}
            </button>
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              No payments in here, ever — prices are words, deals are yours.
            </p>
          </>
        )}
      </div>
      {drunkAsk ? (
        <DrunkConfirmSheet
          text="You're in drunk mode and this goes on the board for people around you (or everyone, if public). Tonight-you is sure?"
          confirmLabel="Post it 🍻"
          onConfirm={() => {
            setDrunkAsk(false);
            void post(true);
          }}
          onCancel={() => setDrunkAsk(false)}
        />
      ) : null}
    </div>
    </Portal>
  );
}
