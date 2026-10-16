import argon2 from 'argon2';
import { eq, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  INVITE_TOKEN_REGEX,
  LoginRequestSchema,
  RegisterRequestSchema,
  type SessionInfo,
} from '@socialchat/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { userPrivateDto } from '../../lib/dto.js';
import { ApiError, conflict, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { acceptInvite, findInviteByToken } from '../invites/service.js';
import { authed, requireAuth } from './guard.js';
import {
  ARGON2_OPTS,
  createSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './service.js';

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/api/auth/register', { schema: { body: RegisterRequestSchema } }, async (req, reply) => {
    const rate = await fixedWindow(`register:${req.ip}`, 3, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const { username, email, password, display_name } = req.body;

    const [existing] = await db
      .select({ username: schema.users.username, email: schema.users.email })
      .from(schema.users)
      .where(or(eq(schema.users.username, username), eq(schema.users.email, email)))
      .limit(1);
    if (existing) {
      throw conflict(existing.username.toLowerCase() === username.toLowerCase() ? 'username_taken' : 'email_taken');
    }

    const passwordHash = await argon2.hash(password, ARGON2_OPTS);
    let user: typeof schema.users.$inferSelect;
    try {
      const inserted = await db
        .insert(schema.users)
        .values({ id: newId(), username, email, passwordHash, displayName: display_name })
        .returning();
      user = inserted[0]!;
    } catch (err) {
      // Unique-violation race fallback.
      const pgErr = err as { code?: string; constraint_name?: string };
      if (pgErr.code === '23505') {
        throw conflict(String(pgErr.constraint_name ?? '').includes('email') ? 'email_taken' : 'username_taken');
      }
      throw err;
    }

    const { token } = await createSession(user.id, req.headers['user-agent'] ?? null, req.ip);
    setSessionCookie(reply, token);

    // v0.2 (API.md §1.11): register-with-token runs the invite accept AFTER
    // the user row + session commit. Registration NEVER fails on a bad,
    // expired, exhausted, revoked or MALFORMED invite — the account stands,
    // invite: null. The schema deliberately accepts invite_token loosely
    // (max-length only); the ADR-007 shape check lives here, where failing it
    // degrades instead of 400ing the whole registration.
    let invite: { conversation_id: string } | null = null;
    if (req.body.invite_token && INVITE_TOKEN_REGEX.test(req.body.invite_token)) {
      try {
        const row = await findInviteByToken(req.body.invite_token);
        if (row) invite = await acceptInvite(row, user.id);
      } catch (err) {
        req.log.info({ err }, 'register: invite accept failed, account created anyway');
        invite = null;
      }
    }
    return reply.status(201).send({ user: userPrivateDto(user), invite });
  });

  app.post('/api/auth/login', { schema: { body: LoginRequestSchema } }, async (req, reply) => {
    const rate = await fixedWindow(`login:${req.ip}`, 10, 60);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const { username_or_email, password } = req.body;

    const [user] = await db
      .select()
      .from(schema.users)
      .where(
        or(eq(schema.users.username, username_or_email), eq(schema.users.email, username_or_email)),
      )
      .limit(1);
    if (!user) throw new ApiError(401, 'bad_credentials');
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new ApiError(401, 'bad_credentials');

    const { token } = await createSession(user.id, req.headers['user-agent'] ?? null, req.ip);
    setSessionCookie(reply, token);
    return reply.status(200).send({ user: userPrivateDto(user) });
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const { session } = authed(req);
    await revokeSession(session.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const { session: current, user } = authed(req);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    const sessions: SessionInfo[] = rows.map((s) => ({
      id: s.id,
      user_agent: s.userAgent,
      ip: s.ip,
      created_at: s.createdAt.toISOString(),
      last_seen_at: s.lastSeenAt.toISOString(),
      current: s.id === current.id,
    }));
    return { sessions };
  });

  app.delete(
    '/api/auth/sessions/:id',
    { preHandler: requireAuth, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { user } = authed(req);
      const [row] = await db
        .select({ id: schema.sessions.id, userId: schema.sessions.userId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, req.params.id))
        .limit(1);
      if (!row || row.userId !== user.id) throw notFound('session_not_found');
      await revokeSession(req.params.id);
      return reply.status(204).send();
    },
  );
}
