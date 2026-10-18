'use client';

// "I'm bored" → beacon create sheet (v0.3 — API.md §1.15, FEATURES #23).
// Everything here is an active micro-task — vibe chips, when presets rendered
// as countdown previews, audience, group-size stepper — and submitting drops
// the user straight back on the list where their live card already sits.
// NO waiting state, ever (PSYCHOLOGY §1).
import { useEffect, useState } from 'react';
import {
  AREA_MAX_CHARS,
  BEACON_NOTE_MAX_CHARS,
  BEACON_OPEN_MAX,
  BEACON_SPARK_THRESHOLD_MAX,
  BEACON_SPARK_THRESHOLD_MIN,
  type BeaconAudience,
  type Location,
  type SettingsResponse,
  type UpdateMeResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { createBeacon, fmtCountdown, presetWindow, rememberVibeRecent, type WhenPreset } from '@/lib/beacons';
import { isSelfDrunk } from '@/lib/mood';
import { setMe, setSettings } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import DrunkConfirmSheet from './DrunkConfirmSheet';
import { LocationField } from './LocationPicker';
import Portal from './Portal';
import VibePicker, { vibeDraftValid, type VibeDraft } from './VibePicker';
import styles from './beacons.module.css';

const AUDIENCES: { value: BeaconAudience; label: string }[] = [
  { value: 'friends', label: 'Friends' },
  { value: 'area', label: 'My area' },
  { value: 'public', label: 'Public' },
];

export default function BeaconCreateSheet({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const me = state.me;
  const now = useNow(30_000);

  const [vibeDraft, setVibeDraft] = useState<VibeDraft>({
    vibe: null,
    custom_vibe_emoji: '',
    custom_vibe_label: '',
  });
  const [location, setLocation] = useState<Location | null>(null);
  const [when, setWhen] = useState<WhenPreset>('now');
  const [audience, setAudience] = useState<BeaconAudience>(
    state.settings?.beacon_default_audience ?? 'friends'
  );
  const [audienceTouched, setAudienceTouched] = useState(false);
  // The stepper speaks group size (you + joiners): default 3 people = the
  // contract's default spark_threshold of 2 joiners (PSYCHOLOGY §3 sweet spot).
  const [groupSize, setGroupSize] = useState(3);
  const [note, setNote] = useState('');
  const [areaDraft, setAreaDraft] = useState('');
  const [areaBusy, setAreaBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.8a §1.57: pending drunk-mode "you sure?" before a PUBLIC beacon.
  const [drunkAsk, setDrunkAsk] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Pre-select the user's beacon_default_audience (§1.13) when it isn't
  // mirrored locally yet — never overriding an explicit pick.
  useEffect(() => {
    if (state.settings !== null) return;
    let cancelled = false;
    void api
      .get<SettingsResponse>('/api/users/me/settings')
      .then((res) => {
        setSettings(res.settings);
        if (!cancelled) {
          setAudience((current) =>
            audienceTouched ? current : res.settings.beacon_default_audience
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsArea = audience === 'area' && !me?.area;

  function whenPreview(preset: WhenPreset): { label: string; sub: string; valid: boolean } {
    const w = presetWindow(preset, new Date(now));
    const startsMs = new Date(w.starts_at).getTime();
    if (preset === 'now') return { label: 'Now', sub: 'next 4h', valid: w.valid };
    if (preset === 'tonight') {
      return {
        label: 'Tonight',
        sub: startsMs <= now ? 'already on' : `in ${fmtCountdown(w.starts_at, now)}`,
        valid: w.valid,
      };
    }
    return {
      label: 'Weekend',
      sub: startsMs <= now ? 'it IS the weekend' : `in ${fmtCountdown(w.starts_at, now)}`,
      valid: w.valid,
    };
  }

  async function saveArea(): Promise<void> {
    const value = areaDraft.trim();
    if (!value || areaBusy) return;
    setAreaBusy(true);
    setError(null);
    try {
      const res = await api.patch<UpdateMeResponse>('/api/users/me', { area: value });
      setMe(res.user);
    } catch {
      setError('Could not save your area — try again.');
    } finally {
      setAreaBusy(false);
    }
  }

  async function light(force = false): Promise<void> {
    if (!vibeDraftValid(vibeDraft) || vibeDraft.vibe === null || busy) return;
    // v0.8a §1.57 drunk guardrail: a PUBLIC beacon while drunk asks first
    // (client-side only; the server records nothing about hesitation).
    if (!force && audience === 'public' && isSelfDrunk()) {
      setDrunkAsk(true);
      return;
    }
    const w = presetWindow(when);
    if (!w.valid) {
      setError('That window already closed — pick another time.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const isCustom = vibeDraft.vibe === 'custom';
      await createBeacon({
        vibe: vibeDraft.vibe,
        ...(isCustom
          ? {
              custom_vibe_emoji: vibeDraft.custom_vibe_emoji,
              custom_vibe_label: vibeDraft.custom_vibe_label.trim(),
            }
          : {}),
        note: note.trim(),
        audience,
        spark_threshold: groupSize - 1,
        starts_at: w.starts_at,
        expires_at: w.expires_at,
        ...(location ? { location } : {}),
      });
      // Recents are per-device localStorage only (§1.47).
      if (isCustom) rememberVibeRecent(vibeDraft.custom_vibe_emoji, vibeDraft.custom_vibe_label.trim());
      toast('Beacon lit 🔥'); // v0.7.1 §1.56: the shared confirmation toast
      // Straight back to the list — the live card is already on top.
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'beacon_limit') {
        setError(`You already have ${BEACON_OPEN_MAX} beacons burning — let one land first.`);
      } else if (err instanceof ApiError && err.code === 'area_required') {
        setError('Set your area first — area beacons need one to match on.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Whoa, beacon machine — take a breather and try again in a bit.');
      } else {
        setError('Could not light it. Check your connection and try again.');
      }
      setBusy(false);
    }
  }

  const minSize = BEACON_SPARK_THRESHOLD_MIN + 1;
  const maxSize = BEACON_SPARK_THRESHOLD_MAX + 1;

  return (
    // Portaled to <body>: the BoredButton mounts this sheet inside the
    // `.boredWrap` FAB shell, whose pointer-events:none inherited into the
    // whole sheet (every tap fell through to the board) and whose z-index
    // stacking context slid the sheet UNDER the tab bar, hiding "Light it".
    <Portal>
    <div
      className={`${styles.sheetBackdrop} ${styles.beaconVars}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Light a beacon">
        <div className={styles.sheetHead}>
          {/* Royal v2 (ref 34): serif title, no emoji in the chrome. */}
          <h2>Light a beacon</h2>
          <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Royal v2 (ref 34): the free-text "what" sits first. */}
        <input
          className="input"
          placeholder="late tacos, who’s up (optional)"
          aria-label="Anything else about the plan"
          value={note}
          maxLength={BEACON_NOTE_MAX_CHARS}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className={styles.sheetLabel}>What&rsquo;s the vibe?</div>
        <VibePicker value={vibeDraft} onChange={setVibeDraft} />

        <div className={styles.sheetLabel}>Where? (optional)</div>
        <LocationField value={location} onChange={setLocation} />

        <div className={styles.sheetLabel}>When?</div>
        <div className={styles.whenRow} role="radiogroup" aria-label="When">
          {(['now', 'tonight', 'weekend'] as const).map((preset) => {
            const p = whenPreview(preset);
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={when === preset}
                disabled={!p.valid}
                className={`${styles.whenChip}${when === preset ? ` ${styles.whenChipOn}` : ''}`}
                onClick={() => setWhen(preset)}
              >
                {p.label}
                <small>{p.valid ? p.sub : 'too late 😴'}</small>
              </button>
            );
          })}
        </div>

        <div className={styles.sheetLabel}>Who can see it?</div>
        <div className={styles.segRow} role="radiogroup" aria-label="Audience">
          {AUDIENCES.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={audience === a.value}
              className={`${styles.segBtn}${audience === a.value ? ` ${styles.segOn}` : ''}`}
              onClick={() => {
                setAudienceTouched(true);
                setAudience(a.value);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        {audience === 'area' ? (
          needsArea ? (
            <div className={styles.areaPrompt}>
              <input
                className="input"
                placeholder="Your area — e.g. Indiranagar"
                value={areaDraft}
                maxLength={AREA_MAX_CHARS}
                onChange={(e) => setAreaDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!areaDraft.trim() || areaBusy}
                onClick={() => void saveArea()}
              >
                {areaBusy ? '…' : 'Set'}
              </button>
            </div>
          ) : (
            <p className={styles.sheetNote}>
              Matches people who set their area to &ldquo;{me?.area}&rdquo;. Your area itself is never
              shown to anyone.
            </p>
          )
        ) : null}

        {/* Royal v2 (ref 34): "Sparks at" row — label left, stepper right. */}
        <div className={styles.sheetRow}>
          <span className={styles.sheetRowLabel}>Sparks at</span>
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepBtn}
              aria-label="Smaller group"
              disabled={groupSize <= minSize}
              onClick={() => setGroupSize((n) => Math.max(minSize, n - 1))}
            >
              −
            </button>
            <span className={styles.stepVal} aria-live="polite">
              {groupSize} people
            </span>
            <button
              type="button"
              className={styles.stepBtn}
              aria-label="Bigger group"
              disabled={groupSize >= maxSize}
              onClick={() => setGroupSize((n) => Math.min(maxSize, n + 1))}
            >
              +
            </button>
          </div>
        </div>
        <p className={styles.sheetNote} style={{ marginTop: 4 }}>
          sparks when {groupSize - 1} tap &ldquo;Join&rdquo; — you included makes {groupSize}
        </p>

        <p className={styles.expiryNote}>
          Expires on its own. No one is notified when it fizzles.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className={styles.lightBtn}
          disabled={!vibeDraftValid(vibeDraft) || busy || (audience === 'area' && needsArea)}
          onClick={() => void light()}
        >
          {busy ? 'Lighting…' : 'Light it'}
        </button>
      </div>
      {drunkAsk ? (
        <DrunkConfirmSheet
          text="You're in drunk mode and this beacon would be PUBLIC — anyone on this server could join. Tonight-you is sure?"
          confirmLabel="Light it 🍻"
          onConfirm={() => {
            setDrunkAsk(false);
            void light(true);
          }}
          onCancel={() => setDrunkAsk(false)}
        />
      ) : null}
    </div>
    </Portal>
  );
}

/** The dashed "+ I'm bored" pill (Local tab) — Royal v2 (ref 10): it sits in
 * flow directly under the live beacon card, still one tap to the sheet. */
export function BoredButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${styles.boredWrap} ${styles.beaconVars}`}>
      <button type="button" className={styles.boredBtn} onClick={() => setOpen(true)}>
        <span aria-hidden>+</span> I&rsquo;m bored
      </button>
      {open ? <BeaconCreateSheet onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
