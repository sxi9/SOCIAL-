'use client';

// The mood picker (v0.8a — API.md §1.57, FEATURES #72–#73). Four ways to feel:
// preset chips, a custom emoji+word, 🎢 swing mode (2–6 presets the worker
// rotates every ~30 min) and 🍻 drunk mode (the guardrailed one). Every mood
// auto-expires after ~4 h — always current, never stale — and the fade time
// shows subtly, owner-only (others NEVER see a countdown on your feelings).
// Drunk visibility DEFAULTS to connections-only even when other moods were
// public (§1.57 guardrail) — still overridable, but the default is the point.
import { useEffect, useRef, useState } from 'react';
import {
  MOOD_DRUNK_DEFAULT_VISIBILITY,
  MOOD_EMOJI_MAX_LEN,
  MOOD_LABEL_MAX_CHARS,
  MOOD_PRESETS,
  MOOD_SWING_SET_MAX,
  MOOD_SWING_SET_MIN,
  type MoodVisibility,
  type SetMoodRequest,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { clearMood, refreshMyMood, setMood } from '@/lib/mood';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import MoodChip from './MoodChip';
import Portal from './Portal';
import sheet from './beacons.module.css';
import idm from './identity.module.css';

type PickKind = 'preset' | 'custom' | 'swing' | 'drunk';

const KIND_TABS: { kind: PickKind; label: string }[] = [
  { kind: 'preset', label: 'Presets' },
  { kind: 'custom', label: 'Custom' },
  { kind: 'swing', label: '🎢 Swing' },
  { kind: 'drunk', label: '🍻 Drunk' },
];

const VIS_OPTIONS: { value: MoodVisibility; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'connections', label: 'Connections' },
  { value: 'nobody', label: 'Only me' },
];

function fadeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MoodSheet({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const ms = state.moodState;

  const [kind, setKind] = useState<PickKind>('preset');
  const [preset, setPreset] = useState<string | null>(null);
  const [customEmoji, setCustomEmoji] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [swingSet, setSwingSet] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<MoodVisibility>('everyone');
  const [visTouched, setVisTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The owner read carries the full state (visibility/expires_at/swing_set).
  useEffect(() => {
    void refreshMyMood().catch(() => undefined);
  }, []);
  const seededRef = useRef(false);
  useEffect(() => {
    if (!ms || seededRef.current) return;
    seededRef.current = true;
    if (!visTouched) setVisibility(ms.visibility);
    // Seed the picker from the current mood so "Change" starts where I am.
    const cur = ms.mood;
    if (!cur) return;
    setKind(cur.kind);
    if (cur.kind === 'preset') setPreset(cur.label);
    else if (cur.kind === 'custom') {
      setCustomEmoji(cur.emoji);
      setCustomLabel(cur.label);
    } else if (cur.kind === 'swing' && ms.swing_set) {
      setSwingSet(ms.swing_set.map((e) => e.label));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // §1.57: drunk DEFAULTS to connections-only (overridable; untouched only).
  const effectiveVis: MoodVisibility =
    kind === 'drunk' && !visTouched ? MOOD_DRUNK_DEFAULT_VISIBILITY : visibility;

  const canSave = (() => {
    if (busy) return false;
    if (kind === 'preset') return preset !== null;
    if (kind === 'custom') return customEmoji.trim().length > 0 && customLabel.trim().length > 0;
    if (kind === 'swing')
      return swingSet.length >= MOOD_SWING_SET_MIN && swingSet.length <= MOOD_SWING_SET_MAX;
    return true; // drunk needs nothing else
  })();

  function toggleSwing(label: string): void {
    setSwingSet((prev) =>
      prev.includes(label)
        ? prev.filter((l) => l !== label)
        : prev.length < MOOD_SWING_SET_MAX
          ? [...prev, label]
          : prev
    );
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    let req: SetMoodRequest;
    if (kind === 'preset') {
      req = { kind: 'preset', label: preset!, visibility: effectiveVis };
    } else if (kind === 'custom') {
      req = {
        kind: 'custom',
        emoji: customEmoji.trim(),
        label: customLabel.trim(),
        visibility: effectiveVis,
      };
    } else if (kind === 'swing') {
      req = {
        kind: 'swing',
        swing_set: swingSet.map((label) => ({
          emoji: MOOD_PRESETS.find((p) => p.label === label)?.emoji ?? '🎢',
          label,
        })),
        visibility: effectiveVis,
      };
    } else {
      req = { kind: 'drunk', visibility: effectiveVis };
    }
    try {
      await setMood(req);
      toast(kind === 'drunk' ? 'Drunk mode on 🍻 — guardrails up' : 'Mood set — it fades on its own');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Easy on the mood swings — try again in a bit.');
      } else if (err instanceof ApiError && err.code === 'bad_mood_preset') {
        setError('That preset does not exist any more — pick another.');
      } else {
        setError('Could not set the mood — try again.');
      }
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clearMood();
      toast('Mood cleared');
      onClose();
    } catch {
      setError('Could not clear it — try again.');
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Set your mood">
          <div className={sheet.sheetHead}>
            <h2>How are you?</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>

          {ms?.mood && ms.expires_at ? (
            <p style={{ margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <MoodChip mood={ms.mood} />
              {/* Subtle, OWNER-only: others never see a countdown (§1.57). */}
              <span className={idm.moodFade}>fades by {fadeLabel(ms.expires_at)}</span>
            </p>
          ) : (
            <p className="muted small" style={{ margin: '0 0 8px' }}>
              A chip on your name for a few hours — it fades on its own, no trace left.
            </p>
          )}

          <div className={sheet.segRow} role="radiogroup" aria-label="Mood kind">
            {KIND_TABS.map((t) => (
              <button
                key={t.kind}
                type="button"
                role="radio"
                aria-checked={kind === t.kind}
                className={`${sheet.segBtn}${kind === t.kind ? ` ${sheet.segOn}` : ''}`}
                onClick={() => setKind(t.kind)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {kind === 'preset' ? (
            <div className={idm.moodGrid} role="radiogroup" aria-label="Pick a mood">
              {MOOD_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.label}
                  className={`${idm.moodPick}${preset === p.label ? ` ${idm.moodPickOn}` : ''}`}
                  onClick={() => setPreset(p.label)}
                >
                  <span aria-hidden>{p.emoji}</span> {p.label}
                </button>
              ))}
            </div>
          ) : null}

          {kind === 'custom' ? (
            <div className={idm.customRow}>
              <input
                className={`input ${idm.customEmoji}`}
                aria-label="Mood emoji"
                placeholder="🫠"
                value={customEmoji}
                maxLength={MOOD_EMOJI_MAX_LEN}
                onChange={(e) => setCustomEmoji(e.target.value)}
              />
              <input
                className="input"
                aria-label="One word for it"
                placeholder="one word for it…"
                value={customLabel}
                maxLength={MOOD_LABEL_MAX_CHARS}
                onChange={(e) => setCustomLabel(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ) : null}

          {kind === 'swing' ? (
            <>
              <p className="muted small" style={{ margin: '0 0 6px' }}>
                Pick {MOOD_SWING_SET_MIN}–{MOOD_SWING_SET_MAX} moods — the chip rides the
                rollercoaster every half hour or so.
              </p>
              <div className={idm.moodGrid} aria-label="Swing set">
                {MOOD_PRESETS.map((p) => {
                  const on = swingSet.includes(p.label);
                  return (
                    <button
                      key={p.label}
                      type="button"
                      aria-pressed={on}
                      className={`${idm.moodPick}${on ? ` ${idm.moodPickOn}` : ''}`}
                      onClick={() => toggleSwing(p.label)}
                    >
                      <span aria-hidden>{p.emoji}</span> {p.label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {kind === 'drunk' ? (
            <p className="muted small" style={{ margin: '0 0 6px' }}>
              🍻 Tonight-mode, with guardrails: every send gets a 10-second undo, you&rsquo;ll be
              asked &ldquo;you sure?&rdquo; before messaging someone you haven&rsquo;t talked to
              in a month and before posting publicly, and people who can see the chip get a
              gentle heads-up in your chats. It wears off on its own — no trace.
            </p>
          ) : null}

          <div className={sheet.sheetLabel}>Who sees it</div>
          <div className={sheet.segRow} role="radiogroup" aria-label="Mood visibility">
            {VIS_OPTIONS.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={effectiveVis === v.value}
                className={`${sheet.segBtn}${effectiveVis === v.value ? ` ${sheet.segOn}` : ''}`}
                onClick={() => {
                  setVisTouched(true);
                  setVisibility(v.value);
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
          {kind === 'drunk' && !visTouched ? (
            <p className={idm.moodFade} style={{ margin: '4px 0 0' }}>
              Drunk mode defaults to connections only — change it if you really want.
            </p>
          ) : null}

          {error ? <p className="error-text">{error}</p> : null}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {ms?.mood ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void clear()}>
                Clear mood
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {busy ? 'Setting…' : 'Set mood'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
