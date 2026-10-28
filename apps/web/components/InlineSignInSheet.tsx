'use client';

// Inline sign-in on share pages (share-everything Slice E — AUDIT-PLAN §1b,
// SPECS "show the thing, hide the people, gate the action"). A gated tap on
// a /p or /s page opens THIS over the page instead of bouncing to /register:
// password + passkey + QR hand-off + create-account, the TOTP second step,
// and the once-only recovery-codes reveal after sign-up. It is the login
// and register pages' LOGIC without their scene (no AuthScene, no mascot,
// no confetti — those need the full-page providers). Finishing navigates to
// `next` — the object route Slice D built (`/feed/<id>`, `/local/<id>`,
// `/local/b/<id>`) or the share path itself for groups — with a FULL load:
// share pages run outside AppShell, so there is no store/WS to upgrade in
// place; the fresh page bootstraps from the sid cookie the response set.
// Rules kept: no user cards / no member identities around the form (SPECS),
// errors byte-identical to the pages', recovery stays on /login (rare path).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AGE_MIN,
  LOGIN_LINK_POLL_INTERVAL_MS,
  PASSWORD_MIN_LENGTH,
  TOTP_CODE_REGEX,
  USERNAME_REGEX,
  type CreateLoginLinkResponse,
  type LoginOutcome,
  type RegisterRequest,
  type RegisterResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import {
  countdown,
  createLoginLink,
  isExpired,
  isTotpChallenge,
  passkeyLogin,
  passkeyLoginOptions,
  pollLoginLink,
  totpVerify,
} from '@/lib/auth';
import { useOverlayEscape } from '@/lib/overlays';
import { useNow } from '@/lib/useNow';
import { assertPasskey, isWebAuthnCancel, passkeysSupported } from '@/lib/webauthn';
import { EyeIcon } from './AuthScene';
import QrCode from './QrCode';
import RecoveryCodes from './RecoveryCodes';
import authStyles from './auth.module.css';
import ap from './authpack.module.css';
import sheet from './beacons.module.css';
import Portal from './Portal';

type Mode = 'login' | 'register' | 'totp' | 'qr' | 'codes';

/** Login-page copy for the account-state 403s (Wave 1.3 asks the page for
 *  the same; the server has sent them since v0.3). */
export function accountStateMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  if (err.code === 'account_suspended') {
    return 'This account is suspended. Contact the people who run this server to appeal.';
  }
  if (err.code === 'account_banned') {
    return 'This account has been banned from this server.';
  }
  return null;
}

