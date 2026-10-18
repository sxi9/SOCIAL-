'use client';

// Channel member management (v0.5a — API.md §1.35). Owner/admin-only read: a
// PAGED, username-ordered list with a prefix search — deliberately NO member
// count anywhere (PSYCHOLOGY rule 3: no follower counts). Owner promotes/demotes
// admins; owner/admins remove members; admins are removable by the owner only;
// the owner can never leave or be removed (the channel is never headless).
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  ConversationListItem,
  ConversationResponse,
  ListParticipantsResponse,
  Participant,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import * as store from '@/lib/store';
import Avatar from './Avatar';
import sheet from './beacons.module.css';
import st from './social.module.css';
import { confirmDialog } from '@/lib/confirm';

const SEARCH_DEBOUNCE_MS = 300;

interface ChannelMembersSheetProps {
  conv: ConversationListItem | Conversation;
  meId: string;
  onClose: () => void;
}

export default function ChannelMembersSheet({ conv, meId, onClose }: ChannelMembersSheetProps) {
  const [rows, setRows] = useState<Participant[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const myRole = conv.participants.find((p) => p.user.id === meId)?.role ?? 'member';
  const amOwner = myRole === 'owner';

  const load = useCallback(
    async (reset: boolean, cur: string | null, query: string) => {
      const params = new URLSearchParams();
      if (cur && !reset) params.set('cursor', cur);
      if (query.trim()) params.set('q', query.trim());
      const qs = params.toString();
      try {
        const res = await api.get<ListParticipantsResponse>(
          `/api/conversations/${conv.id}/participants${qs ? `?${qs}` : ''}`
        );
        setRows((prev) => {
          const base = reset ? [] : prev;
          const seen = new Set(base.map((p) => p.user.id));
          return [...base, ...res.participants.filter((p) => !seen.has(p.user.id))];
        });
        setCursor(res.next_cursor);
        setLoaded(true);
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Only the owner and admins can see the member list.'
            : 'Could not load members.'
        );
        setLoaded(true);
      }
    },
    [conv.id]
  );

  useEffect(() => {
    void load(true, null, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Debounced prefix search (the §1.33 autocomplete read, reused here).
  useEffect(() => {
    if (!loaded) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void load(true, null, q), SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function setRole(p: Participant, role: 'admin' | 'member'): Promise<void> {
    if (busyId) return;
    setBusyId(p.user.id);
    setError(null);
    try {
      const res = await api.put<ConversationResponse>(
        `/api/conversations/${conv.id}/participants/${p.user.id}/role`,
        { role }
      );
      store.upsertConversation(res.conversation);
      setRows((prev) => prev.map((row) => (row.user.id === p.user.id ? { ...row, role } : row)));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only the channel owner can change roles.'
          : 'Could not change that role.'
      );
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: Participant): Promise<void> {
    if (busyId) return;
    if (!(await confirmDialog(`Remove ${p.user.display_name} from this channel?`))) return;
    setBusyId(p.user.id);
    setError(null);
    try {
      await api.del(`/api/conversations/${conv.id}/participants/${p.user.id}`);
      setRows((prev) => prev.filter((row) => row.user.id !== p.user.id));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Admins can only be removed by the owner.'
          : 'Could not remove them.'
      );
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
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Channel members">
        <div className={sheet.sheetHead}>
          <h2>Members</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <input
          className="input"
          type="search"
          placeholder="Search members"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 10 }}
        />
        {!loaded ? (
          <p className="muted small">
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className={st.connEmpty}>Nobody matches.</p>
        ) : (
          <div style={{ maxHeight: '48dvh', overflowY: 'auto' }}>
            {rows.map((p) => {
              const isMe = p.user.id === meId;
              const isOwner = p.role === 'owner';
              return (
                <div key={p.user.id} className={st.connRow}>
                  <Avatar avatar={p.user.avatar} name={p.user.display_name} size={36} />
                  <span className={st.connName}>
                    <strong>
                      {p.user.display_name}
                      {isMe ? ' (you)' : ''}
                    </strong>
                    <span>@{p.user.username}</span>
                  </span>
                  {p.role !== 'member' ? <span className={st.roleChip}>{p.role}</span> : null}
                  {!isMe && !isOwner ? (
                    <span className={st.connActions}>
                      {amOwner ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busyId !== null}
                          onClick={() => void setRole(p, p.role === 'admin' ? 'member' : 'admin')}
                        >
                          {p.role === 'admin' ? 'Demote' : 'Make admin'}
                        </button>
                      ) : null}
                      {amOwner || p.role === 'member' ? (
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={busyId !== null}
                          onClick={() => void remove(p)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
            {cursor ? (
              <button
                type="button"
                className="btn"
                style={{ width: '100%', marginTop: 8 }}
                onClick={() => void load(false, cursor, q)}
              >
                Show more
              </button>
            ) : null}
          </div>
        )}
        {error ? <p className="error-text">{error}</p> : null}
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          Admins post and manage invites. The owner keeps the lights on and can&rsquo;t leave.
        </p>
      </div>
    </div>
  );
}
