'use client';

// Quick-react popover (v0.2 reactions, API.md §1.12): six common emoji plus a
// "+" that expands to the full static grid (~40, lib/emoji.ts — hand-rolled,
// no picker library). Anchored above a bubble by chat.module.css `.picker`.
// v0.4 (§1.19): leads with the avatar STAMP — react with your own face. One
// stamp per user per message; disabled (with a hint) until you have an avatar.
import { useEffect, useState } from 'react';
import type { Avatar as AvatarDto } from '@socialchat/shared';
import { EMOJI_GRID, QUICK_REACTIONS } from '@/lib/emoji';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useAppState } from '@/lib/useStore';
import styles from './chat.module.css';
import exp from './expression.module.css';

interface ReactionPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** v0.4 stamps: toggle my avatar stamp on this message. */
  onStamp?: () => void;
  stamped?: boolean;
  myAvatar?: AvatarDto | null;
}

export default function ReactionPicker({ onPick, onClose, onStamp, stamped, myAvatar }: ReactionPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reducedMotion = useReducedMotion();
  const state = useAppState();
  const avatarReady = myAvatar?.status === 'ready' && myAvatar.static_url !== null;
  // Animated on hover/focus (the stamp preview winks at you); static otherwise.
  // Fully still under prefers-reduced-motion or avatar_motion 'off' (§5 rules).
  const motionOk = !reducedMotion && state.me?.avatar_motion !== 'off';
  const stampSrc =
    hovered && motionOk && myAvatar?.animated_url ? myAvatar.animated_url : myAvatar?.static_url ?? null;

  return (
    <>
      <button type="button" className={styles.pickerBackdrop} aria-label="Close reactions" onClick={onClose} />
      <div className={styles.picker} role="menu" aria-label="React to this message" data-overlay-part="picker">
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
            {onStamp ? (
              <button
                type="button"
                role="menuitem"
                className={`${exp.stampPick}${stamped ? ` ${exp.stampPickOn}` : ''}`}
                aria-label={
                  !avatarReady
                    ? 'Stamp with your avatar (add an avatar first)'
                    : stamped
                      ? 'Remove your avatar stamp'
                      : 'Stamp with your avatar'
                }
                title={!avatarReady ? 'Add an avatar to stamp with your face' : undefined}
                disabled={!avatarReady}
                onClick={onStamp}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => setHovered(false)}
              >
                {stampSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={stampSrc} alt="" draggable={false} />
                ) : (
                  <span aria-hidden style={{ fontSize: 18, lineHeight: '26px' }}>
                    🙂
                  </span>
                )}
              </button>
            ) : null}
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
