'use client';

// Chat settings sheet (v0.4): §1.24 appearance (theme palette + wallpaper
// pattern + per-member nicknames — ALL personal, my view only, labeled as
// such) and §1.25 disappearing messages (conversation-wide TTL; DM = anyone,
// group = admin only — the server enforces, this mirrors).
import { useEffect, useState } from 'react';
import type {
  ChatTheme,
  ChatWallpaper,
  ConversationListItem,
  ConversationResponse,
} from '@socialchat/shared';
import { CHAT_THEMES, CHAT_WALLPAPERS, DISAPPEAR_TTL_OPTIONS_S, NICKNAME_MAX_CHARS } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { THEME_INFO, WALLPAPER_INFO, updatePrefs, wallpaperClassName } from '@/lib/prefs';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

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
  const prefs = state.prefs.get(conv.id);
  const [error, setError] = useState<string | null>(null);
  const [ttlBusy, setTtlBusy] = useState(false);

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
  const canSetTtl = conv.type === 'dm' || myRole === 'admin';

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
    </div>
  );
}
