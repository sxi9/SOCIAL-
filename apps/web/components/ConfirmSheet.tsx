'use client';

// The app-wide confirm sheet (lib/confirm.ts) — replaces every
// window.confirm() (owner report, 2026-10-18: the browser box says
// "<host> says" and looks like a system alert on phones). Same bottom-sheet
// shell as the other sheets; Cancel is focused so Enter never destroys.
import { useEffect } from 'react';
import { usePendingConfirm } from '@/lib/confirm';
import Portal from './Portal';
import sheet from './beacons.module.css';

export default function ConfirmSheet() {
  const ask = usePendingConfirm();
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ask.resolve(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask]);
  if (!ask) return null;
  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) ask.resolve(false);
        }}
      >
        <div className={sheet.sheet} role="alertdialog" aria-modal="true" aria-label="Please confirm">
          <p style={{ margin: '6px 0 16px', fontSize: 16, lineHeight: 1.45 }}>{ask.text}</p>
          <button
            type="button"
            className={`btn ${ask.danger ? 'btn-danger' : 'btn-primary'}`}
            style={{ width: '100%' }}
            onClick={() => ask.resolve(true)}
          >
            {ask.confirmLabel}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: 8 }}
            autoFocus
            onClick={() => ask.resolve(false)}
          >
            {ask.cancelLabel}
          </button>
        </div>
      </div>
    </Portal>
  );
}
