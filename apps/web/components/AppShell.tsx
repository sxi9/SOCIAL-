'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { startConnection } from '@/lib/connection';
import { useAppState } from '@/lib/useStore';

/** Boots the connection (WS + /api/sync) and gates authed pages. */
export default function AppShell({ children }: { children: ReactNode }) {
  const state = useAppState();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    startConnection();
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
  return <>{children}</>;
}
