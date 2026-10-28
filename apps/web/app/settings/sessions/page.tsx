'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SessionInfo, SessionsResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { logout } from '@/lib/connection';
import { formatTime } from '@/lib/format';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';

const CHEV = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...CHEV} />
    </svg>
  );
}

function SessionsSettings() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const res = await api.get<SessionsResponse>('/api/auth/sessions');
      setSessions(res.sessions);
    } catch {
      setError('Could not load devices.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(session: SessionInfo): Promise<void> {
    if (revoking) return;
    setRevoking(session.id);
    setError(null);
    try {
      // Revocation closes that session's live sockets immediately (§1.1).
      await api.del(`/api/auth/sessions/${session.id}`);
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== session.id) : prev));
    } catch {
      setError('Could not revoke that device.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 IA: reached from Devices & security. */}
        <Link href="/settings/security" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Devices</h1>
      </header>
      <div className="settings-section">
        <p className="muted small">
          Sessions double as the device registry — revoking one signs that device out instantly.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        {sessions && sessions.length > 1 ? (
          // Wave 1 §1.2: the bulk door — every device but this one.
          <button
            type="button"
            className="btn"
            style={{ marginBottom: 12 }}
            onClick={() => {
              void confirmDialog('Sign out of every other device? They stop receiving messages immediately.', {
                confirmLabel: 'Sign them out',
                danger: true,
              }).then(async (ok) => {
                if (!ok) return;
                try {
                  await api.post('/api/auth/logout-all');
                  toast('Other devices signed out');
                  await load();
                } catch {
                  setError('Could not sign out the other devices.');
                }
              });
            }}
          >
            Sign out all other devices
          </button>
        ) : null}
        {sessions === null ? (
          <p className="muted">Loading…</p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 14 }}>
                  {s.user_agent ? s.user_agent.slice(0, 80) : 'Unknown device'}
                  {s.current ? <span className="chip" style={{ marginLeft: 8 }}>this device</span> : null}
                </strong>
                <p className="muted small" style={{ margin: '4px 0 0' }}>
                  {s.ip ?? 'unknown address'} · active {formatTime(s.last_seen_at)} · since {formatTime(s.created_at)}
                </p>
              </div>
              {s.current ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    void logout().then(() => router.replace('/login'));
                  }}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={revoking === s.id}
                  onClick={() => void revoke(s)}
                >
                  {revoking === s.id ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function SessionsPage() {
  return (
    <AppShell>
      <SessionsSettings />
    </AppShell>
  );
}
