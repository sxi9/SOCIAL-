// v0.9 (ADR-021): the ONE place every login path ends. Password (§1.1),
// passkey (§1.70), QR link poll (§1.71) and recovery reset (§1.72) all mint
// the exact same ADR-001 session row + httpOnly sid cookie through here; the
// §1.73 TOTP gate also lives here, BEFORE minting — the session layer never
// learns about factors. Half-login totp_token is Redis TTL state, one-shot.
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TOTP_TOKEN_TTL_S, type TotpChallenge } from '@socialchat/shared';
import { config } from '../../config.js';
import { userPrivateDto } from '../../lib/dto.js';
import { redis } from '../../redis.js';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS, type UserRow } from './service.js';

/** Fixer r1 (moved here in v0.9): never let a non-IP X-Forwarded-For value
 *  reach an `inet` column — store NULL instead. */
export function storableIp(ip: string | undefined): string | null {
  return ip && isIP(ip) !== 0 ? ip : null;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export const totpTokenKey = (token: string) => `totp:token:${token}`;

/** Mint the standard §1.1 session (UA/IP captured from THIS request) and
 *  answer {user} + Set-Cookie. */
export async function finishLogin(
  user: UserRow,
  req: FastifyRequest,
  reply: FastifyReply,
  status = 200,
): Promise<FastifyReply> {
  const { token } = await createSession(
    user.id,
    req.headers['user-agent'] ?? null,
    storableIp(req.ip),
  );
  // createSession cancelled a pending deletion / reactivated a pause — the
  // DTO reflects it.
  user.scheduledDeletionAt = null;
  user.deactivatedAt = null;
  setSessionCookie(reply, token);
  return reply.status(status).send({ user: userPrivateDto(user) });
}

/**
 * The §1.73 LoginOutcome: a TOTP-armed account gets {totp_required,
 * totp_token} — NO session, NO cookie — and finishes at POST /api/auth/totp;
 * everyone else gets the session now. The token reveals nothing (random ref
 * to a Redis row holding the user id, TOTP_TOKEN_TTL_S).
 */
export async function loginOutcome(
  user: UserRow,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (user.totpSecret !== null) {
    const token = randomBytes(32).toString('base64url');
    await redis.set(totpTokenKey(token), user.id, 'EX', TOTP_TOKEN_TTL_S);
    const challenge: TotpChallenge = { totp_required: true, totp_token: token };
    return reply.status(200).send(challenge);
  }
  return finishLogin(user, req, reply);
}
