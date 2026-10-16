'use client';

// Public profile page (ARCHITECTURE §5.4): one of the two animated-WebP
// surfaces (with the open-chat header). Renders GET /api/users/:username.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { UserPublic, UserResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { formatLastSeen } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import ReportSheet from '@/components/ReportSheet';
import bz from '@/components/beacons.module.css';

function PublicProfile({ username }: { username: string }) {
  const state = useAppState();
  const router = useRouter();
  const [user, setUser] = useState<UserPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);

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
  const isMe = shown !== null && shown.id === state.me?.id;

  async function block(): Promise<void> {
    if (!shown || blockBusy) return;
    setMenu(false);
    setBlockBusy(true);
    try {
      await api.put(`/api/users/${shown.id}/block`);
      setBlocked(true);
    } catch {
      /* idempotent — a failure here just leaves the profile up */
    } finally {
      setBlockBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Profile</h1>
        {shown && !isMe && !blocked ? (
          <div className={bz.cardRel}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Profile options"
              onClick={() => setMenu((v) => !v)}
            >
              ⋯
            </button>
            {menu ? (
              <>
                <button
                  type="button"
                  className={bz.menuBackdrop}
                  aria-label="Close menu"
                  onClick={() => setMenu(false)}
                />
                <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 36 }}>
                  <button type="button" role="menuitem" className={bz.menuDanger} onClick={() => void block()}>
                    Block @{shown.username}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setReport(true);
                    }}
                  >
                    Report
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <span />
        )}
      </header>
      {report && shown ? (
        <ReportSheet target={{ kind: 'user', user_id: shown.id }} onClose={() => setReport(false)} />
      ) : null}

      {blocked ? (
        <div className="settings-section">
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: 0 }}>Blocked.</p>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              You won&rsquo;t see each other around here any more. Change your mind any time in{' '}
              <Link href="/settings/blocked">Blocked people</Link>.
            </p>
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => router.push('/')}>
              Back to chats
            </button>
          </div>
        </div>
      ) : error ? (
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
          {/* Plan karma (§1.15): a private fact about yourself, never a score
              against anyone else — shown on your OWN profile only, never
              ranked, never compared (PSYCHOLOGY design rule 3). */}
          {isMe && (shown.beacons_created > 0 || shown.beacons_sparked > 0) ? (
            <div className="card">
              <p style={{ margin: 0 }}>
                🔥 lit {shown.beacons_created} {shown.beacons_created === 1 ? 'beacon' : 'beacons'} ·{' '}
                {shown.beacons_sparked} sparked
              </p>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Only you see this line.
              </p>
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
