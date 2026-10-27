// Group visibility modes (v0.8b — API.md §1.68, FEATURES #79d, ADR-020).
// private (today's behavior) / invite_only (card page + request queue) /
// public (admin-confirmed; ONLY seq > public_since_seq ever renders publicly)
// / ghost (unlisted everywhere, masks, ONE-WAY — never switchable off).
import {
  SUPPORT_CONVERSATION_TITLE,
  type Conversation,
  type ConversationListItem,
  type GroupJoinRequestsResponse,
  type GroupJoinResponse,
  type GroupJoinState,
  type UpdateGroupVisibilityRequest,
} from '@socialchat/shared';
import { api } from './api';
import * as store from './store';

type ConversationResponse = { conversation: Conversation };

/** PATCH visibility/description — group admins only. Switching TO public or
 * ghost requires confirm:true (400 confirm_required); ghost never switches
 * away (400 ghost_is_forever). */
export async function updateGroupVisibility(
  conversationId: string,
  req: UpdateGroupVisibilityRequest
): Promise<Conversation> {
  const res = await api.patch<ConversationResponse>(
    `/api/conversations/${conversationId}/visibility`,
    req
  );
  store.upsertConversation(res.conversation);
  return res.conversation;
}

/** POST join: public → joined (200 + conversation); invite_only → requested
 * (202); private/ghost → 404, byte-identical to an unknown id. */
export async function joinGroup(conversationId: string): Promise<GroupJoinResponse> {
  const res = await api.post<GroupJoinResponse>(`/api/conversations/${conversationId}/join`);
  if (res.status === 'joined') store.upsertConversation(res.conversation);
  return res;
}

/** Phase 2: my own standing with a public|invite_only group (404 otherwise). */
export function getJoinState(conversationId: string): Promise<GroupJoinState> {
  return api.get<GroupJoinState>(`/api/conversations/${conversationId}/join`);
}

/** Phase 2: withdraw my pending request (idempotent 204). */
export async function withdrawJoinRequest(conversationId: string): Promise<void> {
  await api.del(`/api/conversations/${conversationId}/join`);
}

export async function listJoinRequests(conversationId: string): Promise<GroupJoinRequestsResponse> {
  return api.get<GroupJoinRequestsResponse>(`/api/conversations/${conversationId}/join-requests`);
}

export async function approveJoinRequest(conversationId: string, userId: string): Promise<void> {
  const res = await api.post<ConversationResponse>(
    `/api/conversations/${conversationId}/join-requests/${userId}/approve`
  );
  store.upsertConversation(res.conversation);
}

/** Deny deletes the row SILENTLY — the requester is never told (the
 * no-rejection-surface rule); their button simply stays "requested". */
export async function denyJoinRequest(conversationId: string, userId: string): Promise<void> {
  await api.del(`/api/conversations/${conversationId}/join-requests/${userId}`);
}

/** PUT my mask in a ghost group (unique per group → 409 mask_taken). */
export async function setMask(
  conversationId: string,
  maskName: string,
  maskEmoji: string
): Promise<Conversation> {
  const res = await api.put<ConversationResponse>(`/api/conversations/${conversationId}/mask`, {
    mask_name: maskName,
    mask_emoji: maskEmoji,
  });
  store.upsertConversation(res.conversation);
  return res.conversation;
}

export function isGhost(conv: Conversation | ConversationListItem): boolean {
  return conv.type === 'group' && conv.visibility === 'ghost';
}

export function isPubliclyReadable(conv: Conversation | ConversationListItem): boolean {
  return conv.type === 'group' && conv.visibility === 'public' && conv.public_since_seq !== null;
}

/** The per-user §1.69 Support conversation: type group, operator-created
 * (created_by NULL), the exact brand title, one human member. */
export function isSupportConversation(conv: Conversation | ConversationListItem): boolean {
  return (
    conv.type === 'group' && conv.created_by === null && conv.title === SUPPORT_CONVERSATION_TITLE
  );
}
