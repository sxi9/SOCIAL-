// Feed (v0.5a — API.md §1.36). Posts by my friends-of set + me, newest first,
// FINITE: keyset pages to a hard end (all_caught_up) and STOPS — no wraparound,
// no refetch-on-scroll past the end, no pull-to-refresh loop (PSYCHOLOGY
// design rule 5 + never-build list). New content arrives via post.new or an
// explicit, user-initiated refresh. Reactions/comments fan out NOTHING live —
// viewers reconcile from GET when THEY return (no approval pings).
import type {
  CommentResponse,
  FeedResponse,
  ListCommentsResponse,
  Post,
  PostComment,
  PostResponse,
} from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

let loading = false;

/** First page (or explicit user refresh): replaces the window. */
export async function refreshFeed(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const res = await api.get<FeedResponse>('/api/feed');
    store.setFeedPage(res.posts, res.next_cursor, res.all_caught_up, true);
  } finally {
    loading = false;
  }
}

/** Next keyset page; a no-op once the hard end was reached. */
export async function loadMoreFeed(): Promise<void> {
  const cursor = store.state.feedCursor;
  if (loading || cursor === null) return;
  loading = true;
  try {
    const res = await api.get<FeedResponse>(`/api/feed?cursor=${encodeURIComponent(cursor)}`);
    store.setFeedPage(res.posts, res.next_cursor, res.all_caught_up, false);
  } finally {
    loading = false;
  }
}

export async function createPost(body: string, attachmentIds: string[]): Promise<Post> {
  const res = await api.post<PostResponse>('/api/posts', {
    body,
    attachment_ids: attachmentIds,
  });
  store.prependPost(res.post);
  return res.post;
}

export async function deletePost(postId: string): Promise<void> {
  try {
    await api.del(`/api/posts/${postId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  store.removePostLocal(postId);
}

/** Single-post refetch — the reaction/comment reconcile read (§1.36). */
export async function refetchPost(postId: string): Promise<void> {
  try {
    const res = await api.get<PostResponse>(`/api/posts/${postId}`);
    store.replacePost(res.post);
  } catch (err) {
    // 404 = deleted or out of audience — drop it.
    if (err instanceof ApiError && err.status === 404) store.removePostLocal(postId);
  }
}

/** Toggle my reaction, then refetch the post for the authoritative faces. */
export async function togglePostReaction(post: Post, emoji: string, mine: boolean): Promise<void> {
  try {
    if (mine) {
      await api.del(`/api/posts/${post.id}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await api.post(`/api/posts/${post.id}/reactions`, { emoji });
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'reaction_limit') throw err;
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  await refetchPost(post.id);
}

export async function addComment(postId: string, body: string): Promise<PostComment> {
  const res = await api.post<CommentResponse>(`/api/posts/${postId}/comments`, { body });
  return res.comment;
}

export async function deleteComment(postId: string, commentId: string): Promise<void> {
  try {
    await api.del(`/api/posts/${postId}/comments/${commentId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
}

export async function listComments(postId: string, cursor: string | null): Promise<ListCommentsResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return api.get<ListCommentsResponse>(`/api/posts/${postId}/comments${qs}`);
}
