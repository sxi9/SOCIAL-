'use client';

// Public profile page (ARCHITECTURE §5.4): one of the two animated-WebP
// surfaces (with the open-chat header). Renders GET /api/users/:username.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { UserPublic, UserResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { formatLastSeen } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';

function PublicProfile({ username }: { username: string }) {
  const state = useAppState();
  const [user, setUser] = useState<UserPublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUser(null);
    setError(null);
    void api
      .get<UserResponse>(`/api/users/${encodeURIComponent(username)}`)
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This user does not exist.'
            : 'Could not load this profile.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  // user.updated keeps an open profile live (avatar transcode landing, etc.).
  const peer = user
    ? [...state.conversations.values()]
        .flatMap((c) => c.participants)
        .find((p) => p.user.id === user.id)?.user ?? user
    : null;
  const shown = peer ?? user;
  const presence = shown ? state.presence.get(shown.id) : undefined;

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Profile</h1>
        <span />
      </header>

      {error ? (
        <div className="center-screen muted" role="alert">
          {error}
        </div>
      ) : !shown ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : (
        <div className="settings-section">
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Profile pages render the animated WebP (motion-gated, §5.4). */}
            <Avatar avatar={shown.avatar} name={shown.display_name} size={96} animated />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0 }}>{shown.display_name}</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                @{shown.username}
              </p>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {presence?.online ? 'online' : formatLastSeen(presence?.last_seen_at ?? shown.last_seen_at)}
              </p>
            </div>
          </div>
          {shown.bio ? (
            <div className="card">
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.bio}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function PublicProfilePage() {
  const params = useParams<{ username: string }>();
  return (
    <AppShell>
      <PublicProfile username={params.username} />
    </AppShell>
  );
}