export default function InlineSignInSheet({
  next,
  word,
  onClose,
}: {
  /** Same-site path to land on once signed in (the object, or this page). */
  next: string;
  /** What the gate protects, for the title: "post", "plan", "listing"… */
  word: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [canPasskey, setCanPasskey] = useState(false);

  // login
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false); // Wave 1 §1.1/§1.8 consent
  // register
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  // totp
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  // qr
  const [link, setLink] = useState<CreateLoginLinkResponse | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  // codes
  const [codes, setCodes] = useState<string[]>([]);

  const finishedRef = useRef(false);

  // The sheet can be dismissed unless a request / the final navigation is in
  // flight, or the once-only recovery codes are on screen: the account and
  // its cookie already exist by then and the server keeps only hashes, so
  // the only way out of that step is "I saved them" (as on /register).
  const canClose = !busy && mode !== 'codes';
  useOverlayEscape(onClose, canClose);

  useEffect(() => {
    setCanPasskey(passkeysSupported());
  }, []);

  /** Signed in: the cookie is set; land on the object with a full load. */
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setBusy(true);
    window.location.assign(next);
  }, [next]);

  const handleOutcome = useCallback(
    (outcome: LoginOutcome) => {
      if (isTotpChallenge(outcome)) {
        setTotpToken(outcome.totp_token);
        setTotpCode('');
        setError(null);
        setMode('totp');
        setBusy(false);
        return;
      }
      finish();
    },
    [finish],
  );

  function networkOr(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.status === 429) return 'Too many attempts — try again in a minute.';
    return accountStateMessage(err) ?? fallback;
  }

  // ---- password (§1.1) ----
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
      handleOutcome(res);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'bad_credentials'
          ? 'Wrong username or password.'
          : networkOr(err, 'Could not sign in. Check your connection and try again.'),
      );
      setBusy(false);
    }
  }

  // ---- passkey (§1.70) — the explicit button only; the conditional-UI
  // autofill ceremony belongs to the full login page (one pending ceremony
  // per document, and this sheet mounts and unmounts). ----
  async function passkeyClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const typed = usernameOrEmail.trim();
      const uname = typed && !typed.includes('@') ? typed : undefined;
      const res = await passkeyLoginOptions(uname);
      const assertion = await assertPasskey(res.options, { autofill: false });
      handleOutcome(await passkeyLogin(res.challenge_ref, assertion));
    } catch (err) {
      if (isWebAuthnCancel(err)) {
        // Closed the platform prompt — silence, not a banner.
      } else if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('That passkey was not accepted. Try another way to sign in.');
      } else {
        setError(networkOr(err, 'Passkey sign-in did not work here. Use your password instead.'));
      }
      setBusy(false);
    }
  }

  // ---- TOTP second step (§1.73) ----
  async function submitTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !totpToken) return;
    if (!TOTP_CODE_REGEX.test(totpCode)) {
      setError('Codes are the 6 digits from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await totpVerify(totpToken, totpCode);
      finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_totp_code') {
        setError('That code did not match — codes rotate every 30 seconds.');
      } else if (err instanceof ApiError && err.code === 'bad_totp_token') {
        setError('That sign-in expired — start again.');
        setMode('login');
        setTotpToken(null);
      } else {
        setError(networkOr(err, 'Could not verify the code. Check your connection and try again.'));
      }
      setBusy(false);
    }
  }

  // ---- QR hand-off (§1.71, the laptop side) ----
  const now = useNow(1000);
  const mintingRef = useRef(false);
  const mintLink = useCallback(async (): Promise<void> => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    setLinkErr(null);
    try {
      setLink(await createLoginLink());
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
    if (mode === 'qr' && !link && !linkErr) void mintLink();
  }, [mode, link, linkErr, mintLink]);

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
            finish();
          }
        } catch (err) {
          if (stopped) return;
          // Expired/raced — re-mint a fresh link.
          if (err instanceof ApiError && err.status === 410) setLink(null);
        }
      })();
    }, LOGIN_LINK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mode, link, finish]);

  useEffect(() => {
    if (mode === 'qr' && link && isExpired(link.expires_at, now)) setLink(null);
  }, [mode, link, now]);

  // ---- register (§1.1 / §1.72 codes reveal) ----
  async function submitRegister(e: FormEvent): Promise<void> {
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
    if (!agreed) {
      setError(`Tick the box first — you need to be ${AGE_MIN}+ and okay with the terms.`);
      return;
    }
    setBusy(true);
    try {
      const payload: RegisterRequest = {
        username,
        email: email.trim(),
        password,
        display_name: displayName.trim() || username,
        terms_accepted: true,
        age_attested: true,
      };
      const res = await api.post<RegisterResponse>('/api/auth/register', payload);
      // The codes are shown ONCE, right now — the server keeps only hashes.
      if (res.recovery_codes.length > 0) {
        setCodes(res.recovery_codes);
        setMode('codes');
        setBusy(false);
        return;
      }
      finish();
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
      setBusy(false);
    }
  }

  function switchMode(m: Mode): void {
    setMode(m);
    setError(null);
    // The sign-in and create-account forms must not share a typed password:
    // a mistyped one would otherwise silently become the new account's.
    setPassword('');
    setShowPw(false);
    setTotpToken(null);
    setLink(null);
    setLinkErr(null);
  }

  const title =
    mode === 'register'
      ? 'Create your account'
      : mode === 'codes'
        ? 'Save your recovery codes'
        : mode === 'totp'
          ? 'One more step'
          : mode === 'qr'
            ? 'Sign in with your phone'
            : `Sign in to ${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

  const pwField = (id: string, autoComplete: 'current-password' | 'new-password') => (
    <div className="field">
      <label htmlFor={id}>Password</label>
      <div className={authStyles.pwWrap}>
        <input
          id={id}
          className={`input ${authStyles.pwInput}`}
          type={showPw ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={autoComplete}
          minLength={autoComplete === 'new-password' ? PASSWORD_MIN_LENGTH : undefined}
          required
        />
        <button
          type="button"
          className={authStyles.pwToggle}
          aria-pressed={showPw}
          aria-label="Show password"
          onClick={() => setShowPw((v) => !v)}
        >
          <EyeIcon />
        </button>
      </div>
    </div>
  );

  let body: ReactNode;
  if (mode === 'codes') {
    body = (
      <>
        <p className="muted small" style={{ margin: '0 0 4px' }}>
          You’re in, @{username}! One thing first: these 6 codes are your way back in if you ever
          lose your password. This is the only time they’re shown.
        </p>
        <RecoveryCodes
          codes={codes}
          username={username}
          confirmLabel="I saved them — take me there"
          onConfirm={finish}
        />
      </>
    );
  } else if (mode === 'totp') {
    body = (
      <form onSubmit={(e) => void submitTotp(e)}>
        <p className={sheet.sheetNote} style={{ marginTop: 0 }}>
          Enter the 6-digit code from your authenticator app.
        </p>
        <div className="field">
          <label htmlFor="isi-totp">Code</label>
          <input
            autoFocus
            id="isi-totp"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Verify'}
        </button>
        <button type="button" className={`btn ${ap.outlineBtn} ${ap.pwInstead}`} disabled={busy} onClick={() => switchMode('login')}>
          Start over
        </button>
      </form>
    );
  } else if (mode === 'qr') {
    const url = link ? `${window.location.origin}${link.url}` : null;
    body = (
      <div className={ap.qrPane}>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          On your phone, where you’re already signed in: scan this, or type the short code under
          Settings → Security → “Approve a laptop”.
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
            {/* The human fallback is ALWAYS visible (ADR-021). */}
            <p className={ap.displayCode} aria-label="Short code to type on your phone">
              {link.display_code}
            </p>
            <p className={`muted small ${ap.qrMeta}`} role="status">
              Waiting for your phone… fresh code in {countdown(link.expires_at, now)}
            </p>
          </>
        )}
        <button type="button" className={`btn ${ap.outlineBtn} ${ap.pwInstead}`} onClick={() => switchMode('login')}>
          Use password instead
        </button>
      </div>
    );
  } else if (mode === 'register') {
    body = (
      <form onSubmit={(e) => void submitRegister(e)}>
        <div className="field">
          <label htmlFor="isi-username">Username</label>
          <input
            autoFocus
            id="isi-username"
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
          <label htmlFor="isi-display">Display name (optional)</label>
          <input
            id="isi-display"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            maxLength={100}
          />
        </div>
        <div className="field">
          <label htmlFor="isi-email">Email</label>
          <input
            id="isi-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        {pwField('isi-new-password', 'new-password')}
        <label className={authStyles.consentRow}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />
          <span>
            I&rsquo;m {AGE_MIN} or older and I agree to the{' '}
            <a href="/terms" target="_blank" rel="noreferrer">terms</a> and{' '}
            <a href="/guidelines" target="_blank" rel="noreferrer">guidelines</a>.
          </span>
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className={authStyles.switchLine}>
          Already have an account?{' '}
          <button type="button" className={authStyles.footBtn} disabled={busy} onClick={() => switchMode('login')}>
            Sign in
          </button>
        </p>
      </form>
    );
  } else {
    body = (
      <form onSubmit={(e) => void submitPassword(e)}>
        <div className="field">
          <label htmlFor="isi-id">Username or email</label>
          <input
            autoFocus
            id="isi-id"
            className="input"
            value={usernameOrEmail}
            onChange={(e) => setUsernameOrEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </div>
        {pwField('isi-password', 'current-password')}
        {error ? <p className="error-text">{error}</p> : null}
        <button className={`btn btn-primary ${authStyles.btnBlock}`} type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className={ap.orRow} aria-hidden>
          or
        </div>
        <div className={ap.altBtns}>
          {canPasskey ? (
            <button type="button" className={`btn ${ap.outlineBtn}`} disabled={busy} onClick={() => void passkeyClick()}>
              Sign in with a passkey
            </button>
          ) : null}
          <button type="button" className={`btn ${ap.outlineBtn}`} disabled={busy} onClick={() => switchMode('qr')}>
            Sign in with phone · QR
          </button>
        </div>
        <p className={authStyles.switchLine}>
          New here?{' '}
          <button type="button" className={authStyles.footBtn} disabled={busy} onClick={() => switchMode('register')}>
            Create an account
          </button>
          {' · '}
          <a href={`/login?next=${encodeURIComponent(next)}`}>Lost everything?</a>
        </p>
      </form>
    );
  }

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget && canClose) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label={title}>
          <div className={sheet.sheetHead}>
            <h2>{title}</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" disabled={!canClose} onClick={onClose}>
              ×
            </button>
          </div>
          {body}
        </div>
      </div>
    </Portal>
  );
}
