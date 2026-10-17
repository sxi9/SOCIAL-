'use client';

// v0.7.1 notifications-on assurance (API.md §1.56, FEATURES #90b): the
// ONE-TIME post-login explainer — what push is for, with Enable now / Not
// now. Shows only when permission is still 'default' AND no subscription
// exists AND this device never saw it before. "Not now" (or a browser deny)
// writes PUSH_EXPLAINER_SEEN_KEY to localStorage — device-local by design
// (permission is a per-browser fact; the prompt state lives beside it) — and
// it never shows again on this device. No re-nags, no badges, no guilt
// (PSYCHOLOGY rule 5). Rendered through Portal like every sheet.
import { useEffect, useState } from 'react';
import { PUSH_EXPLAINER_SEEN_KEY } from '@socialchat/shared';
import { enablePush, getPushSubscription, pushSupported } from '@/lib/push';
import { toast } from '@/lib/toast';
import Mascot from './Mascot';
import Portal from './Portal';
import styles from './beacons.module.css';

function explainerSeen(): boolean {
  try {
    return localStorage.getItem(PUSH_EXPLAINER_SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked → never nag (we could not remember a decline)
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(PUSH_EXPLAINER_SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

export default function PushExplainer() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported() || explainerSeen()) return;
    if (Notification.permission !== 'default') return;
    let cancelled = false;
    void getPushSubscription()
      .then((sub) => {
        if (!cancelled && sub === null) setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!open) return null;

  function decline(): void {
    markSeen();
    setOpen(false);
  }

  async function enable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await enablePush();
      // Either way this device has answered — never re-nag (§1.56).
      markSeen();
      setOpen(false);
      if (ok) toast('Notifications are on');
    } catch {
      markSeen();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={styles.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) decline();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Turn on notifications?">
          <div className={styles.sheetHead}>
            <h2>Hear about it when it happens</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={decline}>
              ×
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 8px' }}>
            <Mascot state="wave" size={72} />
          </div>
          <p className={styles.sheetNote} style={{ marginTop: 0 }}>
            With notifications on, Bored Chat can reach you when the app is closed: new messages,
            incoming calls, plans that sparked, and the occasional anonymous wave. Nothing else —
            no streaks, no &ldquo;come back&rdquo; nudges, ever.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 10 }}
            disabled={busy}
            onClick={() => void enable()}
          >
            {busy ? 'Asking your browser…' : 'Enable now'}
          </button>
          <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={decline}>
            Not now
          </button>
          <p className={styles.sheetNote}>
            &ldquo;Not now&rdquo; means we never ask again on this device — you can always turn it
            on later in Settings.
          </p>
        </div>
      </div>
    </Portal>
  );
}
