'use client';

// Connections (v0.5a — API.md §1.28): accepted connections by username,
// pending requests to me, and my pending requests. Removals/declines are
// silent to the other party by contract. No counts framed as scores — this is
// an address book, not a leaderboard. v2 Royal (proto 33): serif title +
// "+ Find" action, REQUESTS with Accept/Ignore pills, a dashed share-your-link
// card when the request queue is empty, YOUR PEOPLE rows with a ··· menu.
// (No exclusive ✦ marker — no such concept exists in the product.)
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
import InviteSheet from '@/components/InviteSheet';
import SuggestionCards from '@/components/SuggestionCards';
import TabPage from '@/components/TabPage';
import bz from '@/components/beacons.module.css';
import cm from '@/components/community.module.css';

function ConnectionsView() {
  const state = useAppState();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

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

  function row(conn: Connection, actions: ReactNode, sub?: string) {
    return (
      <div key={conn.id} className={cm.memberRow}>
        <Link href={`/u/${encodeURIComponent(conn.user.username)}`} className={cm.memberWho}>
          <Avatar avatar={conn.user.avatar} name={conn.user.display_name} size={44} />
          <span className={cm.personText}>
            <strong>{conn.user.display_name}</strong>
            <span className={cm.personSub}>{sub ?? `@${conn.user.username}`}</span>
          </span>
        </Link>
        {actions}
      </div>
    );
  }

  // The ··· menu on a YOUR PEOPLE row: Message / Remove (silent by contract).
  function kebab(conn: Connection) {
    const open = menuFor === conn.id;
    return (
      <div className={bz.cardRel}>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={`Options for ${conn.user.display_name}`}
          aria-expanded={open}
          onClick={() => setMenuFor(open ? null : conn.id)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5.5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="18.5" cy="12" r="1.6" />
          </svg>
        </button>
        {open ? (
          <>
            <button type="button" className={bz.menuBackdrop} aria-label="Close menu" onClick={() => setMenuFor(null)} />
            <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 34 }}>
              <button
                type="button"
                role="menuitem"
                disabled={busyId !== null}
                onClick={() => {
                  setMenuFor(null);
                  void message(conn);
                }}
              >
                Message
              </button>
              <button
                type="button"
                role="menuitem"
                className={bz.menuDanger}
                disabled={busyId !== null}
                onClick={() => {
                  setMenuFor(null);
                  if (window.confirm(`Remove ${conn.user.display_name} as a friend? They won't be told.`)) {
                    void run(conn.id, () => removeConnection(conn), 'Could not remove.');
                  }
                }}
              >
                Remove
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M14.5 5.5 8 12l6.5 6.5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <h1 style={{ fontSize: 20 }}>Connections</h1>
        <Link href="/people" className={cm.secHeadBtn}>
          + Find
        </Link>
      </header>
      {!conns ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : (
        <div className="settings-section">
          {error ? <p className="error-text">{error}</p> : null}

          <h2>Requests</h2>
          {conns.incoming.length > 0 ? (
            conns.incoming.map((conn) =>
              row(
                conn,
                <span style={{ display: 'inline-flex', gap: 8, flex: 'none' }}>
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
                    Ignore
                  </button>
                </span>
              )
            )
          ) : (
            // proto 33: the dashed empty-state card → the existing invite flow.
            <button type="button" className={cm.dashCard} onClick={() => setInviteOpen(true)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="8.4" r="3.4" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M5.5 19.5 c1.3 -3.2 3.7 -4.7 6.5 -4.7 s5.2 1.5 6.5 4.7"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              <span className={cm.dashCardText}>No more requests — share your link to meet people.</span>
              <span className={cm.dashCardAction}>Copy</span>
            </button>
          )}

          <h2>Your people</h2>
          {conns.connections.length === 0 ? (
            <p className="muted small" style={{ margin: '4px 2px 0' }}>
              No connections yet. Friends also include people you DM — connect to share stories,
              posts and beacons with someone before the first chat.
            </p>
          ) : (
            conns.connections.map((conn) => row(conn, kebab(conn)))
          )}

          {conns.outgoing.length > 0 ? (
            <>
              <h2>Sent</h2>
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
            </>
          ) : null}

          {/* v0.8b §1.64: people-you-may-know — dismissible, silent. */}
          <SuggestionCards moreHref="/people" />

          <p className="muted small" style={{ margin: '14px 2px 0' }}>
            Your connections plus the people you DM are your &ldquo;friends&rdquo; everywhere in
            Bored Chat — that&rsquo;s who sees your stories, posts and friends-only beacons.
          </p>
        </div>
      )}
      {inviteOpen ? <InviteSheet onClose={() => setInviteOpen(false)} /> : null}
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
