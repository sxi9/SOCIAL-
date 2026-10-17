'use client';

// v1.0 (#78c, owner ask "discover more people options"): the full Find-people
// page — the §1.64 suggestions as a grid with narrowing filter chips
// (mutuals / groups / area / interests — the §1.65 doctrine: filters only
// ever narrow by what people chose to share), a refresh, an honest empty
// state, and a cross-link to Bored Together. Dismissals stay permanent.
import { useState } from 'react';
import Link from 'next/link';
import SuggestionCards from '@/components/SuggestionCards';
import TabPage from '@/components/TabPage';
import type { SuggestionFilters } from '@/lib/suggestions';

const CHIPS: { key: keyof SuggestionFilters; label: string }[] = [
  { key: 'mutuals', label: '👥 Mutual friends' },
  { key: 'groups', label: '💬 Shared groups' },
  { key: 'area', label: '📍 My area' },
  { key: 'interests', label: '✨ Shared interests' },
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
        <div className="settings-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ flex: 1, margin: 0 }}>Find people</h1>
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Refresh suggestions"
            onClick={() => setRefreshKey((n) => n + 1)}
          >
            ↻ Refresh
          </button>
        </div>
        <p className="muted small" style={{ margin: '4px 0 10px' }}>
          People you may know, from mutual friends, shared groups, your area and shared public
          interests. Dismissing someone is permanent — they are never told.
        </p>
        <div
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}
          role="group"
          aria-label="Narrow suggestions"
        >
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`btn${filters[c.key] ? ' btn-primary' : ''}`}
              aria-pressed={Boolean(filters[c.key])}
              onClick={() => toggle(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <SuggestionCards title="" layout="grid" filters={filters} refreshKey={refreshKey} showEmpty />
        <p className="muted small" style={{ marginTop: 14 }}>
          Want someone to hang out with right now? <Link href="/local">See who is bored</Link> on
          the Local tab.
        </p>
        </div>
      </div>
    </TabPage>
  );
}
