// Media job (ARCHITECTURE §5): ffprobe dims/duration, representative poster,
// 512px WebP thumb + blurhash, faststart remux when the moov atom trails,
// then PUSHED hydration — msg.updated if bound, attachment.ready otherwise.
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, ne, or, sql as dsql } from 'drizzle-orm';
import { encode as encodeBlurhash } from 'blurhash';
import { execa } from 'execa';
import sharp from 'sharp';
import {
  AUDIO_WAVEFORM_BUCKETS,
  AUDIO_WAVEFORM_PEAK_MAX,
  MAX_AUDIO_DURATION_S,
  THUMB_SIZE_PX,
} from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import { attachmentDto, type AttRow } from '../lib/dto.js';
import { contentKey, sha256Hex } from '../lib/media.js';
import { publishMessageUpdated } from '../modules/messages/service.js';
import type { MediaJob } from '../queues.js';
import { deleteObject, getObjectStream, putObject } from '../s3.js';
import { publishToUsers } from '../ws/events.js';
import { ffprobe } from './avatar.js';

/** Walk top-level MP4 boxes: true when moov appears after mdat. */
export async function moovTrailsMdat(path: string): Promise<boolean> {
  const fd = await open(path, 'r');
  try {
    const size = (await stat(path)).size;
    let offset = 0;
    let seenMdat = false;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(16);
      await fd.read(header, 0, 16, offset);
      let boxSize: number = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (type === 'moov') return seenMdat;
      if (type === 'mdat') seenMdat = true;
      if (boxSize < headerSize) return false; // corrupt
      offset += boxSize;
    }
    return false;
  } finally {
    await fd.close();
  }
}

async function publishHydration(row: AttRow): Promise<void> {
  if (row.messageId) {
    // v0.8b (§1.68): route through publishMessageUpdated so 👻 ghost
    // conversations mask the sender per recipient class — fanning the raw
    // DTO here would deanonymize voice-note/video senders on hydration.
    const [msg] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row.messageId))
      .limit(1);
    if (msg) await publishMessageUpdated(msg);
  } else {
    // Composer still open — the uploader gets attachment.ready.
    await publishToUsers([row.uploaderId], {
      t: 'attachment.ready',
      d: { attachment: attachmentDto(row) },
    });
  }
}

/**
 * v0.4 (§1.20): split the decoded mono PCM into AUDIO_WAVEFORM_BUCKETS equal
 * segments and take each segment's peak |sample|, normalized to integers
 * 0..AUDIO_WAVEFORM_PEAK_MAX. Pure so the scoring is unit-testable.
 */
