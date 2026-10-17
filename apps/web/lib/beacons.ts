// Beacons, plan roles, polls & kudos — REST writes with optimistic store
// patches (API.md §1.15–§1.17). WS frames (beacon.updated / plan.updated /
// poll.updated) confirm; reconnects reconcile from REST, never frame replay.
import {
  BEACON_CUSTOM_VIBE_RECENTS_MAX,
  BEACON_MIN_WINDOW_S,
  BEACON_STARTS_AT_SLACK_S,
  type Beacon,
  type BeaconJoinsResponse,
  type BeaconResponse,
  type BeaconRole,
  type BeaconVibe,
  type CreateBeaconRequest,
  type KudosKind,
  type ListBeaconsResponse,
  type PatchBeaconRequest,
  type Poll,
  type PollResponse,
  type RadarResponse,
  type RoleResponse,
  type UserLite,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

// ---------------------------------------------------------------------------
// Vibe chips — emoji + labels for the fixed BEACON_VIBES set. v0.7 (§1.47)
// adds 'custom' to the VALUE set; its emoji/label live on the beacon row, so
// render through vibeEmojiOf/vibeLabelOf wherever a Beacon DTO is in hand.
// ---------------------------------------------------------------------------

export const VIBE_EMOJI: Record<BeaconVibe, string> = {
  food: '🍜',
  chai: '☕',
  walk: '🚶',
  game: '🎮',
  movie: '🎬',
  study: '📚',
  sport: '🏸',
  chill: '🛋️',
  custom: '✨', // fallback only — a real custom beacon carries its own emoji
};

export const VIBE_LABEL: Record<BeaconVibe, string> = {
  food: 'Food',
  chai: 'Chai',
  walk: 'Walk',
  game: 'Games',
  movie: 'Movie',
  study: 'Study',
  sport: 'Sport',
  chill: 'Chill',
  custom: 'Custom',
};

/** The chip emoji for anything carrying {vibe, custom_vibe_emoji}. */
export function vibeEmojiOf(b: {
  vibe: BeaconVibe;
  custom_vibe_emoji: string | null;
}): string {
  return b.vibe === 'custom' && b.custom_vibe_emoji ? b.custom_vibe_emoji : VIBE_EMOJI[b.vibe];
}

/** The chip label for anything carrying {vibe, custom_vibe_label}. */
export function vibeLabelOf(b: {
  vibe: BeaconVibe;
  custom_vibe_label: string | null;
}): string {
  return b.vibe === 'custom' && b.custom_vibe_label ? b.custom_vibe_label : VIBE_LABEL[b.vibe];
}

// ---------------------------------------------------------------------------
// Custom-vibe recents (§1.47): CLIENT-SIDE ONLY, per device — localStorage,
// never synced, never serialized (the review-nudge precedent).
// ---------------------------------------------------------------------------

export interface CustomVibeRecent {
  emoji: string;
  label: string;
}

const VIBE_RECENTS_KEY = 'beacon_custom_vibe_recents';

export function readVibeRecents(): CustomVibeRecent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(VIBE_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is CustomVibeRecent =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as CustomVibeRecent).emoji === 'string' &&
          typeof (x as CustomVibeRecent).label === 'string'
      )
      .slice(0, BEACON_CUSTOM_VIBE_RECENTS_MAX);
  } catch {
    return [];
  }
}

export function rememberVibeRecent(emoji: string, label: string): void {
  if (typeof window === 'undefined') return;
  try {
    const rest = readVibeRecents().filter((r) => !(r.emoji === emoji && r.label === label));
    const next = [{ emoji, label }, ...rest].slice(0, BEACON_CUSTOM_VIBE_RECENTS_MAX);
    window.localStorage.setItem(VIBE_RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — recents are a convenience, not state */
  }
}

// ---------------------------------------------------------------------------
// Window presets (API.md §1.15): starts_at/expires_at are CLIENT-computed —
// the server is timezone-blind. now → [now, now+4h]; tonight → [18:00, 23:59]
// local today; weekend → [Sat 10:00, Sun 23:59] local.
// ---------------------------------------------------------------------------

export type WhenPreset = 'now' | 'tonight' | 'weekend';

export interface PresetWindow {
  starts_at: string;
  expires_at: string;
  /** false when the remaining window would violate the server's ≥30 min rule. */
  valid: boolean;
}

export function presetWindow(preset: WhenPreset, now = new Date()): PresetWindow {
  let start: Date;
  let end: Date;
  if (preset === 'now') {
    start = new Date(now);
    end = new Date(now.getTime() + 4 * 3600_000);
  } else if (preset === 'tonight') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
    // Past 18:00 the beacon starts right away (starts_at must be ≥ now−300s).
    if (start.getTime() < now.getTime()) start = new Date(now);
  } else {
    // Next Saturday 10:00 → that Sunday 23:59; mid-weekend clamps the start.
    const day = now.getDay(); // 0 Sun … 6 Sat
    const toSat = day === 6 ? 0 : (6 - day) % 7;
    const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toSat, 10, 0, 0);
    let sun = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1, 23, 59, 0);
    if (day === 0) {
      // It IS Sunday: the weekend ends tonight.
      sun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
    }
    start = day === 0 || (day === 6 && sat.getTime() < now.getTime()) ? new Date(now) : sat;
    if (start.getTime() < now.getTime() - BEACON_STARTS_AT_SLACK_S * 1000) start = new Date(now);
    end = sun;
  }
  const valid = end.getTime() - Math.max(start.getTime(), now.getTime()) >= BEACON_MIN_WINDOW_S * 1000;
  return { starts_at: start.toISOString(), expires_at: end.toISOString(), valid };
}

