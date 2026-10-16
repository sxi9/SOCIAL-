'use client';

// Quick-react popover (v0.2 reactions, API.md §1.12): six common emoji plus a
// "+" that expands to the full static grid (~40, lib/emoji.ts — hand-rolled,
// no picker library). Anchored above a bubble by chat.module.css `.picker`.
import { useEffect, useState } from 'react';
import { EMOJI_GRID, QUICK_REACTIONS } from '@/lib/emoji';
import styles from './chat.module.css';

interface ReactionPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export default function ReactionPicker({ onPick, onClose }: ReactionPickerProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button type="button" className={styles.pickerBackdrop} aria-label="Close reactions" onClick={onClose} />
      <div className={styles.picker} role="menu" aria-label="React with an emoji">
        {expanded ? (
          <div className={styles.emojiGrid}>
            {EMOJI_GRID.map((emoji) => (
              <button key={emoji} type="button" role="menuitem" onClick={() => onPick(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.quickRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <button key={emoji} type="button" role="menuitem" onClick={() => onPick(emoji)}>
                {emoji}
              </button>
            ))}
            <button
              type="button"
              className={styles.moreBtn}
              aria-label="More emoji"
              onClick={() => setExpanded(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M10 4 V16 M4 10 H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </>
  );
}
