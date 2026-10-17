'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AREA_MAX_CHARS,
  MAX_AVATAR_SOURCE_BYTES,
  type AvatarMotion,
  type AvatarResponse,
  type UpdateMeResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { logout } from '@/lib/connection';
import { disablePush, enablePush, getPushSubscription, pushSupported } from '@/lib/push';
import { toast } from '@/lib/toast';
import { setMe } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Avatar from '@/components/Avatar';
import ProfileEditor from '@/components/ProfileEditor';
import { RescueCard } from '@/components/RescueSheet';
import TabPage from '@/components/TabPage';

/** v0.7.1 (§1.56): per-browser unblock steps for the 'denied' state — the
 * page cannot re-ask, so the row says exactly where the switch lives. */
function unblockSteps(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iPhone/iPad: add Bored Chat to your home screen (Share → Add to Home Screen), then iOS Settings → Notifications → Bored Chat → Allow Notifications.';
  }
  if (/Firefox/.test(ua)) {
    return 'Firefox: tap the permissions icon left of the address bar → Notifications → remove the "Blocked" entry, then reload and enable here.';
  }
  if (/Edg\//.test(ua)) {
    return 'Edge: tap the lock icon in the address bar → Permissions for this site → Notifications → Allow, then reload and enable here.';
  }
  if (/Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua)) {
    return 'Safari: menu Safari → Settings → Websites → Notifications → set this site to Allow, then reload and enable here.';
  }
  return 'Chrome: tap the lock/tune icon in the address bar → Site settings → Notifications → Allow, then reload and enable here.';
}

