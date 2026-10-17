'use client';

// Friends list (v0.5a — API.md §1.28): accepted connections by username,
// pending requests to me, and my pending requests. Removals/declines are
// silent to the other party by contract. No counts framed as scores — this is
// an address book, not a leaderboard.
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Connection, ConversationResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import {
  acceptConnection,
  declineConnection,
  refreshConnections,
  removeConnection,
} from '@/lib/connections';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Avatar from '@/components/Avatar';
import TabPage from '@/components/TabPage';
import st from '@/components/social.module.css';

function ConnectionsView() {
  const state = useAppState();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshConnections();
  }, []);

  const conns = state.connections;

  async function run(id: string, fn: () => Promise<void>, failCopy: string): Promise<void> {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch {
      setError(failCopy);
    } finally {
      setBusyId(null);
    }
  }

  async function message(conn: Connection): Promise<void> {
    await run(
      conn.id,
      async () => {
        const res = await api.post<ConversationResponse>('/api/conversations', {
          type: 'dm',
          user_id: conn.user.id,
        });
        upsertConversation(res.conversation);
        router.push(`/c/${res.conversation.id}`);
      },
      'Could not open a chat.'
    );
  }

  function row(conn: Connection, actions: ReactNode) {
    return (
      <div key={conn.id} className={st.connRow}>
        <Link href={`/u/${encodeURIComponent(conn.user.username)}`}>
          <Avatar avatar={conn.user.avatar} name={conn.user.display_name} size={40} />
        </Link>
        <span className={st.connName}>
          <strong>{conn.user.display_name}</strong>
          <span>@{conn.user.username}</span>
        </span>
        <span className={st.connActions}>{actions}</span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Friends</h1>
      </header>
      {!conns ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : (
        <div className="settings-section">
          {error ? <p className="error-text">{error}</p> : null}

          {conns.incoming.length > 0 ? (
            <>
              <h2>Requests</h2>
              <div className="card">
                {conns.incoming.map((conn) =>
                  row(
                    conn,
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busyId !== null}
                        onClick={() => void run(conn.id, () => acceptConnection(conn.id), 'Could not accept.')}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busyId !== null}
                        onClick={() => void run(conn.id, () => declineConnection(conn), 'Could not decline.')}
                      >
                        Decline
                      </button>
                    </>
                  )
                )}
              </div>
            </>
          ) : null}

          <h2>Friends</h2>
          <div className="card">
            {conns.connections.length === 0 ? (
              <p className={st.connEmpty}>
                No connections yet. Friends also include people you DM — connect to share stories,
                posts and beacons with someone before the first chat.
              </p>
            ) : (
              conns.connections.map((conn) =>
                row(
                  conn,
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId !== null}
                      onClick={() => void message(conn)}
                    >
                      Message
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busyId !== null}
                      onClick={() => {
                        if (window.confirm(`Remove ${conn.user.display_name} as a friend? They won't be told.`)) {
                          void run(conn.id, () => removeConnection(conn), 'Could not remove.');
                        }
                      }}
                    >
                      Remove
                    </button>
                  </>
                )
              )
            )}
          </div>

          {conns.outgoing.length > 0 ? (
            <>
              <h2>Sent</h2>
              <div className="card">
                {conns.outgoing.map((conn) =>
                  row(
                    conn,
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId !== null}
                      onClick={() => void run(conn.id, () => removeConnection(conn), 'Could not cancel.')}
                    >
                      Cancel
                    </button>
                  )
                )}
              </div>
            </>
          ) : null}

          <p className="muted small" style={{ margin: '14px 2px 0' }}>
            &ldquo;Friends&rdquo; everywhere in Bored Chat means your connections plus the people you
            DM — that&rsquo;s who sees your stories, posts and friends-only beacons.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <TabPage active="profile">
      <ConnectionsView />
    </TabPage>
  );
}
