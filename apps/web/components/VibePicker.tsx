'use client';

// Vibe picker (v0.3 chips + the v0.7 §1.47 custom vibe). The preset grid plus
// a "Custom" chip that opens an emoji grid + one-word label; recents are
// CLIENT-SIDE only (localStorage via lib/beacons, ≤ 6) — never synced, never
// serialized. Used by BeaconCreateSheet and BeaconEditSheet.
import { useState } from 'react';
import {
  BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN,
  BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS,
  BEACON_VIBES,
  type BeaconVibe,
} from '@socialchat/shared';
import { readVibeRecents, VIBE_EMOJI, VIBE_LABEL } from '@/lib/beacons';
import { EMOJI_GRID } from '@/lib/emoji';
import styles from './beacons.module.css';

export interface VibeDraft {
  vibe: BeaconVibe | null;
  custom_vibe_emoji: string;
  custom_vibe_label: string;
}

export function vibeDraftValid(d: VibeDraft): boolean {
  if (d.vibe === null) return false;
  if (d.vibe !== 'custom') return true;
  return d.custom_vibe_emoji.length > 0 && d.custom_vibe_label.trim().length > 0;
}

export default function VibePicker({
  value,
  onChange,
}: {
  value: VibeDraft;
  onChange: (next: VibeDraft) => void;
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Read once per mount — recents are a convenience, not live state.
  const [recents] = useState(readVibeRecents);

  return (
    <div>
      <div className={styles.vibeGrid} role="radiogroup" aria-label="Vibe">
        {/* BEACON_VIBES is the preset set; 'custom' gets its own chip below. */}
        {BEACON_VIBES.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value.vibe === v}
            className={`${styles.vibeChip}${value.vibe === v ? ` ${styles.vibeChipOn}` : ''}`}
            onClick={() => onChange({ ...value, vibe: v })}
          >
            <span aria-hidden>{VIBE_EMOJI[v]}</span>
            <span>{VIBE_LABEL[v]}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={value.vibe === 'custom'}
          className={`${styles.vibeChip}${value.vibe === 'custom' ? ` ${styles.vibeChipOn}` : ''}`}
          onClick={() => onChange({ ...value, vibe: 'custom' })}
        >
          <span aria-hidden>{value.custom_vibe_emoji || '✨'}</span>
          <span>{value.custom_vibe_label.trim() || 'Custom'}</span>
        </button>
      </div>

      {value.vibe === 'custom' ? (
        <>
          <div className={styles.customVibeBox}>
            <button
              type="button"
              className={`${styles.customEmojiBtn}${value.custom_vibe_emoji ? ` ${styles.customEmojiBtnOn}` : ''}`}
              aria-label={value.custom_vibe_emoji ? `Emoji: ${value.custom_vibe_emoji} — tap to change` : 'Pick an emoji'}
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((v) => !v)}
            >
              {value.custom_vibe_emoji || '🙂'}
            </button>
            <input
              className="input"
              placeholder="one word — “karaoke”"
              aria-label="Custom vibe label"
              value={value.custom_vibe_label}
              maxLength={BEACON_CUSTOM_VIBE_LABEL_MAX_CHARS}
              onChange={(e) => onChange({ ...value, custom_vibe_label: e.target.value })}
            />
          </div>
          {emojiOpen ? (
            <div className={styles.customEmojiGrid} role="listbox" aria-label="Pick an emoji">
              {EMOJI_GRID.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="option"
                  aria-selected={value.custom_vibe_emoji === emoji}
                  onClick={() => {
                    // Zod counts UTF-16 units; the grid entries all fit.
                    onChange({
                      ...value,
                      custom_vibe_emoji: emoji.slice(0, BEACON_CUSTOM_VIBE_EMOJI_MAX_LEN),
                    });
                    setEmojiOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
          {recents.length > 0 ? (
            <div className={styles.recentsRow} aria-label="Recent custom vibes">
              {recents.map((r) => (
                <button
                  key={`${r.emoji}:${r.label}`}
                  type="button"
                  className={styles.recentChip}
                  onClick={() =>
                    onChange({ vibe: 'custom', custom_vibe_emoji: r.emoji, custom_vibe_label: r.label })
                  }
                >
                  <span aria-hidden>{r.emoji}</span>
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
