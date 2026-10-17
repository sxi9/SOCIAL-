// Suggestions & find-your-people (v0.8b — API.md §1.64, FEATURES #78,
// ADR-019). Pull-only (no WS, no push); dismissals are PERMANENT and silent —
// nothing re-surfaces a dismissed person (PSYCHOLOGY rule 4). NEVER rendered
// on the login page (unauthenticated member enumeration stays forbidden).
import type { Suggestion, SuggestionsResponse } from '@socialchat/shared';
import { api } from './api';

// v1.0 (#78c): filters only ever NARROW (the §1.65 doctrine).
export type SuggestionFilters = {
  mutuals?: boolean;
  groups?: boolean;
  area?: boolean;
  interests?: boolean;
};

export async function fetchSuggestions(filters: SuggestionFilters = {}): Promise<Suggestion[]> {
  const qs = Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k]) => `${k}=1`)
    .join('&');
  const res = await api.get<SuggestionsResponse>(`/api/suggestions${qs ? `?${qs}` : ''}`);
  return res.suggestions;
}

/** Idempotent, permanent; the dismissed user is never told. */
export async function dismissSuggestion(userId: string): Promise<void> {
  await api.post(`/api/suggestions/${userId}/dismiss`);
}

// Post-signup "find your people" step: device-local seen key (the
// TOUR_SEEN_KEY pattern) — skippable, never re-shown.
const FIND_PEOPLE_SEEN_KEY = 'bored:find-people-seen';

export function findPeopleSeen(): boolean {
  try {
    return localStorage.getItem(FIND_PEOPLE_SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked → we could not remember a skip; never nag
  }
}

export function markFindPeopleSeen(): void {
  try {
    localStorage.setItem(FIND_PEOPLE_SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}
