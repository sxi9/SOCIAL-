'use client';

// Settings → Appearance (owner ask 2026-10-18): the WHOLE app's look — light /
// dark / system mode and an accent palette. Device-local (lib/theme.ts);
// applies instantly, no reload. Per-chat theme/wallpaper live in each chat's
// settings sheet and layer on top of this.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ACCENTS,
  THEME_MODES,
  getThemePrefs,
  setThemePrefs,
  type Accent,
  type ThemeMode,
  type ThemePrefs,
} from '@/lib/theme';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';
import seg from '@/components/beacons.module.css';
import cm from '@/components/community.module.css';

const S = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...S} />
    </svg>
  );
}

function AppearanceSettings() {
  // Read after mount so SSR never touches storage (and never mismatches).
  const [prefs, setPrefs] = useState<ThemePrefs | null>(null);
  useEffect(() => {
    setPrefs(getThemePrefs());
  }, []);

  function pickMode(mode: ThemeMode): void {
    setPrefs(setThemePrefs({ mode }));
  }
  function pickAccent(accent: Accent): void {
    setPrefs(setThemePrefs({ accent }));
  }

  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Appearance</h1>
        <span />
      </header>

      <div className={sm.sectionLabel}>Theme</div>
      <div className={sm.setList}>
        <div className={sm.setRow}>
          <div className={sm.setMain}>
            <div className={sm.setTitle}>Light or dark</div>
            <p className={sm.setHint}>
              {prefs ? THEME_MODES.find((m) => m.key === prefs.mode)?.hint : ' '}
            </p>
            <div className={seg.segRow} role="radiogroup" aria-label="Theme mode" style={{ marginTop: 10 }}>
              {THEME_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={prefs?.mode === m.key}
                  className={`${seg.segBtn}${prefs?.mode === m.key ? ` ${seg.segOn}` : ''}`}
                  disabled={prefs === null}
                  onClick={() => pickMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={sm.sectionLabel}>Accent</div>
      <div className={sm.setList}>
        <div className={sm.setRow}>
          <div className={sm.setMain}>
            <div className={sm.setTitle}>Color</div>
            <p className={sm.setHint}>Buttons, your bubbles, live rings — the app&rsquo;s highlight color.</p>
            <div className={cm.swGrid} role="radiogroup" aria-label="Accent color" style={{ marginTop: 10 }}>
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="radio"
                  aria-checked={prefs?.accent === a.key}
                  aria-label={a.label}
                  title={a.label}
                  className={`${cm.sw}${prefs?.accent === a.key ? ` ${cm.swOn}` : ''}`}
                  disabled={prefs === null}
                  onClick={() => pickAccent(a.key)}
                >
                  <span className={cm.swFill} style={{ background: a.swatch }} aria-hidden />
                  <span className={cm.swPill} aria-hidden />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className={sm.noteLine}>
        Applies on this device only. Each chat can still have its own theme and wallpaper from its
        settings sheet.
      </p>
    </div>
  );
}

export default function AppearanceSettingsPage() {
  return (
    <AppShell>
      <AppearanceSettings />
    </AppShell>
  );
}
