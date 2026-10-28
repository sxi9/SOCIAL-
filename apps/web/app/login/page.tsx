'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  LOGIN_LINK_POLL_INTERVAL_MS,
  PASSWORD_MIN_LENGTH,
  TOTP_CODE_REGEX,
  type CreateLoginLinkResponse,
  type LoginOutcome,
  type UserPrivate,
} from '@socialchat/shared';
import { api, ApiError, safeNext } from '@/lib/api';
import {
  countdown,
  createLoginLink,
  isExpired,
  isTotpChallenge,
  passkeyLogin,
  passkeyLoginOptions,
  pollLoginLink,
  recoverAccount,
  resetPassword,
  totpVerify,
} from '@/lib/auth';
import { onAuthenticated } from '@/lib/connection';
import { setMe } from '@/lib/store';
import { useNow } from '@/lib/useNow';
import {
  assertPasskey,
  isWebAuthnCancel,
  passkeyAutofillSupported,
  passkeysSupported,
} from '@/lib/webauthn';
import AuthScene, { EyeIcon, SceneFooter, SceneMascot, useAuthFx } from '@/components/AuthScene';
import { accountStateMessage } from '@/components/InlineSignInSheet';
import { resetMeProbe } from '@/lib/shareAuth';
import Mascot, { caretPoint, type MascotHandle, type MascotState } from '@/components/Mascot';
import QrCode from '@/components/QrCode';
import authStyles from '@/components/auth.module.css';
import HostedBy from '@/components/HostedBy';
import ap from '@/components/authpack.module.css';

