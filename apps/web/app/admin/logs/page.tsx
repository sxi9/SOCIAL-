'use client';

// Admin log viewer (§1.41) — the Redis ring tail: pino warn/error from api and
// worker plus every admin action ('admin' level — the audit trail, ADR-013).
// Offset-paged newest-first; level filtering is client-side over what's loaded.
import { useEffect, useState } from 'react';
import type { AdminLogEntry } from '@socialchat/shared';
import { ADMIN_LOG_LEVELS, LOG_RING_MAX } from '@socialchat/shared';
import { adminLogs } from '@/lib/admin';
import ad from '@/components/admin.module.css';

type Level = (typeof ADMIN_LOG_LEVELS)[number];

export default function AdminLogsPage() {
  const [entries, setEntries] = useState<AdminLogEntry[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [levels, setLevels] = useState<Set<Level>>(new Set(ADMIN_LOG_LEVELS));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(offset: number, reset: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await adminLogs(offset);
      setEntries((prev) => (reset ? res.entries : [...(prev ?? []), ...res.entries]));
      setNextOffset(res.next_offset);
    } catch {
      setError('Could not read the log ring.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(0, true);
  }, []);

  function toggle(level: Level): void {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next.size === 0 ? new Set(ADMIN_LOG_LEVELS) : next;
    });
  }

  const shown = (entries ?? []).filter((e) => levels.has(e.level));

  return (
    <div>
      <h2>Logs</h2>
      <p className={ad.note}>
        A capped Redis ring (newest first, {LOG_RING_MAX} max) — operational telemetry, not product
        data. Every admin action lands here with its actor; a noisy error loop can wash old entries
        out (stdout keeps the second copy).
      </p>
      <div className={ad.levelChips} role="group" aria-label="Level filter">
        {ADMIN_LOG_LEVELS.map((lvl) => (
          <button
            key={lvl}
            type="button"
            aria-pressed={levels.has(lvl)}
            className={`btn${levels.has(lvl) ? ' btn-primary' : ''}`}
            onClick={() => toggle(lvl)}
          >
            {lvl}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" disabled={busy} onClick={() => void load(0, true)}>
          {busy ? '…' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      {entries === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : shown.length === 0 ? (
        <p className="muted small">Nothing at these levels.</p>
      ) : (
        <div className={ad.tableWrap}>
          {shown.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={ad.logRow}>
              <span className={ad.logTs}>{new Date(e.ts).toLocaleString()}</span>
              <span
                className={`${ad.logLevel} ${
                  e.level === 'admin' ? ad.logAdmin : e.level === 'error' ? ad.logError : ad.logWarn
                }`}
              >
                {e.level}
              </span>
              <span>
                {e.actor ? <strong>@{e.actor.username} </strong> : null}
                {e.msg}
                {e.data && Object.keys(e.data).length > 0 ? (
                  <span className={ad.logData}> {JSON.stringify(e.data)}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
      {nextOffset !== null ? (
        <button type="button" className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={() => void load(nextOffset, false)}>
          Older entries
        </button>
      ) : null}
    </div>
  );
}
