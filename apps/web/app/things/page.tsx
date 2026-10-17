'use client';

// "✨ Things you can do" (v0.8a — API.md §1.61, FEATURES #80): the feature
// directory, rendered from the STATIC typed registry in the contract
// (FEATURE_DIRECTORY) so every client shows the same list. One card per
// feature, the one-liner, a Try-it deep link, client-side substring search.
// `since` drives a "new" badge against my release marker — informational
// only, no dots anywhere else.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FEATURE_DIRECTORY } from '@socialchat/shared';
import { isNewSince, refreshReleases } from '@/lib/releases';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import idm from '@/components/identity.module.css';

function ThingsDirectory() {
  const state = useAppState();
  const [q, setQ] = useState('');

  useEffect(() => {
    void refreshReleases().catch(() => undefined);
  }, []);

  const needle = q.trim().toLowerCase();
  const entries = FEATURE_DIRECTORY.filter(
    (f) =>
      needle.length === 0 ||
      f.title.toLowerCase().includes(needle) ||
      f.one_liner.toLowerCase().includes(needle)
  );

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>✨ Things you can do</h1>
        <span />
      </header>

      <div className="settings-section">
        <input
          className="input"
          type="search"
          placeholder="Search features…"
          aria-label="Search features"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 10 }}
        />

        {entries.length === 0 ? (
          <p className="muted small">Nothing matches — try fewer letters.</p>
        ) : (
          entries.map((f) => (
            <div key={f.id} className={idm.dirCard}>
              <div className={idm.dirText}>
                <strong>
                  {f.title}
                  {isNewSince(f.since, state.releases) ? (
                    <span className={idm.newBadge}>new</span>
                  ) : null}
                </strong>
                <p>{f.one_liner}</p>
              </div>
              <Link href={f.href} className="btn">
                Try it
              </Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function ThingsPage() {
  return (
    <AppShell>
      <ThingsDirectory />
    </AppShell>
  );
}
