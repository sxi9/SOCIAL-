'use client';

// Admin instance settings (§1.41). One switch today: invites. Enforced at
// mint AND accept server-side (minted links outlive the flip); registration
// with a token degrades to invite:null rather than failing. Ring-logged.
// v0.7.1 (§1.55): TURN state surfaces here too, read from the same
// GET /api/call-selftest everyone consumes — a read-only environment fact,
// NOT a PATCHable InstanceSettings field.
import { useEffect, useState } from 'react';
import { LEGAL_PAGES, type CallSelftestResponse, type InstanceSettings, type LegalTexts } from '@socialchat/shared';
import { adminSettings, adminUpdateSettings } from '@/lib/admin';
import { api } from '@/lib/api';
import ad from '@/components/admin.module.css';

/** Wave 1 (§1.1): operator contact + the three legal pages as markdown.
 * Empty = the shipped default renders (see /terms etc. live). */
function LegalEditor({ settings, onSaved }: { settings: InstanceSettings; onSaved: (s: InstanceSettings) => void }) {
  const [contact, setContact] = useState(settings.operator_contact);
  const [legal, setLegal] = useState<LegalTexts>(settings.legal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await adminUpdateSettings({ operator_contact: contact.trim(), legal });
      onSaved(res.settings);
      setSaved(true);
    } catch {
      setError('Could not save — try again.');
    } finally {
      setBusy(false);
    }
  }
  const LABELS: Record<(typeof LEGAL_PAGES)[number], string> = { terms: 'Terms (/terms)', privacy: 'Privacy (/privacy)', guidelines: 'Community guidelines (/guidelines)' };
  return (
    <div style={{ marginTop: 18 }}>
      <h3>Operator &amp; legal</h3>
      <p className={ad.note}>
        The contact shows on the sign-in page, the About block, the 403 screens and the legal pages
        (an email, a handle, a URL). Each page is markdown; leave one empty to keep the shipped
        default text, which already states what this software stores.
      </p>
      <div className="field">
        <label htmlFor="op-contact">Operator contact</label>
        <input id="op-contact" className="input" value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} placeholder="e.g. hello@example.org or @someone" />
      </div>
      {LEGAL_PAGES.map((k) => (
        <div className="field" key={k}>
          <label htmlFor={`legal-${k}`}>{LABELS[k]}</label>
          <textarea
            id={`legal-${k}`}
            className="input"
            rows={6}
            value={legal[k]}
            placeholder="Empty = the shipped default"
            onChange={(e) => setLegal((prev) => ({ ...prev, [k]: e.target.value }))}
          />
        </div>
      ))}
      {error ? <p className="error-text">{error}</p> : null}
      {saved ? <p className="ok-text">Saved.</p> : null}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save operator & legal'}
      </button>
    </div>
  );
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnConfigured, setTurnConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminSettings()
      .then((res) => {
        if (!cancelled) setSettings(res.settings);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load settings.');
      });
    void api
      .get<CallSelftestResponse>('/api/call-selftest')
      .then((res) => {
        if (!cancelled) setTurnConfigured(res.turn_configured);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleInvites(): Promise<void> {
    if (!settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminUpdateSettings({ invites_enabled: !settings.invites_enabled });
      setSettings(res.settings);
    } catch {
      setError('Could not save — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Instance settings</h2>
      {error ? <p className="error-text">{error}</p> : null}
      {settings === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : (
        <div className={ad.settingRow}>
          <div>
            <h3>Invite links</h3>
            <p>
              Off: minting and accepting invites both answer invites_disabled (existing links stop
              working too), and registering with a token still succeeds — it just lands without the
              invite. The flip is audit-logged.
            </p>
          </div>
          <button
            type="button"
            className={`btn${settings.invites_enabled ? ' btn-primary' : ''}`}
            disabled={busy}
            aria-pressed={settings.invites_enabled}
            onClick={() => void toggleInvites()}
          >
            {busy ? '…' : settings.invites_enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      )}
      {settings ? <LegalEditor settings={settings} onSaved={setSettings} /> : null}
      <div className={ad.settingRow} style={{ marginTop: 14 }}>
        <div>
          <h3>Call relay (TURN)</h3>
          <p>
            {turnConfigured === null
              ? 'Reading…'
              : turnConfigured
                ? 'Configured — cross-network calls can relay through coturn (reachability still depends on each caller’s network; Settings → Call self-test checks it from a device).'
                : 'Not configured (no TURN_SECRET) — calls only work when both sides are on the same network. Set TURN_SECRET and deploy coturn reachably (VPS or port forwarding); a laptop behind home NAT with an HTTP-only tunnel cannot relay media.'}
          </p>
        </div>
        <span className={`btn${turnConfigured ? ' btn-primary' : ''}`} aria-disabled style={{ pointerEvents: 'none' }}>
          {turnConfigured === null ? '…' : turnConfigured ? 'Configured' : 'Absent'}
        </span>
      </div>
      <p className={ad.note} style={{ marginTop: 14 }}>
        TURN state is environment fact, read via <code>GET /api/call-selftest</code> — change it in{' '}
        <code>.env</code> on the host (<code>./bored status</code> prints the same), not here.
      </p>
      <p className={ad.note} style={{ marginTop: 14 }}>
        Adminhood is granted and removed from the Users tab (or via{' '}
        <code>node dist/cli.js grant-admin &lt;username&gt;</code> / <code>revoke-admin</code>). The
        CLI is the only way to remove your own role or the last admin (ADR-013, amended).
      </p>
    </div>
  );
}
