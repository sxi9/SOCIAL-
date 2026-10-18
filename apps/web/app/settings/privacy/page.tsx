'use client';

// Privacy settings (v0.3 — API.md §1.13, FEATURES #28). Every control mirrors
// a server-enforced setting; PATCH applies immediately (partial update).
// Calm defaults by design (PSYCHOLOGY §6) — and the read-receipt toggle is
// reciprocal: hiding yours hides everyone else's from you.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  ActivityVisibility,
  AnonOptin,
  BeaconAudience,
  GroupAddPolicy,
  SettingsResponse,
  ShowLastSeen,
  UpdateSettingsRequest,
  UserSettings,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import { setSettings as storeSettings } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';

const CHEV = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...CHEV} />
    </svg>
  );
}

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
      toast('Settings saved'); // v0.7.1 §1.56: the shared confirmation toast
    } catch {
      setLocal(prev);
      storeSettings(prev);
      setError('That change did not save — try again.');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 IA: reached from the /settings category page. */}
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Privacy &amp; safety</h1>
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

          {/* v0.8a §1.58: a per-VIEWER render toggle — whether MY client
              performs other people's mood-reactive bubble effects. Stored
              server-side purely for cross-device sync. */}
          <h2>Moods &amp; effects</h2>
          <div className="card">
            <ToggleRow
              title="Mood effects"
              hint="When someone's visible mood is drunk, sad or hyped, their bubbles perform a little (wobble, rain, bounce). Off keeps every chat still. Reduced-motion devices never see them either way."
              value={settings.mood_effects}
              onChange={(v) => void patch({ mood_effects: v })}
            />
          </div>

          {/* v0.8a §1.59: per-kind activity-strip visibility. The toggle can
              only NARROW — an item never shows wider than the thing itself
              (a friends-only beacon never appears in public activity). */}
          <h2>Activity on your profile</h2>
          <div className="card">
            <SelectRow
              id="pv-act-beacons"
              title="Beacons you lit & plans you sparked"
              value={settings.activity_beacons}
              options={ACTIVITY_OPTIONS}
              onChange={(v) => void patch({ activity_beacons: v as ActivityVisibility })}
            />
            <SelectRow
              id="pv-act-posts"
              title="Posts"
              value={settings.activity_posts}
              options={ACTIVITY_OPTIONS}
              onChange={(v) => void patch({ activity_posts: v as ActivityVisibility })}
            />
            <SelectRow
              id="pv-act-listings"
              title="Board listings"
              value={settings.activity_listings}
              options={ACTIVITY_OPTIONS}
              onChange={(v) => void patch({ activity_listings: v as ActivityVisibility })}
            />
            <SelectRow
              id="pv-act-games"
              title="Puzzles & games"
              value={settings.activity_games}
              options={ACTIVITY_OPTIONS}
              onChange={(v) => void patch({ activity_games: v as ActivityVisibility })}
            />
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Applies instantly, and never widens anything: people only ever see activity about
              things they could already see themselves. Moods never show up here — they leave no
              trace at all.
            </p>
          </div>

          {/* v0.8b §1.62/§1.63: anonymous game opt-in + the wave nudge.
              Both are enforced server-side; refusals stay invisible. */}
          <h2>Anonymous &amp; nudges</h2>
          <div className="card">
            <SelectRow
              id="pv-anon"
              title="🎭 Who can send you anonymous messages"
              value={settings.anon_messages}
              options={[
                { value: 'nobody', label: 'Nobody' },
                { value: 'connections', label: 'Connections' },
                { value: 'everyone', label: 'Everyone' },
              ]}
              onChange={(v) => void patch({ anon_messages: v as AnonOptin })}
            />
            <p className="muted small" style={{ margin: '0 0 8px' }}>
              Senders are anonymous to you, never to the server — reporting a message always
              attaches who sent it. Nobody can tell what you picked here.
            </p>
            <ToggleRow
              title="👀 Wave nudges"
              hint="While you're discoverable, one anonymous “someone in the pool waved at you” per hour — no names, no counts, and only when the pool is big enough to keep the waver anonymous."
              value={settings.wave_nudges}
              onChange={(v) => void patch({ wave_nudges: v })}
            />
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

// v0.8a §1.59: 'private' = only me (ACTIVITY_VISIBILITIES).
const ACTIVITY_OPTIONS = [
  { value: 'public', label: 'Anyone who can see my profile' },
  { value: 'connections', label: 'Connections' },
  { value: 'private', label: 'Only me' },
];

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
