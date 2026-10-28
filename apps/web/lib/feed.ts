// Feed (v0.5a §1.36 + v0.7 §1.49–§1.51). Posts newest first, per-lane FINITE
// windows: keyset pages to a hard end (all_caught_up) and STOP — no wraparound,
// no refetch-on-scroll past the end, no pull-to-refresh loop, in EITHER lane
// (PSYCHOLOGY design rule 5 binds discover exactly as hard — no ranking, no
// "trending"). New content arrives via post.new (friends-of fan-out only; the
// discover lane is pull-only, §1.49) or an explicit, user-initiated refresh.
// Reactions/comments fan out NOTHING live — viewers reconcile from GET when
// THEY return (no approval pings).
import type {
  ClaimGameResponse,
  CommentResponse,
  CreatePostRequest,
  FeedLane,
  FeedResponse,
  ListCommentsResponse,
  Post,
  PostComment,
  PostPoll,
  PostPollResponse,
  PostResponse,
  ReactionKind,
  UserLite,
} from '@socialchat/shared';
import { COMMENT_REACTORS_PREVIEW_MAX, STAMP_REACTION_KEY } from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

const loading: Record<FeedLane, boolean> = { friends: false, discover: false };

/** First page (or explicit user refresh) of a lane: replaces that window. */
export async function refreshFeed(lane: FeedLane = 'friends'): Promise<void> {
  if (loading[lane]) return;
  loading[lane] = true;
  try {
    const res = await api.get<FeedResponse>(`/api/feed?lane=${lane}`);
    store.setFeedPage(lane, res.posts, res.next_cursor, res.all_caught_up, true);
  } finally {
    loading[lane] = false;
  }
}

/** Next keyset page of a lane; a no-op once its hard end was reached. */
export async function loadMoreFeed(lane: FeedLane = 'friends'): Promise<void> {
  const cursor = store.state.feed[lane].cursor;
  if (loading[lane] || cursor === null) return;
  loading[lane] = true;
  try {
    const res = await api.get<FeedResponse>(
      `/api/feed?lane=${lane}&cursor=${encodeURIComponent(cursor)}`
    );
    store.setFeedPage(lane, res.posts, res.next_cursor, res.all_caught_up, false);
  } finally {
    loading[lane] = false;
  }
}

/** v0.7 (§1.50): the full create shape — kind/audience/poll/ref/location. */
export async function createPost(req: CreatePostRequest): Promise<Post> {
  const res = await api.post<PostResponse>('/api/posts', req);
  store.prependPost(res.post);
  return res.post;
}

/** post.new arrival. join_card frames come with `ref_summary` stripped — it is
 * VIEWER-specific (joiner faces, visibility, my_state) and the server never
 * fans one user's view to another (golden rule 5) — so resolve MY view with
 * the single-post reconcile read before adopting it. A failed read (deleted,
 * offline) just skips the prepend: the next feed GET carries the post. */
export async function adoptIncomingPost(post: Post): Promise<void> {
  if (post.kind !== 'join_card') {
    store.prependPost(post);
    return;
  }
  try {
    const res = await api.get<PostResponse>(`/api/posts/${post.id}`);
    store.prependPost(res.post);
  } catch {
    // 404 or transient failure — nothing adopted; pull reconciles.
  }
}

