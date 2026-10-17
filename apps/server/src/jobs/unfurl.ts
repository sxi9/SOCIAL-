// Unfurl worker (ARCHITECTURE §6). SSRF protection is non-negotiable and all
// of it lives here, never in the API process:
//   * schemes http/https only; ports 80/443 only
//   * own DNS resolve; reject if ANY A/AAAA answer is private/reserved,
//     IPv4-mapped IPv6 unwrapped and re-checked against the v4 list
//   * connect to the pinned resolved IP (undici lookup override), Host/SNI
//     stay the original hostname — closes the DNS-rebinding TOCTOU
//   * max 3 redirects, every hop re-runs the checklist; 5 s budget; 1 MB HTML
//   * og:image re-encoded with sharp (600px WebP) into MinIO, never hotlinked
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as cheerio from 'cheerio';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { Agent, request as undiciRequest } from 'undici';
import {
  PREVIEW_FAILED_TTL_S,
  PREVIEW_OK_TTL_S,
  UNFURL_BUDGET_MS,
  UNFURL_IMAGE_WIDTH_PX,
  UNFURL_MAX_HTML_BYTES,
  UNFURL_MAX_IMAGE_BYTES,
  UNFURL_MAX_REDIRECTS,
} from '@socialchat/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { contentKey, sha256Hex } from '../lib/media.js';
import { publishMessageUpdated } from '../modules/messages/service.js';
import { previewDto, takePreviewWaiters } from '../modules/previews/service.js';
import type { UnfurlJob } from '../queues.js';
import { putObject } from '../s3.js';
import { publishToUsers } from '../ws/events.js';

// --------------------------- address screening ------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
];

export function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  for (const [base, bits] of V4_BLOCKED) {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (b & mask)) return true;
  }
  return false;
}

