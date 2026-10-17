'use client';

// Admin reports queue (§1.41) — consumes the v0.3 reports table. Target
// previews are METADATA ONLY: who/where/when/what-kind, never a message body.
// The only quoted content on this page is the reporter's own reason text.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminReport } from '@socialchat/shared';
import { ADMIN_NOTE_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { adminCloseReport, adminReports } from '@/lib/admin';
import { formatTime } from '@/lib/format';
import ad from '@/components/admin.module.css';

type StatusFilter = 'open' | 'closed' | null;

export default function AdminReportsPage() {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = (fetchSeq.current += 1);
    setError(null);
    try {
      const res = await adminReports(status, null);
      if (fetchSeq.current !== seq) return;
      setReports(res.reports);
      setCursor(res.next_cursor);
    } catch {
      if (fetchSeq.current === seq) setError('Could not load reports.');
    }
  }, [status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function more(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await adminReports(status, cursor);
      setReports((prev) => [...(prev ?? []), ...res.reports]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    }
  }

  return (
    <div>
      <h2>Reports</h2>
      <p className={ad.note}>
        Previews are metadata only — a reported message shows who/where/when/what-kind, never its
        body. The reason text is the reporter&rsquo;s own submission. Reports outlive their targets;
        previews go blank when the target is gone.
      </p>
      <div className={ad.levelChips} role="radiogroup" aria-label="Status filter">
        {(
          [
            { v: 'open' as StatusFilter, label: 'Open' },
            { v: 'closed' as StatusFilter, label: 'Closed' },
            { v: null as StatusFilter, label: 'All' },
          ] as const
        ).map((f) => (
          <button
            key={f.label}
            type="button"
            role="radio"
            aria-checked={status === f.v}
            className={`btn${status === f.v ? ' btn-primary' : ''}`}
            onClick={() => setStatus(f.v)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      {reports === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : reports.length === 0 ? (
        <p className="muted small">Nothing here. Quiet instance, good instance.</p>
      ) : (
        <>
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              onClosed={(updated) =>
                setReports((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)) ?? prev)
              }
            />
          ))}
          {cursor !== null ? (
            <button type="button" className="btn" onClick={() => void more()}>
              Load more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ReportCard({ report, onClosed }: { report: AdminReport; onClosed: (r: AdminReport) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminCloseReport(report.id, note.trim());
      onClosed(res.report);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'report_closed') {
        setError('Already closed (maybe by another admin) — refresh to see the note.');
      } else {
        setError('Could not close the report.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={ad.reportCard}>
      <div className={ad.reportHead}>
        <span className={`${ad.flag}${report.status === 'open' ? ` ${ad.flagBad}` : ''}`}>
          {report.status}
        </span>
        <span className={ad.flag}>{report.kind}</span>
        <span>
          by{' '}
          {report.reporter ? (
            <strong>@{report.reporter.username}</strong>
          ) : (
            <span className={ad.dim}>account deleted</span>
          )}
        </span>
        <span className={ad.dim}>{formatTime(report.created_at)}</span>
      </div>

      <p className={ad.reportReason}>{report.reason || <span className={ad.dim}>no reason text</span>}</p>

      <div className={ad.targetBox}>
        {report.target_user ? (
          <>
            Target user: <strong>@{report.target_user.username}</strong> ({report.target_user.display_name})
          </>
        ) : report.target_message ? (
          <>
            Target message: {report.target_message.type} by{' '}
            {report.target_message.sender ? `@${report.target_message.sender.username}` : 'deleted account'} ·{' '}
            {formatTime(report.target_message.created_at)} · conv{' '}
            <span className={ad.mono}>{report.target_message.conversation_id.slice(0, 8)}…</span> seq{' '}
            {report.target_message.seq}
            {report.target_message.deleted ? ' · since deleted' : ''} <em>(bodies are never shown here)</em>
          </>
        ) : report.target_beacon ? (
          <>
            Target beacon: {report.target_beacon.vibe} · {report.target_beacon.status} · by{' '}
            {report.target_beacon.creator ? `@${report.target_beacon.creator.username}` : 'deleted account'}
          </>
        ) : (
          <>Target gone — the report outlived it.</>
        )}
      </div>

      {report.status === 'open' ? (
        <div className={ad.closeRow}>
          <input
            className="input"
            placeholder="Close note (optional, audit-logged)"
            value={note}
            maxLength={ADMIN_NOTE_MAX_CHARS}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void close()}>
            {busy ? 'Closing…' : 'Close'}
          </button>
        </div>
      ) : (
        <p className={ad.note} style={{ margin: '10px 0 0' }}>
          Closed {report.closed_at ? formatTime(report.closed_at) : ''}
          {report.closed_by ? ` by @${report.closed_by.username}` : ''}
          {report.close_note ? ` — “${report.close_note}”` : ''}
        </p>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </article>
  );
}
