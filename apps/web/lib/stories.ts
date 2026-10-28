// Stories (v0.5a — API.md §1.34). 24-hour ephemera for the friends-of
// audience. The tray is FINITE and username-ordered (unviewed authors first) —
// a tray, not a feed; viewing never auto-advances between authors. View lists
// are author-only faces with NO timestamps (story_views stores none).
import type {
  BlockedListResponse,
  ListStoriesResponse,
  OverlayResponse,
  Story,
  StoryCanvasMode,
  StoryOverlay,
  StoryOverlayPayload,
  StoryReplyResponse,
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

/** POST /api/stories — attachment must be mine, image|video, unbound.
 * v0.8b §1.66: canvas_mode defaults 'off' — drawable is always the AUTHOR's
 * invitation. */
export async function createStory(
  attachmentId: string,
  caption: string,
  canvasMode: StoryCanvasMode = 'off'
): Promise<Story> {
  const res = await api.post<StoryResponse>('/api/stories', {
    attachment_id: attachmentId,
    caption,
    canvas_mode: canvasMode,
  });
  store.applyStoryNew(res.story);
  return res.story;
}

// ---------------------------------------------------------------------------
// Canvas stories (v0.8b — API.md §1.66, ADR-020). Overlays are attributed
// VECTOR layers, never burned into the image; story.updated keeps viewers
// live, reconnect truth is GET /api/stories.
// ---------------------------------------------------------------------------

/** PATCH /api/stories/:id — author only; the canvas switch. 'off' keeps
 * existing overlays (they were invited) and stops NEW ones. */
export async function setCanvasMode(storyId: string, mode: StoryCanvasMode): Promise<Story> {
  const res = await api.patch<StoryResponse>(`/api/stories/${storyId}`, { canvas_mode: mode });
  store.replaceStoryLocal(res.story);
  return res.story;
}

/** POST an overlay. 403 canvas_closed is byte-identical for 'off' AND a
 * canvas ban (never confirmable); 409 overlay_limit = my 5-per-story cap. */
export async function addOverlay(storyId: string, payload: StoryOverlayPayload): Promise<StoryOverlay> {
  const res = await api.post<OverlayResponse>(`/api/stories/${storyId}/overlays`, { payload });
  return res.overlay;
}

/** Remove: the STORY AUTHOR (any overlay) or the OVERLAY AUTHOR (their own).
 * Tombstoned server-side (reports outlive moderation); idempotent. */
export async function removeOverlay(storyId: string, overlayId: string): Promise<void> {
  try {
    await api.del(`/api/stories/${storyId}/overlays/${overlayId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
}

/** Approve a pending overlay — story author only. */
export async function approveOverlay(storyId: string, overlayId: string): Promise<StoryOverlay> {
  const res = await api.post<OverlayResponse>(`/api/stories/${storyId}/overlays/${overlayId}/approve`);
  return res.overlay;
}

/** Ban/unban a user from ALL my canvases, present and future (idempotent). */
export async function canvasBan(userId: string): Promise<void> {
  await api.put(`/api/users/${userId}/canvas-ban`);
}

export async function canvasUnban(userId: string): Promise<void> {
  await api.del(`/api/users/${userId}/canvas-ban`);
}

export async function listCanvasBans(): Promise<BlockedListResponse> {
  return api.get<BlockedListResponse>('/api/users/me/canvas-bans');
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

/** §1.79 "Edit" on your own story — the caption while it lives. */
export async function updateStoryCaption(storyId: string, caption: string): Promise<Story> {
  const res = await api.patch<StoryResponse>(`/api/stories/${storyId}`, { caption });
  store.replaceStoryLocal(res.story);
  return res.story;
}

/** §1.79 POST /api/stories/:id/reply — a reply (text / voice / image) or a
 * one-emoji reaction to a friend's story; lands as a DM to the author. 403
 * reply_closed is one shape for "not taking replies" and a block. */
export async function replyToStory(
  storyId: string,
  body: { body?: string; attachment_id?: string; emoji?: string }
): Promise<StoryReplyResponse> {
  return api.post<StoryReplyResponse>(`/api/stories/${storyId}/reply`, body);
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
