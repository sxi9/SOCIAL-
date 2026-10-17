// Moods & 🍻 drunk mode (v0.8a — API.md §1.57, FEATURES #72–#73).
//
// Binding rules carried here:
// - Moods leave NO trace: no history surface anywhere, chips vanish on expiry
//   (the sweep's user.updated nulls me.mood / participants' mood).
// - The ONLY payload with visibility/expires_at/swing_set is MY owner read
//   (store.moodState); everyone else's mood is just the chip on their
//   UserLite/UserPublic, already per-viewer resolved SERVER-side.
// - Mood-reactive bubble effects key on label for kinds preset/swing/drunk
//   ONLY — a custom label never triggers one, even on collision (§1.58).
import {
  COLD_CONTACT_THRESHOLD_S,
  MOOD_BUBBLE_EFFECTS,
  MOOD_MESSAGE_EFFECTS,
  MOOD_PRESETS,
  type Conversation,
  type Mood,
  type MoodResponse,
  type MoodState,
  type SetMoodRequest,
} from '@socialchat/shared';
import { api } from './api';
import * as store from './store';

export type MoodBubbleEffect = (typeof MOOD_BUBBLE_EFFECTS)[number];

/** GET my full mood state (owner-only read). */
export async function refreshMyMood(): Promise<void> {
  const res = await api.get<MoodResponse>('/api/users/me/mood');
  store.setMoodState(res.mood_state);
}

/** PUT a mood — every set (re)starts the 4 h fade (§1.57). */
export async function setMood(req: SetMoodRequest): Promise<MoodState> {
  const res = await api.put<MoodResponse>('/api/users/me/mood', req);
  store.setMoodState(res.mood_state);
  return res.mood_state;
}

/** DELETE — clears every mood column server-side; zero trace survives. */
export async function clearMood(): Promise<void> {
  await api.del('/api/users/me/mood');
  const prev = store.state.moodState;
  store.setMoodState({
    mood: null,
    visibility: prev?.visibility ?? 'everyone',
    expires_at: null,
    swing_set: null,
  });
}

/** Am I in drunk mode RIGHT NOW? me.mood is kept live by user.updated (the
 * expiry sweep included); moodState sharpens the edge with the exact
 * expires_at when it has been loaded. The server re-checks at undo time
 * anyway — this only gates client-side guardrail UI. */
export function isSelfDrunk(): boolean {
  if (store.state.me?.mood?.kind !== 'drunk') return false;
  const ms = store.state.moodState;
  if (ms?.mood?.kind === 'drunk' && ms.expires_at !== null) {
    return Date.parse(ms.expires_at) > Date.now();
  }
  return true;
}

/** §1.58 mapping: label → bubble effect, kinds preset/swing/drunk ONLY. */
export function bubbleEffectFor(mood: Mood | null | undefined): MoodBubbleEffect | null {
  if (!mood || mood.kind === 'custom') return null;
  const map: Record<string, MoodBubbleEffect> = MOOD_MESSAGE_EFFECTS;
  return map[mood.label] ?? null;
}

/** The default emoji for a preset label (the picker + swing set builder). */
export function presetEmojiFor(label: string): string | null {
  const hit = MOOD_PRESETS.find((p) => p.label === label);
  return hit ? hit.emoji : null;
}

/** §1.57 cold-contact fact: Conversation.last_message_at IS the DTO flag —
 * a DM not talked to in >30 d (or a brand-new one) gets the "you sure?". */
export function isColdContact(conv: Pick<Conversation, 'type' | 'last_message_at'>): boolean {
  if (conv.type !== 'dm') return false;
  if (conv.last_message_at === null) return true;
  return Date.now() - Date.parse(conv.last_message_at) > COLD_CONTACT_THRESHOLD_S * 1000;
}
