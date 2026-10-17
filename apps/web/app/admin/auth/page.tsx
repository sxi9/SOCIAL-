'use client';

// Admin → Authentication (v0.9 — API.md §1.74, FEATURES #86, ADR-021).
// Config-not-code readiness: the SMTP block and the four feature toggles
// PERSIST today, but no mailer ships in v0.9 (golden rule 10) — so every
// email-dependent control renders visible-but-inert behind the binding
// "needs SMTP support in a future update" note, Test send answers an honest
// 503, and flipping toggles becomes meaningful the release a mailer lands.
import { useEffect, useState, type FormEvent } from 'react';
import {
  AUTH_FEATURE_TOGGLES,
  SMTP_FIELD_MAX_CHARS,
  type AuthSettings,
  type AuthSettingsPatch,
  type InstanceSettings,
} from '@socialchat/shared';
import { adminSettings, adminUpdateSettings } from '@/lib/admin';
import { api, ApiError } from '@/lib/api';
import { quickTunnelWarning } from '@/lib/auth';
import { toast } from '@/lib/toast';
import ad from '@/components/admin.module.css';
import ap from '@/components/authpack.module.css';

const INERT_NOTE = 'needs SMTP support in a future update';

const TOGGLE_COPY: Record<(typeof AUTH_FEATURE_TOGGLES)[number], { title: string; hint: string }> = {
  email_verification: {
    title: 'Require email verification',
    hint: 'New accounts must confirm their address before chatting.',
  },
  email_otp: {
    title: 'Email one-time codes at login',
    hint: 'A 6-digit code mailed on every sign-in, as a second factor.',
  },
  magic_links: {
    title: 'Magic sign-in links',
    hint: 'Password-free login links by email.',
  },
  password_reset: {
    title: 'Password reset by email',
    hint: 'Self-serve reset mail (recovery codes work regardless).',
  },
};

