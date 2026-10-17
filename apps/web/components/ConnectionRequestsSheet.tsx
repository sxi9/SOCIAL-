'use client';

// Pending connection requests (v0.5a — API.md §1.28). Accepting pings the
// requester (an answer they asked for); declining DELETES the row and is
// silent to them — the copy never threatens a "rejection notice".
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Connection } from '@socialchat/shared';
import { acceptConnection, declineConnection, refreshConnections } from '@/lib/connections';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import sheet from './beacons.module.css';
import st from './social.module.css';

export default function ConnectionRequestsSheet({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshConnections();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const incoming = state.connections?.incoming ?? [];

  async function accept(conn: Connection): Promise<void> {
    if (busyId) return;
    setBusyId(conn.id);
    setError(null);
    try {
      await acceptConnection(conn.id);
    } catch {
      setError('Could not accept — try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function decline(conn: Connection): Promise<void> {
    if (busyId) return;
    setBusyId(conn.id);
    setError(null);
    try {
      await declineConnection(conn);
    } catch {
      setError('Could not decline — try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className={sheet.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Friend requests">
        <div className={sheet.sheetHead}>
          <h2>Friend requests</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {incoming.length === 0 ? (
          <p className={st.connEmpty}>No pending requests. Peaceful, honestly.</p>
        ) : (
          incoming.map((conn) => (
            <div key={conn.id} className={st.connRow}>
              <Link href={`/u/${encodeURIComponent(conn.user.username)}`} onClick={onClose}>
                <Avatar avatar={conn.user.avatar} name={conn.user.display_name} size={40} />
              </Link>
              <span className={st.connName}>
                <strong>{conn.user.display_name}</strong>
                <span>@{conn.user.username}</span>
              </span>
              <span className={st.connActions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId !== null}
                  onClick={() => void accept(conn)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busyId !== null}
                  onClick={() => void decline(conn)}
                >
                  Decline
                </button>
              </span>
            </div>
          ))
        )}
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          Declining is quiet — nobody gets a &ldquo;rejected&rdquo; ping, and they can ask again later.
        </p>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          <Link href="/connections" onClick={onClose}>
            All your friends →
          </Link>
        </p>
      </div>
    </div>
  );
}
