'use client';

// Settings → Account (Royal v2 IA, proto ref 47). The editing that used to
// live on /settings/profile moved here wholesale: avatar upload/crop,
// display name / bio / area, the animated name style, avatar motion, the
// mood picker entry, and the rich-profile editor (GIF strip, interests,
// work & skills). Behavior is unchanged — only the address is new.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AREA_MAX_CHARS,
  MAX_AVATAR_SOURCE_BYTES,
  NAME_STYLES,
  type AvatarMotion,
  type AvatarResponse,
  type NameStyle,
  type UpdateMeResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { refreshMyMood } from '@/lib/mood';
import ImageEditSheet from '@/components/ImageEditSheet';
import { toast } from '@/lib/toast';
import { setMe } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import MoodChip from '@/components/MoodChip';
import MoodSheet from '@/components/MoodSheet';
import ProfileEditor from '@/components/ProfileEditor';
import StyledName from '@/components/StyledName';
import idm from '@/components/identity.module.css';
import sm from '@/components/settings.module.css';

const S = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...S} />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path d="M4.5 8.5 a2 2 0 0 1 2 -2 h1.6 l1.3 -2 h5.2 l1.3 2 h1.6 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 h-11 a2 2 0 0 1 -2 -2 Z" {...S} />
      <circle cx="12" cy="12.3" r="3.1" {...S} />
    </svg>
  );
}

function AccountSettings() {
  const state = useAppState();
  const me = state.me;

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [area, setArea] = useState('');
  const [motion, setMotion] = useState<AvatarMotion>('auto');
  // v0.8a §1.58 animated name + §1.57 mood picker entry point.
  const [nameStyle, setNameStyle] = useState<NameStyle>('none');
  const [moodOpen, setMoodOpen] = useState(false);
  const seededRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // v1.0a (#92): a picked STATIC avatar opens the crop editor first (1:1).
  // Animated sources (gif/webp/apng/mp4) skip it — canvas would flatten them.
  const [avatarEdit, setAvatarEdit] = useState<File | null>(null);

  useEffect(() => {
    if (me && !seededRef.current) {
      seededRef.current = true;
      setDisplayName(me.display_name);
      setBio(me.bio);
      setArea(me.area ?? '');
      setMotion(me.avatar_motion);
      setNameStyle(me.name_style);
    }
  }, [me]);

  // My full mood state (fade time) for the mood card — owner-only read.
  useEffect(() => {
    void refreshMyMood().catch(() => undefined);
  }, []);

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
        // v0.8a §1.58: the animated-name style — identity, not privacy.
        name_style: nameStyle,
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

  function pickAvatar(file: File): void {
    if (['image/jpeg', 'image/png'].includes(file.type)) {
      setAvatarEdit(file); // v1.0a #92 — crop first, upload from the sheet
      return;
    }
    void uploadAvatar(file);
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

  if (!me) return null;

  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Account</h1>
        <span />
      </header>

      {/* Reference 47: centered avatar, camera orb, "photo or GIF" below. */}
      <div className={sm.avatarBlock}>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/gif,image/webp,image/apng,image/png,image/jpeg,video/mp4"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickAvatar(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className={sm.avatarTap}
          aria-label="Upload a new profile photo"
          onClick={() => fileRef.current?.click()}
        >
          <Avatar avatar={me.avatar} name={me.display_name} size={84} animated />
          <span className={sm.camOrb} aria-hidden>
            <CameraIcon />
          </span>
        </button>
        <span className={sm.avatarCaption}>
          photo or GIF — animated sources become a live avatar
        </span>
        {me.avatar.status === 'processing' ? (
          <p className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0 }}>
            <span className="spinner" /> Processing — it will pop in when ready.
          </p>
        ) : me.avatar.status === 'failed' ? (
          <p className="error-text" style={{ margin: 0 }}>
            Processing failed. The previous avatar is kept.
          </p>
        ) : null}
        {me.avatar.status === 'ready' ? (
          <div className={sm.avatarActions}>
            <button type="button" className="btn btn-danger" onClick={() => void removeAvatar()}>
              Remove photo
            </button>
          </div>
        ) : null}
        {avatarError ? <p className="error-text" style={{ margin: 0 }}>{avatarError}</p> : null}
      </div>

      <div className="settings-section" style={{ marginTop: 4 }}>
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
          <label htmlFor="pf-username">Username</label>
          <input id="pf-username" className="input" value={`@${me.username}`} disabled readOnly />
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {me.email}
          </p>
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
          {/* v0.8a §1.58: animated display name with a live preview.
              'surprise' rotates daily — same style for every viewer. */}
          <label htmlFor="pf-name-style">Name style</label>
          <select
            id="pf-name-style"
            className="input"
            value={nameStyle}
            onChange={(e) => setNameStyle(e.target.value as NameStyle)}
          >
            {NAME_STYLES.map((s) => (
              <option key={s} value={s}>
                {s === 'none'
                  ? 'Off'
                  : s === 'surprise'
                    ? 'Surprise me (changes daily)'
                    : s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          {nameStyle !== 'none' ? (
            <p style={{ margin: '6px 0 0', fontSize: 16, fontWeight: 600 }}>
              <StyledName
                userId={me.id}
                style={nameStyle}
                name={displayName.trim() || me.display_name}
              />
            </p>
          ) : null}
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Shows on your profile, chat headers and group messages. Reduced-motion viewers see
            a calm static tint instead.
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

        {/* v0.8a §1.57: the mood picker entry point — the chip auto-expires
            (~4 h); the fade time shows inside the sheet, owner-only. */}
        <h2 className={idm.sectionLabel}>Mood</h2>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {state.moodState?.mood ? (
              <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <MoodChip mood={state.moodState.mood} />
                {state.moodState.expires_at ? (
                  <span className={idm.moodFade}>
                    fades by{' '}
                    {new Date(state.moodState.expires_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                ) : null}
              </p>
            ) : (
              <>
                <strong>No mood set</strong>
                <p className="muted small" style={{ margin: '4px 0 0' }}>
                  A chip that says how you are — presets, your own word, 🎢 swing mode or 🍻
                  drunk mode. It fades on its own, no trace.
                </p>
              </>
            )}
          </div>
          <button type="button" className="btn" onClick={() => setMoodOpen(true)}>
            {state.moodState?.mood ? 'Change' : 'Set a mood'}
          </button>
        </div>
        <p className="muted small" style={{ margin: '8px 2px 0' }}>
          Your mood shows next to your name — it never posts on its own.
        </p>
        {moodOpen ? <MoodSheet onClose={() => setMoodOpen(false)} /> : null}

        {/* v0.5a §1.37: interests, work/skills, the 3-GIF strip. */}
        <ProfileEditor />
      </div>

      {avatarEdit ? (
        <ImageEditSheet
          source={avatarEdit}
          fileName={avatarEdit.name}
          lockedAspect={1}
          onCancel={() => setAvatarEdit(null)}
          onDone={(file) => {
            setAvatarEdit(null);
            void uploadAvatar(file);
          }}
        />
      ) : null}
    </div>
  );
}

export default function AccountSettingsPage() {
  return (
    <AppShell>
      <AccountSettings />
    </AppShell>
  );
}
