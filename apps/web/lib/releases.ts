// Releases / what's-new (v0.8a — API.md §1.61, FEATURES #80). Pull-based and
// deliberately boring: cards are informational, never engagement bait — no
// badges elsewhere, no unread dots on tabs, no re-surfacing after dismissal
// (PSYCHOLOGY rules 4/5).
import type { ReleasesResponse } from '@socialchat/shared';
import { api } from './api';
import * as store from './store';

let inflight = false;

/** Fetch the instance's shipped releases + my marker, once per session. */
export async function refreshReleases(): Promise<void> {
  if (store.state.releases !== null || inflight) return;
  inflight = true;
  try {
    const res = await api.get<ReleasesResponse>('/api/releases');
    store.setReleases(res);
  } finally {
    inflight = false;
  }
}

/** Dismissing the cards moves my cursor (idempotent server-side). */
export async function markReleasesSeen(version: string): Promise<void> {
  store.setLastSeenRelease(version); // optimistic — cards fold immediately
  await api.post('/api/releases/seen', { version });
}

function norm(v: string): string {
  return v.trim().toLowerCase().replace(/^v/, '');
}

/** The releases strictly newer than my marker (newest first). An unknown or
 * null marker means everything listed is unseen — the register-time stamp
 * keeps day-one users out of this branch (§1.61). */
export function unseenReleases(rel: ReleasesResponse | null) {
  if (!rel || rel.releases.length === 0) return [];
  if (rel.last_seen_release === null) return rel.releases;
  const idx = rel.releases.findIndex((r) => norm(r.version) === norm(rel.last_seen_release ?? ''));
  return idx === -1 ? rel.releases : rel.releases.slice(0, idx);
}

/** Does a FEATURE_DIRECTORY entry (its `since` release) deserve a ✨ new
 * badge for this viewer? True iff that release is newer than the marker. */
export function isNewSince(since: string, rel: ReleasesResponse | null): boolean {
  if (!rel) return false;
  return unseenReleases(rel).some((r) => norm(r.version) === norm(since));
}