/** RFC 4291 text form → 16 bytes, or null when unparseable. */
export function ipv6ToBytes(raw: string): Uint8Array | null {
  const ip = raw.split('%')[0]!;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const left = parseGroups(halves[0]!);
  if (left === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const right = parseGroups(halves[1]!);
    if (right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<number>(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

export function isBlockedV6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true;
  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10
  // IPv4-mapped (::ffff:a.b.c.d): unwrap and re-check against the v4 list.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  return family === 4 ? isBlockedV4(address) : isBlockedV6(address);
}

interface Pinned {
  address: string;
  family: 4 | 6;
}

async function resolvePinned(hostname: string): Promise<Pinned> {
  const literal = isIP(hostname);
  if (literal === 4 || literal === 6) {
    if (isBlockedAddress(hostname, literal)) throw new Error('blocked address');
    return { address: hostname, family: literal };
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error('no dns answers');
  for (const a of answers) {
    if (isBlockedAddress(a.address, a.family)) throw new Error('blocked dns answer');
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family as 4 | 6 };
}

// ------------------------------ guarded fetch -------------------------------

const USER_AGENT = `BoredChatBot/1.0 (+https://${config.domain})`;

interface FetchResult {
  contentType: string;
  body: Buffer;
  finalUrl: URL;
}

async function guardedFetch(
  startUrl: string,
  deadlineAt: number,
  maxBytes: number,
  mode: 'html' | 'image',
): Promise<FetchResult> {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= UNFURL_MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('blocked scheme');
    }
    const port = current.port ? Number(current.port) : current.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) throw new Error('blocked port');

    const pinned = await resolvePinned(current.hostname);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('budget exhausted');

    const pinnedLookup = (
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      if (options && options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new Agent({ connect: { lookup: pinnedLookup as any, timeout: remaining } });
    try {
      const res = await undiciRequest(current, {
        dispatcher: agent,
        method: 'GET',
        maxRedirections: 0,
        headers: {
          'user-agent': USER_AGENT,
          accept: mode === 'html' ? 'text/html,application/xhtml+xml' : 'image/*,*/*;q=0.8',
        },
        headersTimeout: remaining,
        bodyTimeout: remaining,
        signal: AbortSignal.timeout(remaining),
      });

      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers['location'];
        const location = Array.isArray(loc) ? loc[0] : loc;
        await res.body.dump();
        if (!location) throw new Error('redirect without location');
        current = new URL(location, current);
        continue; // next hop re-runs the full checklist
      }
      if (res.statusCode !== 200) {
        // Consume the body before throwing: an orphaned undici body later
        // fires its bodyTimeout abort as an unhandled 'error' on the
        // BodyReadable, crashing the whole worker process.
        await res.body.dump();
        throw new Error(`status ${res.statusCode}`);
      }

      const contentType = String(res.headers['content-type'] ?? '');
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        if (size + buf.length > maxBytes) {
          if (mode === 'html') {
            chunks.push(buf.subarray(0, maxBytes - size));
            truncated = true;
            break; // parse what we have
          }
          throw new Error('body too large');
        }
        chunks.push(buf);
        size += buf.length;
      }
      if (truncated) res.body.destroy();
      return { contentType, body: Buffer.concat(chunks), finalUrl: current };
    } finally {
      await agent.close().catch(() => agent.destroy());
    }
  }
  throw new Error('too many redirects');
}

// --------------------------------- parsing ----------------------------------

interface ParsedCard {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

function clip(v: string | undefined, max: number): string | null {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
}

export function parseHtmlCard(html: string): ParsedCard {
  const $ = cheerio.load(html);
  const og = (p: string) =>
    $(`meta[property="og:${p}"]`).attr('content') ?? $(`meta[name="og:${p}"]`).attr('content');
  const tw = (n: string) =>
    $(`meta[name="twitter:${n}"]`).attr('content') ?? $(`meta[property="twitter:${n}"]`).attr('content');
  return {
    title: clip(og('title') ?? tw('title') ?? $('title').first().text(), 300),
    description:
      clip(og('description') ?? tw('description') ?? $('meta[name="description"]').attr('content'), 500),
    siteName: clip(og('site_name'), 100),
    imageUrl: clip(og('image') ?? og('image:url') ?? tw('image'), 2000),
  };
}

// ----------------------------------- job -------------------------------------

export async function processUnfurlJob(job: UnfurlJob): Promise<void> {
  const deadlineAt = Date.now() + UNFURL_BUDGET_MS;
  const now = new Date();
  let ok = false;

  try {
    const res = await guardedFetch(job.url, deadlineAt, UNFURL_MAX_HTML_BYTES, 'html');
    // Content-Type: text/html required for parsing.
    if (!res.contentType.toLowerCase().includes('text/html')) throw new Error('not html');
    const card = parseHtmlCard(res.body.toString('utf8'));
    if (!card.title && !card.description && !card.siteName) throw new Error('nothing to preview');

    let imageKey: string | null = null;
    if (card.imageUrl) {
      try {
        const imgUrl = new URL(card.imageUrl, res.finalUrl).toString();
        const img = await guardedFetch(imgUrl, deadlineAt, UNFURL_MAX_IMAGE_BYTES, 'image');
        // Re-encoding discards decompression-bomb/polyglot tricks.
        const webp = await sharp(img.body)
          .resize({ width: UNFURL_IMAGE_WIDTH_PX, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        imageKey = contentKey(sha256Hex(webp), 'webp', 'preview');
        await putObject(imageKey, webp, 'image/webp');
      } catch {
        imageKey = null; // card ships without an image
      }
    }

    await db
      .update(schema.linkPreviews)
      .set({
        status: 'ok',
        siteName: card.siteName,
        title: card.title,
        description: card.description,
        imageKey,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + PREVIEW_OK_TTL_S * 1000),
      })
      .where(eq(schema.linkPreviews.urlHash, job.url_hash));
    ok = true;
  } catch {
    // Negative-cache failures for 1 h — stops retry storms.
    await db
      .update(schema.linkPreviews)
      .set({
        status: 'failed',
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + PREVIEW_FAILED_TTL_S * 1000),
      })
      .where(eq(schema.linkPreviews.urlHash, job.url_hash));
  }

  const [row] = await db
    .select()
    .from(schema.linkPreviews)
    .where(eq(schema.linkPreviews.urlHash, job.url_hash))
    .limit(1);

  // Every requester answered 'pending' while the fetch was in flight gets the
  // event, not only the one whose request enqueued the job (API.md §1.7).
  const waiters = await takePreviewWaiters(job.url_hash);
  await publishToUsers([...new Set([job.requested_by, ...waiters])], {
    t: 'preview.ready',
    d: {
      url_hash: job.url_hash,
      status: ok ? 'ok' : 'failed',
      ...(ok && row ? { preview: previewDto(row) } : {}),
    },
  });

  // Message-bound unfurl: snapshot the card into the message (if it still has
  // none) and hydrate recipients via msg.updated.
  if (ok && row && job.message) {
    const snapshot = JSON.stringify(previewDto(row));
    const updated = (await db.execute(sql`
      UPDATE messages
      SET metadata = jsonb_set(metadata, '{link_preview}', ${snapshot}::jsonb)
      WHERE id = ${job.message.id} AND metadata->'link_preview' IS NULL
      RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length > 0) {
      // v0.8b (§1.68): route through publishMessageUpdated so 👻 ghost
      // conversations mask the sender per recipient class — fanning the raw
      // DTO here would deanonymize link senders on preview hydration.
      const [msg] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, job.message.id))
        .limit(1);
      if (msg) await publishMessageUpdated(msg);
    }
  }
}
