'use client';

// Chat settings sheet (v0.4): §1.24 appearance (theme palette + wallpaper
// pattern + per-member nicknames — ALL personal, my view only, labeled as
// such) and §1.25 disappearing messages (conversation-wide TTL; DM = anyone,
// group = admin only — the server enforces, this mirrors).
import { useEffect, useRef, useState } from 'react';
import type {
  AvatarResponse,
  ChatTheme,
  ChatWallpaper,
  ConversationListItem,
  ConversationResponse,
  UploadResponse,
  UserPublic,
  UserSearchResponse,
} from '@socialchat/shared';
import {
  CHAT_BG_VIDEO_MAX_BYTES,
  CHAT_BG_VIDEO_MAX_DURATION_S,
  CHAT_THEMES,
  CHAT_WALLPAPERS,
  DISAPPEAR_TTL_OPTIONS_S,
  MAX_AVATAR_SOURCE_BYTES,
  MAX_GROUP_PARTICIPANTS,
  MAX_IMAGE_BYTES,
  NICKNAME_MAX_CHARS,
} from '@socialchat/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import { THEME_INFO, WALLPAPER_INFO, updatePrefs, wallpaperClassName } from '@/lib/prefs';
import { getChatSoundOverride, setChatSoundOverride, type ChatSoundOverride } from '@/lib/sounds';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import ChannelMembersSheet from './ChannelMembersSheet';
import GroupSettingsSection from './GroupSettingsSection';
import ImageEditSheet from './ImageEditSheet';
import { isGhost, isSupportConversation } from '@/lib/groups';
import { InviteButton } from './InviteSheet';
import sheetStyles from './beacons.module.css';
import cm from './community.module.css';
import exp from './expression.module.css';
import idm from './identity.module.css';

const TTL_LABELS: Record<number, string> = {
  3600: '1 hour',
  86400: '24 hours',
  604800: '7 days',
  2592000: '30 days',
};

interface ChatInfoSheetProps {
  conv: ConversationListItem;
  meId: string;
  onClose: () => void;
}

