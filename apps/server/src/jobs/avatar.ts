// Avatar job (ARCHITECTURE §5, signature feature): animated-WebP 512px q75
// with one step-down retry (q55/384px), representative-frame JPEG poster via
// the thumbnail filter, EXIF-free, avatar_version bump. Serves users AND
// group conversations via the target discriminator.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { eq, sql } from 'drizzle-orm';
import { AVATAR_MAX_OUTPUT_BYTES, AVATAR_SIZE_PX } from '@socialchat/shared';
import { db, schema } from '../db/index.js';
import {
  activeParticipantUserIds,
  coParticipantUserIds,
  publishConversationToUsers,
  publishUserUpdated,
} from '../lib/dto.js';
import { contentKey, sha256Hex } from '../lib/media.js';
import type { AvatarJob } from '../queues.js';
import { deleteObject, getObjectBuffer, putObject } from '../s3.js';

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

export async function ffprobe(path: string): Promise<ProbeResult> {
  const { stdout } = await execa('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout) as ProbeResult;
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || Number.isNaN(num)) return null;
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

const SQUARE_CROP = 'crop=min(iw\\,ih):min(iw\\,ih)';

async function encodeAnimatedWebp(
  inPath: string,
  outPath: string,
  sizePx: number,
  quality: number,
  fps: number,
): Promise<void> {
  await execa('ffmpeg', [
    '-y',
    '-i',
    inPath,
    '-t',
    '10',
    '-vf',
    `${SQUARE_CROP},scale=${sizePx}:${sizePx},fps=${fps}`,
    '-c:v',
    'libwebp',
    '-q:v',
    String(quality),
    '-loop',
    '0',
    '-an',
    '-map_metadata',
    '-1',
    outPath,
  ]);
}

async function encodePosterJpeg(inPath: string, outPath: string): Promise<void> {
  // thumbnail=90 picks a representative frame — frame 0 of animated sources
  // is often blank ([fix] graft).
  await execa('ffmpeg', [
    '-y',
    '-i',
    inPath,
    '-vf',
    `thumbnail=90,${SQUARE_CROP},scale=${AVATAR_SIZE_PX}:${AVATAR_SIZE_PX}`,
    '-frames:v',
    '1',
    '-qscale:v',
    '3',
    '-map_metadata',
    '-1',
    outPath,
  ]);
}

async function updateTarget(
  target: AvatarJob['target'],
  patch: { status: 'ready' | 'failed'; staticKey?: string; animatedKey?: string },
): Promise<void> {
  if ('user_id' in target) {
    const update = db.update(schema.users);
    const query =
      patch.status === 'ready'
        ? update.set({
            avatarStatus: 'ready',
            avatarStaticKey: patch.staticKey!,
            avatarAnimatedKey: patch.animatedKey!,
            avatarVersion: sql`${schema.users.avatarVersion} + 1`,
            updatedAt: new Date(),
          })
        : update.set({ avatarStatus: 'failed', updatedAt: new Date() });
    const [row] = await query.where(eq(schema.users.id, target.user_id)).returning();
    if (row) {
      // §1.14: blocked co-members get the frame with last_seen_at clamped.
      const peers = await coParticipantUserIds(target.user_id);
      await publishUserUpdated(row, peers);
    }
  } else {
    const update = db.update(schema.conversations);
    const query =
      patch.status === 'ready'
        ? update.set({
            avatarStatus: 'ready',
            avatarStaticKey: patch.staticKey!,
            avatarAnimatedKey: patch.animatedKey!,
            avatarVersion: sql`${schema.conversations.avatarVersion} + 1`,
          })
        : update.set({ avatarStatus: 'failed' });
    await query.where(eq(schema.conversations.id, target.conversation_id));
    // Per-recipient clamped conv.updated (§1.13/§1.14) — never a shared
    // unfiltered DTO.
    const members = await activeParticipantUserIds(target.conversation_id);
    await publishConversationToUsers(target.conversation_id, members, 'conv.updated');
  }
}

export async function processAvatarJob(job: AvatarJob): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'avatar-'));
  try {
    const ext = job.raw_key.split('.').pop() ?? 'bin';
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, await getObjectBuffer(job.raw_key));

    // ffprobe validation: decodes OK, ≤ 4096 px, sane frame rate.
    const probe = await ffprobe(inPath);
    const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');
    if (!video?.width || !video.height) throw new Error('no decodable video stream');
    if (video.width > 4096 || video.height > 4096) throw new Error('dimensions too large');
    const fps = Math.min(24, parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate) ?? 24);

    const outWebp = join(dir, 'out.webp');
    await encodeAnimatedWebp(inPath, outWebp, AVATAR_SIZE_PX, 75, fps);
    let webpBuf = await readFile(outWebp);
    if (webpBuf.length > AVATAR_MAX_OUTPUT_BYTES) {
      // Step-down retry once: q55, 384px (graft P1 size budget).
      await encodeAnimatedWebp(inPath, outWebp, 384, 55, fps);
      webpBuf = await readFile(outWebp);
    }

    const outJpg = join(dir, 'poster.jpg');
    await encodePosterJpeg(inPath, outJpg);
    const jpgBuf = await readFile(outJpg);

    const animatedKey = contentKey(sha256Hex(webpBuf), 'webp', 'avatar');
    const staticKey = contentKey(sha256Hex(jpgBuf), 'jpg', 'avatar');
    await putObject(animatedKey, webpBuf, 'image/webp');
    await putObject(staticKey, jpgBuf, 'image/jpeg');

    await updateTarget(job.target, { status: 'ready', staticKey, animatedKey });
    await deleteObject(job.raw_key);
  } catch (err) {
    // Failure → 'failed'; previous avatar keys are kept.
    await updateTarget(job.target, { status: 'failed' });
    await deleteObject(job.raw_key);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
