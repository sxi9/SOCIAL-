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
  BEACON_VIBES,
  type BeaconAudience,
  type BeaconVibe,
  type SettingsResponse,
  type UpdateMeResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { createBeacon, fmtCountdown, presetWindow, VIBE_EMOJI, VIBE_LABEL, type WhenPreset } from '@/lib/beacons';
import { setMe, setSettings } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
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

  const [vibe, setVibe] = useState<BeaconVibe | null>(null);
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

  async function light(): Promise<void> {
    if (!vibe || busy) return;
    const w = presetWindow(when);
    if (!w.valid) {
      setError('That window already closed — pick another time.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createBeacon({
        vibe,
        note: note.trim(),
        audience,
        spark_threshold: groupSize - 1,
        starts_at: w.starts_at,
        expires_at: w.expires_at,
      });
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
    <div
      className={`${styles.sheetBackdrop} ${styles.beaconVars}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Light a beacon">
        <div className={styles.sheetHead}>
          <h2>Bored? Light a beacon 🔥</h2>
          <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Friends tap in, and when enough do — it&rsquo;s a plan.
        </p>

        <div className={styles.sheetLabel}>What&rsquo;s the vibe?</div>
        <div className={styles.vibeGrid} role="radiogroup" aria-label="Vibe">
          {BEACON_VIBES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={vibe === v}
              className={`${styles.vibeChip}${vibe === v ? ` ${styles.vibeChipOn}` : ''}`}
              onClick={() => setVibe(v)}
            >
              <span aria-hidden>{VIBE_EMOJI[v]}</span>
              <span>{VIBE_LABEL[v]}</span>
            </button>
          ))}
        </div>

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

        <div className={styles.sheetLabel}>How many of you?</div>
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
            {groupSize} of you
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
          <span className={styles.stepHint}>sparks when {groupSize - 1} tap &ldquo;I&rsquo;m in&rdquo;</span>
        </div>

        <div className={styles.sheetLabel}>Anything else?</div>
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
          disabled={!vibe || busy || (audience === 'area' && needsArea)}
          onClick={() => void light()}
        >
          {busy ? 'Lighting…' : 'Light it 🔥'}
        </button>
      </div>
    </div>
  );
}

/** The floating mascot-yellow "I'm bored" button (Local tab) — docked
 * bottom-right so it never stacks on the board's own controls (fixer r1). */
export function BoredButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${styles.boredWrap} ${styles.beaconVars}`}>
      <button type="button" className={styles.boredBtn} onClick={() => setOpen(true)}>
        <MiniBlob />
        I&rsquo;m bored
      </button>
      {open ? <BeaconCreateSheet onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** Tiny drowsy blob face — the mascot peeking out of the button. */
function MiniBlob() {
  return (
    <svg width="26" height="26" viewBox="0 0 120 120" aria-hidden focusable="false">
      <path
        d="M60 16 C84 16 102 32 103 58 C104 86 88 106 60 106 C32 106 16 86 17 58 C18 32 36 16 60 16 Z"
        fill="#3b2d07"
        opacity="0.9"
      />
      <ellipse cx="44" cy="54" rx="7" ry="4.5" fill="#ffd166" />
      <ellipse cx="76" cy="54" rx="7" ry="4.5" fill="#ffd166" />
      <path d="M50 78 L70 78" stroke="#ffd166" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}