export default function ChatInfoSheet({ conv, meId, onClose }: ChatInfoSheetProps) {
  // FEATURES #103: per-chat text-tone override (device-local, lib/sounds).
  const [soundOverride, setSoundOverride] = useState<ChatSoundOverride | null>(null);
  useEffect(() => {
    setSoundOverride(getChatSoundOverride(conv.id));
  }, [conv.id]);
  function chooseSound(value: ChatSoundOverride | null): void {
    setChatSoundOverride(conv.id, value);
    setSoundOverride(value);
  }

  const state = useAppState();
  const router = useRouter();
  const prefs = state.prefs.get(conv.id);
  const [error, setError] = useState<string | null>(null);
  const [ttlBusy, setTtlBusy] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);

  // v0.8a §1.60 chat background: my own upload, image/GIF (≤ MAX_IMAGE_BYTES)
  // or a short clip (≤ 25 MB / ≤ 30 s). A pending video has no probed
  // duration yet, so we PATCH only once attachment.ready lands (re-PATCH
  // rule in the contract).
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const [bgPendingId, setBgPendingId] = useState<string | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  // v1.0a (#95): where the NEXT uploaded background lands — me or everyone.
  const bgTargetShared = useRef(false);

  const bgLimits = `Images and GIFs up to ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB, clips up to ${Math.round(
    CHAT_BG_VIDEO_MAX_BYTES / (1024 * 1024)
  )} MB and ${CHAT_BG_VIDEO_MAX_DURATION_S} s.`;

  // v1.0a (#95): the background EVERYONE sees — DM: either side; group:
  // admins. My own pref (below) still overrides my view.
  async function applySharedBackground(attachmentId: string | null): Promise<void> {
    setBgError(null);
    try {
      await api.patch(`/api/conversations/${conv.id}/background`, { attachment_id: attachmentId });
      // conv.background echoes to everyone incl. me; nothing else to do.
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_background') {
        setBgError(`That file can’t be a background. ${bgLimits}`);
      } else if (err instanceof ApiError && err.status === 403) {
        setBgError('Only group admins can set the shared background.');
      } else {
        setBgError('Could not update the shared background — try again.');
      }
    }
  }

  async function applyBackground(attachmentId: string | null): Promise<void> {
    setBgError(null);
    try {
      await updatePrefs(conv.id, { background_attachment_id: attachmentId });
      toast(attachmentId ? 'Background set' : 'Background removed');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_background') {
        setBgError(`That file can’t be a background. ${bgLimits}`);
      } else {
        setBgError('Could not update the background — try again.');
      }
    }
  }

  // A pending upload (video poster still transcoding) resolves via the
  // attachment.ready the store mirrors — PATCH the moment it lands.
  const readyBg = bgPendingId ? state.readyAttachments.get(bgPendingId) : undefined;
  useEffect(() => {
    if (!bgPendingId || !readyBg) return;
    setBgPendingId(null);
    if (readyBg.status === 'ready') {
      void (bgTargetShared.current ? applySharedBackground(readyBg.id) : applyBackground(readyBg.id));
    } else setBgError('That clip failed to process — try another one.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgPendingId, readyBg]);

  async function uploadBackground(file: File): Promise<void> {
    setBgError(null);
    const isVideo = file.type.startsWith('video/');
    // Pre-check what the server will refuse anyway (§1.60 caps).
    if (isVideo && file.size > CHAT_BG_VIDEO_MAX_BYTES) {
      setBgError(`That clip is too big. ${bgLimits}`);
      return;
    }
    if (!isVideo && file.size > MAX_IMAGE_BYTES) {
      setBgError(`That image is too big. ${bgLimits}`);
      return;
    }
    setBgBusy(true);
    try {
      const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      const form = new FormData();
      form.append('file', up, up.name);
      // The ordinary §1.6 pipeline — sniffed MIME, EXIF strip, worker poster.
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.status === 'ready') {
        await (bgTargetShared.current
          ? applySharedBackground(res.attachment.id)
          : applyBackground(res.attachment.id));
      } else {
        setBgPendingId(res.attachment.id);
      }
    } catch (err) {
      if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setBgError(`Too large. ${bgLimits}`);
      else if (err instanceof ApiError && err.status === 415) setBgError('That file type is not supported.');
      else setBgError('Upload failed — try again.');
    } finally {
      setBgBusy(false);
    }
  }

  const isChannel = conv.type === 'channel';
  const channelRole = conv.participants.find((p) => p.user.id === meId)?.role ?? 'member';
  const channelAdmin = channelRole === 'owner' || channelRole === 'admin';

  // Royal v2: the Leave row serves groups too — same §1.4 self-DELETE.
  async function leaveConversation(): Promise<void> {
    if (leaveBusy) return;
    const confirmText = isChannel
      ? 'Leave this channel? You can rejoin with an invite link.'
      : 'Leave this group?';
    if (!window.confirm(confirmText)) return;
    setLeaveBusy(true);
    setError(null);
    try {
      await api.del(`/api/conversations/${conv.id}/participants/${meId}`);
      store.removeConversation(conv.id);
      onClose();
      router.push('/');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'owner_cannot_leave'
          ? 'The owner keeps the lights on — a channel can never be headless.'
          : isChannel
            ? 'Could not leave the channel.'
            : 'Could not leave the group.'
      );
      setLeaveBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function patch(change: { theme?: ChatTheme | null; wallpaper?: ChatWallpaper | null }): Promise<void> {
    setError(null);
    try {
      await updatePrefs(conv.id, change);
    } catch {
      setError('That change did not save — try again.');
    }
  }

  async function saveNickname(targetId: string, raw: string): Promise<void> {
    const value = raw.trim().slice(0, NICKNAME_MAX_CHARS);
    const current = prefs?.nicknames[targetId] ?? '';
    if (value === current) return;
    setError(null);
    try {
      await updatePrefs(conv.id, { nicknames: { [targetId]: value === '' ? null : value } });
    } catch {
      setError('Nickname did not save — try again.');
    }
  }

  const myRole = conv.participants.find((p) => p.user.id === meId)?.role;
  const canSetTtl = conv.type === 'dm' || myRole === 'admin' || myRole === 'owner';

  // Owner fix round: group photo/GIF, add-people, tappable member rows.
  const ghost = isGhost(conv);
  const support = isSupportConversation(conv);
  const groupAdmin = myRole === 'admin' || myRole === 'owner';
  const plainGroup = conv.type === 'group' && !support;
  // §1.4: the avatar endpoint is groups-only (admins); channels show theirs.
  const canEditGroupAvatar = plainGroup && groupAdmin;
  const showAvatarSection = plainGroup || (isChannel && channelAdmin);

  const [gaBusy, setGaBusy] = useState(false);
  const [gaPending, setGaPending] = useState(false);
  const [gaError, setGaError] = useState<string | null>(null);
  const [gaEdit, setGaEdit] = useState<File | null>(null);
  const gaFileRef = useRef<HTMLInputElement | null>(null);
  const gaVersionRef = useRef(conv.avatar.version);

  // 202 answered 'processing'; the finished photo fans out as conv.updated and
  // lands here through the conv prop — the note clears when the version moves.
  useEffect(() => {
    if (!gaPending) return;
    if (conv.avatar.version !== gaVersionRef.current) {
      setGaPending(false);
    } else if (conv.avatar.status === 'failed') {
      setGaPending(false);
      setGaError('Processing failed — the previous photo is kept.');
    }
  }, [gaPending, conv.avatar.version, conv.avatar.status]);

  async function uploadGroupAvatar(file: File): Promise<void> {
    setGaError(null);
    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      setGaError(`Photos are capped at ${Math.round(MAX_AVATAR_SOURCE_BYTES / (1024 * 1024))} MB.`);
      return;
    }
    setGaBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      gaVersionRef.current = conv.avatar.version;
      // §1.4: 202 {avatar:{status:'processing'}} — completion via conv.updated.
      await api.postForm<AvatarResponse>(`/api/conversations/${conv.id}/avatar`, form);
      setGaPending(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) setGaError('That file is too large.');
      else if (err instanceof ApiError && err.status === 415) setGaError('That file type is not supported.');
      else if (err instanceof ApiError && err.status === 403) setGaError('Only group admins can change the photo.');
      else setGaError('Could not update the photo — try again.');
    } finally {
      setGaBusy(false);
    }
  }

  // Same flow as Settings → Profile pickAvatar (#92): HEIC converts first,
  // static JPEG/PNG crops 1:1 in the edit sheet, animated sources (GIF/WebP/
  // APNG/MP4) upload untouched so their motion survives.
  async function pickGroupAvatar(file: File): Promise<void> {
    setGaError(null);
    try {
      const source = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      if (['image/jpeg', 'image/png'].includes(source.type)) {
        setGaEdit(source);
        return;
      }
      await uploadGroupAvatar(source);
    } catch (err) {
      setGaError(err instanceof HeicUnreadableError ? err.message : 'Could not read that file.');
    }
  }

  async function setTtl(ttl: number | null): Promise<void> {
    if (ttlBusy || ttl === conv.disappear_ttl_s) return;
    setTtlBusy(true);
    setError(null);
    try {
      const res = await api.patch<ConversationResponse>(`/api/conversations/${conv.id}/disappearing`, {
        ttl_s: ttl,
      });
      store.upsertConversation(res.conversation);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError('Only group admins can change this.');
      else setError('Could not update disappearing messages.');
    } finally {
      setTtlBusy(false);
    }
  }

  const members = conv.participants.filter((p) => p.left_at === null);

  return (
    <div
      className={sheetStyles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Chat settings">
        <div className={sheetStyles.sheetHead}>
          <h2>Chat settings</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Royal v2 (proto 13): the group's face is a centered hero — the
            avatar itself is the tap target for admins (camera badge), the
            serif name under it, the "tap to change" caption below. Same §1.4
            photo/GIF pipeline and handlers as the Owner fix round. */}
        {showAvatarSection ? (
          <section className={cm.grpHero} aria-label={isChannel ? 'Channel photo' : 'Group photo'}>
            {canEditGroupAvatar ? (
              <>
                <input
                  ref={gaFileRef}
                  type="file"
                  hidden
                  accept="image/gif,image/webp,image/apng,image/png,image/jpeg,video/mp4"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickGroupAvatar(f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className={cm.grpHeroTap}
                  aria-label="Change photo or GIF"
                  disabled={gaBusy || gaPending}
                  onClick={() => gaFileRef.current?.click()}
                >
                  <Avatar avatar={conv.avatar} name={conv.title ?? 'Group'} size={84} animated />
                  <span className={cm.grpHeroBadge} aria-hidden>
                    <CameraBadgeIcon />
                  </span>
                </button>
              </>
            ) : (
              <Avatar avatar={conv.avatar} name={conv.title ?? 'Group'} size={84} animated />
            )}
            <strong className={cm.grpHeroName}>{conv.title ?? (isChannel ? 'Channel' : 'Group')}</strong>
            {gaBusy || gaPending || conv.avatar.status === 'processing' ? (
              <span className={cm.grpHeroHint}>
                {gaBusy ? 'Uploading…' : 'Processing… the new photo pops in when ready.'}
              </span>
            ) : canEditGroupAvatar ? (
              <span className={cm.grpHeroHint}>Photo or GIF · tap to change</span>
            ) : null}
          </section>
        ) : null}
        {gaError ? <p className="error-text">{gaError}</p> : null}

        {/* v0.8b §1.68: visibility modes, description, join queue & masks —
            GROUPS only (DMs and channels stay private; the Support
            conversation is operator plumbing with no modes to set). */}
        {conv.type === 'group' && !isSupportConversation(conv) ? (
          <GroupSettingsSection conv={conv} meId={meId} />
        ) : null}

        {/* Royal v2 (proto 13): MEMBERS rows with OWNER/MOD chips; admins grow
            the group from the "+ add people" header action (same §1.4 add
            participants flow and copy as the last round). */}
        {conv.type === 'group' ? (
          <MembersSection
            conv={conv}
            meId={meId}
            ghost={ghost}
            canAdd={plainGroup && groupAdmin}
            onNavigate={onClose}
          />
        ) : null}

        {isChannel ? (
          <>
            <div className={sheetStyles.sheetLabel}>📣 Channel</div>
            <p className="muted small" style={{ margin: '0 0 8px' }}>
              Only the owner and admins post; everyone reads and reacts. People join through invite
              links — there&rsquo;s no member counter here, just members.
            </p>
            {channelAdmin ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <InviteButton className="btn" label="Share invite" conversationId={conv.id} />
                <button type="button" className="btn" onClick={() => setMembersOpen(true)}>
                  Members &amp; admins
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* Royal v2 (proto 13): theme & wallpaper as 64×88 visual swatch
            tiles — the picked one wears the white border; names ride
            aria-labels. Behavior (personal prefs PATCH) unchanged. */}
        <div className={sheetStyles.sheetLabel}>
          Theme <span className={exp.personalTag}>only you see this</span>
        </div>
        <div className={cm.swGrid} role="radiogroup" aria-label="Chat theme (your view only)">
          <button
            type="button"
            role="radio"
            aria-checked={!prefs?.theme}
            aria-label="Default"
            title="Default"
            className={`${cm.sw}${!prefs?.theme ? ` ${cm.swOn}` : ''}`}
            onClick={() => void patch({ theme: null })}
          >
            <span className={cm.swFill} style={{ background: 'var(--chat-bg)' }} aria-hidden />
            <span className={cm.swPill} aria-hidden />
          </button>
          {CHAT_THEMES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={prefs?.theme === t}
              aria-label={THEME_INFO[t].label}
              title={THEME_INFO[t].label}
              className={`${cm.sw}${prefs?.theme === t ? ` ${cm.swOn}` : ''}`}
              onClick={() => void patch({ theme: t })}
            >
              <span className={cm.swFill} style={{ background: THEME_INFO[t].swatch }} aria-hidden />
              <span className={cm.swPill} aria-hidden />
            </button>
          ))}
        </div>

        <div className={sheetStyles.sheetLabel}>
          Wallpaper <span className={exp.personalTag}>only you see this</span>
        </div>
        <div className={cm.swGrid} role="radiogroup" aria-label="Chat wallpaper (your view only)">
          <button
            type="button"
            role="radio"
            aria-checked={!prefs?.wallpaper}
            aria-label="None"
            title="None"
            className={`${cm.sw}${!prefs?.wallpaper ? ` ${cm.swOn}` : ''}`}
            onClick={() => void patch({ wallpaper: null })}
          >
            <span className={cm.swFill} style={{ background: 'var(--chat-bg)' }} aria-hidden />
          </button>
          {CHAT_WALLPAPERS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={prefs?.wallpaper === w}
              aria-label={WALLPAPER_INFO[w].label}
              title={WALLPAPER_INFO[w].label}
              className={`${cm.sw}${prefs?.wallpaper === w ? ` ${cm.swOn}` : ''}`}
              onClick={() => void patch({ wallpaper: w })}
            >
              <span
                className={`${cm.swFill} ${wallpaperClassName(exp, w)}`}
                // The real stars tile (110/70/160px) puts ~no star inside a
                // 64×88 swatch — same denser tiling fix as the old preview.
                style={
                  w === 'stars'
                    ? {
                        backgroundSize: '24px 24px, 15px 15px, 36px 36px',
                        backgroundPosition: '3px 4px, 10px 11px, 19px 7px',
                      }
                    : undefined
                }
                aria-hidden
              />
            </button>
          ))}
        </div>

        {/* #103: text tone for THIS chat — Default follows Settings →
            Notifications & sounds; a server-side mute still wins. */}
        <div className={sheetStyles.sheetLabel}>
          Message sound <span className={exp.personalTag}>only on this device</span>
        </div>
        <div className={sheetStyles.segRow} role="radiogroup" aria-label="Message sound for this chat">
          {(
            [
              { value: null, label: 'Default' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ] as { value: ChatSoundOverride | null; label: string }[]
          ).map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={soundOverride === o.value}
              className={`${sheetStyles.segBtn}${soundOverride === o.value ? ` ${sheetStyles.segOn}` : ''}`}
              onClick={() => chooseSound(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* v1.0a (#95): the background EVERYONE in this chat sees. DM: either
            side sets it; group: admins. A personal background below still
            overrides it for you alone. */}
        <div className={sheetStyles.sheetLabel}>Shared background 🌏 everyone sees this</div>
        <div className={idm.bgRow}>
          {prefs?.shared_background ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={idm.bgPreview}
              src={prefs.shared_background.thumb_url ?? prefs.shared_background.url}
              alt="Current shared chat background"
            />
          ) : null}
          {conv.type === 'dm' || myRole === 'admin' || myRole === 'owner' ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={bgBusy || bgPendingId !== null}
                onClick={() => {
                  bgTargetShared.current = true;
                  bgFileRef.current?.click();
                }}
              >
                {prefs?.shared_background ? 'Replace for everyone' : 'Set for everyone'}
              </button>
              {prefs?.shared_background ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={bgBusy}
                  onClick={() => void applySharedBackground(null)}
                >
                  Remove
                </button>
              ) : null}
            </>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              {prefs?.shared_background ? 'Set by a group admin.' : 'Group admins can set one.'}
            </p>
          )}
        </div>

        {/* v0.8a §1.60: GIF/video background — personal like every pref; it
            paints behind the bubbles under a scrim, visually replacing the
            wallpaper while set (both survive in prefs). */}
        <div className={sheetStyles.sheetLabel}>
          Background <span className={exp.personalTag}>only you see this</span>
        </div>
        <div className={idm.bgRow}>
          {prefs?.background ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={idm.bgPreview}
              src={prefs.background.thumb_url ?? prefs.background.url}
              alt="Current chat background"
            />
          ) : null}
          <input
            ref={bgFileRef}
            type="file"
            hidden
            accept="image/*,video/mp4,video/webm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadBackground(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={bgBusy || bgPendingId !== null}
            onClick={() => {
              bgTargetShared.current = false;
              bgFileRef.current?.click();
            }}
          >
            {bgBusy
              ? 'Uploading…'
              : bgPendingId
                ? 'Processing…'
                : prefs?.background
                  ? 'Replace'
                  : 'Add a GIF or clip'}
          </button>
          {prefs?.background ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={bgBusy}
              onClick={() => void applyBackground(null)}
            >
              Remove
            </button>
          ) : null}
        </div>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          Your own upload, dimmed behind the bubbles — muted, looped, paused off-screen.{' '}
          {bgLimits}
        </p>
        {bgError ? <p className="error-text">{bgError}</p> : null}

        <div className={sheetStyles.sheetLabel}>
          Nicknames <span className={exp.personalTag}>only you see these</span>
        </div>
        {members.map((p) => (
          <div key={p.user.id} className={exp.nickRow}>
            {/* Owner fix round: tapping a face or name opens their profile —
                EXCEPT in 👻 ghost groups, where identities are masks (§1.68). */}
            {!ghost && p.user.username ? (
              <Link
                href={`/u/${encodeURIComponent(p.user.username)}`}
                className={cm.memberLink}
                aria-label={`Open ${p.user.display_name}’s profile`}
                onClick={onClose}
              >
                <Avatar avatar={p.user.avatar} name={p.user.display_name} size={30} />
                <span className={exp.nickName}>{p.user.display_name}</span>
              </Link>
            ) : (
              <>
                <Avatar avatar={p.user.avatar} name={p.user.display_name} size={30} />
                <span className={exp.nickName}>{p.user.display_name}</span>
              </>
            )}
            <input
              className="input"
              aria-label={`Nickname for ${p.user.display_name} (only you see it)`}
              placeholder="nickname…"
              maxLength={NICKNAME_MAX_CHARS}
              defaultValue={prefs?.nicknames[p.user.id] ?? ''}
              onBlur={(e) => void saveNickname(p.user.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        ))}

        <div className={sheetStyles.sheetLabel}>⏳ Disappearing messages</div>
        <div className={sheetStyles.segRow} role="radiogroup" aria-label="Disappearing messages">
          <button
            type="button"
            role="radio"
            aria-checked={conv.disappear_ttl_s === null}
            className={`${sheetStyles.segBtn}${conv.disappear_ttl_s === null ? ` ${sheetStyles.segOn}` : ''}`}
            disabled={!canSetTtl || ttlBusy}
            onClick={() => void setTtl(null)}
          >
            Off
          </button>
          {DISAPPEAR_TTL_OPTIONS_S.map((ttl) => (
            <button
              key={ttl}
              type="button"
              role="radio"
              aria-checked={conv.disappear_ttl_s === ttl}
              className={`${sheetStyles.segBtn}${conv.disappear_ttl_s === ttl ? ` ${sheetStyles.segOn}` : ''}`}
              disabled={!canSetTtl || ttlBusy}
              onClick={() => void setTtl(ttl)}
            >
              {TTL_LABELS[ttl]}
            </button>
          ))}
        </div>
        <p className={exp.ttlNote}>
          {canSetTtl
            ? 'Applies to everyone in this chat — new and existing messages disappear after the timer.'
            : 'Only group admins can change this. Everyone shares the same timer.'}
        </p>

        {error ? <p className="error-text">{error}</p> : null}

        {/* Royal v2 (proto 13): the Leave row — full-width, danger red. The
            owner can't leave (the server refuses owner_cannot_leave). */}
        {(isChannel && channelRole !== 'owner') ||
        (conv.type === 'group' && !support && myRole !== 'owner') ? (
          <button
            type="button"
            className={cm.leaveRow}
            disabled={leaveBusy}
            onClick={() => void leaveConversation()}
          >
            {leaveBusy ? 'Leaving…' : isChannel ? 'Leave channel' : 'Leave group'}
          </button>
        ) : null}
      </div>
      {membersOpen ? (
        <ChannelMembersSheet conv={conv} meId={meId} onClose={() => setMembersOpen(false)} />
      ) : null}
      {gaEdit ? (
        // Static shots crop square first — the sheet portals to body (#92).
        <ImageEditSheet
          source={gaEdit}
          fileName={gaEdit.name}
          lockedAspect={1}
          onCancel={() => setGaEdit(null)}
          onDone={(file) => {
            setGaEdit(null);
            void uploadGroupAvatar(file);
          }}
        />
      ) : null}
    </div>
  );
}

