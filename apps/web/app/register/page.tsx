'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
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
import AuthScene, { useAuthFx } from '@/components/AuthScene';
import Mascot, { caretPoint, type MascotHandle, type MascotState } from '@/components/Mascot';
import authStyles from '@/components/auth.module.css';

// RegisterForm renders INSIDE AuthScene so useAuthFx() reaches the scene's
// provider (party mode, confetti burst, card lift, reduced-motion flag).
function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const fx = useAuthFx();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  // The Bored Blob: tracks the caret while you type, covers its eyes on the
  // password (peeks when shown), winces on a taken username and celebrates
  // with a confetti burst when the account lands.
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

  function track(e: { currentTarget: HTMLInputElement }): void {
    mascotRef.current?.lookAt(caretPoint(e.currentTarget));
  }
  function untrack(): void {
    mascotRef.current?.lookAt(null);
  }

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
      pulse('wince', 1000);
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`);
      pulse('wince', 1000);
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
      // Same destinations as ever — confetti + happy bounce + card lift run
      // first (skipped entirely under reduced motion).
      const dest = res.invite?.conversation_id
        ? `/c/${res.invite.conversation_id}`
        : safeNext(search.get('next'));
      setMascot('celebrate');
      fx.burst();
      fx.lift();
      window.setTimeout(() => router.replace(dest), fx.reducedMotion ? 0 : 800);
      return; // keep busy=true while the card lifts away
    } catch (err) {
      if (err instanceof ApiError && err.code === 'username_taken') {
        setError('That username is taken.');
        pulse('wince', 1000);
      } else {
        if (err instanceof ApiError && err.code === 'email_taken') {
          setError('That email already has an account.');
        } else if (err instanceof ApiError && err.status === 429) {
          setError('Too many sign-ups from here — try again later.');
        } else if (err instanceof ApiError && err.status === 400) {
          setError(err.message || 'Check the fields and try again.');
        } else {
          setError('Could not create the account. Check your connection and try again.');
        }
        pulse('shake', 900);
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className={authStyles.mascotRow}>
        {/* v0.7 (§1.54): the wordmark's word drives the ambient mascot. */}
        <Mascot
          ref={mascotRef}
          state={fx.party ? 'party' : mascot === 'watch' && fx.wordMascot ? fx.wordMascot : mascot}
          size={96}
        />
      </div>
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
          onChange={(e) => {
            setUsername(e.target.value.toLowerCase());
            track(e);
          }}
          onFocus={track}
          onSelect={track}
          onBlur={untrack}
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
          onChange={(e) => {
            setDisplayName(e.target.value);
            track(e);
          }}
          onFocus={track}
          onSelect={track}
          onBlur={untrack}
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
          onChange={(e) => {
            setEmail(e.target.value);
            track(e);
          }}
          onFocus={track}
          onSelect={track}
          onBlur={untrack}
          autoComplete="email"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="reg-password">Password</label>
        <div
          className={authStyles.pwWrap}
          onFocus={() => setMascot(showPw ? 'peek' : 'cover')}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMascot('watch');
          }}
        >
          <input
            id="reg-password"
            className={`input ${authStyles.pwInput}`}
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
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
        {busy ? 'Creating…' : 'Create account'}
      </button>
      <p className={`muted small ${authStyles.switchLine}`}>
        Already have an account?{' '}
        <Link href={`/login${search.get('next') ? `?next=${encodeURIComponent(safeNext(search.get('next')))}` : ''}`}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <AuthScene>
        <RegisterForm />
      </AuthScene>
    </Suspense>
  );
}
