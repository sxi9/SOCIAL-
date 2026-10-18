'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { startConnection } from '@/lib/connection';
import { installSoundEngine } from '@/lib/sounds';
import { installTheme } from '@/lib/theme';
import { useAppState } from '@/lib/useStore';
import GlobalOverlays from './GlobalOverlays';

/** Boots the connection (WS + /api/sync) and gates authed pages. */
export default function AppShell({ children }: { children: ReactNode }) {
  const state = useAppState();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    startConnection();
    // FEATURES #103: ringtone / ringback / text tone follow the store from
    // here on (unlocks audio on the first gesture; see lib/sounds.ts).
    installSoundEngine();
    installTheme();
  }, []);

  useEffect(() => {
    if (state.authed === false) {
      router.replace(`/login?next=${encodeURIComponent(pathname || '/')}`);
    }
  }, [state.authed, pathname, router]);

  if (state.authed !== true) {
    return (
      <div className="center-screen muted" role="status">
        Loading…
      </div>
    );
  }
  return (
    <>
      {children}
      {/* v0.6: incoming-call overlay, in-call screen, match moment, roulette
          goodbye and the one-tap feedback — on every page (§1.42/§1.44/§1.45). */}
      <GlobalOverlays />
    </>
  );
}
