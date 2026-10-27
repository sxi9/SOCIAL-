'use client';

// The share page header's pill (phase 2): "Sign in" for a stranger, "Open
// Bored Chat" once `probeMe()` says there is a session — the SSR render is
// always the logged-out one, so the island corrects it after mount.
import { useEffect, useState } from 'react';
import { probeMe } from '@/lib/shareAuth';

export default function ShareHeaderPill({ path, className }: { path: string; className: string }) {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void probeMe().then((me) => {
      if (!cancelled && me) setAuthed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return authed ? (
    <a href="/" className={className}>
      Open Bored Chat
    </a>
  ) : (
    <a href={`/login?next=${encodeURIComponent(path)}`} className={className}>
      Sign in
    </a>
  );
}
