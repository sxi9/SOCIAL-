'use client';

// First-run spotlight tour (v0.8a — API.md §1.61, FEATURES #80). Shown ONCE
// after first login on a device: TOUR_SEEN_KEY is localStorage, device-local
// by design (the PUSH_EXPLAINER_SEEN_KEY rule — orientation is per-device,
// and a declined tour never re-nags; blocked storage means never nag at all).
// Skippable at EVERY step. Steps anchor to the shell tabs via [data-tour=…];
// a missing anchor (e.g. the plans step on this shell) just shows the card
// without a ring. Reduced motion: no spotlight travel animation — plain
// dismissible cards (the ring is skipped entirely).
import { useCallback, useEffect, useState } from 'react';
import { TOUR_SEEN_KEY, TOUR_STEPS } from '@socialchat/shared';
import { useReducedMotion } from '@/lib/useReducedMotion';
import Portal from './Portal';
import idm from './identity.module.css';

function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked → we could not remember a skip; never nag
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function SpotlightTour() {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!tourSeen()) setOpen(true);
  }, []);

  const current = TOUR_STEPS[step];

  const measure = useCallback(() => {
    if (!open || reduced) {
      setRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${current.anchor}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    // A hidden anchor (the tab bar hides while a chat is open on mobile)
    // measures 0×0 — show the plain card instead of a ring at the origin.
    if (r.width === 0 || r.height === 0) {
      setRect(null);
      return;
    }
    setRect({ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 });
  }, [open, reduced, current.anchor]);

  useEffect(() => {
    measure();
    if (!open) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, open]);

  if (!open) return null;

  const done = (): void => {
    markSeen();
    setOpen(false);
  };

  const next = (): void => {
    if (step >= TOUR_STEPS.length - 1) done();
    else setStep((s) => s + 1);
  };

  const last = step === TOUR_STEPS.length - 1;

  return (
    <Portal>
      {/* With a ring, the ring's giant shadow does the dimming; without one
          (missing anchor / reduced motion) the plain backdrop dims instead. */}
      {rect ? (
        <div
          className={idm.tourRing}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          aria-hidden
        />
      ) : (
        <div className={idm.tourBackdrop} role="presentation" onClick={done} />
      )}
      <div className={idm.tourCard} role="dialog" aria-modal="true" aria-label="Quick tour">
        <div className={idm.tourDots} aria-hidden>
          {TOUR_STEPS.map((s, i) => (
            <span key={s.id} className={`${idm.tourDot}${i === step ? ` ${idm.tourDotOn}` : ''}`} />
          ))}
        </div>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <div className={idm.tourBtns}>
          <button type="button" className="btn btn-ghost" onClick={done}>
            Skip
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={next}>
            {last ? 'Done ✨' : 'Next'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