export async function deletePost(postId: string): Promise<void> {
  try {
    await api.del(`/api/posts/${postId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  store.removePostLocal(postId);
}

/** One post by id for the /feed/<id> landing (§1b deep-link back): returns
 * it without touching lane windows. 404 = deleted / out of audience. */
export async function getPost(postId: string): Promise<PostResponse['post']> {
  const res = await api.get<PostResponse>(`/api/posts/${postId}`);
  return res.post;
}

/** Single-post refetch — the reaction/comment/join-state reconcile read. */
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

/** v0.7 (§1.51): at least one of body / attachment (route-enforced). */
export async function addComment(
  postId: string,
  body: string,
  attachmentId?: string,
  parentId?: string | null
): Promise<PostComment> {
  const res = await api.post<CommentResponse>(`/api/posts/${postId}/comments`, {
    body,
    ...(attachmentId ? { attachment_id: attachmentId } : {}),
    // §1.79 one reply level: the parent is a top-level comment on this post.
    ...(parentId ? { parent_id: parentId } : {}),
  });
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

// ---------------------------------------------------------------------------
// v0.7 interactive-post actions (§1.50)
// ---------------------------------------------------------------------------

/** Vote (or revote — UPSERT replaces) on a poll post; null unvotes. The 200
 * carries the voter's fresh aggregate; feed surfaces reconcile on pull. */
export async function votePostPoll(postId: string, optionIdx: number | null): Promise<PostPoll> {
  const res =
    optionIdx === null
      ? await api.del<PostPollResponse>(`/api/posts/${postId}/poll/vote`)
      : await api.post<PostPollResponse>(`/api/posts/${postId}/poll/vote`, { option_idx: optionIdx });
  // Patch the post in place wherever it is loaded — a lane window, or the
  // §1b deep-link slot (state.feedExtra) when no lane holds it. replacePost
  // fans the patch into every copy, so one call on whichever is found does.
  const cur =
    store.state.feed.friends.posts?.find((p) => p.id === postId) ??
    store.state.feed.discover.posts?.find((p) => p.id === postId) ??
    store.state.feedExtra.get(postId);
  if (cur) store.replacePost({ ...cur, poll: res.poll });
  return res.poll;
}

/** First tap claims the open challenge (advisory-locked server-side) and lands
 * the claimer straight in the DM carrying the §1.27 game_ttt board. */
export async function claimGame(postId: string): Promise<ClaimGameResponse> {
  const res = await api.post<ClaimGameResponse>(`/api/posts/${postId}/claim-game`);
  store.replacePost(res.post);
  return res;
}

// ---------------------------------------------------------------------------
// v0.7 comment reactions (§1.51) — the §1.19 machinery against comments.
// No fan-out by doctrine: the server 204s; we patch the chip optimistically
// and let the next pull reconcile (feed truth is always the DTO).
// ---------------------------------------------------------------------------

export async function addCommentReaction(
  postId: string,
  commentId: string,
  kind: ReactionKind,
  emoji?: string
): Promise<void> {
  await api.post(`/api/posts/${postId}/comments/${commentId}/reactions`, {
    kind,
    ...(kind === 'emoji' ? { emoji } : {}),
  });
}

export async function removeCommentReaction(
  postId: string,
  commentId: string,
  kind: ReactionKind,
  emoji: string
): Promise<void> {
  const key = kind === 'stamp' ? STAMP_REACTION_KEY : emoji;
  await api.del(`/api/posts/${postId}/comments/${commentId}/reactions/${encodeURIComponent(key)}`);
}

/** Optimistic local patch of a comment's reaction chips — faces, never totals.
 * Mirrors the server's aggregation: one chip per (emoji, kind), reactors in
 * first-reaction order capped at COMMENT_REACTORS_PREVIEW_MAX. */
export function patchCommentReaction(
  comment: PostComment,
  kind: ReactionKind,
  emoji: string,
  me: UserLite,
  add: boolean
): PostComment {
  const key = kind === 'stamp' ? STAMP_REACTION_KEY : emoji;
  const reactions = [...comment.reactions];
  const i = reactions.findIndex((r) => r.kind === kind && r.emoji === key);
  if (add) {
    if (i === -1) {
      reactions.push({ emoji: key, kind, reactors: [me], has_more: false, mine: true });
    } else if (!reactions[i].mine) {
      const r = reactions[i];
      const reactors =
        r.reactors.length < COMMENT_REACTORS_PREVIEW_MAX ? [...r.reactors, me] : r.reactors;
      reactions[i] = {
        ...r,
        reactors,
        has_more: r.has_more || r.reactors.length >= COMMENT_REACTORS_PREVIEW_MAX,
        mine: true,
      };
    }
  } else if (i !== -1 && reactions[i].mine) {
    const r = reactions[i];
    const reactors = r.reactors.filter((u) => u.id !== me.id);
    if (reactors.length === 0 && !r.has_more) reactions.splice(i, 1);
    else reactions[i] = { ...r, reactors, mine: false };
  }
  return { ...comment, reactions };
}
