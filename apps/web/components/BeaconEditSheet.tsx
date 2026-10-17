'use client';

// Beacon edit sheet (v0.7 — API.md §1.47, FEATURES #61). Creator-only, open
// beacons only — the server re-checks both. Sends ONLY the fields that
// changed (omitted = unchanged; location null clears); window fields travel
// together when either moves. Lowering the threshold to the current joiner
// count sparks the plan inside the edit transaction — the sheet says so out
// loud before it happens. Joiners get the "changed the plan" push (§2.9
// guards, server-side); the audience sees beacon.updated flash the card.
import { useEffect, useMemo, useState } from 'react';
import {
  BEACON_NOTE_MAX_CHARS,
  BEACON_SPARK_THRESHOLD_MAX,
  BEACON_SPARK_THRESHOLD_MIN,
  type Beacon,
  type Location,
  type PatchBeaconRequest,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { patchBeacon, rememberVibeRecent } from '@/lib/beacons';
import Portal from './Portal';
import VibePicker, { vibeDraftValid, type VibeDraft } from './VibePicker';
import { LocationField } from './LocationPicker';
import styles from './beacons.module.css';

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BeaconEditSheet({
  beacon,
  onClose,
  onSaved,
}: {
  beacon: Beacon;
  onClose: () => void;
  /** Called with the fresh DTO (which may have SPARKED inside the edit). */
  onSaved?: (beacon: Beacon) => void;
}) {
  const [vibeDraft, setVibeDraft] = useState<VibeDraft>({
    vibe: beacon.vibe,
    custom_vibe_emoji: beacon.custom_vibe_emoji ?? '',
    custom_vibe_label: beacon.custom_vibe_label ?? '',
  });
  const [note, setNote] = useState(beacon.note);
  const [startsLocal, setStartsLocal] = useState(() => toLocalInputValue(beacon.starts_at));
  const [expiresLocal, setExpiresLocal] = useState(() => toLocalInputValue(beacon.expires_at));
  const [threshold, setThreshold] = useState(beacon.spark_threshold);
  const [location, setLocation] = useState<Location | null>(beacon.location);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // §1.47: a new threshold must be ≥ max(contract min, current joins).
  const minThreshold = Math.max(BEACON_SPARK_THRESHOLD_MIN, beacon.joiner_count);
  const sparksNow = beacon.joiner_count >= BEACON_SPARK_THRESHOLD_MIN && threshold === beacon.joiner_count;

  const req = useMemo((): PatchBeaconRequest => {
    const out: PatchBeaconRequest = {};
    const vibeChanged =
      vibeDraft.vibe !== beacon.vibe ||
      (vibeDraft.vibe === 'custom' &&
        (vibeDraft.custom_vibe_emoji !== (beacon.custom_vibe_emoji ?? '') ||
          vibeDraft.custom_vibe_label.trim() !== (beacon.custom_vibe_label ?? '')));
    if (vibeChanged && vibeDraft.vibe !== null) {
      out.vibe = vibeDraft.vibe;
      if (vibeDraft.vibe === 'custom') {
        out.custom_vibe_emoji = vibeDraft.custom_vibe_emoji;
        out.custom_vibe_label = vibeDraft.custom_vibe_label.trim();
      }
    }
    if (note.trim() !== beacon.note) out.note = note.trim();
    const startsChanged = startsLocal !== toLocalInputValue(beacon.starts_at);
    const expiresChanged = expiresLocal !== toLocalInputValue(beacon.expires_at);
    if (startsChanged || expiresChanged) {
      // §1.47: both window fields travel together when either changes.
      const s = new Date(startsLocal);
      const e = new Date(expiresLocal);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
        out.starts_at = s.toISOString();
        out.expires_at = e.toISOString();
      }
    }
    if (threshold !== beacon.spark_threshold) out.spark_threshold = threshold;
    const locChanged = JSON.stringify(location) !== JSON.stringify(beacon.location);
    if (locChanged) out.location = location;
    return out;
  }, [beacon, vibeDraft, note, startsLocal, expiresLocal, threshold, location]);

  const dirty = Object.keys(req).length > 0;
  const valid = vibeDraftValid(vibeDraft);

  async function save(): Promise<void> {
    if (!dirty || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await patchBeacon(beacon.id, req);
      if (req.vibe === 'custom' && req.custom_vibe_emoji && req.custom_vibe_label) {
        rememberVibeRecent(req.custom_vibe_emoji, req.custom_vibe_label);
      }
      onSaved?.(updated);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'threshold_below_joins') {
        setError(`People already tapped in — the bar can't go below ${beacon.joiner_count}.`);
      } else if (err instanceof ApiError && err.code === 'beacon_not_open') {
        setError('This plan already sparked (or closed) — changes happen in its chat now.');
      } else if (err instanceof ApiError && err.code === 'bad_custom_vibe') {
        setError('A custom vibe needs both an emoji and a word.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy on the edits — try again in a bit.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('That time window doesn’t work — at least 30 minutes, at most a week out.');
      } else {
        setError('Could not save the changes — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={`${styles.sheetBackdrop} ${styles.beaconVars}`}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Edit your beacon">
          <div className={styles.sheetHead}>
            <h2>Change the plan ✏️</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Everyone who tapped in gets a heads-up. Who can see it stays as it is — re-aiming a live
            invite means a new beacon.
          </p>

          <div className={styles.sheetLabel}>Vibe</div>
          <VibePicker value={vibeDraft} onChange={setVibeDraft} />

          <div className={styles.sheetLabel}>When</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 150 }}>
              <span className="muted small">Starts</span>
              <input
                className="input"
                type="datetime-local"
                value={startsLocal}
                onChange={(e) => setStartsLocal(e.target.value)}
              />
            </label>
            <label style={{ flex: 1, minWidth: 150 }}>
              <span className="muted small">Joinable until</span>
              <input
                className="input"
                type="datetime-local"
                value={expiresLocal}
                onChange={(e) => setExpiresLocal(e.target.value)}
              />
            </label>
          </div>

          <div className={styles.sheetLabel}>Sparks at</div>
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepBtn}
              aria-label="Lower the bar"
              disabled={threshold <= minThreshold}
              onClick={() => setThreshold((n) => Math.max(minThreshold, n - 1))}
            >
              −
            </button>
            <span className={styles.stepVal} aria-live="polite">
              {threshold} {threshold === 1 ? 'joiner' : 'joiners'}
            </span>
            <button
              type="button"
              className={styles.stepBtn}
              aria-label="Raise the bar"
              disabled={threshold >= BEACON_SPARK_THRESHOLD_MAX}
              onClick={() => setThreshold((n) => Math.min(BEACON_SPARK_THRESHOLD_MAX, n + 1))}
            >
              +
            </button>
            <span className={styles.stepHint}>
              {beacon.joiner_count > 0 ? `${beacon.joiner_count} already in · ` : ''}
              can&rsquo;t go below whoever already joined
            </span>
          </div>
          {sparksNow ? (
            <p className={styles.sheetNote} role="status">
              ⚡ {beacon.joiner_count} already tapped in — saving this <strong>starts the plan right
              now</strong> and opens the group chat.
            </p>
          ) : null}

          <div className={styles.sheetLabel}>Where</div>
          <LocationField value={location} onChange={setLocation} />

          <div className={styles.sheetLabel}>Note</div>
          <input
            className="input"
            placeholder="optional — “got a deck of cards”"
            value={note}
            maxLength={BEACON_NOTE_MAX_CHARS}
            onChange={(e) => setNote(e.target.value)}
          />

          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className={styles.lightBtn}
            disabled={!dirty || !valid || busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : sparksNow ? 'Save & start the plan ⚡' : 'Save changes'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
