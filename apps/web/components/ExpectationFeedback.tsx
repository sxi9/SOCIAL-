'use client';

// v0.6 (API.md §1.45, PSYCHOLOGY finding #10): the PRIVATE one-tap
// expectation feedback. Shown exactly once per match (the caller guards via
// lib/discovery feedbackSeen/markFeedbackSeen), skippable, never re-surfaced,
// never shown to the other person — it feeds only the anonymous
// encouragement aggregate.
import { useEffect } from 'react';
import type { ExpectationContext, ExpectationVerdict } from '@socialchat/shared';
import { markFeedbackSeen, sendFeedback } from '@/lib/discovery';
import bcn from './beacons.module.css';
import styles from './discovery.module.css';

const VERDICTS: { value: ExpectationVerdict; emoji: string; label: string }[] = [
  { value: 'better', emoji: '😄', label: 'Better than I expected' },
  { value: 'same', emoji: '😐', label: 'About what I expected' },
  { value: 'worse', emoji: '😕', label: 'Worse' },
];

export default function ExpectationFeedback({
  context,
  conversationId,
  onClose,
}: {
  context: ExpectationContext;
  conversationId: string;
  onClose: () => void;
}) {
  // Showing it at all consumes the one shot — skip or tap, it never returns.
  useEffect(() => {
    markFeedbackSeen(conversationId);
  }, [conversationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function tap(verdict: ExpectationVerdict): void {
    void sendFeedback(context, conversationId, verdict);
    onClose();
  }

  return (
    <div
      className={bcn.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bcn.sheet} role="dialog" aria-modal="true" aria-label="How was that?">
        <div className={bcn.sheetHead}>
          <h2>How was the stranger?</h2>
          <button type="button" className={bcn.sheetClose} aria-label="Skip" onClick={onClose}>
            ×
          </button>
        </div>
        <p className={bcn.sheetNote} style={{ marginTop: 0 }}>
          One tap, totally private — they will never see it. It only helps nudge the next hesitant
          person.
        </p>
        <div className={styles.verdictRow}>
          {VERDICTS.map((v) => (
            <button key={v.value} type="button" className={styles.verdictBtn} onClick={() => tap(v.value)}>
              <span className={styles.verdictEmoji} aria-hidden>
                {v.emoji}
              </span>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" style={{ marginTop: 10, width: '100%' }} onClick={onClose}>
          Skip
        </button>
      </div>
    </div>
  );
}
