'use client';

// Wave 1 (§1.8): the one-time consent sheet before the first "Make me
// discoverable" / roulette spin for accounts that signed up before the
// attestation existed (age_attested_at null; the server answers 403
// age_attestation_required until POST /api/users/me/attest-age lands).
// Nothing is stored but the moment of the tick — no date of birth (#78b).
import { useState } from 'react';
import { AGE_MIN, type MeResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { setMe } from '@/lib/store';
import { useOverlayEscape } from '@/lib/overlays';
import Portal from './Portal';
import SafetyStrip from './SafetyStrip';
import styles from './beacons.module.css';

export default function AgeGateSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useOverlayEscape(onClose);

  async function confirm(): Promise<void> {
    if (!ticked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<MeResponse>('/api/users/me/attest-age');
      setMe(res.user);
      onDone();
    } catch {
      setError('Could not save that. Try again.');
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={styles.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Before you meet strangers">
          <div className={styles.sheetHead}>
            <h2>Before you meet strangers</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className={styles.sheetNote} style={{ marginTop: 0 }}>
            Discovery and roulette put you in front of people you don&rsquo;t know. This server asks
            everyone who uses them to be at least {AGE_MIN}. Nothing about your age is stored — only
            that you confirmed it.
          </p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 14 }}>
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I am {AGE_MIN} or older.</span>
          </label>
          <SafetyStrip style={{ marginTop: 12 }} />
          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ticked || busy}
            onClick={() => void confirm()}
            style={{ marginTop: 12, width: '100%' }}
          >
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
