// Invite links (v0.2 — API.md §1.11, ARCHITECTURE §9, ADR-007): mint / list /
// revoke (authed), public lookup + avatar proxy (UNAUTHENTICATED, per-IP
// rate-limited, token-shaped-or-404 — nothing beyond the status enum ever
// leaks), and the already-logged-in accept path.
import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import sharp from 'sharp';
import {
  CreateInviteRequestSchema,
  INVITE_AVATAR_CACHE_TTL_S,
  INVITE_AVATAR_RATE_PER_HOUR_PER_IP,
  INVITE_CREATE_RATE_PER_HOUR,
  INVITE_MAX_USES,
  INVITE_OG_RATE_PER_HOUR_PER_IP,
  INVITE_OPEN_MAX,
  INVITE_PUBLIC_RATE_PER_HOUR_PER_IP,
  INVITE_TOKEN_REGEX,
  INVITE_TTL_S,
  InviteAvatarQuerySchema,
  OG_BANNER_AVATAR_PX,
  OG_BANNER_HEIGHT_PX,
  OG_BANNER_WIDTH_PX,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { redis } from '../../redis.js';
import { getObjectBuffer, getObjectStream } from '../../s3.js';
import { authed, requireAuth } from '../auth/guard.js';
import { invitesEnabled } from '../admin/service.js';
import { getParticipant } from '../conversations/routes.js';
import {
  acceptInvite,
  findInviteByToken,
  invitePrivateDto,
  invitePublicDto,
  inviteStatus,
  newInviteToken,
  type InviteRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
// Loose shape at the router; the ADR-007 regex is applied by hand below so a
// malformed token answers 404 invite_not_found like an unknown one (the public
// endpoints never explain themselves beyond the status enum).
const TokenParams = z.object({ token: z.string().min(1).max(256) });

/** v0.5a (§1.35): invite kind from the scoped conversation's type. */
function inviteKindOf(
  conversationId: string | null,
  convType: string | null | undefined,
): 'dm' | 'group' | 'channel' {
  if (!conversationId) return 'dm';
  return convType === 'channel' ? 'channel' : 'group';
}

function requireTokenShape(token: string): void {
  if (!INVITE_TOKEN_REGEX.test(token)) throw notFound('invite_not_found');
}

async function loadInviteOr404(token: string): Promise<InviteRow> {
  requireTokenShape(token);
  const invite = await findInviteByToken(token);
  if (!invite) throw notFound('invite_not_found');
  return invite;
}

// ---------------------------------------------------------------------------
// v0.7 §1.53 — the OG banner. Everything is composed IN-PROCESS: gradient,
// mascot and text are inline SVG rendered by sharp; no fonts, images or
// services are fetched at request time (golden rule 7).
// ---------------------------------------------------------------------------

/** display_name is user input entering SVG markup — ALWAYS escaped (§1.53). */
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

/** The mascot blob fallback — the card is good with or without an avatar. */
function mascotSvg(size: number): Buffer {
  const s = size;
  return Buffer.from(`<svg width="${s}" height="${s}" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg">
  <circle cx="160" cy="160" r="156" fill="#ffffff" fill-opacity="0.92"/>
  <path d="M160 52c62 0 112 44 112 106 0 64-50 110-112 110S48 222 48 158C48 96 98 52 160 52z" fill="#6f8cff"/>
  <circle cx="122" cy="150" r="20" fill="#ffffff"/>
  <circle cx="198" cy="150" r="20" fill="#ffffff"/>
  <circle cx="126" cy="154" r="9" fill="#1d2440"/>
  <circle cx="202" cy="154" r="9" fill="#1d2440"/>
  <path d="M128 208q32 26 64 0" stroke="#1d2440" stroke-width="10" stroke-linecap="round" fill="none"/>
</svg>`);
}

/** 1200×630 sharp composition: brand gradient → avatar/mascot circle → text. */
async function composeOgBanner(inviter: {
  displayName: string;
  avatarStatus: string;
  avatarStaticKey: string | null;
}): Promise<Buffer> {
  const W = OG_BANNER_WIDTH_PX;
  const H = OG_BANNER_HEIGHT_PX;
  const A = OG_BANNER_AVATAR_PX;

  const background = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f6fff"/>
      <stop offset="0.55" stop-color="#6f8cff"/>
      <stop offset="1" stop-color="#8f7bff"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="90" cy="560" r="180" fill="#ffffff" fill-opacity="0.08"/>
  <circle cx="1130" cy="80" r="220" fill="#ffffff" fill-opacity="0.08"/>
  <circle cx="${W / 2}" cy="${90 + A / 2}" r="${A / 2 + 12}" fill="#ffffff" fill-opacity="0.35"/>
</svg>`);

  // Avatar circle: the static rendition when ready, else the mascot blob.
  let face: Buffer | null = null;
  if (inviter.avatarStatus === 'ready' && inviter.avatarStaticKey) {
    try {
      const raw = await getObjectBuffer(inviter.avatarStaticKey);
      const square = await sharp(raw).resize(A, A, { fit: 'cover' }).png().toBuffer();
      const mask = Buffer.from(
        `<svg width="${A}" height="${A}"><circle cx="${A / 2}" cy="${A / 2}" r="${A / 2}" fill="#fff"/></svg>`,
      );
      face = await sharp(square)
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    } catch {
      face = null; // storage hiccup → the mascot keeps the card good
    }
  }
  if (!face) {
    face = await sharp(mascotSvg(A)).resize(A, A).png().toBuffer();
  }

  const name = escapeXml(inviter.displayName);
  const textLayer = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <text x="${W / 2}" y="500" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif"
        font-size="56" font-weight="700" fill="#ffffff">${name}</text>
  <text x="${W / 2}" y="562" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif"
        font-size="38" fill="#ffffff" fill-opacity="0.9">invited you to Bored Chat</text>
</svg>`);

  return sharp(background)
    .composite([
      { input: face, top: 90, left: Math.round((W - A) / 2) },
      { input: textLayer, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

export async function inviteRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.11 POST /api/invites — mint. Omitted conversation_id = DM-with-inviter;
  // set = group invite (minter must be an ADMIN of that group, matching §1.4).
  app.post(
    '/api/invites',
    { preHandler: requireAuth, schema: { body: CreateInviteRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      // v0.5b (§1.41): instance-wide invite switch — mint refuses outright.
      if (!(await invitesEnabled())) throw forbidden('invites_disabled');
      // §1.13 invites_paused: minting is paused along with accepts.
      if (user.invitesPaused) throw forbidden('invites_paused');
      const rate = await fixedWindow(`invitecreate:${user.id}`, INVITE_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const conversationId = req.body.conversation_id ?? null;
      let scopeKind: 'dm' | 'group' | 'channel' = 'dm';
      if (conversationId) {
        // Error precedence per API.md §1.11: 404 (unknown / not-a-participant)
        // → 400 invite_bad_scope (a DM) → 403 forbidden (not privileged).
        // v0.5a §1.35: channel invites are owner/admin-minted (membership
        // arrives ONLY through invites — there is no direct-add for channels).
        const [conv] = await db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, conversationId))
          .limit(1);
        if (!conv) throw notFound();
        const part = await getParticipant(conversationId, user.id);
        if (!part || part.leftAt !== null) throw notFound();
        if (conv.type === 'dm') throw badRequest('invite_bad_scope');
        if (conv.type === 'group' && part.role !== 'admin') throw forbidden();
        if (conv.type === 'channel' && part.role !== 'owner' && part.role !== 'admin') {
          throw forbidden();
        }
        scopeKind = conv.type as 'group' | 'channel';
      }

      // Cap simultaneously OPEN invites per user (revoke or let one lapse to
      // mint more) — keeps one account from carpeting the internet in links.
      const openRows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM invites
        WHERE inviter_id = ${user.id}
          AND revoked_at IS NULL
          AND expires_at > now()
          AND use_count < max_uses
      `)) as unknown as { n: number }[];
      if ((openRows[0]?.n ?? 0) >= INVITE_OPEN_MAX) throw conflict('invite_limit');

      const [row] = await db
        .insert(schema.invites)
        .values({
          id: newId(),
          token: newInviteToken(),
          inviterId: user.id,
          conversationId,
          expiresAt: new Date(Date.now() + INVITE_TTL_S * 1000),
          maxUses: INVITE_MAX_USES,
        })
        .returning();
      return reply.status(201).send({ invite: invitePrivateDto(row!, scopeKind) });
    },
  );

  // §1.11 GET /api/invites — mine, created_at DESC, capped at 100. Includes
  // revoked/expired rows so the list explains dead links.
  app.get('/api/invites', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select({ invite: schema.invites, convType: schema.conversations.type })
      .from(schema.invites)
      .leftJoin(schema.conversations, eq(schema.invites.conversationId, schema.conversations.id))
      .where(eq(schema.invites.inviterId, user.id))
      .orderBy(desc(schema.invites.createdAt))
      .limit(100);
    return {
      invites: rows.map(({ invite, convType }) =>
        invitePrivateDto(invite, inviteKindOf(invite.conversationId, convType)),
      ),
    };
  });

  // §1.11 DELETE /api/invites/:id — revoke; idempotent re-revoke is also 204.
  app.delete(
    '/api/invites/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const rows = (await db.execute(sql`
        UPDATE invites SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = ${req.params.id} AND inviter_id = ${user.id}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (rows.length === 0) throw notFound(); // not mine / unknown
      return reply.status(204).send();
    },
  );

  // §1.11 GET /api/invites/:token/public — UNAUTHENTICATED join-page data.
  // 200 for any existing token whatever its status (the page renders
  // expired/revoked states by name); 404 invite_not_found otherwise.
  app.get(
    '/api/invites/:token/public',
    { schema: { params: TokenParams } },
    async (req) => {
      const rate = await fixedWindow(
        `invitepub:${req.ip}`,
        INVITE_PUBLIC_RATE_PER_HOUR_PER_IP,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const invite = await loadInviteOr404(req.params.token);
      const [inviter] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, invite.inviterId))
        .limit(1);
      if (!inviter) throw notFound('invite_not_found');

      let groupTitle: string | null = null;
      let convType: string | null = null;
      if (invite.conversationId) {
        const [conv] = await db
          .select({ title: schema.conversations.title, type: schema.conversations.type })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, invite.conversationId))
          .limit(1);
        groupTitle = conv?.title ?? null;
        convType = conv?.type ?? null;
      }
      return {
        invite: invitePublicDto(
          invite,
          inviter,
          groupTitle,
          inviteKindOf(invite.conversationId, convType),
        ),
      };
    },
  );

  // §1.11 GET /api/invites/:token/avatar?v=static|animated — UNAUTHENTICATED
  // streaming proxy of the inviter's avatar. The token itself is the
  // capability: valid-gated (revocation instantly kills it), 404 unless the
  // inviter's avatar is 'ready', never exposes MinIO keys. `ver` is accepted
  // and ignored (Zod strips unknown query keys).
  app.get(
    '/api/invites/:token/avatar',
    { schema: { params: TokenParams, querystring: InviteAvatarQuerySchema } },
    async (req, reply) => {
      const rate = await fixedWindow(
        `inviteav:${req.ip}`,
        INVITE_AVATAR_RATE_PER_HOUR_PER_IP,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const invite = await loadInviteOr404(req.params.token);
      if (inviteStatus(invite) !== 'valid') throw notFound();
      const [inviter] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, invite.inviterId))
        .limit(1);
      if (!inviter || inviter.avatarStatus !== 'ready') throw notFound();

      // static = the JPEG fallback rendition (what OG unfurlers render);
      // animated = the WebP, falling back to static when absent.
      const key =
        req.query.v === 'animated'
          ? (inviter.avatarAnimatedKey ?? inviter.avatarStaticKey)
          : inviter.avatarStaticKey;
      if (!key) throw notFound();

      let obj;
      try {
        obj = await getObjectStream(key, req.headers.range);
      } catch {
        throw notFound();
      }
      // Short private TTL: avatar_version can move while the token lives
      // (ARCHITECTURE §9).
      reply.header('cache-control', `private, max-age=${INVITE_AVATAR_CACHE_TTL_S}`);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('accept-ranges', 'bytes');
      if (obj.contentLength !== undefined) reply.header('content-length', String(obj.contentLength));
      if (obj.contentRange) {
        reply.status(206);
        reply.header('content-range', obj.contentRange);
      }
      reply.header('content-type', obj.contentType ?? 'application/octet-stream');
      return reply.send(obj.body);
    },
  );

  // v0.7 §1.53 GET /api/invites/:token/og-banner.png — UNAUTHENTICATED, the
  // join page's unfurl face: sharp-composed 1200×630 (gradient → avatar circle
  // or mascot fallback → XML-escaped display-name overlay). Valid-token-gated
  // exactly like the avatar proxy (revocation kills it within the cache TTL);
  // ETag keyed on avatar_version so unfurler re-scrapes revalidate after an
  // avatar change. The composed PNG is memoized in Redis per (token,
  // avatar_version) with the same TTL. Optional `v` cache-buster is accepted
  // and ignored (no querystring schema binds it).
  app.get(
    '/api/invites/:token/og-banner.png',
    { schema: { params: TokenParams } },
    async (req, reply) => {
      const rate = await fixedWindow(`inviteog:${req.ip}`, INVITE_OG_RATE_PER_HOUR_PER_IP, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const invite = await loadInviteOr404(req.params.token);
      if (inviteStatus(invite) !== 'valid') throw notFound();
      const [inviter] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, invite.inviterId))
        .limit(1);
      if (!inviter) throw notFound();

      const etag = `"${inviter.avatarVersion}"`;
      reply.header('cache-control', `private, max-age=${INVITE_AVATAR_CACHE_TTL_S}`);
      reply.header('etag', etag);
      reply.header('x-content-type-options', 'nosniff');
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();

      const memoKey = `ogbanner:${invite.token}:${inviter.avatarVersion}`;
      let png: Buffer | null = null;
      try {
        png = await redis.getBuffer(memoKey);
      } catch {
        png = null; // memo is best-effort only
      }
      if (!png) {
        png = await composeOgBanner(inviter);
        try {
          await redis.set(memoKey, png, 'EX', INVITE_AVATAR_CACHE_TTL_S);
        } catch {
          // best-effort memo
        }
      }
      reply.header('content-type', 'image/png');
      reply.header('content-length', String(png.length));
      return reply.send(png);
    },
  );

  // §1.11 POST /api/invites/:token/accept — the already-logged-in join path.
  app.post(
    '/api/invites/:token/accept',
    { preHandler: requireAuth, schema: { params: TokenParams } },
    async (req) => {
      const { user } = authed(req);
      const invite = await loadInviteOr404(req.params.token);
      return acceptInvite(invite, user.id); // 200 {conversation_id}
    },
  );
}
