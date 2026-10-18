'use client';

// v1.0 (#78c, owner ask "discover more people options"): the full Find-people
// page — the §1.64 suggestions as a card grid with narrowing filter chips
// (mutuals / groups / area / interests — the §1.65 doctrine: filters only
// ever narrow by what people chose to share), a refresh, an honest empty
// state and the dashed invite-a-friend card (proto 32). Dismissals stay
// permanent. v2 Royal: serif title bar with back chevron + refresh icon,
// pill chips (active = accent gradient).
import { useState } from 'react';
import Link from 'next/link';
import SuggestionCards from '@/components/SuggestionCards';
import TabPage from '@/components/TabPage';
import type { SuggestionFilters } from '@/lib/suggestions';

const CHIPS: { key: keyof SuggestionFilters; label: string }[] = [
  { key: 'mutuals', label: 'Mutual friends' },
  { key: 'groups', label: 'Shared groups' },
  { key: 'area', label: 'My area' },
  { key: 'interests', label: 'Shared interests' },
];

export default function PeoplePage() {
  const [filters, setFilters] = useState<SuggestionFilters>({});
  const [refreshKey, setRefreshKey] = useState(0);

  function toggle(key: keyof SuggestionFilters): void {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <TabPage active="profile">
      <div className="page">
        <header className="topbar">
          <Link href="/connections" className="btn btn-ghost btn-icon" aria-label="Back">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M14.5 5.5 8 12l6.5 6.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <h1 style={{ fontSize: 20 }}>Find people</h1>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Refresh suggestions"
            onClick={() => setRefreshKey((n) => n + 1)}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M19 12 a7 7 0 1 1 -2.05 -4.95"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <path
                d="M17.4 3.6 v3.6 h-3.6"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>
        <div className="settings-section" style={{ marginTop: 10 }}>
          {/* proto 32: ONE horizontally scrolling chip row — never a wrap. */}
          <div
            style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none', marginBottom: 6, paddingBottom: 2 }}
            role="group"
            aria-label="Narrow suggestions"
          >
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`btn${filters[c.key] ? ' btn-primary' : ''}`}
                style={{ padding: '7px 13px', fontSize: 13, flex: 'none', whiteSpace: 'nowrap' }}
                aria-pressed={Boolean(filters[c.key])}
                onClick={() => toggle(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <SuggestionCards
            title=""
            layout="grid"
            filters={filters}
            refreshKey={refreshKey}
            showEmpty
            inviteCard
          />
          <p className="muted small" style={{ marginTop: 12 }}>
            People you may know, from mutual friends, shared groups, your area and shared public
            interests. Dismissing someone is permanent — they are never told. Want someone to hang
            out with right now? <Link href="/local">See who is bored</Link> on the Local tab.
          </p>
        </div>
      </div>
    </TabPage>
  );
}
