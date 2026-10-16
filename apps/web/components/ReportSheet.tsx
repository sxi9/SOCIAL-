'use client';

// Report sheet (v0.3 — API.md §1.14). One short optional reason, then
// POST /api/reports. No one is notified; nothing else changes (FEATURES #29).
import { useEffect, useState } from 'react';
import { REPORT_REASON_MAX_CHARS, type CreateReportRequest } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import styles from './beacons.module.css';

/** The target identity — reason is collected here. */
export type ReportTarget =
  | { kind: 'user'; user_id: string }
  | { kind: 'message'; conversation_id: string; seq: number }
  | { kind: 'beacon'; beacon_id: string };

const TITLES: Record<ReportTarget['kind'], string> = {
  user: 'Report this person',
  message: 'Report this message',
  beacon: 'Report this beacon',
};

export default function ReportSheet({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    const body: CreateReportRequest = { ...target, reason: reason.trim() };
    try {
      await api.post('/api/reports', body);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('You have sent a lot of reports this hour — try again later.');
      } else {
        setError('Could not send the report. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={TITLES[target.kind]}>
        <div className={styles.sheetHead}>
          <h2>{TITLES[target.kind]}</h2>
          <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {done ? (
          <>
            <p className="ok-text">Thanks — a human will take a look.</p>
            <p className={styles.sheetNote}>No one is told you reported this.</p>
            <button type="button" className="btn" onClick={onClose} style={{ marginTop: 8 }}>
              Done
            </button>
          </>
        ) : (
          <>
            <p className={styles.sheetNote} style={{ marginTop: 0 }}>
              Tell us what&rsquo;s wrong (optional). Reports go to moderators only — no one is
              notified.
            </p>
            <textarea
              className="input"
              rows={3}
              placeholder="What happened?"
              value={reason}
              maxLength={REPORT_REASON_MAX_CHARS}
              onChange={(e) => setReason(e.target.value)}
              style={{ marginTop: 10 }}
            />
            {error ? <p className="error-text">{error}</p> : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void submit()}
              style={{ marginTop: 10, width: '100%' }}
            >
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
