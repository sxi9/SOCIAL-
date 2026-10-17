'use client';

// Admin instance settings (§1.41). One switch today: invites. Enforced at
// mint AND accept server-side (minted links outlive the flip); registration
// with a token degrades to invite:null rather than failing. Ring-logged.
import { useEffect, useState } from 'react';
import type { InstanceSettings } from '@socialchat/shared';
import { adminSettings, adminUpdateSettings } from '@/lib/admin';
import ad from '@/components/admin.module.css';

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminSettings()
      .then((res) => {
        if (!cancelled) setSettings(res.settings);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load settings.');
      });
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
      <p className={ad.note} style={{ marginTop: 14 }}>
        Adminhood itself is CLI-only: <code>node dist/cli.js grant-admin &lt;username&gt;</code> /{' '}
        <code>revoke-admin &lt;username&gt;</code> — there is no web path to promote anyone
        (ADR-013).
      </p>
    </div>
  );
}