export default function AdminAuthPage() {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rpHost, setRpHost] = useState('');
  const [tunnelWarn, setTunnelWarn] = useState<string | null>(null);

  // SMTP form fields (string-local; '' serializes to null on save).
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState('');
  const [from, setFrom] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);

  function seed(auth: AuthSettings): void {
    setHost(auth.smtp.host ?? '');
    setPort(String(auth.smtp.port));
    setSecure(auth.smtp.secure);
    setUsername(auth.smtp.username ?? '');
    setFrom(auth.smtp.from ?? '');
    setPassword('');
    setClearPassword(false);
  }

  useEffect(() => {
    setRpHost(window.location.hostname);
    setTunnelWarn(quickTunnelWarning(window.location.hostname));
    let cancelled = false;
    void adminSettings()
      .then((res) => {
        if (cancelled) return;
        setSettings(res.settings);
        seed(res.settings.auth);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveSmtp(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!settings || busy) return;
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError('Port must be 1–65535.');
      return;
    }
    setBusy(true);
    setError(null);
    const smtp: NonNullable<AuthSettingsPatch['smtp']> = {
      host: host.trim() === '' ? null : host.trim(),
      port: portNum,
      secure,
      username: username.trim() === '' ? null : username.trim(),
      from: from.trim() === '' ? null : from.trim(),
    };
    // §1.74: the password is WRITE-ONLY — a string stores it (encrypted,
    // its own settings key), null clears it, absence leaves it alone. It
    // never reads back; password_set is all that serializes.
    if (clearPassword) smtp.password = null;
    else if (password.length > 0) smtp.password = password;
    try {
      const res = await adminUpdateSettings({ auth: { smtp } });
      setSettings(res.settings);
      seed(res.settings.auth);
      toast('Authentication settings saved'); // §1.56
    } catch {
      setError('Could not save — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function testSend(): Promise<void> {
    // Honesty check (§1.74): always 503 mailer_unavailable in v0.9. The
    // button is disabled; this stays for the release that enables it.
    try {
      await api.post('/api/admin/settings/auth/test-send', { to: 'test@example.com' });
      toast('Test mail sent');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'mailer_unavailable'
          ? 'No mailer ships in this version yet — the config is stored and ready.'
          : 'Test send failed.',
      );
    }
  }

  const auth = settings?.auth ?? null;
  const mailerAvailable = auth?.mailer_available ?? false;

  return (
    <div>
      <h2>Authentication</h2>
      {error ? <p className="error-text">{error}</p> : null}
      {auth === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : (
        <>
          {/* ---- SMTP block: fully storable TODAY (§1.74) ---- */}
          <h3 style={{ marginBottom: 6 }}>Outgoing mail (SMTP)</h3>
          <p className={ad.note}>
            The config saves now and a future update uses it as-is — enabling email features later
            is flipping the toggles below, not re-entering settings. No mail is sent in this
            version.
          </p>
          <form onSubmit={(e) => void saveSmtp(e)} style={{ maxWidth: 560 }}>
            <div className="field">
              <label htmlFor="smtp-host">Host</label>
              <input
                id="smtp-host"
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.example.com"
                maxLength={SMTP_FIELD_MAX_CHARS}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div className="field" style={{ width: 120 }}>
                <label htmlFor="smtp-port">Port</label>
                <input
                  id="smtp-port"
                  className="input"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                />
              </div>
              <div className="field" style={{ alignSelf: 'flex-end' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
                  TLS (secure)
                </label>
              </div>
            </div>
            <div className="field">
              <label htmlFor="smtp-user">Username</label>
              <input
                id="smtp-user"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                maxLength={SMTP_FIELD_MAX_CHARS}
              />
            </div>
            <div className="field">
              <label htmlFor="smtp-from">From address</label>
              <input
                id="smtp-from"
                className="input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="Bored Chat <noreply@example.com>"
                maxLength={SMTP_FIELD_MAX_CHARS}
              />
            </div>
            <div className="field">
              <label htmlFor="smtp-pass">
                Password{' '}
                {auth.smtp.password_set ? (
                  <span className="ok-text" style={{ fontWeight: 400 }}>
                    — one is stored (write-only, never shown)
                  </span>
                ) : (
                  <span className="muted" style={{ fontWeight: 400 }}>
                    — none stored
                  </span>
                )}
              </label>
              <input
                id="smtp-pass"
                className="input"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (e.target.value) setClearPassword(false);
                }}
                placeholder={auth.smtp.password_set ? 'leave empty to keep the stored one' : ''}
                autoComplete="new-password"
                maxLength={SMTP_FIELD_MAX_CHARS}
                disabled={clearPassword}
              />
              {auth.smtp.password_set ? (
                <label
                  className="muted small"
                  style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={clearPassword}
                    onChange={(e) => setClearPassword(e.target.checked)}
                  />
                  clear the stored password on save
                </label>
              ) : null}
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Stored encrypted in instance settings. An <code>SMTP_PASSWORD</code> env on the
                host takes precedence over whatever is stored here.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save SMTP settings'}
              </button>
              {/* §1.74 binding copy: disabled + the note, until a mailer ships. */}
              <button
                type="button"
                className="btn"
                disabled={!mailerAvailable}
                title={mailerAvailable ? undefined : INERT_NOTE}
                onClick={() => void testSend()}
              >
                Test send
              </button>
              {!mailerAvailable ? <span className="muted small">{INERT_NOTE}</span> : null}
            </div>
          </form>

          {/* ---- feature toggles: visible but inert (§1.74 / SPECS #86) ---- */}
          <h3 style={{ marginTop: 22 }}>Email features</h3>
          {AUTH_FEATURE_TOGGLES.map((key) => (
            <div key={key} className={`${ad.settingRow}${mailerAvailable ? '' : ` ${ap.inertToggle}`}`}>
              <div>
                <h3>{TOGGLE_COPY[key].title}</h3>
                <p>
                  {TOGGLE_COPY[key].hint}
                  {!mailerAvailable ? (
                    <>
                      {' '}
                      <em>({INERT_NOTE})</em>
                    </>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                className={`btn${auth.features[key] ? ' btn-primary' : ''}`}
                aria-pressed={auth.features[key]}
                disabled={!mailerAvailable || busy}
                title={mailerAvailable ? undefined : INERT_NOTE}
                onClick={() => {
                  void (async () => {
                    if (!settings) return;
                    setBusy(true);
                    try {
                      const res = await adminUpdateSettings({
                        auth: { features: { [key]: !auth.features[key] } },
                      });
                      setSettings(res.settings);
                      toast('Authentication settings saved');
                    } catch {
                      setError('Could not save — try again.');
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                {auth.features[key] ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          ))}

          {/* ---- SMS gateway: a documented placeholder, no schema (§1.74) ---- */}
          <h3 style={{ marginTop: 22 }}>SMS gateway</h3>
          <div className={`${ad.settingRow} ${ap.inertToggle}`}>
            <div>
              <h3>Text-message codes</h3>
              <p>
                Coming later — the slot is reserved, no gateway is chosen yet. Nothing to configure
                until one is.
              </p>
            </div>
            <span className="btn" aria-disabled style={{ pointerEvents: 'none' }}>
              Coming later
            </span>
          </div>

          {/* ---- §1.70 rpID readout + quick-tunnel warning ---- */}
          <h3 style={{ marginTop: 22 }}>Passkey domain (rpID)</h3>
          <p className={ad.note}>
            Passkeys on this page&rsquo;s origin bind to <code>{rpHost || '…'}</code> (overridable
            with <code>WEBAUTHN_RP_ID</code>, else derived from <code>PUBLIC_ORIGIN</code>/
            <code>DOMAIN</code> — check <code>./bored status</code> on the host for the effective
            value). Changing the domain orphans every enrolled passkey.
          </p>
          {tunnelWarn ? <p className={ap.warnNote}>{tunnelWarn}</p> : null}
        </>
      )}
    </div>
  );
}
