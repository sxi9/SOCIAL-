'use client';

// Privacy settings (v0.3 — API.md §1.13, FEATURES #28). Every control mirrors
// a server-enforced setting; PATCH applies immediately (partial update).
// Calm defaults by design (PSYCHOLOGY §6) — and the read-receipt toggle is
// reciprocal: hiding yours hides everyone else's from you.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  BeaconAudience,
  GroupAddPolicy,
  SettingsResponse,
  ShowLastSeen,
  UpdateSettingsRequest,
  UserSettings,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import { setSettings as storeSettings } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';

function PrivacySettings() {
  const state = useAppState();
  const [settings, setLocal] = useState<UserSettings | null>(state.settings);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<SettingsResponse>('/api/users/me/settings')
      .then((res) => {
        if (cancelled) return;
        setLocal(res.settings);
        storeSettings(res.settings);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function patch(change: UpdateSettingsRequest): Promise<void> {
    if (!settings) return;
    const prev = settings;
    const optimistic = { ...settings, ...change };
    setLocal(optimistic);
    storeSettings(optimistic);
    setError(null);
    try {
      const res = await api.patch<SettingsResponse>('/api/users/me/settings', change);
      setLocal(res.settings);
      storeSettings(res.settings);
    } catch {
      setLocal(prev);
      storeSettings(prev);
      setError('That change did not save — try again.');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/settings/profile" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Privacy</h1>
        <span />
      </header>

      {!settings ? (
        <div className="center-screen muted" role="status">
          {error ?? 'Loading…'}
        </div>
      ) : (
        <div className="settings-section">
          <h2>Receipts &amp; presence</h2>
          <div className="card">
            <ToggleRow
              title="Read receipts"
              hint="Reciprocal: turning this off hides your “seen” from everyone — and hides everyone’s from you. Delivery ticks are unaffected."
              value={settings.read_receipts}
              onChange={(v) => void patch({ read_receipts: v })}
            />
            <SelectRow
              id="pv-last-seen"
              title="Who sees your last seen"
              value={settings.show_last_seen}
              options={[
                { value: 'everyone', label: 'Everyone' },
                { value: 'dm_partners', label: 'People you chat with' },
                { value: 'nobody', label: 'Nobody' },
              ]}
              onChange={(v) => void patch({ show_last_seen: v as ShowLastSeen })}
            />
            <ToggleRow
              title="Show when you’re typing"
              hint="Off means the three dots never appear for you."
              value={settings.show_typing}
              onChange={(v) => void patch({ show_typing: v })}
            />
          </div>

          <h2>Invites &amp; groups</h2>
          <div className="card">
            <ToggleRow
              title="Pause your invite links"
              hint="While paused, your existing links stop working and you can’t mint new ones. Nothing is deleted."
              value={settings.invites_paused}
              onChange={(v) => void patch({ invites_paused: v })}
            />
            <SelectRow
              id="pv-group-add"
              title="Who can add you to groups"
              value={settings.group_add_policy}
              options={[
                { value: 'everyone', label: 'Everyone' },
                { value: 'dm_partners', label: 'People you chat with' },
                { value: 'nobody', label: 'Nobody' },
              ]}
              onChange={(v) => void patch({ group_add_policy: v as GroupAddPolicy })}
            />
          </div>

          <h2>Beacons</h2>
          <div className="card">
            <SelectRow
              id="pv-beacon-aud"
              title="Default beacon audience"
              value={settings.beacon_default_audience}
              options={[
                { value: 'friends', label: 'Friends' },
                { value: 'area', label: 'My area' },
                { value: 'public', label: 'Public' },
              ]}
              onChange={(v) => void patch({ beacon_default_audience: v as BeaconAudience })}
            />
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              You can still pick per beacon — this is just the pre-selected chip.
              &ldquo;Friends&rdquo; means your connections plus the people you DM.
            </p>
          </div>

          <h2>Safety</h2>
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <strong>Blocked people</strong>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                Manage who can’t reach you.
              </p>
            </div>
            <Link href="/settings/blocked" className="btn">
              Open
            </Link>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      <div style={{ flex: 1 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <p className="muted small" style={{ margin: '3px 0 0' }}>
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={title}
        className={`btn${value ? ' btn-primary' : ''}`}
        onClick={() => onChange(!value)}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  );
}

function SelectRow({
  id,
  title,
  value,
  options,
  onChange,
}: {
  id: string;
  title: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="field" style={{ marginBottom: 8, marginTop: 8 }}>
      <label htmlFor={id}>{title}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function PrivacySettingsPage() {
  return (
    <AppShell>
      <PrivacySettings />
    </AppShell>
  );
}
