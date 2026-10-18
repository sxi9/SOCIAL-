'use client';

// Admin users (§1.41). Search, IPs (until the 90-day GC nulls them), session
// metadata, storage, and the suspend/ban levers. Last-seen is a COARSE bucket
// by contract — liveness, not surveillance. Admin accounts can't be
// suspended/banned or have a password set from here (bad_admin_target):
// remove their admin role first. Adminhood and password reset moved from
// CLI-only to this page with the ADR-013 amendment (2026-10-18).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminUserRow } from '@socialchat/shared';
import { IP_RETENTION_DAYS, PASSWORD_MIN_LENGTH } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  adminSetPassword,
  adminUserAction,
  adminUserExport,
  adminUsers,
  BUCKET_LABEL,
  downloadJson,
  type AdminUserAction,
} from '@/lib/admin';
import { formatBytes, formatTime } from '@/lib/format';
import ad from '@/components/admin.module.css';

export default function AdminUsersPage() {
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(qDraft.trim()), 350);
    return () => clearTimeout(t);
  }, [qDraft]);

  const refresh = useCallback(async () => {
    const seq = (fetchSeq.current += 1);
    setError(null);
    try {
      const res = await adminUsers(q, null);
      if (fetchSeq.current !== seq) return;
      setUsers(res.users);
      setCursor(res.next_cursor);
    } catch {
      if (fetchSeq.current === seq) setError('Could not load users.');
    }
  }, [q]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function more(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await adminUsers(q, cursor);
      setUsers((prev) => [...(prev ?? []), ...res.users]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    }
  }

  async function act(user: AdminUserRow, action: AdminUserAction): Promise<void> {
    const verb: Record<AdminUserAction, string> = {
      suspend: `Suspend @${user.username}? All their sessions end immediately and they cannot log in until unsuspended.`,
      ban: `Ban @${user.username}? Everything suspend does, plus their public presence (profile, listings, stories, posts) disappears until unbanned.`,
      unsuspend: `Unsuspend @${user.username}?`,
      unban: `Unban @${user.username}?`,
      'grant-admin': `Make @${user.username} an admin? They get this whole operator surface (users, reports, logs, settings) and can grant it to others.`,
      'revoke-admin': `Remove the admin role from @${user.username}?`,
    };
    if (!window.confirm(verb[action])) return;
    const note = window.prompt('Note for the audit log (optional):', '') ?? '';
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUserAction(user.id, action, note.slice(0, 500));
      setUsers((prev) => prev?.map((u) => (u.id === updated.id ? updated : u)) ?? prev);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_admin_target') {
        setError('That account is an admin — remove their admin role first.');
      } else if (err instanceof ApiError && err.code === 'self_target') {
        setError('You cannot remove your own admin role — ask another admin, or use the CLI.');
      } else if (err instanceof ApiError && err.code === 'target_disabled') {
        setError('Lift the suspension or ban before making that account an admin.');
      } else {
        setError(`Could not ${action} @${user.username}.`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function setPassword(user: AdminUserRow): Promise<void> {
    const pw = window.prompt(
      `New password for @${user.username} (at least ${PASSWORD_MIN_LENGTH} characters). All their sessions end; tell them the password out of band.`,
      '',
    );
    if (pw === null) return;
    if (pw.length < PASSWORD_MIN_LENGTH) {
      setError(`The password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminSetPassword(user.id, pw);
      setUsers((prev) => prev?.map((u) => (u.id === updated.id ? updated : u)) ?? prev);
      setNotice(`Password set for @${user.username}; their sessions were ended.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_admin_target') {
        setError('Admins change their own password in Settings.');
      } else {
        setError(`Could not set a password for @${user.username}.`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function exportUser(user: AdminUserRow): Promise<void> {
    setBusyId(user.id);
    setError(null);
    try {
      const data = await adminUserExport(user.id);
      downloadJson(`boredchat-export-${user.username}.json`, data);
    } catch {
      setError(`Could not export @${user.username}.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2>Users</h2>
      <p className={ad.note}>
        IPs show until the nightly GC nulls them at {IP_RETENTION_DAYS} days (the window in the
        instance privacy note). Exports carry the user&rsquo;s own rows minus secrets — and never
        message bodies (ADR-013).
      </p>
      <div className="field" style={{ maxWidth: 360 }}>
        <input
          className="input"
          type="search"
          placeholder="Search username / display name…"
          aria-label="Search users"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
        />
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {notice ? (
        <p className="muted small" role="status">
          {notice}
        </p>
      ) : null}

      {users === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : (
        <div className={ad.tableWrap}>
          <table className={ad.table}>
            <thead>
              <tr>
                <th>User</th>
                <th>Joined</th>
                <th>Last seen</th>
                <th>Reg. IP</th>
                <th>Last session</th>
                <th>Sessions</th>
                <th>Storage</th>
                <th>Flags</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.display_name}</strong>
                    <br />
                    <span className={ad.dim}>@{u.username}</span>
                  </td>
                  <td className={ad.dim}>{formatTime(u.created_at)}</td>
                  <td>{BUCKET_LABEL[u.last_seen_bucket]}</td>
                  <td className={ad.mono}>{u.registration_ip ?? <span className={ad.dim}>aged out</span>}</td>
                  <td>
                    {u.last_session ? (
                      <>
                        <span className={ad.mono}>{u.last_session.ip ?? 'ip aged out'}</span>
                        <br />
                        <span className={ad.dim} title={u.last_session.user_agent ?? undefined}>
                          {(u.last_session.user_agent ?? 'unknown agent').slice(0, 42)}
                          {(u.last_session.user_agent?.length ?? 0) > 42 ? '…' : ''}
                        </span>
                        <br />
                        <span className={ad.dim}>{formatTime(u.last_session.last_seen_at)}</span>
                      </>
                    ) : (
                      <span className={ad.dim}>none</span>
                    )}
                  </td>
                  <td>{u.session_count}</td>
                  <td>{formatBytes(u.storage_bytes)}</td>
                  <td>
                    {u.is_admin ? <span className={`${ad.flag} ${ad.flagAdmin}`}>admin</span> : null}
                    {u.suspended ? <span className={`${ad.flag} ${ad.flagBad}`}>suspended</span> : null}
                    {u.banned ? <span className={`${ad.flag} ${ad.flagBad}`}>banned</span> : null}
                  </td>
                  <td>
                    <div className={ad.rowActions}>
                      {!u.is_admin ? (
                        <>
                          {u.suspended ? (
                            <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void act(u, 'unsuspend')}>
                              Unsuspend
                            </button>
                          ) : (
                            <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void act(u, 'suspend')}>
                              Suspend
                            </button>
                          )}
                          {u.banned ? (
                            <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void act(u, 'unban')}>
                              Unban
                            </button>
                          ) : (
                            <button type="button" className="btn btn-danger" disabled={busyId === u.id} onClick={() => void act(u, 'ban')}>
                              Ban
                            </button>
                          )}
                          <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void setPassword(u)}>
                            Set password
                          </button>
                          <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void act(u, 'grant-admin')}>
                            Make admin
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void act(u, 'revoke-admin')}>
                          Remove admin
                        </button>
                      )}
                      <button type="button" className="btn" disabled={busyId === u.id} onClick={() => void exportUser(u)}>
                        Export
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={9} className={ad.dim}>
                    No users match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {cursor !== null ? (
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => void more()}>
          Load more
        </button>
      ) : null}
    </div>
  );
}
