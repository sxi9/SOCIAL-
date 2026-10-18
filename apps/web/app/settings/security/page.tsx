'use client';

// Settings → Security (v0.9 — API.md §1.70–§1.73, FEATURES #82–#85).
// Passkeys (add/rename/delete, last-used), two-factor (TOTP enable/disable),
// recovery codes (status + regenerate; shown once), the scanner-free
// "approve a laptop" code entry (§1.71 fallback) and the Devices link —
// sessions double as the device registry (§1.1), so revocation lives there.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  PASSKEYS_MAX,
  PASSKEY_NICKNAME_MAX_CHARS,
  TOTP_CODE_REGEX,
  type PasskeyInfo,
  type RecoveryCodesStatusResponse,
  type TotpSetupResponse,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  countdown,
  deletePasskey,
  isExpired,
  listPasskeys,
  passkeyRegister,
  passkeyRegisterOptions,
  quickTunnelWarning,
  recoveryCodesStatus,
  regenerateRecoveryCodes,
  renamePasskey,
  totpDisable,
  totpEnable,
  totpSetup,
} from '@/lib/auth';
import { setMe } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import { createPasskey, isWebAuthnCancel, passkeysSupported } from '@/lib/webauthn';
import { formatTime } from '@/lib/format';
import AppShell from '@/components/AppShell';
import Portal from '@/components/Portal';
import QrCode from '@/components/QrCode';
import RecoveryCodes from '@/components/RecoveryCodes';
import sheet from '@/components/beacons.module.css';
import ap from '@/components/authpack.module.css';
import sm from '@/components/settings.module.css';

const CHEV = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...CHEV} />
    </svg>
  );
}

// ---- §1.73 TOTP setup sheet ---------------------------------------------------

