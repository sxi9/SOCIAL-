'use client';

// Public profile page (ARCHITECTURE §5.4; v0.5a §1.37): animated avatar +
// the rich profile — 3-GIF strip, interest chips, work/skills — plus connect
// and message actions (§1.28). No endorsement counts, no connection counts,
// no profile view counters: a page about a person, not a scoreboard.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type {
  Attachment,
  ConversationResponse,
  Profile,
  Trust,
  UserProfileResponse,
  UserPublic,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { connectionStateFor, connectTo, refreshConnections, removeConnection } from '@/lib/connections';
import { formatLastSeen } from '@/lib/format';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useReducedMotion } from '@/lib/useReducedMotion';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import ReportSheet from '@/components/ReportSheet';
import TrustPanel from '@/components/TrustPanel';
import bz from '@/components/beacons.module.css';
import st from '@/components/social.module.css';

function PublicProfile({ username }: { username: string }) {
  const state = useAppState();
  const router = useRouter();
  const [user, setUser] = useState<UserPublic | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [trust, setTrust] = useState<Trust | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUser(null);
    setProfile(null);
    setTrust(null);
    setError(null);
    void api
      .get<UserProfileResponse>(`/api/users/${encodeURIComponent(username)}`)
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setProfile(res.profile ?? null);
        // v0.5b §1.40: defaulted server-side; guard keeps old payloads clean.
        setTrust(res.trust ?? null);
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

  // Connection state powers the Connect button (§1.28).
  useEffect(() => {
    void refreshConnections();
  }, []);

  // user.updated keeps an open profile live (avatar transcode landing, etc.).
  const peer = user
    ? [...state.conversations.values()]
        .flatMap((c) => c.participants)
        .find((p) => p.user.id === user.id)?.user ?? user
    : null;
  const shown = peer ?? user;
  const presence = shown ? state.presence.get(shown.id) : undefined;
  const isMe = shown !== null && shown.id === state.me?.id;
  const connState = shown && !isMe && state.connections ? connectionStateFor(shown.id) : null;

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

  async function connect(): Promise<void> {
    if (!shown || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await connectTo(shown.id);
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 429
          ? 'Easy there — too many requests this hour.'
          : 'Could not send the request right now.',
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function message(): Promise<void> {
    if (!shown || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'dm',
        user_id: shown.id,
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch {
      setActionError('Could not open a chat.');
      setActionBusy(false);
    }
  }

  const connectButton = (() => {
    if (!connState) return null;
    switch (connState.kind) {
      case 'none':
        return (
          <button type="button" className="btn btn-primary" disabled={actionBusy} onClick={() => void connect()}>
            Connect
          </button>
        );
      case 'outgoing':
        return (
          <button
            type="button"
            className="btn"
            disabled={actionBusy}
            onClick={() => {
              setActionBusy(true);
              void removeConnection(connState.connection)
                .catch(() => setActionError('Could not cancel.'))
                .finally(() => setActionBusy(false));
            }}
          >
            Requested · cancel
          </button>
        );
      case 'incoming':
        // Their request to me — connect() auto-accepts it server-side (§1.28).
        return (
          <button type="button" className="btn btn-primary" disabled={actionBusy} onClick={() => void connect()}>
            Accept request
          </button>
        );
      case 'accepted':
        return (
          <button
            type="button"
            className="btn"
            disabled={actionBusy}
            onClick={() => {
              if (window.confirm(`Remove ${shown?.display_name ?? 'them'} as a friend? They won't be told.`)) {
                setActionBusy(true);
                void removeConnection(connState.connection)
                  .catch(() => setActionError('Could not remove.'))
                  .finally(() => setActionBusy(false));
              }
            }}
          >
            ✓ Friends
          </button>
        );
    }
  })();

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
        ) : isMe ? (
          <Link href="/settings/profile" className="btn btn-ghost">
            Edit
          </Link>
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

          {!isMe ? (
            <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {connectButton}
              <button type="button" className="btn" disabled={actionBusy} onClick={() => void message()}>
                Message
              </button>
              {actionError ? (
                <p className="error-text" style={{ width: '100%', margin: 0 }}>
                  {actionError}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* §1.37: the 3-GIF strip — animation gated by the VIEWER's settings. */}
          {profile && profile.media.length > 0 ? (
            <div className="card">
              <div className={st.gifStrip}>
                {profile.media.map((m) => (
                  <ProfileGif key={m.id} media={m} />
                ))}
              </div>
            </div>
          ) : null}

          {shown.bio ? (
            <div className="card">
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.bio}</p>
            </div>
          ) : null}

          {profile && profile.interests.length > 0 ? (
            <div className="card">
              <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Into</h3>
              <div className={st.interestChips}>
                {profile.interests.map((tag) => (
                  <span key={tag} className="chip">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {profile && profile.entries.length > 0 ? (
            <div className="card">
              {(['work', 'skill'] as const).map((kind) => {
                const list = profile.entries.filter((e) => e.kind === kind);
                if (list.length === 0) return null;
                return (
                  <div key={kind}>
                    <h3 style={{ margin: '6px 0 2px', fontSize: 14 }}>
                      {kind === 'work' ? '💼 Work' : '✨ Skills'}
                    </h3>
                    {list.map((entry) => (
                      <div key={entry.id} className={st.entryRow}>
                        <span className={st.entryText}>
                          <strong>{entry.title}</strong>
                          {entry.detail ? <span>{entry.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* v0.5b §1.40: marketplace trust — safety information from real
              listing contacts, shown ONLY here (never ranked, never compared;
              the no-scores argument lives in ADR-012). */}
          {trust ? <TrustPanel username={shown.username} trust={trust} /> : null}

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

/**
 * One tile of the 3-GIF strip. Animation is gated by the VIEWER's settings
 * (prefers-reduced-motion + their own avatar_motion — §1.37/§5 motion rules):
 * 'auto' plays, 'reduced' plays on hover, 'off' stays static.
 */
function ProfileGif({ media }: { media: Attachment }) {
  const state = useAppState();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const motion = state.me?.avatar_motion ?? 'auto';
  const animate = !reduced && motion !== 'off' && (motion === 'auto' || hovered);
  const src = animate ? media.url : media.thumb_url ?? media.url;
  return (
    <span
      className={st.gifTile}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" />
    </span>
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