export function waveformFromPcm(pcm: Buffer, buckets = AUDIO_WAVEFORM_BUCKETS): number[] {
  const samples = Math.floor(pcm.length / 2);
  const out = new Array<number>(buckets).fill(0);
  if (samples === 0) return out;
  const perBucket = Math.max(1, Math.ceil(samples / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const start = b * perBucket;
    const end = Math.min(samples, start + perBucket);
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out[b] = Math.min(AUDIO_WAVEFORM_PEAK_MAX, Math.round((peak / 32768) * AUDIO_WAVEFORM_PEAK_MAX));
  }
  return out;
}

/** v0.4 (§1.20) audio leg of the media job: ffprobe duration (over the 5-min
 * cap → 'failed'), peak-measure the 48 waveform buckets, hydrate as usual. */
async function processAudioJob(att: AttRow, dir: string): Promise<void> {
  const ext = att.originalKey.split('.').pop() ?? 'ogg';
  const inPath = join(dir, `in.${ext}`);
  const obj = await getObjectStream(att.originalKey);
  await pipeline(obj.body, createWriteStream(inPath));

  const probe = await ffprobe(inPath);
  const durationS = Number(probe.format?.duration ?? 0);
  if (durationS > MAX_AUDIO_DURATION_S) {
    // Server-truth duration cap: a recording-side client should never hit it.
    const [failed] = await db
      .update(schema.attachments)
      .set({ status: 'failed' })
      .where(eq(schema.attachments.id, att.id))
      .returning();
    if (failed) await publishHydration(failed);
    return;
  }

  // One decode pass to mono 8 kHz s16le PCM, peak-measured per equal segment —
  // the same measurement astats-per-segment yields, in a single ffmpeg run.
  const pcmPath = join(dir, 'out.pcm');
  await execa('ffmpeg', ['-y', '-i', inPath, '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
  const waveform = waveformFromPcm(await readFile(pcmPath));

  const [updated] = await db
    .update(schema.attachments)
    .set({
      status: 'ready',
      durationMs: durationS > 0 ? Math.round(durationS * 1000) : null,
      waveform,
    })
    .where(eq(schema.attachments.id, att.id))
    .returning();
  if (updated) await publishHydration(updated);
}

export async function processMediaJob(job: MediaJob, isFinalAttempt: boolean): Promise<void> {
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, job.attachment_id))
    .limit(1);
  if (!att || (att.kind !== 'video' && att.kind !== 'audio') || att.status !== 'pending') return;

  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    if (att.kind === 'audio') {
      await processAudioJob(att, dir);
      return;
    }
    const ext = att.originalKey.split('.').pop() ?? 'mp4';
    const inPath = join(dir, `in.${ext}`);
    const obj = await getObjectStream(att.originalKey);
    await pipeline(obj.body, createWriteStream(inPath));

    const probe = await ffprobe(inPath);
    const video = (probe.streams ?? []).find(
      (s) => (s as { codec_type?: string }).codec_type === 'video',
    ) as { width?: number; height?: number } | undefined;
    const durationS = Number(probe.format?.duration ?? 0);
    const width = video?.width ?? null;
    const height = video?.height ?? null;

    // Representative poster frame → 512px WebP thumb + blurhash.
    const posterPath = join(dir, 'poster.png');
    await execa('ffmpeg', ['-y', '-i', inPath, '-vf', 'thumbnail=90', '-frames:v', '1', posterPath]);
    const posterBuf = await readFile(posterPath);
    const { data: thumbBuf } = await sharp(posterBuf)
      .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const { data: rawPx, info: rawInfo } = await sharp(posterBuf)
      .resize(32, 32, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const blurhash = encodeBlurhash(
      new Uint8ClampedArray(rawPx.buffer, rawPx.byteOffset, rawPx.byteLength),
      rawInfo.width,
      rawInfo.height,
      4,
      3,
    );
    const thumbKey = contentKey(sha256Hex(thumbBuf), 'webp');
    await putObject(thumbKey, thumbBuf, 'image/webp');

    // Faststart remux (-c copy) when the moov atom trails — progressive
    // streaming without re-encoding.
    let originalKey = att.originalKey;
    let sizeBytes = att.sizeBytes;
    if (att.mime === 'video/mp4' && (await moovTrailsMdat(inPath))) {
      const remuxPath = join(dir, 'remux.mp4');
      await execa('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', remuxPath]);
      const remuxBuf = await readFile(remuxPath);
      const newKey = contentKey(sha256Hex(remuxBuf), 'mp4');
      await putObject(newKey, remuxBuf, 'video/mp4');
      if (newKey !== att.originalKey) {
        const oldKey = att.originalKey;
        originalKey = newKey;
        sizeBytes = remuxBuf.length;
        // Delete the pre-remux object only if nothing else references it.
        const [other] = await db
          .select({ id: schema.attachments.id })
          .from(schema.attachments)
          .where(
            and(
              ne(schema.attachments.id, att.id),
              or(
                eq(schema.attachments.originalKey, oldKey),
                dsql`${schema.attachments.thumbKey} = ${oldKey}`,
              ),
            ),
          )
          .limit(1);
        if (!other) await deleteObject(oldKey);
      }
    }

    const [updated] = await db
      .update(schema.attachments)
      .set({
        status: 'ready',
        originalKey,
        sizeBytes,
        thumbKey,
        blurhash,
        width,
        height,
        durationMs: durationS > 0 ? Math.round(durationS * 1000) : null,
      })
      .where(eq(schema.attachments.id, att.id))
      .returning();
    if (updated) await publishHydration(updated);
  } catch (err) {
    if (isFinalAttempt) {
      const [failed] = await db
        .update(schema.attachments)
        .set({ status: 'failed' })
        .where(eq(schema.attachments.id, att.id))
        .returning();
      if (failed) await publishHydration(failed);
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
