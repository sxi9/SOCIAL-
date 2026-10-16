import { createHash } from 'node:crypto';

/** Media-proxy URL for a MinIO object key (API.md §1.6). */
export function mediaUrl(key: string): string {
  return `/api/media/${key}`;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Content-hashed object key: media/<sha256>.<ext> (ARCHITECTURE §5). */
export function contentKey(hashHex: string, ext: string, prefix = 'media'): string {
  return `${prefix}/${hashHex}.${ext}`;
}

/** Strip path separators / control chars from a client-supplied filename. */
export function sanitizeFileName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f"]/g, '').trim().slice(0, 255);
  return clean.length > 0 ? clean : null;
}