/** Short human countdown: "38m", "2h 10m", "3d". Never a seconds treadmill. */
export function fmtCountdown(targetIso: string, nowMs = Date.now()): string {
  const diff = new Date(targetIso).getTime() - nowMs;
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// REST — beacons
// ---------------------------------------------------------------------------

export async function refreshBeacons(): Promise<void> {
  try {
    const [list, radar] = await Promise.all([
      api.get<ListBeaconsResponse>('/api/beacons'),
      api.get<RadarResponse>('/api/beacons/radar'),
    ]);
    store.setBeacons(list.beacons);
    store.setRadar(radar.active_visible_count);
  } catch {
    /* offline / unauthenticated — the strip renders from whatever is cached */
  }
}

export async function createBeacon(req: CreateBeaconRequest): Promise<Beacon> {
  const res = await api.post<BeaconResponse>('/api/beacons', req);
  store.upsertBeacon(res.beacon);
  return res.beacon;
}

/** Optimistic join: the pile grows instantly; the response (or a revert) settles it. */
export async function joinBeacon(id: string): Promise<Beacon> {
  const prev = store.state.beacons.get(id);
  const me = store.state.me;
  if (prev && me && prev.my_state === 'none') {
    store.upsertBeacon({
      ...prev,
      my_state: 'joined',
      joiner_count: prev.joiner_count + 1,
      needs: Math.max(0, prev.needs - 1),
      joiners: [
        ...prev.joiners,
        {
          id: me.id,
          username: me.username,
          display_name: me.display_name,
          avatar: me.avatar,
          mood: me.mood,
          name_style: me.name_style,
          mask_emoji: null,
        },
      ],
    });
  }
  try {
    const res = await api.post<BeaconResponse>(`/api/beacons/${id}/join`);
    store.upsertBeacon(res.beacon);
    return res.beacon;
  } catch (err) {
    if (prev) store.upsertBeacon(prev);
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      // Gone / closed under us — retire the card silently and resync.
      store.removeBeacon(id);
      void refreshBeacons();
    }
    throw err;
  }
}

export async function leaveBeacon(id: string): Promise<void> {
  const prev = store.state.beacons.get(id);
  const me = store.state.me;
  if (prev && me && prev.my_state === 'joined') {
    store.upsertBeacon({
      ...prev,
      my_state: 'none',
      joiner_count: Math.max(0, prev.joiner_count - 1),
      needs: prev.needs + 1,
      joiners: prev.joiners.filter((j) => j.id !== me.id),
    });
  }
  try {
    const res = await api.del<BeaconResponse>(`/api/beacons/${id}/join`);
    store.upsertBeacon(res.beacon);
  } catch (err) {
    if (prev) store.upsertBeacon(prev);
    throw err;
  }
}

/** v0.7 (§1.47): creator edit — any subset of the editable fields; omitted =
 * unchanged. Threshold == current joins sparks inside the edit transaction. */
export async function patchBeacon(id: string, req: PatchBeaconRequest): Promise<Beacon> {
  const res = await api.patch<BeaconResponse>(`/api/beacons/${id}`, req);
  store.upsertBeacon(res.beacon);
  return res.beacon;
}

/** v0.7 (§1.47): "start with whoever's here" — the §1.15 spark transaction
 * verbatim, threshold not consulted. Needs ≥1 non-creator joiner (409). */
