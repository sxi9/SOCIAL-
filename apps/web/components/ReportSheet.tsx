'use client';

// Report sheet (v0.3 — API.md §1.14; widened v0.8b — §1.62/§1.66/§1.69).
// One short reason, then POST /api/reports. No one is notified; nothing else
// changes (FEATURES #29). v0.8b binding UX contracts carried here:
//   * message reports render REPORT_CONTEXT_CONSENT_COPY beside an UNCHECKED
//     include-context checkbox — the report sends fine without it;
//   * anonymous-message and canvas-overlay reports SAY that the author's real
//     identity is attached (anonymity never survives a report).
import { useEffect, useState } from 'react';
import {
  REPORT_CONTEXT_CONSENT_COPY,
  REPORT_REASON_MAX_CHARS,
  type CreateReportRequest,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import styles from './beacons.module.css';

/** The target identity — reason is collected here. */
export type ReportTarget =
  | { kind: 'user'; user_id: string }
  | { kind: 'message'; conversation_id: string; seq: number }
  | { kind: 'beacon'; beacon_id: string }
  | { kind: 'anon_message'; thread_id: string; message_id: string }
  | { kind: 'story_overlay'; story_id: string; overlay_id: string };

const TITLES: Record<ReportTarget['kind'], string> = {
  user: 'Report this person',
  message: 'Report this message',
  beacon: 'Report this beacon',
  anon_message: 'Report this anonymous message',
  story_overlay: 'Report this canvas addition',
};

export default function ReportSheet({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [includeContext, setIncludeContext] = useState(false); // unchecked by default (binding)
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
    const body: CreateReportRequest =
      target.kind === 'message'
        ? { ...target, reason: reason.trim(), include_context: includeContext }
        : { ...target, reason: reason.trim() };
    try {
      await api.post('/api/reports', body);
      setDone(true);
      // v0.7.1 §1.56: the shared confirmation toast (the sheet's done view
      // keeps the "no one is told" reassurance for whoever lingers).
      toast('Report sent — a human will take a look');
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
            {target.kind === 'anon_message' ? (
              // §1.62 binding: anonymity never survives a report — say so.
              <p className={styles.sheetNote}>
                🎭 The sender was only ever anonymous to <em>you</em> — this report attaches their
                real identity for the moderators.
              </p>
            ) : null}
            {target.kind === 'story_overlay' ? (
              // §1.66: the overlay author is attached server-side.
              <p className={styles.sheetNote}>
                🎨 The moderators see who drew this — attribution is attached automatically.
              </p>
            ) : null}
            <textarea
              className="input"
              rows={3}
              placeholder="What happened?"
              value={reason}
              maxLength={REPORT_REASON_MAX_CHARS}
              onChange={(e) => setReason(e.target.value)}
              style={{ marginTop: 10 }}
            />
            {target.kind === 'message' ? (
              // v0.8b §1.69 (binding UX contract): the EXACT consent copy,
              // unchecked by default. Without it the admin context viewer
              // answers 404 for this report.
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 13 }}
              >
                <input
                  type="checkbox"
                  checked={includeContext}
                  onChange={(e) => setIncludeContext(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{REPORT_CONTEXT_CONSENT_COPY}</span>
              </label>
            ) : null}
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
