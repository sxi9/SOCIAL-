// OS share of the thing itself (share-everything phase 4, AUDIT-PLAN §1b
// "even the chat" + §2.2): a chat message's text, or a photo / video /
// voice note / file as the FILE — through the Web Share API, which hands it
// to whatever app the phone offers. Media rides the cookie-authed proxy URL
// (`/api/media/<key>`, same origin), so the bytes are fetched here and
// wrapped in a File; nothing new on the server. Where the platform cannot
// share files (desktop browsers mostly) the caller falls back to Save.
import type { Attachment } from '@socialchat/shared';

export type OsShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed';

export function canOsShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** The person closed the OS sheet. NotAllowedError is NOT that — it is the
 * activation window expiring (a long download before share()) or a share
 * already in flight, which the caller must surface, not swallow. */
function isCancel(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Can this platform share a file of this type at all? Asked with an empty
 * File BEFORE the download, so an unsupported platform never fetches. */
export function canShareFiles(mime: string, name: string): boolean {
  if (!canOsShare() || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File([], name, { type: mime })] });
  } catch {
    return false;
  }
}

/** The name the receiving app sees: the upload's own name when its
 * extension still matches what the server serves (images are re-encoded),
 * else `<kind>.<ext>` from the served key. */
export function attachmentFileName(att: Attachment): string {
  const ext = att.url.split('.').pop()?.toLowerCase() ?? '';
  const own = att.file_name?.trim();
  if (own && ext && own.toLowerCase().endsWith(`.${ext}`)) return own;
  if (own && att.kind === 'file') return own;
  const stem = att.kind === 'audio' ? 'voice-note' : att.kind === 'video' ? 'video' : att.kind === 'image' ? 'photo' : 'file';
  return ext ? `${stem}.${ext}` : stem;
}

export async function shareText(text: string): Promise<OsShareOutcome> {
  if (!canOsShare()) return 'unsupported';
  try {
    await navigator.share({ text });
    return 'shared';
  } catch (err) {
    return isCancel(err) ? 'cancelled' : 'failed';
  }
}

/** Fetch the media through the authed proxy and share it as a File. */
export async function shareAttachment(att: Attachment, text?: string | null): Promise<OsShareOutcome> {
  const name = attachmentFileName(att);
  if (!canShareFiles(att.mime, name)) return 'unsupported';
  let file: File;
  try {
    const res = await fetch(att.url, { credentials: 'same-origin' });
    if (!res.ok) return 'failed';
    const blob = await res.blob();
    file = new File([blob], name, { type: att.mime || blob.type });
  } catch {
    return 'failed';
  }
  const data: ShareData = text ? { files: [file], text } : { files: [file] };
  if (!navigator.canShare(data)) return 'unsupported';
  try {
    await navigator.share(data);
    return 'shared';
  } catch (err) {
    return isCancel(err) ? 'cancelled' : 'failed';
  }
}

/** Save = a same-origin anchor download with a real name (images, video
 * and audio come inline from the proxy, so the name must be set here). */
export function saveAttachment(att: Attachment): void {
  const a = document.createElement('a');
  a.href = att.url;
  a.download = attachmentFileName(att);
  document.body.appendChild(a);
  a.click();
  a.remove();
}
