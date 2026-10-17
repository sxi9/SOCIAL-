'use client';

// Blocked users (v0.3 — API.md §1.14, FEATURES #29). Newest first, no
// timestamps. Unblock is idempotent; blocking itself lives on profiles.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BlockedListResponse, UserLite } from '@socialchat/shared';
import { api } from '@/lib/api';
import { canvasUnban, listCanvasBans } from '@/lib/stories';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';

function BlockedUsers() {
  const [users, setUsers] = useState<UserLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<BlockedListResponse>('/api/users/me/blocks')
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your blocked list.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unblock(user: UserLite): Promise<void> {
    if (busy) return;
    setBusy(user.id);
    setError(null);
    try {
      await api.del(`/api/users/${user.id}/block`);
      setUsers((prev) => (prev ? prev.filter((u) => u.id !== user.id) : prev));
    } catch {
      setError('Could not unblock — try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/settings/privacy" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Blocked people</h1>
        <span />
      </header>

      <div className="settings-section">
        {error ? <p className="error-text">{error}</p> : null}
        {!users ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : users.length === 0 ? (
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: 0 }}>No one&rsquo;s blocked.</p>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Good vibes only. If someone spoils that, block them from their profile.
            </p>
          </div>
        ) : (
          <div className="card" style={{ padding: 8 }}>
            {users.map((u) => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px' }}>
                <Avatar avatar={u.avatar} name={u.display_name} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{u.display_name}</div>
                  <div className="muted small">@{u.username}</div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy === u.id}
                  onClick={() => void unblock(u)}
                >
                  {busy === u.id ? '…' : 'Unblock'}
                </button>
              </div>
            ))}
          </div>
        )}
        {users && users.length > 0 ? (
          <p className="muted small" style={{ margin: '10px 2px' }}>
            Blocked people can&rsquo;t message you, see your profile, or join your beacons — and they
            are never told.
          </p>
        ) : null}

        {/* v0.8b §1.66: canvas bans — softer than a block; they just can't
            draw on MY stories any more (present and future). */}
        <CanvasBans />
      </div>
    </div>
  );
}

function CanvasBans() {
  const [users, setUsers] = useState<UserLite[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listCanvasBans()
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unban(user: UserLite): Promise<void> {
    if (busy) return;
    setBusy(user.id);
    setError(null);
    try {
      await canvasUnban(user.id);
      setUsers((prev) => (prev ? prev.filter((u) => u.id !== user.id) : prev));
    } catch {
      setError('Could not lift the ban — try again.');
    } finally {
      setBusy(null);
    }
  }

  if (!users || users.length === 0) return null;
  return (
    <>
      <h2 style={{ margin: '18px 2px 8px', fontSize: 15 }}>🎨 Banned from your canvases</h2>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="card" style={{ padding: 8 }}>
        {users.map((u) => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px' }}>
            <Avatar avatar={u.avatar} name={u.display_name} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{u.display_name}</div>
              <div className="muted small">@{u.username}</div>
            </div>
            <button type="button" className="btn" disabled={busy === u.id} onClick={() => void unban(u)}>
              {busy === u.id ? '…' : 'Allow again'}
            </button>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ margin: '10px 2px' }}>
        They can still see your stories — they just can&rsquo;t draw on them. They were never told.
      </p>
    </>
  );
}

export default function BlockedUsersPage() {
  return (
    <AppShell>
      <BlockedUsers />
    </AppShell>
  );
}
