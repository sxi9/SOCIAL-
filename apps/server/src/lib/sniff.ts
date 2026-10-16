// Magic-byte MIME sniffing (ARCHITECTURE §5) — the client-declared MIME is
// advisory only; the sniffed type decides `kind` and allowlist checks.

export interface SniffResult {
  mime: string;
  ext: string;
}

/** Bytes needed for a reliable sniff (PNG acTL scan, ftyp brands, EBML doctype). */
export const SNIFF_BYTES = 4100;

const ascii = (buf: Buffer, start: number, len: number) =>
  buf.subarray(start, start + len).toString('latin1');

export function sniffMime(buf: Buffer): SniffResult {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    ascii(buf, 1, 3) === 'PNG' &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    // APNG: acTL chunk appears before the first IDAT.
    const head = buf.subarray(0, SNIFF_BYTES).toString('latin1');
    const actl = head.indexOf('acTL');
    const idat = head.indexOf('IDAT');
    if (actl !== -1 && (idat === -1 || actl < idat)) return { mime: 'image/apng', ext: 'png' };
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 6 && (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buf.length >= 12 && ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return { mime: 'image/heic', ext: 'heic' };
    }
    // Everything else with an ftyp box is treated as MP4-family video.
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const head = buf.subarray(0, SNIFF_BYTES).toString('latin1');
    if (head.includes('webm')) return { mime: 'video/webm', ext: 'webm' };
    return { mime: 'video/x-matroska', ext: 'mkv' };
  }
  if (buf.length >= 5 && ascii(buf, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  if (buf.length >= 4 && ascii(buf, 0, 2) === 'PK' && buf[2] === 0x03 && buf[3] === 0x04) {
    return { mime: 'application/zip', ext: 'zip' };
  }
  return { mime: 'application/octet-stream', ext: 'bin' };
}