export async function sparkNow(id: string): Promise<Beacon> {
  const res = await api.post<BeaconResponse>(`/api/beacons/${id}/spark-now`);
  store.upsertBeacon(res.beacon);
  return res.beacon;
}

/** v0.7 (§1.47): the full "Who's in" list, join order, faces only. */
export async function fetchBeaconJoiners(id: string): Promise<UserLite[]> {
  const res = await api.get<BeaconJoinsResponse>(`/api/beacons/${id}/joins`);
  return res.joiners;
}

export async function cancelBeacon(id: string): Promise<void> {
  await api.post<BeaconResponse>(`/api/beacons/${id}/cancel`);
  store.removeBeacon(id);
}

export async function ritualizeBeacon(id: string): Promise<Beacon> {
  const res = await api.post<BeaconResponse>(`/api/beacons/${id}/ritualize`);
  store.upsertBeacon(res.beacon);
  return res.beacon;
}

/** One-tap re-create from the afterglow recap — the new beacon is MINE. */
export async function runItBack(id: string): Promise<Beacon> {
  const res = await api.post<BeaconResponse>(`/api/beacons/${id}/run-it-back`);
  store.upsertBeacon(res.beacon);
  return res.beacon;
}

/** 204, idempotent; delivered privately to the recipient only (§1.15). */
export async function sendKudos(beaconId: string, toUserId: string, kind: KudosKind): Promise<void> {
  await api.post(`/api/beacons/${beaconId}/kudos`, { to_user_id: toUserId, kind });
}

// ---------------------------------------------------------------------------
// REST — plan roles (§1.16). Mutation responses patch optimistically; the
// plan.updated frame (full list) is the settle; GET is the reconcile.
// ---------------------------------------------------------------------------

export async function fetchRoles(beaconId: string): Promise<BeaconRole[]> {
  const res = await api.get<{ roles: BeaconRole[] }>(`/api/beacons/${beaconId}/roles`);
  store.setPlanRoles(beaconId, res.roles);
  return res.roles;
}

export async function addRole(beaconId: string, label: string): Promise<void> {
  const res = await api.post<RoleResponse>(`/api/beacons/${beaconId}/roles`, { label });
  store.patchPlanRole(beaconId, res.role);
}

export async function claimRole(beaconId: string, roleId: string): Promise<void> {
  const res = await api.post<RoleResponse>(`/api/beacons/${beaconId}/roles/${roleId}/claim`);
  store.patchPlanRole(beaconId, res.role);
}

export async function releaseRole(beaconId: string, roleId: string): Promise<void> {
  const res = await api.del<RoleResponse>(`/api/beacons/${beaconId}/roles/${roleId}/claim`);
  store.patchPlanRole(beaconId, res.role);
}

export async function completeRole(beaconId: string, roleId: string): Promise<void> {
  const res = await api.post<RoleResponse>(`/api/beacons/${beaconId}/roles/${roleId}/complete`);
  store.patchPlanRole(beaconId, res.role);
}

export async function deleteRole(beaconId: string, roleId: string): Promise<void> {
  await api.del(`/api/beacons/${beaconId}/roles/${roleId}`);
  store.dropPlanRole(beaconId, roleId);
}

// ---------------------------------------------------------------------------
// REST — poll votes (§1.17). Optimistic; revote replaces (UPSERT), null unvotes.
// ---------------------------------------------------------------------------

export async function votePoll(poll: Poll, optionIdx: number | null): Promise<void> {
  if (poll.my_vote === optionIdx) return;
  // Optimistic local tally; the 200 {poll} (and the WS delta) settle the truth.
  const counts = [...poll.counts];
  let total = poll.total_votes;
  if (poll.my_vote !== null && counts[poll.my_vote] !== undefined) {
    counts[poll.my_vote] = Math.max(0, counts[poll.my_vote] - 1);
    total -= 1;
  }
  if (optionIdx !== null && counts[optionIdx] !== undefined) {
    counts[optionIdx] += 1;
    total += 1;
  }
  store.applyPollDto({ ...poll, counts, total_votes: Math.max(0, total), my_vote: optionIdx });
  try {
    const res =
      optionIdx === null
        ? await api.del<PollResponse>(`/api/polls/${poll.id}/vote`)
        : await api.post<PollResponse>(`/api/polls/${poll.id}/vote`, { option_idx: optionIdx });
    store.applyPollDto(res.poll);
  } catch (err) {
    store.applyPollDto(poll); // roll back (poll_closed, bad_option, offline…)
    throw err;
  }
}