function ProfileSettings() {
  const state = useAppState();
  const router = useRouter();
  const me = state.me;

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [area, setArea] = useState('');
  const [motion, setMotion] = useState<AvatarMotion>('auto');
  const seededRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // v0.7.1 (§1.56, FEATURES #90b): the row always tells the truth — ON
  // (permission granted + live subscription), OFF ('default', or granted with
  // no subscription), or Blocked by browser ('denied' — the page cannot
  // re-ask; per-browser unblock steps shown instead).
  const [pushStatus, setPushStatus] = useState<'on' | 'off' | 'blocked' | 'unsupported' | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (me && !seededRef.current) {
      seededRef.current = true;
      setDisplayName(me.display_name);
      setBio(me.bio);
      setArea(me.area ?? '');
      setMotion(me.avatar_motion);
    }
  }, [me]);

  useEffect(() => {
    refreshPushStatus();
  }, []);

  function refreshPushStatus(): void {
    if (!pushSupported()) {
      setPushStatus('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushStatus('blocked');
      return;
    }
    void getPushSubscription()
      .then((sub) => setPushStatus(sub !== null && Notification.permission === 'granted' ? 'on' : 'off'))
      .catch(() => setPushStatus('off'));
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.patch<UpdateMeResponse>('/api/users/me', {
        display_name: displayName.trim(),
        bio,
        avatar_motion: motion,
        // Coarse self-declared area (§1.13): null clears it (and with it all
        // 'area' beacon visibility, both directions). Owner-private.
        area: area.trim() === '' ? null : area.trim(),
      });
      setMe(res.user);
      setSaved(true);
      toast('Settings saved'); // §1.56: actions without a visible result confirm themselves
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || 'Could not save.') : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file: File): Promise<void> {
    setAvatarError(null);
    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      setAvatarError('Avatar sources are capped at 15 MB.');
      return;
    }
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      // 202: processing — completion arrives as WS user.updated (§1.2).
      const res = await api.postForm<AvatarResponse>('/api/users/me/avatar', form);
      if (me) setMe({ ...me, avatar: { ...me.avatar, ...res.avatar } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 415) setAvatarError('That file type is not supported.');
      else if (err instanceof ApiError && err.status === 413) setAvatarError('That file is too large.');
      else setAvatarError('Avatar upload failed.');
    }
  }

  async function removeAvatar(): Promise<void> {
    setAvatarError(null);
    try {
      const res = await api.del<AvatarResponse>('/api/users/me/avatar');
      if (me) setMe({ ...me, avatar: res.avatar });
    } catch {
      setAvatarError('Could not remove the avatar.');
    }
  }

  async function togglePush(): Promise<void> {
    if (pushBusy || pushStatus === null || pushStatus === 'unsupported' || pushStatus === 'blocked') return;
    setPushBusy(true);
    try {
      if (pushStatus === 'on') {
        await disablePush();
      } else {
        await enablePush();
      }
    } catch {
      /* permission denied or endpoint failure; the refresh below tells the truth */
    } finally {
      refreshPushStatus();
      setPushBusy(false);
    }
  }

  if (!me) return null;

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Profile</h1>
        <Link href={`/u/${encodeURIComponent(me.username)}`} className="btn btn-ghost">
          View
        </Link>
        <Link href="/settings/sessions" className="btn btn-ghost">
          Devices
        </Link>
      </header>

      <div className="settings-section">
        <h2>Avatar</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Profile page: the animated WebP renders here (motion-gated, §5.4). */}
          <Avatar avatar={me.avatar} name={me.display_name} size={72} animated />
          <div style={{ flex: 1 }}>
            {me.avatar.status === 'processing' ? (
              <p className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="spinner" /> Processing — it will pop in when ready.
              </p>
            ) : me.avatar.status === 'failed' ? (
              <p className="error-text">Processing failed. The previous avatar is kept.</p>
            ) : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/gif,image/webp,image/apng,image/png,image/jpeg,video/mp4"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAvatar(f);
                  e.target.value = '';
                }}
              />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                Upload new
              </button>
              {me.avatar.status === 'ready' ? (
                <button type="button" className="btn btn-danger" onClick={() => void removeAvatar()}>
                  Remove
                </button>
              ) : null}
            </div>
            {avatarError ? <p className="error-text">{avatarError}</p> : null}
            <p className="muted small">GIF, WebP, APNG, PNG, JPEG or MP4 — animated sources become a live avatar.</p>
          </div>
        </div>

        <h2>Details</h2>
        <div className="card">
          <div className="field">
            <label htmlFor="pf-name">Display name</label>
            <input
              id="pf-name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-bio">Bio</label>
            <textarea
              id="pf-bio"
              className="input"
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={1000}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-area">Area</label>
            <input
              id="pf-area"
              className="input"
              placeholder="e.g. Indiranagar"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              maxLength={AREA_MAX_CHARS}
            />
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Only used to match &ldquo;my area&rdquo; beacons — never shown on your profile, never
              GPS. Leave it empty to opt out.
            </p>
          </div>
          <div className="field">
            <label htmlFor="pf-motion">Animated avatars</label>
            <select
              id="pf-motion"
              className="input"
              value={motion}
              onChange={(e) => setMotion(e.target.value as AvatarMotion)}
            >
              <option value="auto">Auto — play (respects reduce-motion)</option>
              <option value="reduced">Reduced — play on hover only</option>
              <option value="off">Off — always static</option>
            </select>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          {saved ? <p className="ok-text">Saved.</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !displayName.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* v0.5a §1.37: interests, work/skills, the 3-GIF strip. */}
        <ProfileEditor />

        <h2>Friends</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>Connections</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Friend requests and your people — friends also include everyone you DM.
            </p>
          </div>
          <Link href="/connections" className="btn">
            Open
          </Link>
        </div>

        {/* v0.6 §1.46: one tap pings up to 3 friends to call you out of a
            boring situation — the one push that cuts through mutes. */}
        <RescueCard />

        <h2>Notifications</h2>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                Push notifications
                {pushStatus === 'on' ? (
                  <span className="ok-text" style={{ marginLeft: 8 }}>ON</span>
                ) : pushStatus === 'off' ? (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>OFF</span>
                ) : pushStatus === 'blocked' ? (
                  <span className="error-text" style={{ marginLeft: 8 }}>Blocked by browser</span>
                ) : null}
              </strong>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {pushStatus === 'unsupported'
                  ? 'Not supported in this browser.'
                  : 'Messages, incoming calls, sparked plans and wave nudges when the app is closed — rings depend on this.'}
              </p>
            </div>
            {pushStatus !== 'blocked' ? (
              <button
                type="button"
                className={`btn${pushStatus === 'on' ? '' : ' btn-primary'}`}
                disabled={pushStatus === 'unsupported' || pushBusy || pushStatus === null}
                onClick={() => void togglePush()}
              >
                {pushStatus === null ? '…' : pushStatus === 'on' ? 'Disable' : 'Enable'}
              </button>
            ) : null}
          </div>
          {pushStatus === 'blocked' ? (
            <p className="muted small" style={{ marginBottom: 0 }}>
              {/* §1.56: 'denied' cannot be re-asked from the page — per-browser
                  unblock steps, keyed on the UA. */}
              {unblockSteps()}
            </p>
          ) : null}
        </div>

        {/* v0.7.1 (§1.55, FEATURES #89): find out BEFORE a call fails. */}
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>Call self-test</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Checks mic &amp; camera permission, secure context, and whether this server&rsquo;s
              call relay is reachable from your network — in plain words.
            </p>
          </div>
          <Link href="/settings/calls" className="btn">
            Run
          </Link>
        </div>

        <h2>Privacy &amp; safety</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>Privacy settings</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Read receipts, last seen, typing, invites, beacon audience, groups — plus your
              blocked list.
            </p>
          </div>
          <Link href="/settings/privacy" className="btn">
            Open
          </Link>
        </div>

        <h2>Account</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>@{me.username}</strong>
            <p className="muted small" style={{ margin: '4px 0 0' }}>{me.email}</p>
          </div>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              void logout().then(() => router.replace('/login'));
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProfileSettingsPage() {
  return (
    <TabPage active="profile">
      <ProfileSettings />
    </TabPage>
  );
}
