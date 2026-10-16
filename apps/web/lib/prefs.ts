// Chat themes / wallpapers / nicknames (v0.4 — API.md §1.24). PERSONAL:
// everything here changes MY view only — never serialized to anyone else;
// prefs.updated fans to my own sockets for cross-device sync.
import type {
  ChatTheme,
  ChatWallpaper,
  ConversationPrefs,
  PrefsResponse,
  UpdatePrefsRequest,
  UserPublic,
} from '@socialchat/shared';
import { api } from './api';
import * as store from './store';

const inflight = new Set<string>();

/** Fetch my prefs for a conversation once (store-cached; WS keeps it fresh). */
export async function loadPrefs(conversationId: string): Promise<void> {
  if (store.state.prefs.has(conversationId) || inflight.has(conversationId)) return;
  inflight.add(conversationId);
  try {
    const res = await api.get<PrefsResponse>(`/api/conversations/${conversationId}/prefs`);
    store.setPrefs(res.prefs);
  } catch {
    /* defaults apply; retried on next open */
  } finally {
    inflight.delete(conversationId);
  }
}

/** PATCH a subset; the response is the full new state (also echoed via WS). */
export async function updatePrefs(conversationId: string, change: UpdatePrefsRequest): Promise<void> {
  const res = await api.patch<PrefsResponse>(`/api/conversations/${conversationId}/prefs`, change);
  store.setPrefs(res.prefs);
}

/** My nickname for a user in this conversation, else their display name. */
export function displayNameFor(prefs: ConversationPrefs | undefined, user: Pick<UserPublic, 'id' | 'display_name'>): string {
  return prefs?.nicknames[user.id] ?? user.display_name;
}

// ---- picker metadata (swatches/labels; the CSS lives in expression.module.css) ----

export const THEME_INFO: Record<ChatTheme, { label: string; swatch: string }> = {
  classic: { label: 'Classic', swatch: '#4f6fff' },
  sunset: { label: 'Sunset', swatch: '#f97352' },
  ocean: { label: 'Ocean', swatch: '#1e9cc9' },
  forest: { label: 'Forest', swatch: '#2f9e5f' },
  grape: { label: 'Grape', swatch: '#8d5bd4' },
  bubblegum: { label: 'Bubblegum', swatch: '#ee6fa8' },
  mono: { label: 'Mono', swatch: '#6b7280' },
  midnight: { label: 'Midnight', swatch: '#27335e' },
};

export const WALLPAPER_INFO: Record<ChatWallpaper, { label: string }> = {
  dots: { label: 'Dots' },
  grid: { label: 'Grid' },
  waves: { label: 'Waves' },
  stars: { label: 'Stars' },
  scribbles: { label: 'Scribbles' },
  blobs: { label: 'Blobs' },
};

/** CSS-module class suffixes (expression.module.css themeX / wpX rules). */
export function themeClassName(styles: Record<string, string>, theme: ChatTheme | null | undefined): string {
  if (!theme) return '';
  return styles[`theme_${theme}`] ?? '';
}

export function wallpaperClassName(styles: Record<string, string>, wp: ChatWallpaper | null | undefined): string {
  if (!wp) return '';
  return styles[`wp_${wp}`] ?? '';
}
