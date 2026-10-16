// Invite links (v0.2 — API.md §1.11, ARCHITECTURE §9, ADR-007): mint / list /
// revoke (authed), public lookup + avatar proxy (UNAUTHENTICATED, per-IP
// rate-limited, token-shaped-or-404 — nothing beyond the status enum ever
// leaks), and the already-logged-in accept path.
import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateInviteRequestSchema,
  INVITE_AVATAR_CACHE_TTL_S,
  INVITE_AVATAR_RATE_PER_HOUR_PER_IP,
  INVITE_CREATE_RATE_PER_HOUR,
  INVITE_MAX_USES,
  INVITE_OPEN_MAX,
  INVITE_PUBLIC_RATE_PER_HOUR_PER_IP,
  INVITE_TOKEN_REGEX,
  INVITE_TTL_S,
  InviteAvatarQuerySchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { getObjectStream } from '../../s3.js';
import { authed, requireAuth } from '../auth/guard.js';
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

function requireTokenShape(token: string): void {
  if (!INVITE_TOKEN_REGEX.test(token)) throw notFound('invite_not_found');
}

async function loadInviteOr404(token: string): Promise<InviteRow> {
  requireTokenShape(token);
  const invite = await findInviteByToken(token);
  if (!invite) throw notFound('invite_not_found');
  return invite;
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
      const rate = await fixedWindow(`invitecreate:${user.id}`, INVITE_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const conversationId = req.body.conversation_id ?? null;
      if (conversationId) {
        // Error precedence per API.md §1.11: 404 (unknown / not-a-participant)
        // → 400 invite_bad_scope (a DM) → 403 forbidden (group, not admin).
        const [conv] = await db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, conversationId))
          .limit(1);
        if (!conv) throw notFound();
        const part = await getParticipant(conversationId, user.id);
        if (!part || part.leftAt !== null) throw notFound();
        if (conv.type !== 'group') throw badRequest('invite_bad_scope');
        if (part.role !== 'admin') throw forbidden();
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
      return reply.status(201).send({ invite: invitePrivateDto(row!) });
    },
  );

  // §1.11 GET /api/invites — mine, created_at DESC, capped at 100. Includes
  // revoked/expired rows so the list explains dead links.
  app.get('/api/invites', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.inviterId, user.id))
      .orderBy(desc(schema.invites.createdAt))
      .limit(100);
    return { invites: rows.map(invitePrivateDto) };
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
      if (invite.conversationId) {
        const [conv] = await db
          .select({ title: schema.conversations.title })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, invite.conversationId))
          .limit(1);
        groupTitle = conv?.title ?? null;
      }
      return { invite: invitePublicDto(invite, inviter, groupTitle) };
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
