'use client';

// "New since your last visit" (v0.8a — API.md §1.61, FEATURES #80). After
// login/sync, releases newer than users.last_seen_release render as ONE
// dismissible card stack on the chat list — informational, never engagement
// bait: no badges elsewhere, no unread dots on tabs, no re-surfacing after
// dismissal (PSYCHOLOGY rules 4/5 — the user pulls, the app never guilts).
// Dismissing POSTs /api/releases/seen with the newest version shown.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { markReleasesSeen, refreshReleases, unseenReleases } from '@/lib/releases';
import { useAppState } from '@/lib/useStore';
import idm from './identity.module.css';

const MAX_CARDS = 3;

export default function WhatsNewCard() {
  const state = useAppState();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.authed === true) void refreshReleases().catch(() => undefined);
  }, [state.authed]);

  const fresh = unseenReleases(state.releases).slice(0, MAX_CARDS);
  if (fresh.length === 0) return null;
  const newest = fresh[0];

  async function dismiss(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await markReleasesSeen(newest.version);
    } catch {
      /* optimistic fold already happened; the next visit re-offers */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={idm.whatsNew} role="note" aria-label="New since your last visit">
      <button
        type="button"
        className={idm.whatsNewClose}
        aria-label="Dismiss — don't show these again"
        onClick={() => void dismiss()}
      >
        ×
      </button>
      {fresh.map((r) => (
        <div key={r.version}>
          <h3>
            🆕 {r.title} <span className="muted small">({r.version})</span>
          </h3>
          <ul>
            {r.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      <Link href="/things" className="btn btn-ghost" onClick={() => void dismiss()}>
        ✨ See everything you can do
      </Link>
    </div>
  );
}