function TotpSetupSheet({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryCodesStatusResponse | null>(null);
  const now = useNow(1000);

  const begin = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // Re-calling mints a FRESH pending secret (replaces the old one) —
      // nothing touches the account until a valid code proves the app has it.
      setSetup(await totpSetup());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_enabled') {
        setError('Two-factor is already on for this account.');
      } else {
        setError('Could not start setup — try again.');
      }
    }
  }, []);

  useEffect(() => {
    void begin();
  }, [begin]);

  // The pending secret expires (10 min) — offer a restart rather than a
  // confusing bad_totp_code later.
  const expired = setup !== null && isExpired(setup.expires_at, now);

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !setup) return;
    if (!TOTP_CODE_REGEX.test(code)) {
      setError('Codes are the 6 digits from the app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await totpEnable(code);
      setMe(res.user);
      toast('Two-factor on — codes at every sign-in');
      // §1.73: the natural moment to re-surface recovery codes — "these are
      // your way back in" if the authenticator is ever lost.
      setDone(true);
      void recoveryCodesStatus()
        .then(setRecovery)
        .catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_totp_code') {
        setError('That code did not match — mind the 30-second rotation.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many tries — wait a minute, then enter the current code.');
      } else {
        setError('Could not verify — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyKey(): Promise<void> {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.manual_key.replace(/\s+/g, ''));
      toast('Setup key copied');
    } catch {
      toast('Could not copy — type it by hand');
    }
  }

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Set up two-factor">
          <div className={sheet.sheetHead}>
            <h2>{done ? 'Two-factor is on' : 'Set up two-factor'}</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>

          {done ? (
            <div>
              <p className="muted small">
                From now on, signing in with your password or a passkey also asks for the 6-digit
                code. QR phone-approvals and recovery codes skip it by design.
              </p>
              <p style={{ fontSize: 14 }}>
                <strong>Your recovery codes are your way back in</strong> if you ever lose the
                authenticator
                {recovery
                  ? recovery.generated_at === null
                    ? ' — you have none yet. Generate them below.'
                    : ` — ${recovery.remaining} of ${recovery.total} left.`
                  : '.'}
              </p>
              <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>
                Done
              </button>
            </div>
          ) : setup === null ? (
            <p className="muted" role="status">
              {error ?? 'Preparing…'}
            </p>
          ) : (
            <form onSubmit={(e) => void confirm(e)}>
              <p className="muted small" style={{ marginTop: 0 }}>
                Scan this with any authenticator app (Aegis, Google Authenticator, 1Password…), or
                type the key below into it.
              </p>
              <div className={ap.qrBox}>
                <QrCode text={setup.otpauth_uri} label="Authenticator setup code" size={176} />
              </div>
              {/* The manual key is ALWAYS shown + copyable, not a failure
                  fallback (ADR-021). */}
              <p className={ap.displayCode} style={{ fontSize: 16, letterSpacing: '0.12em' }}>
                {setup.manual_key}
              </p>
              <div className={ap.codeActions} style={{ justifyContent: 'center' }}>
                <button type="button" className="btn" onClick={() => void copyKey()}>
                  Copy key
                </button>
              </div>
              {expired ? (
                <>
                  <p className="error-text">This setup expired.</p>
                  <button type="button" className="btn" onClick={() => void begin()}>
                    Start over
                  </button>
                </>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="totp-setup-code">Then type the app&rsquo;s current code</label>
                    <input
                      id="totp-setup-code"
                      className={`input ${ap.digitInput}`}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      required
                    />
                  </div>
                  {error ? <p className="error-text">{error}</p> : null}
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%' }}
                    disabled={busy || code.length !== 6}
                  >
                    {busy ? 'Checking…' : 'Turn on two-factor'}
                  </button>
                  <p className="muted small" style={{ margin: '8px 0 0' }}>
                    Setup expires in {countdown(setup.expires_at, now)} — nothing changes on your
                    account until a code matches.
                  </p>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </Portal>
  );
}

// ---- §1.73 TOTP disable sheet ---------------------------------------------------

function TotpDisableSheet({ onClose }: { onClose: () => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Proof required (§1.73): the current code, or ONE recovery code —
      // the recovery code is CONSUMED by this.
      const res = await totpDisable(
        useRecovery ? { recovery_code: value.trim() } : { code: value.trim() },
      );
      setMe(res.user);
      toast('Two-factor off');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_totp_code') {
        setError('That code did not match.');
      } else if (err instanceof ApiError && err.code === 'bad_recovery') {
        setError('That recovery code did not match (each works once).');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many tries — wait a minute, then enter the current code.');
      } else {
        setError('Could not turn it off — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Turn off two-factor">
          <div className={sheet.sheetHead}>
            <h2>Turn off two-factor</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <form onSubmit={(e) => void submit(e)}>
            <p className="muted small" style={{ marginTop: 0 }}>
              Prove it&rsquo;s you with the authenticator&rsquo;s current code
              {' — '}or spend one recovery code if the authenticator is gone.
            </p>
            <div className={sheet.segRow} role="radiogroup" aria-label="Proof">
              <button
                type="button"
                role="radio"
                aria-checked={!useRecovery}
                className={`${sheet.segBtn}${!useRecovery ? ` ${sheet.segOn}` : ''}`}
                onClick={() => {
                  setUseRecovery(false);
                  setValue('');
                }}
              >
                6-digit code
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={useRecovery}
                className={`${sheet.segBtn}${useRecovery ? ` ${sheet.segOn}` : ''}`}
                onClick={() => {
                  setUseRecovery(true);
                  setValue('');
                }}
              >
                Recovery code
              </button>
            </div>
            <div className="field">
              <label htmlFor="totp-off-value">
                {useRecovery ? 'One recovery code' : 'Current 6-digit code'}
              </label>
              <input
                id="totp-off-value"
                className={`input${useRecovery ? '' : ` ${ap.digitInput}`}`}
                value={value}
                onChange={(e) =>
                  setValue(
                    useRecovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6),
                  )
                }
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={useRecovery ? 'xxxxx-xxxxx' : undefined}
                maxLength={useRecovery ? 64 : 6}
                required
              />
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            <button
              type="submit"
              className="btn btn-danger"
              style={{ width: '100%' }}
              disabled={busy || (useRecovery ? value.trim().length === 0 : value.length !== 6)}
            >
              {busy ? 'Checking…' : 'Turn off'}
            </button>
          </form>
        </div>
      </div>
    </Portal>
  );
}

// ---- §1.72 regenerate sheet -----------------------------------------------------

function RegenerateSheet({
  username,
  onClose,
  onDone,
}: {
  username: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Re-proves the password (§1.72): a borrowed unlocked phone must not
      // silently re-mint. The OLD set is invalidated by this call.
      const res = await regenerateRecoveryCodes(password);
      setCodes(res.recovery_codes);
      toast('Fresh recovery codes — the old ones are dead');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setError('Wrong password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many regenerations — try again later.');
      } else {
        setError('Could not generate codes — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          // Once codes are on screen, closing is an explicit act — no
          // accidental backdrop-tap past the only viewing.
          if (e.target === e.currentTarget && codes === null) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Recovery codes">
          <div className={sheet.sheetHead}>
            <h2>{codes ? 'Your new recovery codes' : 'New recovery codes'}</h2>
            <button
              type="button"
              className={sheet.sheetClose}
              aria-label="Close"
              onClick={codes ? onDone : onClose}
            >
              ×
            </button>
          </div>
          {codes ? (
            <RecoveryCodes
              codes={codes}
              username={username}
              confirmLabel="I saved them"
              onConfirm={onDone}
            />
          ) : (
            <form onSubmit={(e) => void submit(e)}>
              <p className="muted small" style={{ marginTop: 0 }}>
                This replaces every existing code with 6 fresh ones, shown once. Your password
                proves it&rsquo;s really you.
              </p>
              <div className="field">
                <label htmlFor="regen-pw">Password</label>
                <input
                  id="regen-pw"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {error ? <p className="error-text">{error}</p> : null}
              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%' }}
                disabled={busy || password.length === 0}
              >
                {busy ? 'Generating…' : 'Generate new codes'}
              </button>
            </form>
          )}
        </div>
      </div>
    </Portal>
  );
}

// ---- the page --------------------------------------------------------------------

function SecuritySettings() {
  const state = useAppState();
  const router = useRouter();
  const me = state.me;

  // Passkeys (§1.70).
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [pkError, setPkError] = useState<string | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  const [nickname, setNickname] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [tunnelWarn, setTunnelWarn] = useState<string | null>(null);
  const [rpHost, setRpHost] = useState('');

  // Recovery codes (§1.72).
  const [recStatus, setRecStatus] = useState<RecoveryCodesStatusResponse | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);

  // TOTP (§1.73).
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpDisableOpen, setTotpDisableOpen] = useState(false);

  // Approve a laptop (§1.71 scanner-free entry).
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    setSupported(passkeysSupported());
    setRpHost(window.location.hostname);
    setTunnelWarn(quickTunnelWarning(window.location.hostname));
    void listPasskeys()
      .then(setPasskeys)
      .catch(() => setPkError('Could not load your passkeys.'));
    void recoveryCodesStatus()
      .then(setRecStatus)
      .catch(() => undefined);
  }, []);

  async function addPasskey(): Promise<void> {
    if (pkBusy) return;
    setPkBusy(true);
    setPkError(null);
    try {
      const opts = await passkeyRegisterOptions();
      const response = await createPasskey(opts.options);
      const trimmed = nickname.trim().slice(0, PASSKEY_NICKNAME_MAX_CHARS);
      const res = await passkeyRegister(response, trimmed || null);
      setPasskeys((prev) => (prev ? [...prev, res.passkey] : [res.passkey]));
      setNickname('');
      toast('Passkey added'); // §1.56
    } catch (err) {
      if (isWebAuthnCancel(err)) {
        // Dismissed the platform prompt — not an error.
      } else if (err instanceof ApiError && err.code === 'passkeys_cap') {
        setPkError(`That's the cap — ${PASSKEYS_MAX} passkeys. Delete one first.`);
      } else if (err instanceof ApiError && err.code === 'passkey_exists') {
        setPkError('This device already has a passkey for this account.');
      } else {
        setPkError('Could not add a passkey here. Try again, or another device.');
      }
    } finally {
      setPkBusy(false);
    }
  }

  async function saveRename(pk: PasskeyInfo): Promise<void> {
    const name = renameValue.trim().slice(0, PASSKEY_NICKNAME_MAX_CHARS);
    if (!name) {
      setRenamingId(null);
      return;
    }
    try {
      const updated = await renamePasskey(pk.id, name);
      setPasskeys((prev) => (prev ? prev.map((p) => (p.id === pk.id ? updated : p)) : prev));
      toast('Passkey renamed');
    } catch {
      setPkError('Could not rename it — try again.');
    } finally {
      setRenamingId(null);
    }
  }

  async function reallyDelete(pk: PasskeyInfo): Promise<void> {
    try {
      await deletePasskey(pk.id);
      setPasskeys((prev) => (prev ? prev.filter((p) => p.id !== pk.id) : prev));
      toast('Passkey deleted');
    } catch {
      setPkError('Could not delete it — try again.');
    } finally {
      setConfirmDeleteId(null);
    }
  }

  function openManualCode(e: FormEvent): void {
    e.preventDefault();
    let code = manualCode.trim();
    // A pasted /link/<code> URL works too — take the tail.
    const idx = code.lastIndexOf('/link/');
    if (idx >= 0) code = code.slice(idx + '/link/'.length);
    code = code.replace(/\s+/g, '');
    if (!code) return;
    // Case untouched: the full code is case-sensitive base64url; the server
    // normalizes the 6-char display code itself.
    router.push(`/link/${encodeURIComponent(code)}`);
  }

  if (!me) return null;

  const totpOn = me.totp_enabled;

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 IA: this page is the "Devices & security" category
            (proto ref 52) — sessions first, then the sign-in locks. */}
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Devices &amp; security</h1>
        <span />
      </header>

      <div className="settings-section">
        {/* ---- §1.1 sessions = the device registry (reference: SESSIONS first) ---- */}
        <h2>Sessions</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>Active sessions</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Every signed-in device — password, passkey or phone-approved alike. Revoking one
              signs it out instantly.
            </p>
          </div>
          <Link href="/settings/sessions" className="btn">
            Open
          </Link>
        </div>

        {/* ---- §1.70 passkeys ---- */}
        <h2>Passkeys</h2>
        <div className="card">
          <p className="muted small" style={{ marginTop: 0 }}>
            Sign in with your face, fingerprint or device PIN — no password typed, nothing to
            phish. Your password keeps working either way.
          </p>
          {tunnelWarn ? <p className={ap.warnNote}>{tunnelWarn}</p> : null}
          {passkeys === null ? (
            <p className="muted small" role="status">
              Loading…
            </p>
          ) : passkeys.length === 0 ? (
            <p className="muted small">No passkeys yet.</p>
          ) : (
            <div>
              {passkeys.map((pk) => (
                <div key={pk.id} className={ap.passkeyRow}>
                  <div className={ap.passkeyMain}>
                    {renamingId === pk.id ? (
                      <input
                        className="input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={PASSKEY_NICKNAME_MAX_CHARS}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void saveRename(pk);
                          }
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <div className={ap.passkeyName}>
                          {pk.nickname ?? 'Unnamed passkey'}
                          {pk.device_type === 'multiDevice' ? (
                            <span className="chip" style={{ marginLeft: 8 }}>
                              synced
                            </span>
                          ) : null}
                          {pk.backed_up ? (
                            <span className="chip" style={{ marginLeft: 6 }}>
                              backed up
                            </span>
                          ) : null}
                        </div>
                        {/* Each phrase is nowrap so a tight 390px row breaks
                            at the · separator, never mid-phrase. */}
                        <p className="muted small" style={{ margin: '3px 0 0' }}>
                          <span className={ap.metaPhrase}>added {formatTime(pk.created_at)}</span>
                          {' · '}
                          <span className={ap.metaPhrase}>
                            {pk.last_used_at
                              ? `last used ${formatTime(pk.last_used_at)}`
                              : 'never used'}
                          </span>
                        </p>
                      </>
                    )}
                  </div>
                  <div className={ap.rowActions}>
                    {renamingId === pk.id ? (
                      <button type="button" className="btn" onClick={() => void saveRename(pk)}>
                        Save
                      </button>
                    ) : confirmDeleteId === pk.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => void reallyDelete(pk)}
                        >
                          Really delete
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirmDeleteId(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            setRenamingId(pk.id);
                            setRenameValue(pk.nickname ?? '');
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setConfirmDeleteId(pk.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {supported ? (
            <div style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor="pk-nickname">Name for the new passkey (optional)</label>
                <input
                  id="pk-nickname"
                  className="input"
                  placeholder="e.g. This laptop"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={PASSKEY_NICKNAME_MAX_CHARS}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pkBusy || (passkeys !== null && passkeys.length >= PASSKEYS_MAX)}
                onClick={() => void addPasskey()}
              >
                {pkBusy ? 'Waiting for the device…' : '🔑 Add a passkey'}
              </button>
              {passkeys !== null && passkeys.length >= PASSKEYS_MAX ? (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  You&rsquo;re at the {PASSKEYS_MAX}-passkey cap.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="muted small">This browser does not support passkeys.</p>
          )}
          {pkError ? <p className="error-text">{pkError}</p> : null}
          <p className="muted small" style={{ marginBottom: 0 }}>
            Passkeys are bound to this server&rsquo;s domain ({rpHost || '…'}).
          </p>
        </div>

        {/* ---- §1.73 two-factor ---- */}
        <h2>Two-factor (authenticator app)</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>
              Authenticator codes
              {totpOn ? (
                <span className="ok-text" style={{ marginLeft: 8 }}>
                  ON
                </span>
              ) : (
                <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                  OFF
                </span>
              )}
            </strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              {totpOn
                ? 'Password and passkey sign-ins also ask for a 6-digit code. Recovery codes skip it — they are the lost-authenticator path.'
                : 'A 6-digit code from an authenticator app as a second lock on password and passkey sign-ins.'}
            </p>
          </div>
          {totpOn ? (
            <button type="button" className="btn btn-danger" onClick={() => setTotpDisableOpen(true)}>
              Turn off
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setTotpSetupOpen(true)}>
              Turn on
            </button>
          )}
        </div>

        {/* ---- §1.72 recovery codes ---- */}
        <h2>Recovery codes</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>
              {recStatus === null
                ? 'Recovery codes'
                : recStatus.generated_at === null
                  ? 'No recovery codes yet'
                  : `${recStatus.remaining} of ${recStatus.total} left`}
            </strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              {recStatus?.generated_at
                ? `One-time codes for when everything else is lost — generated ${formatTime(recStatus.generated_at)}. Using one signs out every device and asks for a new password.`
                : 'One-time codes for when everything else is lost. Generate a set and keep it offline.'}
            </p>
            {recStatus && recStatus.generated_at !== null && recStatus.remaining <= 1 ? (
              <p className="error-text" style={{ margin: '4px 0 0' }}>
                {recStatus.remaining === 0
                  ? 'All used up — generate fresh ones now.'
                  : 'Only one left — consider fresh ones.'}
              </p>
            ) : null}
          </div>
          <button type="button" className="btn" onClick={() => setRegenOpen(true)}>
            {recStatus?.generated_at ? 'Regenerate' : 'Generate'}
          </button>
        </div>

        {/* ---- §1.71 scanner-free approve entry ---- */}
        <h2>Approve a laptop</h2>
        <div className="card">
          <p className="muted small" style={{ marginTop: 0 }}>
            A logged-out computer showing &ldquo;Log in with your phone&rdquo;? Scan its QR — or
            type its short code here, no camera needed.
          </p>
          <form onSubmit={openManualCode} style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="e.g. K7M2QX"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-label="Short code from the laptop"
            />
            <button type="submit" className="btn btn-primary" disabled={!manualCode.trim()}>
              Continue
            </button>
          </form>
        </div>

      </div>

      {totpSetupOpen ? <TotpSetupSheet onClose={() => setTotpSetupOpen(false)} /> : null}
      {totpDisableOpen ? <TotpDisableSheet onClose={() => setTotpDisableOpen(false)} /> : null}
      {regenOpen ? (
        <RegenerateSheet
          username={me.username}
          onClose={() => setRegenOpen(false)}
          onDone={() => {
            setRegenOpen(false);
            void recoveryCodesStatus()
              .then(setRecStatus)
              .catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

export default function SecurityPage() {
  return (
    <AppShell>
      <SecuritySettings />
    </AppShell>
  );
}
