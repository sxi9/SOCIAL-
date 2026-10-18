'use client';

// New chat (Royal v2, proto 14): search people up top, the three "New …"
// rows, then PEOPLE — recent DM partners from the conversations the client
// already holds, or live search results while typing. Starting a DM, creating
// a group/channel and the anon entry all keep their existing flows.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_GROUP_PARTICIPANTS,
  type ConversationResponse,
  type UserPublic,
  type UserSearchResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { dmPeer, formatLastSeen } from '@/lib/format';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import UserSearch from '@/components/UserSearch';
import cm from '@/components/community.module.css';
import styles from '@/components/list.module.css';

const MAX_INVITEES = MAX_GROUP_PARTICIPANTS - 1; // + creator = cap
const SEARCH_DEBOUNCE_MS = 300;

function NewConversation() {
  const state = useAppState();
  const router = useRouter();
  const meId = state.me?.id;
  const [mode, setMode] = useState<'root' | 'group' | 'channel'>('root');
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<UserPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Root search (debounced GET /api/users?q=) — tapping a person starts a DM.
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserPublic[]>([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const query = q.trim();
    if (!query) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<UserSearchResponse>(`/api/users?q=${encodeURIComponent(query)}`);
          setResults(res.users);
        } catch {
          setResults([]);
        } finally {
          setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [q]);

  // v0.5a §1.35: a channel starts with just you (role 'owner') — membership
  // arrives through invite links, never bulk-adds.
  async function createChannel(): Promise<void> {
    if (busy) return;
    const name = title.trim();
    if (!name) {
      setError('Give the channel a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'channel',
        title: name,
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch {
      setError('Could not create the channel.');
      setBusy(false);
    }
  }

  async function startDm(userId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // DM replays dedupe via dm_key server-side (§1.4) — 200 returns the existing one.
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'dm',
        user_id: userId,
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch {
      setError('Could not start the conversation.');
      setBusy(false);
    }
  }

  function addMember(user: UserPublic): void {
    setError(null);
    setMembers((prev) => {
      if (prev.some((u) => u.id === user.id)) return prev;
      if (prev.length >= MAX_INVITEES) {
        setError(`Groups are capped at ${MAX_GROUP_PARTICIPANTS} members.`);
        return prev;
      }
      return [...prev, user];
    });
  }

  async function createGroup(): Promise<void> {
    if (busy) return;
    const name = title.trim();
    if (!name) {
      setError('Give the group a name.');
      return;
    }
    if (members.length === 0) {
      setError('Add at least one member.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'group',
        title: name,
        user_ids: members.map((u) => u.id),
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'group_too_large') {
        setError(`Groups are capped at ${MAX_GROUP_PARTICIPANTS} members.`);
      } else {
        setError('Could not create the group.');
      }
      setBusy(false);
    }
  }

  // PEOPLE: recent DM partners, newest conversation first (client-held data).
  const recentPeers: UserPublic[] = (() => {
    if (!meId) return [];
    const seen = new Set<string>();
    return [...state.conversations.values()]
      .filter((c) => c.type === 'dm')
      .sort((a, b) => {
        const ta = a.last_message_at ?? a.created_at;
        const tb = b.last_message_at ?? b.created_at;
        return new Date(tb).getTime() - new Date(ta).getTime();
      })
      .flatMap((c) => {
        const peer = dmPeer(c, meId);
        if (!peer || seen.has(peer.id)) return [];
        seen.add(peer.id);
        return [peer];
      });
  })();

  function personSub(user: UserPublic): { text: string; online: boolean } {
    const presence = state.presence.get(user.id);
    if (presence?.online) return { text: 'online', online: true };
    if (user.mood) return { text: `${user.mood.label} right now`, online: false };
    return { text: formatLastSeen(user.last_seen_at ?? null), online: false };
  }

  return (
    <div className="page">
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Back"
          onClick={() => {
            if (mode !== 'root') setMode('root');
            else router.push('/');
          }}
        >
          <ChevronLeftIcon />
        </button>
        <h1 className={cm.pageTitle}>
          {mode === 'group' ? 'New group' : mode === 'channel' ? 'New channel' : 'New chat'}
        </h1>
      </header>

      {mode === 'root' ? (
        <>
          <div className={cm.ncSearchWrap}>
            <input
              className={`input ${cm.ncSearchInput}`}
              type="search"
              placeholder="Search people"
              aria-label="Search people"
              value={q}
              autoComplete="off"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div>
            <button type="button" className={cm.ncRow} onClick={() => setMode('group')}>
              <span className={cm.ncIcon} aria-hidden>
                <GroupIcon />
              </span>
              New group
              <span className={cm.ncChevron} aria-hidden>
                <ChevronRightIcon />
              </span>
            </button>
            <button type="button" className={cm.ncRow} onClick={() => setMode('channel')}>
              <span className={cm.ncIcon} aria-hidden>
                <BroadcastIcon />
              </span>
              New channel
              <span className={cm.ncChevron} aria-hidden>
                <ChevronRightIcon />
              </span>
            </button>
            <button type="button" className={cm.ncRow} onClick={() => router.push('/anon')}>
              <span className={cm.ncIcon} aria-hidden>
                <MaskBubbleIcon />
              </span>
              New anonymous thread
              <span className={cm.ncChevron} aria-hidden>
                <ChevronRightIcon />
              </span>
            </button>
          </div>

          {error ? (
            <p className="error-text" style={{ margin: '8px 20px 0' }}>
              {error}
            </p>
          ) : null}

          <div className={cm.secLabel}>People</div>
          {searching ? (
            <p className="muted small" style={{ margin: '4px 20px' }}>
              Searching…
            </p>
          ) : null}
          {q.trim() ? (
            <>
              {results.map((user) => {
                const sub = personSub(user);
                return (
                  <button
                    key={user.id}
                    type="button"
                    className={cm.personRow}
                    disabled={busy}
                    onClick={() => void startDm(user.id)}
                  >
                    <Avatar avatar={user.avatar} name={user.display_name} size={44} />
                    <span className={cm.personText}>
                      <strong>{user.display_name}</strong>
                      <span className={`${cm.personSub}${sub.online ? ` ${cm.personSubOnline}` : ''}`}>
                        {sub.text}
                      </span>
                    </span>
                  </button>
                );
              })}
              {!searching && results.length === 0 ? (
                <p className="muted small" style={{ margin: '4px 20px' }}>
                  No one found.
                </p>
              ) : null}
            </>
          ) : recentPeers.length > 0 ? (
            recentPeers.map((peer) => {
              const sub = personSub(peer);
              return (
                <button
                  key={peer.id}
                  type="button"
                  className={cm.personRow}
                  disabled={busy}
                  onClick={() => void startDm(peer.id)}
                >
                  <Avatar avatar={peer.avatar} name={peer.display_name} size={44} />
                  <span className={cm.personText}>
                    <strong>{peer.display_name}</strong>
                    <span className={`${cm.personSub}${sub.online ? ` ${cm.personSubOnline}` : ''}`}>
                      {sub.text}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <p className="muted small" style={{ margin: '4px 20px' }}>
              Search for someone to start your first chat.
            </p>
          )}
        </>
      ) : null}

      {mode === 'group' ? (
        <div className="settings-section">
          <div className="field">
            <label htmlFor="group-title">Group name</label>
            <input
              id="group-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
            />
          </div>
          {members.length > 0 ? (
            <div className={styles.chips}>
              {members.map((u) => (
                <span key={u.id} className="chip">
                  {u.display_name}
                  <button
                    type="button"
                    aria-label={`Remove ${u.display_name}`}
                    onClick={() => setMembers((prev) => prev.filter((m) => m.id !== u.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <p className="muted small">
            {members.length}/{MAX_INVITEES} members added
          </p>
          <UserSearch
            onSelect={(user) => addMember(user)}
            excludeIds={new Set(members.map((m) => m.id))}
            placeholder="Add members"
          />
          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12 }}
            disabled={busy || members.length === 0 || !title.trim()}
            onClick={() => void createGroup()}
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      ) : null}

      {mode === 'channel' ? (
        <div className="settings-section">
          <div className="field">
            <label htmlFor="channel-title">Channel name</label>
            <input
              id="channel-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="e.g. campus happenings"
            />
          </div>
          <p className="muted small">
            A channel is a broadcast: only you and the admins you appoint can post — everyone
            else reads and reacts. People join through an invite link you share after creating
            it. No member counters, ever.
          </p>
          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12 }}
            disabled={busy || !title.trim()}
            onClick={() => void createChannel()}
          >
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ---- stroke icons (24-viewBox, 1.7px, round caps — the Tabs.tsx family) ---- */

function ChevronLeftIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9.5 6 L15.5 12 L9.5 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10" cy="8.6" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4.2 18.5 c1.2 -2.9 3.4 -4.3 5.8 -4.3 s4.6 1.4 5.8 4.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17.5 6.5 V11.5 M15 9 H20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function BroadcastIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="13.5" r="1.6" fill="currentColor" />
      <path d="M8.5 10 a5 5 0 0 1 7 0 M6 7.4 a8.6 8.6 0 0 1 12 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 15.5 V19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function MaskBubbleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4.5 c4.8 0 8 2.7 8 6.3 c0 3.6 -3.2 6.3 -8 6.3 c-0.9 0 -1.8 -0.1 -2.6 -0.3 L5.5 19 l1 -3.2 C4.9 14.5 4 12.8 4 10.8 C4 7.2 7.2 4.5 12 4.5 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="9.4" cy="10.6" r="1" fill="currentColor" />
      <circle cx="14.6" cy="10.6" r="1" fill="currentColor" />
    </svg>
  );
}

export default function NewConversationPage() {
  return (
    <AppShell>
      <NewConversation />
    </AppShell>
  );
}
