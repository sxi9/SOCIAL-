'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  INVITE_TOKEN_REGEX,
  PASSWORD_MIN_LENGTH,
  USERNAME_REGEX,
  type RegisterRequest,
  type RegisterResponse,
} from '@socialchat/shared';
import { api, ApiError, safeNext } from '@/lib/api';
import { onAuthenticated } from '@/lib/connection';
import { setMe } from '@/lib/store';
import AuthScene from '@/components/AuthScene';
import authStyles from '@/components/auth.module.css';

function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // /join/<token> carries the invite through sign-up (API.md §1.11): the
  // register request rides invite_token, and the response names the DM/group
  // conversation to land in. A bad invite never fails registration.
  const rawInvite = search.get('invite');
  const inviteToken = rawInvite && INVITE_TOKEN_REGEX.test(rawInvite) ? rawInvite : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!USERNAME_REGEX.test(username)) {
      setError('Usernames are 3–24 characters: lowercase letters, digits and underscores.');
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      const payload: RegisterRequest = {
        username,
        email: email.trim(),
        password,
        display_name: displayName.trim() || username,
        ...(inviteToken ? { invite_token: inviteToken } : {}),
      };
      const res = await api.post<RegisterResponse>('/api/auth/register', payload);
      setMe(res.user);
      onAuthenticated();
      // Invite accepted during registration → land straight in that chat.
      if (res.invite?.conversation_id) {
        router.replace(`/c/${res.invite.conversation_id}`);
      } else {
        router.replace(safeNext(search.get('next')));
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'username_taken') {
        setError('That username is taken.');
      } else if (err instanceof ApiError && err.code === 'email_taken') {
        setError('That email already has an account.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many sign-ups from here — try again later.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError(err.message || 'Check the fields and try again.');
      } else {
        setError('Could not create the account. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScene>
      <form onSubmit={(e) => void submit(e)}>
        <h2 className={authStyles.formTitle}>Join the fun</h2>
        {inviteToken ? (
          <p className={authStyles.inviteNote}>
            <span aria-hidden>🎟️</span> You&rsquo;ve been invited — your chat opens right after sign-up.
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="reg-username">Username</label>
          <input
            id="reg-username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            autoComplete="username"
            autoCapitalize="none"
            pattern="[a-z0-9_]{3,24}"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="reg-display">Display name</label>
          <input
            id="reg-display"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            maxLength={100}
          />
        </div>
        <div className="field">
          <label htmlFor="reg-email">Email</label>
          <input
            id="reg-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="reg-password">Password</label>
          <input
            id="reg-password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className={`muted small ${authStyles.switchLine}`}>
          Already have an account?{' '}
          <Link href={`/login${search.get('next') ? `?next=${encodeURIComponent(safeNext(search.get('next')))}` : ''}`}>
            Sign in
          </Link>
        </p>
      </form>
    </AuthScene>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
