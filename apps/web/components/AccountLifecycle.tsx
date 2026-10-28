'use client';

// Wave 1 (AUDIT-PLAN §1.2, 2026-10-28): the real Account section —
// labelled email with Change, Download my data, and Delete account in danger
// red at the bottom. Password re-proof on the two that matter; the delete
// schedules a grace (signing in again cancels it) and signs this device out.
import { useState, type FormEvent } from 'react';
import { ACCOUNT_DELETION_GRACE_DAYS, type DeleteMeResponse, type UpdateMeResponse, type UserPrivate } from '@socialchat/shared';
import { api, ApiError, retryIn } from '@/lib/api';
import { logout } from '@/lib/connection';
import { setMe } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useOverlayEscape } from '@/lib/overlays';
import Portal from './Portal';
import idm from './identity.module.css';
import styles from './beacons.module.css';

function PasswordSheet({
  title,
  blurb,
  confirmLabel,
  danger,
  withEmail,
  onClose,
  onSubmit,
}: {
  title: string;
  blurb: string;
  confirmLabel: string;
  danger?: boolean;
  withEmail?: boolean;
  onClose: () => void;
  onSubmit: (password: string, email: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useOverlayEscape(onClose);
  async function go(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(password, email.trim());
    if (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Portal>
      <div
        className={styles.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <form className={styles.sheet} role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => void go(e)}>
          <div className={styles.sheetHead}>
            <h2>{title}</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className={styles.sheetNote} style={{ marginTop: 0 }}>
            {blurb}
          </p>
          {withEmail ? (
            <div className="field">
              <label htmlFor="acct-new-email">New email</label>
              <input
                id="acct-new-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="acct-pw">Your password</label>
            <input
              id="acct-pw"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : confirmLabel}
          </button>
        </form>
      </div>
    </Portal>
  );
}

export default function AccountLifecycle({ me }: { me: UserPrivate }) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function download(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      const data = await api.get<Record<string, unknown>>('/api/users/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bored-chat-${me.username}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast('Your data is downloading');
    } catch (err) {
      toast(err instanceof ApiError && err.status === 429 ? `One export every few minutes — try again ${retryIn(err, 'shortly')}` : 'Could not export your data');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <h2 className={idm.sectionLabel}>Account</h2>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 14 }}>Email</strong>
            <p className="muted small" style={{ margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me.email} · {me.email_verified ? 'verified' : 'not verified'}
            </p>
          </div>
          <button type="button" className="btn" onClick={() => setEmailOpen(true)}>
            Change
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 14 }}>Your data</strong>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Everything this server holds about you, as one JSON file.
            </p>
          </div>
          <button type="button" className="btn" disabled={exporting} onClick={() => void download()}>
            {exporting ? '…' : 'Download'}
          </button>
        </div>
      </div>
      <p className="muted small" style={{ margin: '8px 2px 0' }}>
        Usernames can&rsquo;t be changed — links to your profile would break.
      </p>

      <h2 className={idm.sectionLabel} style={{ marginTop: 22 }}>
        Take a break
      </h2>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Pause your account: your profile, posts and plans disappear and you are signed out
            everywhere. Nothing is deleted — sign in again whenever you like and it all comes back.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => setPauseOpen(true)}>
          Pause
        </button>
      </div>

      <h2 className={idm.sectionLabel} style={{ marginTop: 22 }}>
        Delete account
      </h2>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Your profile, posts, listings, plans, stories and media are removed after a{' '}
            {ACCOUNT_DELETION_GRACE_DAYS}-day grace. Signing in again before then cancels it.
            Messages you sent in other people&rsquo;s chats stay, as &ldquo;Deleted account&rdquo;.
          </p>
        </div>
        <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
          Delete
        </button>
      </div>

      {emailOpen ? (
        <PasswordSheet
          title="Change email"
          blurb="The new address starts out unverified. Enter your password to confirm."
          confirmLabel="Change email"
          withEmail
          onClose={() => setEmailOpen(false)}
          onSubmit={async (password, email) => {
            try {
              const res = await api.patch<UpdateMeResponse>('/api/users/me/email', { password, email });
              setMe(res.user);
              setEmailOpen(false);
              toast('Email changed');
              return null;
            } catch (err) {
              if (err instanceof ApiError && err.status === 401) return 'That password is not right.';
              if (err instanceof ApiError && err.code === 'email_taken') return 'That email is already in use.';
              return 'Could not change the email.';
            }
          }}
        />
      ) : null}
      {pauseOpen ? (
        <PasswordSheet
          title="Pause your account?"
          blurb="You will be signed out everywhere and hidden until you sign in again. Enter your password to confirm."
          confirmLabel="Pause account"
          onClose={() => setPauseOpen(false)}
          onSubmit={async (password) => {
            try {
              await api.post('/api/users/me/deactivate', { password });
              await logout().catch(() => undefined);
              window.location.assign('/login?deactivated=1');
              return null;
            } catch (err) {
              if (err instanceof ApiError && err.status === 401) return 'That password is not right.';
              if (err instanceof ApiError && err.code === 'bad_admin_target') return 'Admins must hand off the role first (CLI).';
              return 'Could not pause the account.';
            }
          }}
        />
      ) : null}
      {deleteOpen ? (
        <PasswordSheet
          title="Delete your account?"
          blurb={`This signs you out everywhere and deletes the account in ${ACCOUNT_DELETION_GRACE_DAYS} days. Change your mind? Sign in again before then and it stays.`}
          confirmLabel="Schedule deletion"
          danger
          onClose={() => setDeleteOpen(false)}
          onSubmit={async (password) => {
            try {
              const res = await api.del<DeleteMeResponse>('/api/users/me', { password });
              const when = new Date(res.scheduled_deletion_at).toLocaleDateString();
              await logout().catch(() => undefined);
              window.location.assign(`/login?deleted=${encodeURIComponent(when)}`);
              return null;
            } catch (err) {
              if (err instanceof ApiError && err.status === 401) return 'That password is not right.';
              if (err instanceof ApiError && err.code === 'bad_admin_target') return 'Admins must hand off the role first (CLI).';
              return 'Could not schedule the deletion.';
            }
          }}
        />
      ) : null}
    </>
  );
}
