'use client';

// The NON-USER report on a public share page (v0.8b — API.md §1.67). Reason
// REQUIRED (an anonymous empty report is noise); hard-rate-limited per IP
// server-side (SHARE_REPORT_RATE_PER_DAY_PER_IP). Stored reporter-less and
// fed to the §1.41 admin queue.
import { useState } from 'react';
import { REPORT_REASON_MAX_CHARS } from '@socialchat/shared';
import sheet from './beacons.module.css';
import Portal from './Portal';

export default function ShareReportLink({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const text = reason.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ reason: text }),
      });
      if (res.status === 429) {
        setError('Too many reports from here today — try again tomorrow.');
      } else if (!res.ok) {
        setError('Could not send the report.');
      } else {
        setDone(true);
      }
    } catch {
      setError('Could not send the report — check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Report this page
      </button>
      {open ? (
        <Portal>
          <div
            className={sheet.sheetBackdrop}
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Report this page">
              <div className={sheet.sheetHead}>
                <h2>Report this page</h2>
                <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={() => setOpen(false)}>
                  ×
                </button>
              </div>
              {done ? (
                <>
                  <p className="ok-text">Thanks — the people who run this server will take a look.</p>
                  <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>
                    Done
                  </button>
                </>
              ) : (
                <>
                  <p className={sheet.sheetNote} style={{ marginTop: 0 }}>
                    No account needed. Say what&rsquo;s wrong (required) — this goes to the
                    moderators of this server only.
                  </p>
                  <textarea
                    className="input"
                    rows={3}
                    placeholder="What's wrong with this page?"
                    value={reason}
                    maxLength={REPORT_REASON_MAX_CHARS}
                    onChange={(e) => setReason(e.target.value)}
                    style={{ marginTop: 10, fontSize: 16 }}
                  />
                  {error ? <p className="error-text">{error}</p> : null}
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginTop: 10, width: '100%' }}
                    disabled={busy || !reason.trim()}
                    onClick={() => void submit()}
                  >
                    {busy ? 'Sending…' : 'Send report'}
                  </button>
                </>
              )}
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  );
}
