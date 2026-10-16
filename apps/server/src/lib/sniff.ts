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
    // v0.4 (§1.20): M4A/AAC audio containers carry their own ftyp brands.
    if (['m4a ', 'm4b ', 'm4p '].includes(ascii(buf, 8, 4).toLowerCase())) {
      return { mime: 'audio/mp4', ext: 'm4a' };
    }
    // Everything else with an ftyp box is treated as MP4-family video.
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const head = buf.subarray(0, SNIFF_BYTES).toString('latin1');
    if (head.includes('webm')) {
      // v0.4 (§1.20): a MediaRecorder voice note is an audio-only webm — the
      // Tracks element (within the sniff window for streamed recordings) names
      // codecs. A video codec id wins; an audio-only track list is audio/webm.
      const hasVideo = head.includes('V_VP8') || head.includes('V_VP9') || head.includes('V_AV1');
      const hasAudio = head.includes('A_OPUS') || head.includes('A_VORBIS');
      if (!hasVideo && hasAudio) return { mime: 'audio/webm', ext: 'webm' };
      return { mime: 'video/webm', ext: 'webm' };
    }
    return { mime: 'video/x-matroska', ext: 'mkv' };
  }
  // v0.4 (§1.20) audio magic: Ogg (opus/vorbis ride the Ogg container).
  if (buf.length >= 4 && ascii(buf, 0, 4) === 'OggS') {
    return { mime: 'audio/ogg', ext: 'ogg' };
  }
  // MP3: ID3v2 header, or a bare MPEG audio frame sync (0xFFE/0xFFF).
  if (buf.length >= 3 && ascii(buf, 0, 3) === 'ID3') {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe6) === 0xe2) {
    // Frame sync 11111111 111xxxxx with a valid MPEG layer (not 00).
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  if (buf.length >= 5 && ascii(buf, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  if (buf.length >= 4 && ascii(buf, 0, 2) === 'PK' && buf[2] === 0x03 && buf[3] === 0x04) {
    return { mime: 'application/zip', ext: 'zip' };
  }
  return { mime: 'application/octet-stream', ext: 'bin' };
}
