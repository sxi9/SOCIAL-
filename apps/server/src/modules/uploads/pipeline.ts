// Proxied streaming upload pipeline (ARCHITECTURE §5): magic-byte sniffing on
// the first chunk, per-kind limits enforced during the stream, content-hashed
// object keys, inline sharp processing for images.
import { createHash } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';
import {
  AUDIO_MIME_ALLOWLIST,
  AVATAR_SOURCE_MIME_ALLOWLIST,
  IMAGE_MIME_ALLOWLIST,
  MAX_AUDIO_BYTES,
  MAX_AVATAR_SOURCE_BYTES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  THUMB_SIZE_PX,
  VIDEO_MIME_ALLOWLIST,
} from '@socialchat/shared';
import { newId } from '../../ids.js';
import { tooLarge, unsupportedMedia } from '../../lib/errors.js';
import { contentKey, sanitizeFileName, sha256Hex } from '../../lib/media.js';
import { SNIFF_BYTES, sniffMime, type SniffResult } from '../../lib/sniff.js';
import { copyObject, deleteObject, putObject, uploadStream } from '../../s3.js';

export interface ProcessedFile {
  kind: 'image' | 'video' | 'file' | 'audio';
  mime: string;
  originalKey: string;
  thumbKey: string | null;
  blurhash: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: 'pending' | 'ready';
  fileName: string | null;
}

interface Head {
  head: Buffer;
  ended: boolean;
}

/** Read the first `bytes` of a paused-able stream without consuming the rest. */
export function collectHead(file: Readable, bytes: number): Promise<Head> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      file.off('data', onData);
      file.off('end', onEnd);
      file.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= bytes) {
        file.pause();
        cleanup();
        resolve({ head: Buffer.concat(chunks), ended: false });
      }
    };
    const onEnd = () => {
      cleanup();
      resolve({ head: Buffer.concat(chunks), ended: true });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    file.on('data', onData);
    file.once('end', onEnd);
    file.once('error', onError);
  });
}

/** Buffer the remainder of a head-collected stream, enforcing a byte cap. */
export function bufferRest(file: Readable, { head, ended }: Head, maxBytes: number): Promise<Buffer> {
  if (head.length > maxBytes) return Promise.reject(tooLarge());
  // `readableEnded` covers the race where the source (e.g. a busboy file
  // stream fed in one synchronous burst) emitted 'end' in the microtask gap
  // after collectHead removed its listeners — 'end' will never fire again.
  if (ended || file.readableEnded) return Promise.resolve(head);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [head];
    let size = head.length;
    file.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        file.destroy();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    file.once('end', () => resolve(Buffer.concat(chunks)));
    file.once('error', reject);
    file.resume();
  });
}

/**
 * Stream head+rest to a temporary S3 key while hashing and enforcing a cap.
 * Returns the hash and size; caller copies to the final content-hash key.
 */
async function streamToTmp(
  file: Readable,
  headInfo: Head,
  maxBytes: number,
  contentType: string,
): Promise<{ tmpKey: string; sha256: string; size: number }> {
  const tmpKey = `tmp/${newId()}`;
  const hash = createHash('sha256');
  const pt = new PassThrough();
  let size = 0;
  let overLimit = false;

  const push = (chunk: Buffer): boolean => {
    size += chunk.length;
    if (size > maxBytes) {
      overLimit = true;
      pt.destroy(tooLarge());
      file.destroy();
      return false;
    }
    hash.update(chunk);
    return pt.write(chunk);
  };

  push(headInfo.head);
  // `readableEnded` covers the race where the source emitted 'end' between
  // collectHead's listener cleanup and this wiring (one-burst small files):
  // waiting on 'end' would deadlock the upload. 'end' only fires with an
  // empty internal buffer, so the head already holds every byte.
  if (headInfo.ended || file.readableEnded) {
    pt.end();
  } else {
    file.on('data', (chunk: Buffer) => {
      if (!push(chunk)) file.pause();
    });
    pt.on('drain', () => file.resume());
    file.once('end', () => pt.end());
    file.once('error', (err) => pt.destroy(err));
    file.resume();
  }

  try {
    await uploadStream(tmpKey, pt, contentType);
  } catch (err) {
    await deleteObject(tmpKey);
    if (overLimit) throw tooLarge();
    throw err;
  }
  if (overLimit) {
    await deleteObject(tmpKey);
    throw tooLarge();
  }
  return { tmpKey, sha256: hash.digest('hex'), size };
}

