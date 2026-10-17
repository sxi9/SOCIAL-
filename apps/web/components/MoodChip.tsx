'use client';

// The mood chip (v0.8a — API.md §1.57). Renders whatever chip the server
// resolved for THIS viewer — visibility/blocks/expiry already applied, so a
// rendered chip is by definition one this viewer may see. kind drives the
// motion: 'drunk' wobbles, 'swing' morphs on every rotation (the inner span
// is keyed on the label so user.updated remounts it). Reduced motion: the
// chip renders static — no wobble, no morph (§1.58 replacement rule).
import type { Mood } from '@socialchat/shared';
import { useReducedMotion } from '@/lib/useReducedMotion';
import idm from './identity.module.css';

export default function MoodChip({ mood, small = false }: { mood: Mood; small?: boolean }) {
  const reduced = useReducedMotion();
  const cls = [
    idm.moodChip,
    small ? idm.moodChipSm : '',
    !reduced && mood.kind === 'drunk' ? idm.moodDrunk : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} title={`feeling ${mood.label}`}>
      <span
        key={`${mood.emoji}:${mood.label}`}
        className={!reduced && mood.kind === 'swing' ? idm.moodMorphIn : undefined}
      >
        <span aria-hidden>{mood.emoji}</span> {mood.label}
      </span>
    </span>
  );
}
