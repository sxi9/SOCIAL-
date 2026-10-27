// Public share links (v0.8b — API.md §1.67, FEATURES #79c, ADR-020).
// Mint-or-return the object's ONE open token; revocation kills the page and
// every gated media URL instantly. Friends-only content never gets a token —
// the server refuses with 400 not_public. On the client the absolute URL is
// location.origin + url (the user is browsing via the instance's public
// origin); SSR pages use publicOrigin() with the PUBLIC_ORIGIN env instead.
//
// §1b (2026-10-27): the one ShareSheet component owns every share surface
// (Copy · OS share · QR · Send to a chat · Revoke); the old copyShareLink
// clipboard-only helper is gone — mount <ShareSheet>/<ShareButton> instead.
import type {
  ListShareLinksResponse,
  ShareLink,
  ShareLinkListItem,
  ShareLinkResponse,
  ShareObjectType,
} from '@socialchat/shared';
import { api, ApiError } from './api';

/** The product word for each shareable object — every user-facing surface
 * says "plan", never "beacon". */
export const SHARE_OBJECT_WORD: Record<ShareObjectType, string> = {
  post: 'post',
  beacon: 'plan',
  listing: 'listing',
  story: 'story',
  group: 'group',
};

export async function mintShareLink(type: ShareObjectType, id: string): Promise<ShareLink> {
  const res = await api.post<ShareLinkResponse>('/api/share-links', { type, id });
  return res.share_link;
}

export async function revokeShareLink(token: string): Promise<void> {
  try {
    await api.del(`/api/share-links/${encodeURIComponent(token)}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
}

/** Every open link I minted, newest first (API.md §1.67). */
export async function listMyShareLinks(): Promise<ShareLinkListItem[]> {
  const res = await api.get<ListShareLinksResponse>('/api/share-links/mine');
  return res.share_links;
}

export function absoluteShareUrl(link: Pick<ShareLink, 'url'>): string {
  return `${window.location.origin}${link.url}`;
}

/** Clipboard write that reports success instead of throwing (blocked
 * clipboards fall back to a select-all link box in the sheet). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