/** Royal v2 members section (proto 13): rows with 44px faces and OWNER
 * (gradient chip) / MOD (outline chip) roles, "+ add people" as the header
 * action. The add flow is the Owner-fix-round one unchanged: the same
 * debounced GET /api/users?q= every people-picker uses, with a per-row Add
 * that POSTs §1.4 add-participants one person at a time so each row can tell
 * its own story (added / invite-only / full). */
function MembersSection({
  conv,
  meId,
  ghost,
  canAdd,
  onNavigate,
}: {
  conv: ConversationListItem;
  meId: string;
  ghost: boolean;
  canAdd: boolean;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserPublic[]>([]);
  const [searching, setSearching] = useState(false);
  const [rowState, setRowState] = useState<Record<string, 'busy' | 'added' | 'invite_only'>>({});
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIds = new Set(
    conv.participants.filter((p) => p.left_at === null).map((p) => p.user.id)
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const query = q.trim();
    if (!query) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<UserSearchResponse>(`/api/users?q=${encodeURIComponent(query)}`);
          setResults(res.users);
        } catch {
          setResults([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [q]);

  function setState(id: string, s: 'busy' | 'added' | 'invite_only' | null): void {
    setRowState((prev) => {
      const next = { ...prev };
      if (s === null) delete next[id];
      else next[id] = s;
      return next;
    });
  }

  async function add(user: UserPublic): Promise<void> {
    const current = rowState[user.id];
    if (current === 'busy' || current === 'added') return;
    setError(null);
    setState(user.id, 'busy');
    try {
      const res = await api.post<ConversationResponse>(
        `/api/conversations/${conv.id}/participants`,
        { user_ids: [user.id] }
      );
      store.upsertConversation(res.conversation);
      setState(user.id, 'added');
      toast(`${user.display_name} is in`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'group_add_denied') {
        // §1.13 group_add_policy / §1.14 — per-target, never spelled out.
        setState(user.id, 'invite_only');
        setError('They take group adds by invite link only — share one instead.');
      } else {
        setState(user.id, null);
        if (err instanceof ApiError && err.code === 'group_too_large') {
          setError(`Groups are capped at ${MAX_GROUP_PARTICIPANTS} people — this one is full.`);
        } else if (err instanceof ApiError && err.status === 403) {
          setError('Only group admins can add people.');
        } else {
          setError('Could not add them — try again.');
        }
      }
    }
  }

  const members = conv.participants.filter((p) => p.left_at === null);

  return (
    <>
      <div className={cm.secHead}>
        <div className={sheetStyles.sheetLabel}>Members</div>
        {canAdd ? (
          <button
            type="button"
            className={cm.secHeadBtn}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            + Add people
          </button>
        ) : null}
      </div>

      {members.map((p) => {
        const chip = p.role === 'owner' ? 'Owner' : p.role === 'admin' ? 'Mod' : null;
        const self = p.user.id === meId;
        const who = (
          <>
            <Avatar avatar={p.user.avatar} name={p.user.display_name} size={44} />
            <span className={cm.memberName}>{self ? 'You' : p.user.display_name}</span>
          </>
        );
        return (
          <div key={p.user.id} className={cm.memberRow}>
            {/* Faces/names open the profile — never in 👻 ghost groups (§1.68). */}
            {!ghost && !self && p.user.username ? (
              <Link
                href={`/u/${encodeURIComponent(p.user.username)}`}
                className={cm.memberWho}
                aria-label={`Open ${p.user.display_name}’s profile`}
                onClick={onNavigate}
              >
                {who}
              </Link>
            ) : (
              <span className={cm.memberWho}>{who}</span>
            )}
            {chip ? (
              <span
                className={`${cm.roleChip}${p.role === 'owner' ? ` ${cm.roleChipOwner}` : ''}`}
              >
                {chip}
              </span>
            ) : null}
          </div>
        );
      })}

      {open ? (
        <div className={cm.addPeople} style={{ marginTop: 8 }}>
          <input
            className="input"
            type="search"
            placeholder="Search people by name or username"
            aria-label="Search people to add"
            value={q}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
          {searching ? (
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Searching…
            </p>
          ) : null}
          {results.length > 0 ? (
            <div className={cm.addResults}>
              {results.map((user) => {
                const already = memberIds.has(user.id) && !rowState[user.id];
                const stateFor = already ? 'added' : rowState[user.id];
                return (
                  <div key={user.id} className={cm.addRow}>
                    <Avatar avatar={user.avatar} name={user.display_name} size={34} />
                    <span className={cm.addWho}>
                      <span className={cm.addName}>{user.display_name}</span>
                      <span className={cm.addUser}>@{user.username}</span>
                    </span>
                    {stateFor === 'added' ? (
                      <span className={cm.addState}>{already ? 'In the group' : 'Added ✓'}</span>
                    ) : stateFor === 'invite_only' ? (
                      <span className={cm.addState}>invite only</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={stateFor === 'busy'}
                        onClick={() => void add(user)}
                      >
                        {stateFor === 'busy' ? 'Adding…' : 'Add'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {!searching && q.trim() && results.length === 0 ? (
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              No one found.
            </p>
          ) : null}
          <p className="muted small" style={{ margin: '6px 0 10px' }}>
            New people join from this moment — earlier messages stay where they were. A system
            line tells the group.
          </p>
        </div>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}

/* Royal v2: the hero's camera badge (decorative — the button carries the label). */
function CameraBadgeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8 a2 2 0 0 1 2 -2 h2 l1.5 -2 h5 L16 6 h2 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 H6 a2 2 0 0 1 -2 -2 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