// The v0.9 login is a small state machine in one card (so the mascot/wordmark
// scene never moves): password (default, with passkey + QR + recovery doors),
// totp (the §1.73 second step a TOTP-armed password/passkey login lands in),
// qr (the §1.71 laptop panel), recover → reset (the §1.72 scorched-earth path).
type Mode = 'password' | 'totp' | 'qr' | 'recover' | 'reset';

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const fx = useAuthFx();
  const [mode, setMode] = useState<Mode>('password');
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [canPasskey, setCanPasskey] = useState(false);

  // §1.73: the half-login token between "password/passkey ok" and "code ok".
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');

  // §1.71: the laptop's QR panel state.
  const [link, setLink] = useState<CreateLoginLinkResponse | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);

  // §1.72: recovery → forced new password.
  const [recoveryCode, setRecoveryCode] = useState('');
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  // The Bored Blob: watches the pointer/caret, covers its eyes on password
  // focus (peeks when the password is shown), head-shakes on bad credentials,
  // peeks approvingly at a passkey success and celebrates as the card lifts.
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

  const finishedRef = useRef(false);
  const finishLogin = useCallback(
    (user: UserPrivate, moment: 'celebrate' | 'peek-then-celebrate') => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setMe(user);
      onAuthenticated();
      resetMeProbe(); // the public pages' probe must not remember "nobody"
      const dest = safeNext(search.get('next'));
      if (moment === 'peek-then-celebrate' && !fx.reducedMotion) {
        // The passkey moment: the blob peeks approvingly, then joins the party.
        setMascot('peek');
        window.setTimeout(() => {
          setMascot('celebrate');
          fx.lift();
        }, 450);
        window.setTimeout(() => router.replace(dest), 1100);
      } else {
        setMascot('celebrate');
        fx.lift();
        window.setTimeout(() => router.replace(dest), fx.reducedMotion ? 0 : 700);
      }
    },
    [fx, router, search],
  );

  /** Shared §1.1/§1.70 outcome handling: session or the TOTP second step. */
  const handleOutcome = useCallback(
    (outcome: LoginOutcome, moment: 'celebrate' | 'peek-then-celebrate'): boolean => {
      if (isTotpChallenge(outcome)) {
        setTotpToken(outcome.totp_token);
        setTotpCode('');
        setError(null);
        setMode('totp');
        setBusy(false);
        return false;
      }
      finishLogin(outcome.user, moment);
      return true;
    },
    [finishLogin],
  );

  // ---- password login (§1.1, now answering LoginOutcome) ----

  async function submitPassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<LoginOutcome>('/api/auth/login', {
        username_or_email: usernameOrEmail.trim(),
        password,
      });
      handleOutcome(res, 'celebrate');
      return; // keep busy=true while the card lifts away
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('Wrong username or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else {
        // AUDIT-PLAN 1.3: the account-state 403s tell the truth.
        setError(accountStateMessage(err) ?? 'Could not sign in. Check your connection and try again.');
      }
      pulse('shake', 900);
      setBusy(false);
    }
  }

  // ---- passkey login (§1.70) ----

  useEffect(() => {
    setCanPasskey(passkeysSupported());
  }, []);

  const passkeyFlow = useCallback(
    async (opts: { autofill: boolean; username?: string }): Promise<void> => {
      const res = await passkeyLoginOptions(opts.username);
      const assertion = await assertPasskey(res.options, { autofill: opts.autofill });
      const outcome = await passkeyLogin(res.challenge_ref, assertion);
      handleOutcome(outcome, 'peek-then-celebrate');
    },
    [handleOutcome],
  );

  async function passkeyClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const typed = usernameOrEmail.trim();
      // An email is not a username — the options route matches usernames only;
      // without one we run the discoverable-credential flow.
      const username = typed && !typed.includes('@') ? typed : undefined;
      await passkeyFlow({ autofill: false, username });
      return;
    } catch (err) {
      if (isWebAuthnCancel(err)) {
        // The person closed the platform prompt — silence, not a banner.
      } else if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('That passkey was not accepted. Try another way to sign in.');
        pulse('shake', 900);
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else {
        setError('Passkey sign-in did not work here. Use your password instead.');
      }
      setBusy(false);
    }
  }

  // Conditional UI (§1.70): where supported, offer passkeys straight from the
  // username field's autofill. The pending ceremony resolves when the person
  // picks one; a later explicit ceremony (button click) auto-aborts it.
  const autofillTried = useRef(false);
  useEffect(() => {
    if (autofillTried.current) return;
    autofillTried.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (!passkeysSupported() || !(await passkeyAutofillSupported())) return;
        if (cancelled) return;
        await passkeyFlow({ autofill: true });
      } catch {
        // Aborted/declined autofill is the normal case — never surface it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [passkeyFlow]);

  // ---- TOTP second step (§1.73) ----

  async function submitTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !totpToken) return;
    if (!TOTP_CODE_REGEX.test(totpCode)) {
      setError('Codes are the 6 digits from your authenticator app.');
      pulse('wince', 900);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await totpVerify(totpToken, totpCode);
      finishLogin(res.user, 'celebrate');
      return;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_totp_code') {
        setError('That code did not match — codes rotate every 30 seconds.');
        pulse('shake', 900);
      } else if (err instanceof ApiError && err.code === 'bad_totp_token') {
        setError('That sign-in expired — start again.');
        setMode('password');
        setTotpToken(null);
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else {
        setError('Could not verify the code. Check your connection and try again.');
      }
      setBusy(false);
    }
  }

  // ---- QR login panel (§1.71, the laptop side) ----

  const now = useNow(1000);
  const mintingRef = useRef(false);

  const mintLink = useCallback(async (): Promise<void> => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    setLinkErr(null);
    try {
      const res = await createLoginLink();
      setLink(res);
    } catch (err) {
      setLink(null);
      setLinkErr(
        err instanceof ApiError && err.status === 429
          ? 'Too many fresh codes from here — give it a few minutes.'
          : 'Could not get a login code. Check your connection and retry.',
      );
    } finally {
      mintingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (mode !== 'qr') return;
    if (!link) void mintLink();
  }, [mode, link, mintLink]);

  // Plain polling, no WS — the laptop has no session to upgrade with (§1.71).
  useEffect(() => {
    if (mode !== 'qr' || !link) return;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await pollLoginLink(link.code);
          if (stopped) return;
          if (res.status === 'consumed') {
            clearInterval(timer);
            finishLogin(res.user, 'celebrate');
          }
        } catch (err) {
          if (stopped) return;
          if (err instanceof ApiError && err.status === 410) {
            // Expired/raced — the panel simply re-mints a fresh link.
            setLink(null);
          }
        }
      })();
    }, LOGIN_LINK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mode, link, finishLogin]);

  // Countdown + auto-refresh on expiry (the server already 410s it by now).
  useEffect(() => {
    if (mode !== 'qr' || !link) return;
    if (isExpired(link.expires_at, now)) setLink(null);
  }, [mode, link, now]);

  // ---- recovery (§1.72) ----

  async function submitRecover(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await recoverAccount(usernameOrEmail.trim(), recoveryCode.trim());
      setResetToken(res.reset_token);
      setNewPassword('');
      setMode('reset');
      setBusy(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_recovery') {
        setError('That did not match — check the username and the code (each code works once).');
        pulse('shake', 900);
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Recovery is deliberately slow — try again in a while.');
      } else {
        setError('Could not check the code. Check your connection and try again.');
      }
      setBusy(false);
    }
  }

  async function submitReset(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !resetToken) return;
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(`Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`);
      pulse('wince', 900);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await resetPassword(resetToken, newPassword);
      finishLogin(res.user, 'celebrate');
      return;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_reset_token') {
        setError('That reset window closed — start recovery again.');
        setMode('recover');
        setResetToken(null);
      } else {
        setError('Could not set the password. Check your connection and try again.');
      }
      setBusy(false);
    }
  }

  function backToPassword(): void {
    setMode('password');
    setError(null);
    setTotpToken(null);
    setLink(null);
    setLinkErr(null);
    setResetToken(null);
    setBusy(false);
  }

  // Royal v2: the mascot lives ABOVE the wordmark (SceneMascot portals it out
  // of the card). v0.7 (§1.54): while ambient ('watch'), it reacts to the
  // flipping wordmark's current word; interactions always win.
  const mascotEl = (
    <SceneMascot>
      <Mascot
        ref={mascotRef}
        state={fx.party ? 'party' : mascot === 'watch' && fx.wordMascot ? fx.wordMascot : mascot}
        size={86}
      />
    </SceneMascot>
  );

  const backRow = (label: string) => (
    <div className={ap.backRow}>
      <button type="button" className={ap.backBtn} onClick={backToPassword}>
        ← {label}
      </button>
    </div>
  );

  // ---- render per mode ----

  if (mode === 'totp') {
    return (
      <form onSubmit={(e) => void submitTotp(e)}>
        {mascotEl}
        <h2 className={authStyles.formTitle}>Two-factor code</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Open your authenticator app and type the 6-digit code for Bored Chat.
        </p>
        <div className="field">
          <label htmlFor="totp-code">6-digit code</label>
          <input
            id="totp-code"
            className={`input ${ap.digitInput}`}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button
          className={`btn btn-primary ${authStyles.btnBlock}`}
          type="submit"
          disabled={busy || totpCode.length !== 6}
        >
          {busy ? 'Checking…' : 'Verify'}
        </button>
        <p className={`muted small ${authStyles.switchLine}`}>
          Lost the authenticator?{' '}
          <button
            type="button"
            className={ap.backBtn}
            style={{ padding: 0 }}
            onClick={() => {
              setMode('recover');
              setError(null);
            }}
          >
            Use a recovery code
          </button>
        </p>
        {backRow('Back to sign in')}
      </form>
    );
  }

  if (mode === 'qr') {
    const url =
      link && typeof window !== 'undefined' ? `${window.location.origin}${link.url}` : null;
    return (
      <div className={ap.qrPane}>
        {mascotEl}
        <h2 className={authStyles.formTitle}>Log in by QR</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          On your phone, where you&rsquo;re already signed in: scan this, or type the short code
          under Settings → Security → &ldquo;Approve a laptop&rdquo;.
        </p>
        {linkErr ? (
          <>
            <p className="error-text">{linkErr}</p>
            <button type="button" className="btn" onClick={() => void mintLink()}>
              Try again
            </button>
          </>
        ) : !link ? (
          <p className="muted" role="status" style={{ textAlign: 'center', padding: '28px 0' }}>
            <span className="spinner" /> Getting a fresh code…
          </p>
        ) : (
          <>
            {url ? (
              <div className={ap.qrBox}>
                <QrCode text={url} label="Login QR code — scan with your phone" />
              </div>
            ) : null}
            {/* The human fallback is ALWAYS visible, not failure-only (ADR-021). */}
            <p className={ap.displayCode} aria-label="Short code to type on your phone">
              {link.display_code}
            </p>
            <p className={`muted small ${ap.qrMeta}`} role="status">
              Waiting for your phone… fresh code in {countdown(link.expires_at, now)}
            </p>
          </>
        )}
        <button
          type="button"
          className={`btn ${ap.outlineBtn} ${ap.pwInstead}`}
          onClick={backToPassword}
        >
          Use password instead
        </button>
      </div>
    );
  }

  if (mode === 'recover') {
    return (
      <form onSubmit={(e) => void submitRecover(e)}>
        {mascotEl}
        <h2 className={authStyles.formTitle}>Lost everything?</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Use one of your recovery codes. It works once: every device is signed out and you pick a
          new password right away.
        </p>
        <div className="field">
          <label htmlFor="rec-id">Username or email</label>
          <input
            id="rec-id"
            className="input"
            value={usernameOrEmail}
            onChange={(e) => setUsernameOrEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="rec-code">Recovery code</label>
          <input
            id="rec-code"
            className="input"
            placeholder="xxxxx-xxxxx"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Use this code'}
        </button>
        {backRow('Back to sign in')}
      </form>
    );
  }

  if (mode === 'reset') {
    return (
      <form onSubmit={(e) => void submitReset(e)}>
        {mascotEl}
        <h2 className={authStyles.formTitle}>Pick a new password</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          The code worked. Everything was signed out — set a new password to get back in.
        </p>
        <div className="field">
          <label htmlFor="reset-pw">New password</label>
          <div
            className={authStyles.pwWrap}
            onFocus={() => setMascot(showPw ? 'peek' : 'cover')}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMascot('watch');
            }}
          >
            <input
              id="reset-pw"
              className={`input ${authStyles.pwInput}`}
              type={showPw ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              autoFocus
              required
            />
            <button
              type="button"
              className={authStyles.pwToggle}
              aria-pressed={showPw}
              aria-label="Show password"
              onClick={() => {
                const next = !showPw;
                setShowPw(next);
                setMascot(next ? 'peek' : 'cover');
              }}
            >
              <EyeIcon />
            </button>
          </div>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password & sign in'}
        </button>
      </form>
    );
  }

  // mode === 'password' (default) — the Royal v2 login card: no heading, the
  // mascot + "{mood}." wordmark above the card carry the brand.
  return (
    <form onSubmit={(e) => void submitPassword(e)}>
      {mascotEl}
      {search.get('deleted') ? (
        // Wave 1 §1.2: the landing after scheduling a deletion — the one
        // place the way back is spelled out.
        <p className="ok-text" style={{ marginTop: 0 }}>
          Your account is scheduled for deletion on {search.get('deleted')}. Signing in before then
          cancels it.
        </p>
      ) : null}
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
          // §1.70 conditional UI: "webauthn" invites the browser's passkey
          // autofill into this field where supported.
          autoComplete="username webauthn"
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
            aria-label="Show password"
            onClick={() => {
              const next = !showPw;
              setShowPw(next);
              setMascot(next ? 'peek' : 'cover');
            }}
          >
            <EyeIcon />
          </button>
        </div>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

      <div className={ap.orRow} aria-hidden>
        or
      </div>
      <div className={ap.altBtns}>
        {canPasskey ? (
          <button
            type="button"
            className={`btn ${ap.outlineBtn}`}
            disabled={busy}
            onClick={() => void passkeyClick()}
          >
            Sign in with a passkey
          </button>
        ) : null}
        <button
          type="button"
          className={`btn ${ap.outlineBtn}`}
          disabled={busy}
          onClick={() => {
            setMode('qr');
            setError(null);
          }}
        >
          Log in with phone · QR
        </button>
      </div>

      {/* Royal v2: the sign-up door + the recovery door live UNDER the card. */}
      <SceneFooter>
        <p className={authStyles.footLine}>
          New here?{' '}
          <Link href={`/register${search.get('next') ? `?next=${encodeURIComponent(safeNext(search.get('next')))}` : ''}`}>
            Join the fun
          </Link>
        </p>
        <HostedBy />
        <p className={authStyles.footLineSmall}>
          <button
            type="button"
            className={authStyles.footBtn}
            onClick={() => {
              setMode('recover');
              setError(null);
            }}
          >
            Lost everything?
          </button>
        </p>
      </SceneFooter>
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
