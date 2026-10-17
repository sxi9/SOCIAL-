// Stories (v0.5a — API.md §1.34). 24-hour ephemera for the friends-of
// audience. The tray is FINITE and username-ordered (unviewed authors first) —
// a tray, not a feed; viewing never auto-advances between authors. View lists
// are author-only faces with NO timestamps (story_views stores none).
import type {
  ListStoriesResponse,
  Story,
  StoryResponse,
  StoryViewsResponse,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

let inflight: Promise<void> | null = null;

/** GET /api/stories — the tray read (story.new frames patch live). */
export async function refreshStories(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.get<ListStoriesResponse>('/api/stories');
      store.setStories(res);
    } catch {
      /* offline — the last tray stands; expired cards drop locally */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** POST /api/stories — attachment must be mine, image|video, unbound. */
export async function createStory(attachmentId: string, caption: string): Promise<Story> {
  const res = await api.post<StoryResponse>('/api/stories', {
    attachment_id: attachmentId,
    caption,
  });
  store.applyStoryNew(res.story);
  return res.story;
}

/** §1.34 afterglow integration: share a recap photo to MY story (re-referenced). */
export async function createRecapStory(
  conversationId: string,
  seq: number,
  attachmentId: string,
  caption = ''
): Promise<Story> {
  const res = await api.post<StoryResponse>('/api/stories/recap', {
    conversation_id: conversationId,
    seq,
    attachment_id: attachmentId,
    caption,
  });
  store.applyStoryNew(res.story);
  return res.story;
}

/** Idempotent view record; author's own views are never recorded server-side. */
export async function viewStory(story: Story): Promise<void> {
  if (story.viewed) return;
  store.markStoryViewedLocal(story.id);
  try {
    await api.post(`/api/stories/${story.id}/view`);
  } catch {
    /* expired or offline — harmless, the next GET reconciles */
  }
}

export async function deleteStory(storyId: string): Promise<void> {
  try {
    await api.del(`/api/stories/${storyId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  store.removeStoryLocal(storyId);
}

/** Author-only faces, username-ordered, NO timestamps (404-shaped otherwise). */
export async function storyViewers(storyId: string): Promise<StoryViewsResponse> {
  return api.get<StoryViewsResponse>(`/api/stories/${storyId}/views`);
}

export function storyLive(s: Story, now = Date.now()): boolean {
  return new Date(s.expires_at).getTime() > now;
}

/** Subtle "expires in …" label (24 h fixed TTL). */
export function expiresLabel(s: Story, now = Date.now()): string {
  const ms = new Date(s.expires_at).getTime() - now;
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `gone in ${mins}m`;
  return `gone in ${Math.round(mins / 60)}h`;
}
