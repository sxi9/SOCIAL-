// Public share pages — routes (v0.8b — API.md §1.67, FEATURES #79c, ADR-020).
// Mint/revoke are authed; the page read, the token-gated media/avatar proxies
// and the non-user report are UNAUTHENTICATED, per-IP rate-limited, and
// byte-identical 404 share_not_found for every failure cause. No open media
// routes exist — /api/media/:key stays authed; everything here is gated by
// the token AND a live ownership + publicness re-check.
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateShareLinkRequestSchema,
  SHARE_MEDIA_CACHE_TTL_S,
  SHARE_MEDIA_RATE_PER_HOUR_PER_IP,
  SHARE_PUBLIC_RATE_PER_HOUR_PER_IP,
  SHARE_REPORT_RATE_PER_DAY_PER_IP,
  SHARE_TOKEN_REGEX,
  SharePageReportRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { isFriendOf } from '../../lib/friends.js';
import { badRequest, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { getObjectStream } from '../../s3.js';
import { authed, requireAuth } from '../auth/guard.js';
import { hasJoin, isBeaconVisibleTo, loadBeacon } from '../beacons/service.js';
import {
  loadOpenTokenByToken,
  mintOrReturnToken,
  resolveSharePage,
  revokeShareTokensFor,
  shareLinkDto,
  type ShareTokenRow,
} from './service.js';

const TokenParams = z.object({ token: z.string().min(1).max(256) });

function requireTokenShape(token: string): void {
  if (!SHARE_TOKEN_REGEX.test(token)) throw notFound('share_not_found');
}

async function loadLiveToken(token: string): Promise<ShareTokenRow> {
  requireTokenShape(token);
  const row = await loadOpenTokenByToken(token);
  if (!row) throw notFound('share_not_found');
  return row;
}

/** Stream one MinIO object with the share-page cache posture. */
async function streamObject(reply: FastifyReply, key: string, range?: string) {
  let obj;
  try {
    obj = await getObjectStream(key, range);
  } catch {
    throw notFound('share_not_found');
  }
  reply.header('cache-control', `private, max-age=${SHARE_MEDIA_CACHE_TTL_S}`);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('accept-ranges', 'bytes');
  if (obj.contentLength !== undefined) reply.header('content-length', String(obj.contentLength));
  if (obj.contentRange) {
    reply.status(206);
    reply.header('content-range', obj.contentRange);
  }
  reply.header('content-type', obj.contentType ?? 'application/octet-stream');
  return reply.send(obj.body);
}

export async function sharePageRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.67 POST /api/share-links — mint-or-return the object's ONE open token.
  // Authorization order per type: invisible → 404 (the §1.14 shape); visible
  // but not public → 400 not_public; story → author only; group → admin of a
  // public|invite_only group.
  app.post(
    '/api/share-links',
    { preHandler: requireAuth, schema: { body: CreateShareLinkRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const { type, id } = req.body;

      if (type === 'post') {
        const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
        if (!post) throw notFound('not_found');
        const mine = post.authorId === user.id;
        if (!mine) {
          const [author] = await db
            .select({ bannedAt: schema.users.bannedAt })
            .from(schema.users)
            .where(eq(schema.users.id, post.authorId))
            .limit(1);
          const blocked = await isBlockedPair(user.id, post.authorId);
          const visible =
            !blocked &&
            author?.bannedAt === null &&
            (post.audience === 'public' || (await isFriendOf(user.id, post.authorId)));
          if (!visible) throw notFound('not_found');
        }
        if (post.audience !== 'public') throw badRequest('not_public');
      } else if (type === 'beacon') {
        const beacon = await loadBeacon(id);
        if (!beacon) throw notFound('not_found');
        const visible =
          beacon.creatorId === user.id ||
          (await isBeaconVisibleTo(beacon, user)) ||
          (await hasJoin(beacon.id, user.id));
        if (!visible) throw notFound('not_found');
        if (beacon.audience !== 'public') throw badRequest('not_public');
      } else if (type === 'listing') {
        const [l] = await db.select().from(schema.listings).where(eq(schema.listings.id, id)).limit(1);
        if (!l) throw notFound('not_found');
        if (l.authorId !== user.id) {
          const [author] = await db
            .select({ bannedAt: schema.users.bannedAt })
            .from(schema.users)
            .where(eq(schema.users.id, l.authorId))
            .limit(1);
          if (author?.bannedAt !== null || (await isBlockedPair(user.id, l.authorId))) {
            throw notFound('not_found');
          }
        }
        if (!l.isPublic) throw badRequest('not_public');
      } else if (type === 'story') {
        // "Create share link" is the AUTHOR's act — 404 for everyone else.
        const [s] = await db.select().from(schema.stories).where(eq(schema.stories.id, id)).limit(1);
        if (!s || s.authorId !== user.id || s.expiresAt.getTime() <= Date.now()) {
          throw notFound('not_found');
        }
      } else {
        // group — owner/admin of a public|invite_only group.
        const [c] = await db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, id))
          .limit(1);
        if (!c) throw notFound('not_found');
        const [part] = await db
          .select()
          .from(schema.conversationParticipants)
          .where(
            and(
              eq(schema.conversationParticipants.conversationId, id),
              eq(schema.conversationParticipants.userId, user.id),
            ),
          )
          .limit(1);
        if (!part || part.leftAt !== null) throw notFound('not_found');
        if (c.type !== 'group') throw badRequest('not_public');
        if (part.role !== 'admin') throw forbidden();
        if (c.visibility !== 'public' && c.visibility !== 'invite_only') {
          throw badRequest('not_public');
        }
      }

      const row = await mintOrReturnToken(type, id, user.id);
      return { share_link: shareLinkDto(row) };
    },
  );

  // §1.67 DELETE /api/share-links/:token — revoke (idempotent 204): object
  // author, the group's admins, or a §1.41 admin. The page and every gated
  // media URL die instantly.
  app.delete(
    '/api/share-links/:token',
    { preHandler: requireAuth, schema: { params: TokenParams } },
    async (req, reply) => {
      const { user } = authed(req);
      requireTokenShape(req.params.token);
      const [row] = await db
        .select()
        .from(schema.shareTokens)
        .where(eq(schema.shareTokens.token, req.params.token))
        .limit(1);
      if (!row) throw notFound('not_found');

      let allowed = user.isAdmin || row.createdBy === user.id;
      if (!allowed) {
        if (row.objectType === 'post') {
          const [p] = await db
            .select({ authorId: schema.posts.authorId })
            .from(schema.posts)
            .where(eq(schema.posts.id, row.objectId))
            .limit(1);
          allowed = p?.authorId === user.id;
        } else if (row.objectType === 'beacon') {
          const [b] = await db
            .select({ creatorId: schema.beacons.creatorId })
            .from(schema.beacons)
            .where(eq(schema.beacons.id, row.objectId))
            .limit(1);
          allowed = b?.creatorId === user.id;
        } else if (row.objectType === 'listing') {
          const [l] = await db
            .select({ authorId: schema.listings.authorId })
            .from(schema.listings)
            .where(eq(schema.listings.id, row.objectId))
            .limit(1);
          allowed = l?.authorId === user.id;
        } else if (row.objectType === 'story') {
          const [s] = await db
            .select({ authorId: schema.stories.authorId })
            .from(schema.stories)
            .where(eq(schema.stories.id, row.objectId))
            .limit(1);
          allowed = s?.authorId === user.id;
        } else {
          const [part] = await db
            .select()
            .from(schema.conversationParticipants)
            .where(
              and(
                eq(schema.conversationParticipants.conversationId, row.objectId),
                eq(schema.conversationParticipants.userId, user.id),
              ),
            )
            .limit(1);
          allowed = part?.role === 'admin' && part.leftAt === null;
        }
      }
      if (!allowed) throw notFound('not_found');
      await revokeShareTokensFor(db, row.objectType, row.objectId);
      return reply.status(204).send();
    },
  );

  // §1.67 GET /api/share/:token/public — UNAUTHENTICATED. Live checks every
  // read; 404 share_not_found byte-identical for every cause.
  app.get(
    '/api/share/:token/public',
    {
      schema: {
        params: TokenParams,
        querystring: z.object({ cursor: z.coerce.number().int().positive().optional() }),
      },
    },
    async (req) => {
      const rate = await fixedWindow(
        `sharepub:${req.ip}`,
        SHARE_PUBLIC_RATE_PER_HOUR_PER_IP,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const row = await loadLiveToken(req.params.token);
      const page = await resolveSharePage(row, req.query.cursor);
      if (!page) throw notFound('share_not_found');
      return { page };
    },
  );

  // §1.67 GET /api/share/:token/media/:attachmentId — the token-gated media
  // proxy (the §1.11 invite-avatar pattern): serves the attachment IFF the
  // valid token's object owns it, live-checked. Anything else 404.
  app.get(
    '/api/share/:token/media/:attachmentId',
    {
      schema: {
        params: TokenParams.extend({ attachmentId: z.string().uuid() }),
        querystring: z.object({ variant: z.enum(['original', 'thumb']).default('original') }),
      },
    },
    async (req, reply) => {
      const rate = await fixedWindow(
        `sharemedia:${req.ip}`,
        SHARE_MEDIA_RATE_PER_HOUR_PER_IP,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const row = await loadLiveToken(req.params.token);
      // The object must still resolve publicly (live re-check)…
      const page = await resolveSharePage(row);
      if (!page) throw notFound('share_not_found');
      // …and must OWN this attachment.
      const [att] = await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, req.params.attachmentId))
        .limit(1);
      if (!att) throw notFound('share_not_found');
      let owns = false;
      if (row.objectType === 'post') owns = att.postId === row.objectId;
      else if (row.objectType === 'listing') owns = att.listingId === row.objectId;
      else if (row.objectType === 'story') {
        const [s] = await db
          .select({ attachmentId: schema.stories.attachmentId })
          .from(schema.stories)
          .where(eq(schema.stories.id, row.objectId))
          .limit(1);
        owns = s?.attachmentId === att.id;
      } else if (row.objectType === 'group' && page.type === 'group_live' && att.messageId) {
        // A public-group message attachment with seq > public_since_seq only.
        const owned = (await db.execute(sql`
          SELECT 1 AS one FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ${att.messageId}
            AND m.conversation_id = ${row.objectId}
            AND m.deleted_at IS NULL
            AND c.visibility = 'public'
            AND m.seq > c.public_since_seq
          LIMIT 1
        `)) as unknown as { one: number }[];
        owns = owned.length > 0;
      }
      if (!owns) throw notFound('share_not_found');
      const key = req.query.variant === 'thumb' ? (att.thumbKey ?? att.originalKey) : att.originalKey;
      return streamObject(reply, key, req.headers.range);
    },
  );

  // §1.67 GET /api/share/:token/avatar/:userId — the author/sender avatar
  // proxy, token-gated the same way. For a group page, :userId may be the
  // conversation id itself (the group's avatar).
  app.get(
    '/api/share/:token/avatar/:userId',
    {
      schema: {
        params: TokenParams.extend({ userId: z.string().uuid() }),
        querystring: z.object({ v: z.enum(['static', 'animated']).default('static') }),
      },
    },
    async (req, reply) => {
      const rate = await fixedWindow(
        `shareav:${req.ip}`,
        SHARE_MEDIA_RATE_PER_HOUR_PER_IP,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const row = await loadLiveToken(req.params.token);
      const page = await resolveSharePage(row);
      if (!page) throw notFound('share_not_found');

      const uid = req.params.userId;
      let allowed = false;
      if (row.objectType === 'group') {
        if (uid === row.objectId) {
          // The group's own avatar.
          const [c] = await db
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, row.objectId))
            .limit(1);
          if (!c || c.avatarStatus !== 'ready') throw notFound('share_not_found');
          const key =
            req.query.v === 'animated'
              ? (c.avatarAnimatedKey ?? c.avatarStaticKey)
              : c.avatarStaticKey;
          if (!key) throw notFound('share_not_found');
          return streamObject(reply, key, req.headers.range);
        }
        // A rendered PUBLIC message's sender only (live tail pages).
        if (page.type === 'group_live') {
          const sent = (await db.execute(sql`
            SELECT 1 AS one FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ${row.objectId}
              AND m.sender_id = ${uid}
              AND m.deleted_at IS NULL
              AND c.visibility = 'public'
              AND m.seq > c.public_since_seq
            LIMIT 1
          `)) as unknown as { one: number }[];
          allowed = sent.length > 0;
        }
      } else {
        // The page's author only.
        const authorId = await objectAuthorId(row);
        allowed = authorId === uid;
      }
      if (!allowed) throw notFound('share_not_found');

      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid)).limit(1);
      if (!u || u.avatarStatus !== 'ready') throw notFound('share_not_found');
      const key =
        req.query.v === 'animated' ? (u.avatarAnimatedKey ?? u.avatarStaticKey) : u.avatarStaticKey;
      if (!key) throw notFound('share_not_found');
      return streamObject(reply, key, req.headers.range);
    },
  );

  // §1.67 POST /api/share/:token/report — the NON-USER report: reporter_id
  // NULL + reporter_ip (aged by the retention GC), kind 'share_page', reason
  // REQUIRED. Hard per-IP day budget. Unknown/revoked token → the same 404.
  app.post(
    '/api/share/:token/report',
    { schema: { params: TokenParams, body: SharePageReportRequestSchema } },
    async (req, reply) => {
      const rate = await fixedWindow(
        `sharereport:${req.ip}`,
        SHARE_REPORT_RATE_PER_DAY_PER_IP,
        86_400,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const row = await loadLiveToken(req.params.token);
      const authorId = await objectAuthorId(row);
      await db.insert(schema.reports).values({
        id: newId(),
        reporterId: null,
        kind: 'share_page',
        reason: req.body.reason,
        targetObjectType: row.objectType,
        targetObjectId: row.objectId,
        // The author snapshot — the admin queue resolves it to a UserLite.
        targetUserId: authorId,
        reporterIp: req.ip,
      });
      return reply.status(204).send();
    },
  );
}

/** The object's author/owner id (group → null: a group has no single author). */
async function objectAuthorId(row: ShareTokenRow): Promise<string | null> {
  switch (row.objectType) {
    case 'post': {
      const [p] = await db
        .select({ authorId: schema.posts.authorId })
        .from(schema.posts)
        .where(eq(schema.posts.id, row.objectId))
        .limit(1);
      return p?.authorId ?? null;
    }
    case 'beacon': {
      const [b] = await db
        .select({ creatorId: schema.beacons.creatorId })
        .from(schema.beacons)
        .where(eq(schema.beacons.id, row.objectId))
        .limit(1);
      return b?.creatorId ?? null;
    }
    case 'listing': {
      const [l] = await db
        .select({ authorId: schema.listings.authorId })
        .from(schema.listings)
        .where(eq(schema.listings.id, row.objectId))
        .limit(1);
      return l?.authorId ?? null;
    }
    case 'story': {
      const [s] = await db
        .select({ authorId: schema.stories.authorId })
        .from(schema.stories)
        .where(eq(schema.stories.id, row.objectId))
        .limit(1);
      return s?.authorId ?? null;
    }
    default:
      return null;
  }
}
