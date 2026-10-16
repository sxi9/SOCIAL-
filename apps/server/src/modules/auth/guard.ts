import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthenticated } from '../../lib/errors.js';
import { authenticateToken, SESSION_COOKIE, type AuthContext } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  const auth = token ? await authenticateToken(token) : null;
  if (!auth) throw unauthenticated();
  req.auth = auth;
}

/** Narrowing accessor — only valid behind requireAuth. */
export function authed(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
