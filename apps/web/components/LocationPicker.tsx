'use client';

// Locations (v0.7 — API.md §1.52): the ONE picker + chip set used by the post
// composer, beacon create/edit, listing create/edit and the chat "📍 Join me
// here" drop. A location is {label, lat?, lng?} — the label always suffices;
// coordinates are an EXPLICIT one-tap snapshot (permission-gated, rounded in
// lib/locations.ts), never captured ambiently. Rendering is a LINK: the map
// opens in the user's own map app/site via lib/locations.mapLinks — no tiles,
// no SDKs, no API keys (golden rule 7).
import { useEffect, useState } from 'react';
import { LOCATION_LABEL_MAX_CHARS, type Location } from '@socialchat/shared';
import { mapLinks, snapshotPosition } from '@/lib/locations';
import Portal from './Portal';
import bz from './beacons.module.css';
import soc from './social.module.css';

// ---------------------------------------------------------------------------
// LocationChip — a tappable chip that expands the map links. Used on posts,
// beacon cards/sheets and listing sheets.
// ---------------------------------------------------------------------------

export function LocationChip({ location }: { location: Location }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', maxWidth: '100%' }}>
      <button
        type="button"
        className={soc.locChip}
        aria-expanded={open}
        aria-label={`Location: ${location.label}. Tap for map links`}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>📍</span>
        <span>{location.label}</span>
      </button>
      {open ? <MapLinksRow location={location} /> : null}
    </span>
  );
}

/** The §1.52 link recipes as a row of outbound anchors. */
export function MapLinksRow({ location }: { location: Location }) {
  return (
    <span className={soc.locLinksRow}>
      {mapLinks(location).map((l) => (
        <a key={l.label} className={soc.locLink} href={l.href} target="_blank" rel="noreferrer noopener">
          <span aria-hidden>🗺</span>
          {l.label}
        </a>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LocationField — composer-embeddable: shows the chosen chip (with remove) or
// an "Add a place" button opening the picker sheet.
// ---------------------------------------------------------------------------

export function LocationField({
  value,
  onChange,
}: {
  value: Location | null;
  onChange: (loc: Location | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {value ? (
        <>
          <span className={soc.locChip} style={{ cursor: 'default' }}>
            <span aria-hidden>📍</span>
            <span>
              {value.label}
              {value.lat !== undefined ? ' · pinned' : ''}
            </span>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
            Change
          </button>
          <button type="button" className="btn btn-ghost" aria-label="Remove location" onClick={() => onChange(null)}>
            ✕ Remove
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          📍 Add a place
        </button>
      )}
      {open ? (
        <LocationPickerSheet
          initial={value}
          onClose={() => setOpen(false)}
          onPick={(loc) => {
            onChange(loc);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocationPickerSheet — typed label (always enough) + the explicit, permission-
// gated "use my current location" snapshot. Optional note row for chat drops.
// ---------------------------------------------------------------------------

export default function LocationPickerSheet({
  initial,
  onClose,
  onPick,
  title = 'Add a place',
  withNote = false,
  submitLabel = 'Set location',
}: {
  initial?: Location | null;
  onClose: () => void;
  onPick: (loc: Location, note: string) => void;
  title?: string;
  /** Chat drops: an optional note rides the message body. */
  withNote?: boolean;
  submitLabel?: string;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    initial && initial.lat !== undefined && initial.lng !== undefined
      ? { lat: initial.lat, lng: initial.lng }
      : null
  );
  const [note, setNote] = useState('');
  const [locBusy, setLocBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function useCurrent(): Promise<void> {
    if (locBusy) return;
    setLocBusy(true);
    setError(null);
    try {
      // One explicit snapshot — the user tapped; nothing watches (§1.52).
      const pos = await snapshotPosition();
      setCoords(pos);
      if (!label.trim()) setLabel('My spot right now');
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'unsupported'
          ? 'This browser has no location support — type a place name instead.'
          : 'Location permission denied or unavailable — a typed place name works just as well.'
      );
    } finally {
      setLocBusy(false);
    }
  }

  function submit(): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    const loc: Location = coords ? { label: trimmed, lat: coords.lat, lng: coords.lng } : { label: trimmed };
    onPick(loc, note.trim());
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
        <div className={bz.sheet} role="dialog" aria-modal="true" aria-label={title}>
          <div className={bz.sheetHead}>
            <h2>📍 {title}</h2>
            <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>

          <div className={bz.sheetLabel}>Place name</div>
          <input
            className="input"
            placeholder="“the chai spot behind campus”"
            value={label}
            maxLength={LOCATION_LABEL_MAX_CHARS}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />

          <div className={bz.sheetLabel}>Pin (optional)</div>
          {coords ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className={soc.locChip} style={{ cursor: 'default' }}>
                <span aria-hidden>🎯</span>
                <span>
                  {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}
                </span>
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => setCoords(null)}>
                ✕ Drop the pin
              </button>
            </div>
          ) : (
            <button type="button" className="btn" disabled={locBusy} onClick={() => void useCurrent()}>
              {locBusy ? 'Locating…' : '🎯 Use my current location'}
            </button>
          )}
          <p className={bz.sheetNote}>
            One snapshot, only when you tap — nothing tracks you. A name alone is always enough.
          </p>

          {withNote ? (
            <>
              <div className={bz.sheetLabel}>Note (optional)</div>
              <input
                className="input"
                placeholder="“we're at the corner table”"
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          ) : null}

          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className={bz.lightBtn}
            disabled={!label.trim()}
            onClick={submit}
            style={{ marginTop: 14 }}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </Portal>
  );
}
