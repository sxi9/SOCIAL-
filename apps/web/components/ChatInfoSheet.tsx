'use client';

// Chat settings sheet (v0.4): §1.24 appearance (theme palette + wallpaper
// pattern + per-member nicknames — ALL personal, my view only, labeled as
// such) and §1.25 disappearing messages (conversation-wide TTL; DM = anyone,
// group = admin only — the server enforces, this mirrors).
import { useEffect, useRef, useState } from 'react';
import type {
  ChatTheme,
  ChatWallpaper,
  ConversationListItem,
  ConversationResponse,
  UploadResponse,
} from '@socialchat/shared';
import {
  CHAT_BG_VIDEO_MAX_BYTES,
  CHAT_BG_VIDEO_MAX_DURATION_S,
  CHAT_THEMES,
  CHAT_WALLPAPERS,
  DISAPPEAR_TTL_OPTIONS_S,
  MAX_IMAGE_BYTES,
  NICKNAME_MAX_CHARS,
} from '@socialchat/shared';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import { THEME_INFO, WALLPAPER_INFO, updatePrefs, wallpaperClassName } from '@/lib/prefs';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import ChannelMembersSheet from './ChannelMembersSheet';
import GroupSettingsSection from './GroupSettingsSection';
import { isSupportConversation } from '@/lib/groups';
import { InviteButton } from './InviteSheet';
import sheetStyles from './beacons.module.css';
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

  const bgLimits = `Images and GIFs up to ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB, clips up to ${Math.round(
    CHAT_BG_VIDEO_MAX_BYTES / (1024 * 1024)
  )} MB and ${CHAT_BG_VIDEO_MAX_DURATION_S} s.`;

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
    if (readyBg.status === 'ready') void applyBackground(readyBg.id);
    else setBgError('That clip failed to process — try another one.');
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
        await applyBackground(res.attachment.id);
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

  async function leaveChannel(): Promise<void> {
    if (leaveBusy) return;
    if (!window.confirm('Leave this channel? You can rejoin with an invite link.')) return;
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
          : 'Could not leave the channel.'
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

        {/* v0.8b §1.68: visibility modes, description, join queue & masks —
            GROUPS only (DMs and channels stay private; the Support
            conversation is operator plumbing with no modes to set). */}
        {conv.type === 'group' && !isSupportConversation(conv) ? (
          <GroupSettingsSection conv={conv} meId={meId} />
        ) : null}

        {isChannel ? (
          <>
            <div className={sheetStyles.sheetLabel}>📣 Channel</div>
            <p className="muted small" style={{ margin: '0 0 8px' }}>
              Only the owner and admins post; everyone reads and reacts. People join through invite
              links — there&rsquo;s no member counter here, just members.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {channelAdmin ? (
                <>
                  <InviteButton className="btn" label="Share invite" conversationId={conv.id} />
                  <button type="button" className="btn" onClick={() => setMembersOpen(true)}>
                    Members &amp; admins
                  </button>
                </>
              ) : null}
              {channelRole !== 'owner' ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={leaveBusy}
                  onClick={() => void leaveChannel()}
                >
                  {leaveBusy ? 'Leaving…' : 'Leave channel'}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <div className={sheetStyles.sheetLabel}>
          Theme <span className={exp.personalTag}>👀 only you see this</span>
        </div>
        <div className={exp.swatchGrid} role="radiogroup" aria-label="Chat theme (your view only)">
          <button
            type="button"
            role="radio"
            aria-checked={!prefs?.theme}
            className={`${exp.swatch}${!prefs?.theme ? ` ${exp.swatchOn}` : ''}`}
            onClick={() => void patch({ theme: null })}
          >
            <span className={exp.swatchDot} style={{ background: 'var(--panel-2)' }} />
            Default
          </button>
          {CHAT_THEMES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={prefs?.theme === t}
              className={`${exp.swatch}${prefs?.theme === t ? ` ${exp.swatchOn}` : ''}`}
              onClick={() => void patch({ theme: t })}
            >
              <span className={exp.swatchDot} style={{ background: THEME_INFO[t].swatch }} />
              {THEME_INFO[t].label}
            </button>
          ))}
        </div>

        <div className={sheetStyles.sheetLabel}>
          Wallpaper <span className={exp.personalTag}>👀 only you see this</span>
        </div>
        <div className={exp.swatchGrid} role="radiogroup" aria-label="Chat wallpaper (your view only)">
          <button
            type="button"
            role="radio"
            aria-checked={!prefs?.wallpaper}
            className={`${exp.swatch}${!prefs?.wallpaper ? ` ${exp.swatchOn}` : ''}`}
            onClick={() => void patch({ wallpaper: null })}
          >
            <span className={exp.wpPreview} />
            None
          </button>
          {CHAT_WALLPAPERS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={prefs?.wallpaper === w}
              className={`${exp.swatch}${prefs?.wallpaper === w ? ` ${exp.swatchOn}` : ''}`}
              onClick={() => void patch({ wallpaper: w })}
            >
              <span className={`${exp.wpPreview} ${wallpaperClassName(exp, w)}`} />
              {WALLPAPER_INFO[w].label}
            </button>
          ))}
        </div>

        {/* v0.8a §1.60: GIF/video background — personal like every pref; it
            paints behind the bubbles under a scrim, visually replacing the
            wallpaper while set (both survive in prefs). */}
        <div className={sheetStyles.sheetLabel}>
          Background <span className={exp.personalTag}>👀 only you see this</span>
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
            onClick={() => bgFileRef.current?.click()}
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
          Nicknames <span className={exp.personalTag}>👀 only you see these</span>
        </div>
        {members.map((p) => (
          <div key={p.user.id} className={exp.nickRow}>
            <Avatar avatar={p.user.avatar} name={p.user.display_name} size={30} />
            <span className={exp.nickName}>{p.user.display_name}</span>
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
      </div>
      {membersOpen ? (
        <ChannelMembersSheet conv={conv} meId={meId} onClose={() => setMembersOpen(false)} />
      ) : null}
    </div>
  );
}