interface ImageResult {
  original: Buffer;
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
  thumb: Buffer | null;
  blurhash: string | null;
}

async function makeThumbAndBlurhash(
  buf: Buffer,
): Promise<{ thumb: Buffer; blurhash: string; width: number; height: number } | null> {
  try {
    const { data: thumb, info } = await sharp(buf, { animated: false })
      .rotate()
      .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const { data: raw, info: rawInfo } = await sharp(buf, { animated: false })
      .rotate()
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hash = encodeBlurhash(
      new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength),
      rawInfo.width,
      rawInfo.height,
      4,
      3,
    );
    return { thumb, blurhash: hash, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** EXIF strip + auto-rotate + thumb + blurhash (ARCHITECTURE §5, inline ~50ms). */
async function processImage(buf: Buffer, sniff: SniffResult): Promise<ImageResult> {
  let original = buf;
  let width: number | null = null;
  let height: number | null = null;

  // Re-encode strips EXIF; animated formats (gif/webp/apng) and heic are kept
  // verbatim so animation/codec survives.
  const reencodable = ['image/jpeg', 'image/png', 'image/webp'].includes(sniff.mime);
  try {
    const meta = await sharp(buf).metadata();
    const animated = (meta.pages ?? 1) > 1;
    if (reencodable && !animated) {
      const base = sharp(buf).rotate();
      const encoded =
        sniff.mime === 'image/jpeg'
          ? base.jpeg({ quality: 85 })
          : sniff.mime === 'image/png'
            ? base.png()
            : base.webp({ quality: 90 });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      original = data;
      width = info.width;
      height = info.height;
    } else {
      width = meta.width ?? null;
      height = meta.height ?? null;
    }
  } catch {
    // v1.0a (#91): an image sharp cannot decode (HEVC-coded .heic — prebuilt
    // libvips has no HEVC codec) used to be stored VERBATIM: no thumb, no
    // dimensions, and most browsers can't render it — the "can't add photos
    // from my iPhone" bug. Reject loudly instead; the web client converts
    // HEIC to JPEG before upload, so a 415 here means a truly alien file.
    throw unsupportedMedia('image_undecodable');
  }

  const extra = await makeThumbAndBlurhash(buf);
  if (extra && width === null) {
    width = extra.width;
    height = extra.height;
  }
  return {
    original,
    mime: sniff.mime === 'image/apng' ? 'image/png' : sniff.mime,
    ext: sniff.ext,
    width,
    height,
    thumb: extra?.thumb ?? null,
    blurhash: extra?.blurhash ?? null,
  };
}

function kindOf(sniff: SniffResult): 'image' | 'video' | 'file' | 'audio' {
  const effective = sniff.mime === 'image/apng' ? 'image/png' : sniff.mime;
  if ((IMAGE_MIME_ALLOWLIST as readonly string[]).includes(effective)) return 'image';
  if ((VIDEO_MIME_ALLOWLIST as readonly string[]).includes(sniff.mime)) return 'video';
  // v0.4 (§1.20): sniffed audio allowlist (ogg/opus, webm/opus, m4a/aac, mp3).
  if ((AUDIO_MIME_ALLOWLIST as readonly string[]).includes(sniff.mime)) return 'audio';
  return 'file';
}

function maxBytesFor(kind: 'video' | 'file' | 'audio'): number {
  if (kind === 'video') return MAX_VIDEO_BYTES;
  if (kind === 'audio') return MAX_AUDIO_BYTES;
  return MAX_FILE_BYTES;
}

async function finishImage(buf: Buffer, sniff: SniffResult, fileName: string | null): Promise<ProcessedFile> {
  const img = await processImage(buf, sniff);
  const originalKey = contentKey(sha256Hex(img.original), img.ext);
  await putObject(originalKey, img.original, img.mime);
  let thumbKey: string | null = null;
  if (img.thumb) {
    thumbKey = contentKey(sha256Hex(img.thumb), 'webp');
    await putObject(thumbKey, img.thumb, 'image/webp');
  }
  return {
    kind: 'image',
    mime: img.mime,
    originalKey,
    thumbKey,
    blurhash: img.blurhash,
    sizeBytes: img.original.length,
    width: img.width,
    height: img.height,
    status: 'ready',
    fileName,
  };
}

/** POST /api/uploads pipeline entry for a busboy file stream. */
export async function processUploadStream(
  file: Readable,
  rawFileName: string | undefined,
): Promise<ProcessedFile> {
  const fileName = sanitizeFileName(rawFileName);
  const headInfo = await collectHead(file, SNIFF_BYTES);
  const sniff = sniffMime(headInfo.head);
  const kind = kindOf(sniff);

  if (kind === 'image') {
    const buf = await bufferRest(file, headInfo, MAX_IMAGE_BYTES);
    return finishImage(buf, sniff, fileName);
  }

  const maxBytes = maxBytesFor(kind);
  const { tmpKey, sha256, size } = await streamToTmp(file, headInfo, maxBytes, sniff.mime);
  const originalKey = contentKey(sha256, sniff.ext);
  await copyObject(tmpKey, originalKey);
  await deleteObject(tmpKey);
  return {
    kind,
    mime: sniff.mime,
    originalKey,
    thumbKey: null,
    blurhash: null,
    sizeBytes: size,
    width: null,
    height: null,
    // Video derived fields (poster/thumb/blurhash/dims) and audio derived
    // fields (duration_ms + 48-bucket waveform, §1.20) hydrate via the worker.
    status: kind === 'video' || kind === 'audio' ? 'pending' : 'ready',
    fileName,
  };
}

/** Share-stash claim path: whole payload is already buffered (≤ 30 MB). */
export async function processUploadBuffer(
  buf: Buffer,
  rawFileName: string | undefined,
): Promise<ProcessedFile> {
  const fileName = sanitizeFileName(rawFileName);
  const sniff = sniffMime(buf);
  const kind = kindOf(sniff);

  if (kind === 'image') {
    if (buf.length > MAX_IMAGE_BYTES) throw tooLarge();
    return finishImage(buf, sniff, fileName);
  }
  const maxBytes = maxBytesFor(kind);
  if (buf.length > maxBytes) throw tooLarge();
  const originalKey = contentKey(sha256Hex(buf), sniff.ext);
  await putObject(originalKey, buf, sniff.mime);
  return {
    kind,
    mime: sniff.mime,
    originalKey,
    thumbKey: null,
    blurhash: null,
    sizeBytes: buf.length,
    width: null,
    height: null,
    status: kind === 'video' || kind === 'audio' ? 'pending' : 'ready',
    fileName,
  };
}

/** Avatar source: allowlist-checked, streamed to raw/ for the worker. */
export async function stashAvatarSource(file: Readable): Promise<{ rawKey: string; mime: string }> {
  const headInfo = await collectHead(file, SNIFF_BYTES);
  const sniff = sniffMime(headInfo.head);
  if (!(AVATAR_SOURCE_MIME_ALLOWLIST as readonly string[]).includes(sniff.mime)) {
    file.destroy();
    throw unsupportedMedia();
  }
  const buf = await bufferRest(file, headInfo, MAX_AVATAR_SOURCE_BYTES);
  const rawKey = `raw/${newId()}.${sniff.ext}`;
  await putObject(rawKey, buf, sniff.mime);
  return { rawKey, mime: sniff.mime };
}
