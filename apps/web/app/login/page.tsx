'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { LoginResponse } from '@socialchat/shared';
import { api, ApiError, safeNext } from '@/lib/api';
import { onAuthenticated } from '@/lib/connection';
import { setMe } from '@/lib/store';
import AuthScene, { useAuthFx } from '@/components/AuthScene';
import Mascot, { caretPoint, type MascotHandle, type MascotState } from '@/components/Mascot';
import authStyles from '@/components/auth.module.css';

// LoginForm renders INSIDE AuthScene so useAuthFx() reaches the scene's
// provider (party mode, card lift, reduced-motion flag).
function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const fx = useAuthFx();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // The Bored Blob: watches the pointer/caret, covers its eyes on password
  // focus (peeks when the password is shown), head-shakes on bad credentials
  // and celebrates on success while the card lifts away.
  const mascotRef = useRef<MascotHandle>(null);
  const [mascot, setMascot] = useState<MascotState>('watch');
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
    },
    [],
  );
  function pulse(state: MascotState, ms: number): void {
    setMascot(state);
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setMascot('watch'), ms);
  }

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
      // Same destination as ever — the happy bounce + card lift just run
      // first (skipped entirely under reduced motion).
      const dest = safeNext(search.get('next'));
      setMascot('celebrate');
      fx.lift();
      window.setTimeout(() => router.replace(dest), fx.reducedMotion ? 0 : 700);
      return; // keep busy=true while the card lifts away
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('Wrong username or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else {
        setError('Could not sign in. Check your connection and try again.');
      }
      pulse('shake', 900);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className={authStyles.mascotRow}>
        {/* v0.7 (§1.54): while ambient ('watch'), the mascot reacts to the
            flipping wordmark's current word; interactions (password cover,
            error shake, success) always win over the word. */}
        <Mascot
          ref={mascotRef}
          state={fx.party ? 'party' : mascot === 'watch' && fx.wordMascot ? fx.wordMascot : mascot}
          size={96}
        />
      </div>
      <h2 className={authStyles.formTitle}>Welcome back</h2>
      <div className="field">
        <label htmlFor="login-id">Username or email</label>
        <input
          id="login-id"
          className="input"
          value={usernameOrEmail}
          onChange={(e) => {
            setUsernameOrEmail(e.target.value);
            mascotRef.current?.lookAt(caretPoint(e.currentTarget));
          }}
          onFocus={(e) => mascotRef.current?.lookAt(caretPoint(e.currentTarget))}
          onSelect={(e) => mascotRef.current?.lookAt(caretPoint(e.currentTarget))}
          onBlur={() => mascotRef.current?.lookAt(null)}
          autoComplete="username"
          autoCapitalize="none"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <div
          className={authStyles.pwWrap}
          onFocus={() => setMascot(showPw ? 'peek' : 'cover')}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMascot('watch');
          }}
        >
          <input
            id="login-password"
            className={`input ${authStyles.pwInput}`}
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button
            type="button"
            className={authStyles.pwToggle}
            aria-pressed={showPw}
            onClick={() => {
              const next = !showPw;
              setShowPw(next);
              setMascot(next ? 'peek' : 'cover');
            }}
          >
            {showPw ? 'hide' : 'show'}
          </button>
        </div>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className={`muted small ${authStyles.switchLine}`}>
        New here?{' '}
        <Link href={`/register${search.get('next') ? `?next=${encodeURIComponent(safeNext(search.get('next')))}` : ''}`}>
          Create an account
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthScene>
        <LoginForm />
      </AuthScene>
    </Suspense>
  );
}
