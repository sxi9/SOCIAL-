'use client';

// Listing edit sheet (v0.7 — API.md §1.48, FEATURES #61). Author-only, active
// listings only — the server re-checks both. `kind` is echoed to pick the Zod
// branch and is immutable; `details`, when sent, is the COMPLETE per-kind
// payload revalidated like create (ride departs_at re-copied to expires_at;
// room photos re-bound). `area` is immutable (the mint snapshot is the
// visibility contract). No fan-out ever — the board stays pull-based.
import { useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  Listing,
  Location,
  UpdateListingRequest,
  UploadResponse,
} from '@socialchat/shared';
import {
  LISTING_BODY_MAX_CHARS,
  LISTING_GIG_TAG_MAX_CHARS,
  LISTING_GIG_TAGS_MAX,
  LISTING_PLACE_NAME_MAX_CHARS,
  LISTING_PRICE_TEXT_MAX_CHARS,
  LISTING_RIDE_LEG_MAX_CHARS,
  LISTING_RIDE_SEATS_MAX,
  LISTING_RIDE_SEATS_MIN,
  LISTING_ROOM_PHOTOS_MAX,
  LISTING_TITLE_MAX_CHARS,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { KIND_EMOJI, KIND_LABEL, updateListing } from '@/lib/listings';
import { LocationField } from './LocationPicker';
import Portal from './Portal';
import { StarPicker } from './Stars';
import bz from './beacons.module.css';
import st from './board.module.css';

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ListingEditSheet({
  listing,
  onClose,
  onSaved,
}: {
  listing: Listing;
  onClose: () => void;
  onSaved: (listing: Listing) => void;
}) {
  const [title, setTitle] = useState(listing.title);
  const [body, setBody] = useState(listing.body);
  const [priceText, setPriceText] = useState(
    listing.kind === 'room' ? listing.details.monthly_price_text ?? '' : listing.price_text ?? ''
  );
  const [isPublic, setIsPublic] = useState(listing.is_public);
  const [location, setLocation] = useState<Location | null>(listing.location);
  // gig
  const [direction, setDirection] = useState<'offering' | 'seeking'>(
    listing.kind === 'gig' ? listing.details.direction : 'offering'
  );
  const [tagsDraft, setTagsDraft] = useState(
    listing.kind === 'gig' ? listing.details.tags.join(', ') : ''
  );
  // ride
  const [fromText, setFromText] = useState(listing.kind === 'ride' ? listing.details.from_text : '');
  const [toText, setToText] = useState(listing.kind === 'ride' ? listing.details.to_text : '');
  const [departsAt, setDepartsAt] = useState(
    listing.kind === 'ride' ? toLocalInputValue(listing.details.departs_at) : ''
  );
  const [seats, setSeats] = useState(listing.kind === 'ride' ? listing.details.seats : 2);
  // room — photos re-bind: existing attachments pre-populate; dropped ones
  // unbind server-side to the orphan GC (§1.48).
  const [availableFrom, setAvailableFrom] = useState(
    listing.kind === 'room' ? listing.details.available_from ?? '' : ''
  );
  const [photos, setPhotos] = useState<Attachment[]>(listing.kind === 'room' ? listing.photos : []);
  const [uploading, setUploading] = useState(0);
  // place review
  const [placeName, setPlaceName] = useState(
    listing.kind === 'place_review' ? listing.details.place_name : ''
  );
  const [rating, setRating] = useState<number | null>(
    listing.kind === 'place_review' ? listing.details.rating : null
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
      if (photos.length + uploading >= LISTING_ROOM_PHOTOS_MAX) {
        setError(`Up to ${LISTING_ROOM_PHOTOS_MAX} photos per room listing.`);
        break;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await api.postForm<UploadResponse>('/api/uploads', form);
        if (res.attachment.kind !== 'image') setError('Room photos must be images.');
        else setPhotos((prev) => (prev.length < LISTING_ROOM_PHOTOS_MAX ? [...prev, res.attachment] : prev));
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) setError(`${file.name} is too large.`);
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

  function buildRequest(): UpdateListingRequest | null {
    // Simple per-kind full-replace of the touched surfaces: `details` is sent
    // as the COMPLETE payload (the §1.48 revalidate-like-create rule), the
    // base fields only when changed. Omitted = unchanged.
    const base = {
      ...(title.trim() !== listing.title ? { title: title.trim() } : {}),
      ...(body.trim() !== listing.body ? { body: body.trim() } : {}),
      ...(isPublic !== listing.is_public ? { is_public: isPublic } : {}),
      ...(JSON.stringify(location) !== JSON.stringify(listing.location) ? { location } : {}),
    };
    switch (listing.kind) {
      case 'gig': {
        const price = priceText.trim() ? priceText.trim() : null;
        return {
          kind: 'gig',
          ...base,
          ...(price !== listing.price_text ? { price_text: price } : {}),
          details: { direction, tags: parsedTags() },
        };
      }
      case 'ride': {
        if (!fromText.trim() || !toText.trim() || !departsAt) return null;
        const at = new Date(departsAt);
        if (Number.isNaN(at.getTime())) return null;
        const price = priceText.trim() ? priceText.trim() : null;
        return {
          kind: 'ride',
          ...base,
          ...(price !== listing.price_text ? { price_text: price } : {}),
          details: {
            from_text: fromText.trim(),
            to_text: toText.trim(),
            departs_at: at.toISOString(),
            seats,
          },
        };
      }
      case 'room':
        return {
          kind: 'room',
          ...base,
          details: {
            monthly_price_text: priceText.trim() ? priceText.trim() : null,
            available_from: availableFrom || null,
            attachment_ids: photos.map((p) => p.id),
          },
        };
      case 'place_review':
        if (!placeName.trim() || rating === null) return null;
        return {
          kind: 'place_review',
          ...base,
          details: { place_name: placeName.trim(), rating },
        };
    }
  }

  const ready = title.trim().length > 0 && !busy && uploading === 0 && buildRequest() !== null;

  async function save(): Promise<void> {
    const req = buildRequest();
    if (!req || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateListing(listing.id, req);
      onSaved(updated);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'listing_closed') {
        setError('This listing closed or expired — retire it and post a fresh one instead.');
      } else if (err instanceof ApiError && err.code === 'departs_at_past') {
        setError('That departure time already passed.');
      } else if (err instanceof ApiError && err.code === 'bad_attachment') {
        setError('One of the photos could not be attached — remove it and try again.');
      } else if (err instanceof ApiError && err.code === 'kind_immutable') {
        setError('A card cannot change kind — post a new one.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy on the edits — try again in a bit.');
      } else {
        setError('Could not save the changes — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={`${bz.sheetBackdrop} ${bz.beaconVars}`}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={bz.sheet} role="dialog" aria-modal="true" aria-label={`Edit ${KIND_LABEL[listing.kind]} listing`}>
          <div className={bz.sheetHead}>
            <h2>
              <span aria-hidden>{KIND_EMOJI[listing.kind]}</span> Edit your {KIND_LABEL[listing.kind].toLowerCase()}
            </h2>
            <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            The card updates quietly — nobody gets pinged. Area stays “{listing.area}” (moving = a
            new card).
          </p>

          <div className={bz.sheetLabel}>Title</div>
          <input
            className="input"
            value={title}
            maxLength={LISTING_TITLE_MAX_CHARS}
            onChange={(e) => setTitle(e.target.value)}
          />

          {listing.kind === 'gig' ? (
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
              <input className="input" value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} />
            </>
          ) : null}

          {listing.kind === 'ride' ? (
            <>
              <div className={st.formGrid2}>
                <div>
                  <div className={bz.sheetLabel}>From</div>
                  <input
                    className="input"
                    value={fromText}
                    maxLength={LISTING_RIDE_LEG_MAX_CHARS}
                    onChange={(e) => setFromText(e.target.value)}
                  />
                </div>
                <div>
                  <div className={bz.sheetLabel}>To</div>
                  <input
                    className="input"
                    value={toText}
                    maxLength={LISTING_RIDE_LEG_MAX_CHARS}
                    onChange={(e) => setToText(e.target.value)}
                  />
                </div>
              </div>
              <div className={bz.sheetLabel}>Departs (also when the card expires)</div>
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

          {listing.kind === 'room' ? (
            <>
              <div className={bz.sheetLabel}>Available from</div>
              <input
                className="input"
                type="date"
                value={availableFrom}
                onChange={(e) => setAvailableFrom(e.target.value)}
              />
              <div className={bz.sheetLabel}>Photos (up to {LISTING_ROOM_PHOTOS_MAX})</div>
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
                  </span>
                ))}
                {photos.length < LISTING_ROOM_PHOTOS_MAX ? (
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
            </>
          ) : null}

          {listing.kind === 'place_review' ? (
            <>
              <div className={bz.sheetLabel}>Place name</div>
              <input
                className="input"
                value={placeName}
                maxLength={LISTING_PLACE_NAME_MAX_CHARS}
                onChange={(e) => setPlaceName(e.target.value)}
              />
              <div className={bz.sheetLabel}>How was it?</div>
              <StarPicker value={rating} onChange={setRating} />
            </>
          ) : null}

          {listing.kind !== 'place_review' ? (
            <>
              <div className={bz.sheetLabel}>
                {listing.kind === 'room' ? 'Monthly price (just text)' : 'Price (just text)'}
              </div>
              <input
                className="input"
                placeholder="optional"
                value={priceText}
                maxLength={LISTING_PRICE_TEXT_MAX_CHARS}
                onChange={(e) => setPriceText(e.target.value)}
              />
            </>
          ) : null}

          <div className={bz.sheetLabel}>{listing.kind === 'place_review' ? 'Your review' : 'Details'}</div>
          <textarea
            className="input"
            rows={3}
            value={body}
            maxLength={LISTING_BODY_MAX_CHARS}
            onChange={(e) => setBody(e.target.value)}
          />

          <div className={bz.sheetLabel}>Place chip (optional)</div>
          <LocationField value={location} onChange={setLocation} />

          <div className={st.toggleRow}>
            <div>
              <label htmlFor="listing-edit-public">Show outside my area</label>
              <p>Off: only people whose area matches “{listing.area}” see it.</p>
            </div>
            <input
              id="listing-edit-public"
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          <button type="button" className={st.msgBtn} disabled={!ready} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
