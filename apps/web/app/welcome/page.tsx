'use client';

// Post-signup "find your people" step (v0.8b — API.md §1.64, FEATURES #78).
// ONE optional step: set your coarse area (§1.13 PATCH), see dismissible
// people-you-may-know cards with the §1.28 connect action, skip any time.
// Device-local seen key (the TOUR_SEEN_KEY pattern) — never re-shown.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AREA_MAX_CHARS, type UpdateMeResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { markFindPeopleSeen } from '@/lib/suggestions';
import { setMe } from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Mascot from '@/components/Mascot';
import SuggestionCards from '@/components/SuggestionCards';

function FindYourPeople() {
  const state = useAppState();
  const router = useRouter();
  const [area, setArea] = useState('');
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaSaved, setAreaSaved] = useState(false);
  const seededRef = useRef(false);

  // Once here, never again — skipping counts as seeing (no nag loops).
  useEffect(() => {
    markFindPeopleSeen();
  }, []);

  useEffect(() => {
    if (state.me && !seededRef.current) {
      seededRef.current = true;
      setArea(state.me.area ?? '');
      setAreaSaved((state.me.area ?? '') !== '');
    }
  }, [state.me]);

  async function saveArea(): Promise<void> {
    if (areaBusy) return;
    setAreaBusy(true);
    try {
      const value = area.trim();
      const res = await api.patch<UpdateMeResponse>('/api/users/me', {
        area: value === '' ? null : value,
      });
      setMe(res.user);
      setAreaSaved(value !== '');
      toast(value ? 'Area saved' : 'Area cleared');
    } catch {
      toast('Could not save your area');
    } finally {
      setAreaBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Find your people</h1>
        <button type="button" className="btn btn-ghost" onClick={() => router.replace('/')}>
          Skip
        </button>
      </header>
      <div className="settings-section">
        <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Mascot state="watch" size={64} />
          <p className="muted small" style={{ margin: 0 }}>
            One optional step: say roughly where you are, and we&rsquo;ll show a few people worth
            knowing — mutual friends and neighbours. Dismissed people never come back; this page
            never nags again.
          </p>
        </div>

        <div className="card">
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="fyp-area">Your area (optional — a neighbourhood or city)</label>
            <input
              id="fyp-area"
              className="input"
              placeholder="e.g. Indiranagar"
              value={area}
              maxLength={AREA_MAX_CHARS}
              onChange={(e) => setArea(e.target.value)}
            />
          </div>
          <button type="button" className="btn" disabled={areaBusy} onClick={() => void saveArea()}>
            {areaBusy ? 'Saving…' : areaSaved ? 'Update area' : 'Save area'}
          </button>
        </div>

        <SuggestionCards title="People you may already know" />

        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 14 }}
          onClick={() => router.replace('/')}
        >
          Done — take me in
        </button>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <AppShell>
      <FindYourPeople />
    </AppShell>
  );
}
