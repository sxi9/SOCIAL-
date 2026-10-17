// Public share links (v0.8b — API.md §1.67, FEATURES #79c, ADR-020).
// Mint-or-return the object's ONE open token; revocation kills the page and
// every gated media URL instantly. Friends-only content never gets a token —
// the server refuses with 400 not_public. On the client the absolute URL is
// location.origin + url (the user is browsing via the instance's public
// origin); SSR pages use publicOrigin() with the PUBLIC_ORIGIN env instead.
import type { ShareLink, ShareLinkResponse, ShareObjectType } from '@socialchat/shared';
import { api, ApiError } from './api';
import { toast } from './toast';

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

export function absoluteShareUrl(link: ShareLink): string {
  return `${window.location.origin}${link.url}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Mint (or return) the link and put it on the clipboard, with the §1.56
 * confirmation toast. Returns the link so callers can offer Revoke. */
export async function copyShareLink(type: ShareObjectType, id: string): Promise<ShareLink | null> {
  try {
    const link = await mintShareLink(type, id);
    const url = absoluteShareUrl(link);
    if (await copyText(url)) {
      toast('Public link copied — anyone can open it');
    } else {
      window.prompt('Copy this public link:', url);
    }
    return link;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_public') {
      toast('Only public things get a share link');
    } else {
      toast('Could not make a share link');
    }
    return null;
  }
}
