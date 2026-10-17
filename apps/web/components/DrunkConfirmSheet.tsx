'use client';

// 🍻 The "you sure?" confirm (v0.8a — API.md §1.57, FEATURES #73). CLIENT-side
// by contract: the server neither knows nor records who hesitated. It
// interposes while drunk mode is live, before (a) sending into a cold DM —
// Conversation.last_message_at older than 30 d, or a brand-new DM — and
// (b) every public write: public post, public beacon, listing. One calm
// question, no judgement, the mascot just slightly concerned.
import { useEffect } from 'react';
import Mascot from './Mascot';
import Portal from './Portal';
import sheet from './beacons.module.css';

export default function DrunkConfirmSheet({
  text,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="You sure?">
          <div className={sheet.sheetHead}>
            <h2>🍻 You sure?</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onCancel}>
              ×
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0 8px' }}>
            {/* The slightly concerned mascot — a friend, not a bouncer. */}
            <Mascot state="wince" size={64} />
          </div>
          <p style={{ margin: '0 0 12px' }}>{text}</p>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: 8 }}
            autoFocus
            onClick={onCancel}
          >
            Hold off for tonight
          </button>
        </div>
      </div>
    </Portal>
  );
}
