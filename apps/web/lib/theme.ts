// App-wide appearance (owner ask 2026-10-18): light / dark / system mode plus
// an accent palette, applied to <html data-theme data-accent> so every token
// in app/globals.css follows. Device-local (localStorage) like sounds — a
// look is a device choice, never serialized to the server or anyone else.
//
// First paint: app/layout.tsx inlines a tiny script that reads the same key
// and sets the attributes before React hydrates, so there is no flash of the
// wrong scheme. This module owns the key, the defaults, and the runtime
// apply/subscribe used by Settings → Appearance.

export type ThemeMode = 'system' | 'light' | 'dark';
export type Accent = 'royal' | 'gold' | 'rose' | 'mint' | 'sky';

export interface ThemePrefs {
  mode: ThemeMode;
  accent: Accent;
}

/** localStorage key — keep in sync with the inline script in app/layout.tsx. */
export const THEME_STORAGE_KEY = 'bc.theme.v1';

export const THEME_MODES: { key: ThemeMode; label: string; hint: string }[] = [
  { key: 'system', label: 'System', hint: 'Follows your device setting.' },
  { key: 'light', label: 'Light', hint: 'Ink on paper.' },
  { key: 'dark', label: 'Dark', hint: 'The Royal charcoal-navy.' },
];

export const ACCENTS: { key: Accent; label: string; swatch: string }[] = [
  { key: 'royal', label: 'Royal', swatch: 'linear-gradient(160deg, #ffffff, #c7cdda)' },
  { key: 'gold', label: 'Gold', swatch: 'linear-gradient(160deg, #f7d58a, #d9a94a)' },
  { key: 'rose', label: 'Rose', swatch: 'linear-gradient(160deg, #ffb3c6, #e8788f)' },
  { key: 'mint', label: 'Mint', swatch: 'linear-gradient(160deg, #a6f0d3, #5fcf9f)' },
  { key: 'sky', label: 'Sky', swatch: 'linear-gradient(160deg, #b7d4ff, #6f9fe8)' },
];

const DEFAULTS: ThemePrefs = { mode: 'system', accent: 'royal' };

export function getThemePrefs(): ThemePrefs {
  let parsed: Partial<ThemePrefs> = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    if (raw) parsed = JSON.parse(raw) as Partial<ThemePrefs>;
  } catch {
    /* no storage / bad JSON → defaults */
  }
  return {
    mode: THEME_MODES.some((m) => m.key === parsed.mode) ? (parsed.mode as ThemeMode) : DEFAULTS.mode,
    accent: ACCENTS.some((a) => a.key === parsed.accent) ? (parsed.accent as Accent) : DEFAULTS.accent,
  };
}

/** Write the attributes the stylesheet keys on. 'system' removes data-theme
 * so the prefers-color-scheme media query decides. */
export function applyTheme(prefs: ThemePrefs = getThemePrefs()): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (prefs.mode === 'system') delete el.dataset.theme;
  else el.dataset.theme = prefs.mode;
  if (prefs.accent === 'royal') delete el.dataset.accent;
  else el.dataset.accent = prefs.accent;
}

export function setThemePrefs(patch: Partial<ThemePrefs>): ThemePrefs {
  const next = { ...getThemePrefs(), ...patch };
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — still applies this session */
  }
  applyTheme(next);
  return next;
}

let installed = false;

/** Boot once: re-apply (the inline script already did, this covers a stale
 * attribute after a client-side navigation) and follow other tabs. */
export function installTheme(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  applyTheme();
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) applyTheme();
  });
}
