'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { LoginResponse } from '@socialchat/shared';
import { api, ApiError, safeNext } from '@/lib/api';
import { onAuthenticated } from '@/lib/connection';
import { setMe } from '@/lib/store';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<LoginResponse>('/api/auth/login', {
        username_or_email: usernameOrEmail.trim(),
        password,
      });
      setMe(res.user);
      onAuthenticated();
      router.replace(safeNext(search.get('next')));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('Wrong username or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else {
        setError('Could not sign in. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={(e) => void submit(e)}>
        <h1>Sign in</h1>
        <div className="field">
          <label htmlFor="login-id">Username or email</label>
          <input
            id="login-id"
            className="input"
            value={usernameOrEmail}
            onChange={(e) => setUsernameOrEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small" style={{ marginTop: 14 }}>
          New here?{' '}
          <Link href={`/register${search.get('next') ? `?next=${encodeURIComponent(safeNext(search.get('next')))}` : ''}`}>
            Create an account
          </Link>
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
