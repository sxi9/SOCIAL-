// Recovery codes (v0.9 — API.md §1.72, ADR-021, FEATURES #84). Email-free
// account recovery: RECOVERY_CODES_COUNT one-time codes, shown ONCE (register
// / regenerate responses), stored sha256 (hashCode). Recovery is scorched
// earth by design: a consumed code revokes EVERY session (4401), notifies via
// the §1.69 Support conversation + push, and answers only a 15-minute
// reset_token — a new password is mandatory before any session exists.
// Recovery BYPASSES TOTP (it is the lost-authenticator path; TOTP stays
// armed afterward). All failures are one byte-identical 401 bad_recovery.
import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LEN,
  RECOVERY_CODES_COUNT,
  RECOVERY_LOGIN_RATE_PER_HOUR,
  ChangePasswordRequestSchema,
  RecoverRequestSchema,
  RegenerateRecoveryCodesRequestSchema,
  RESET_TOKEN_TTL_S,
  ResetPasswordRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { ApiError, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { redis } from '../../redis.js';
import { sendSupportMessage } from '../support/service.js';
import { authed, requireAuth } from './guard.js';
import { finishLogin } from './minting.js';
import { ARGON2_OPTS, hashCode, revokeAllSessions, revokeOtherSessions } from './service.js';

const resetTokenKey = (token: string) => `reset:${token}`;

/** The §1.1 invite_token doctrine: inputs arrive loose, normalization is
 *  route-side — lowercase, strip separators. A mangled paste fails
 *  verification, never validation. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '');
}

function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < RECOVERY_CODE_LEN; i++) {
    raw += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return raw;
}

/** Display form xxxxx-xxxxx (§1.72). */
function displayForm(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Delete the user's old set and insert RECOVERY_CODES_COUNT fresh codes in
 * one tx (regeneration INVALIDATES the old set — §1.72). Returns the display
 * forms, the only time they ever exist outside the caller's response.
 */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const raws = Array.from({ length: RECOVERY_CODES_COUNT }, () => newRecoveryCode());
  await db.transaction(async (tx) => {
    await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
    await tx.insert(schema.recoveryCodes).values(
      raws.map((raw) => ({ id: newId(), userId, codeHash: hashCode(raw) })),
    );
  });
  return raws.map(displayForm);
}

/** The atomic claim (§1.72 / the 0010 race rule): two racing attempts can
 *  never spend one code twice. */
export async function consumeRecoveryCode(userId: string, input: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length === 0) return false;
  const claimed = await db
    .update(schema.recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        eq(schema.recoveryCodes.codeHash, hashCode(normalized)),
        isNull(schema.recoveryCodes.usedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });
  return claimed.length > 0;
}

export async function recoveryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.72 GET /api/auth/recovery-codes — status only, NEVER the codes.
  app.get('/api/auth/recovery-codes', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE used_at IS NULL)::int AS remaining,
             max(created_at) AS generated_at
      FROM recovery_codes WHERE user_id = ${user.id}
    `)) as unknown as { total: number; remaining: number; generated_at: string | Date | null }[];
    const r = rows[0]!;
    return {
      total: r.total,
      remaining: r.remaining,
      generated_at: r.generated_at ? new Date(r.generated_at).toISOString() : null,
    };
  });

  // §1.72 POST /api/auth/recovery-codes — regenerate; re-proves the password
  // (a borrowed unlocked phone can't silently re-mint). Ring-logged, no codes
  // in the log.
  app.post(
    '/api/auth/recovery-codes',
    { preHandler: requireAuth, schema: { body: RegenerateRecoveryCodesRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`recovgen:${user.id}`, 5, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const ok = await argon2.verify(user.passwordHash, req.body.password);
      if (!ok) throw new ApiError(401, 'bad_credentials');
      const recovery_codes = await generateRecoveryCodes(user.id);
      req.log.warn(
        { userId: user.id, username: user.username },
        'auth: recovery codes regenerated',
      );
      return { recovery_codes };
    },
  );

  // §1.72 POST /api/auth/password — change password while signed in.
  // Re-proves the current password (same posture as recovery-codes: a
  // borrowed unlocked phone can't silently take the account), stores the new
  // argon2id hash, and signs out every OTHER device — this session stays, so
  // the user is not bounced to the login page by their own change.
  app.post(
    '/api/auth/password',
    { preHandler: requireAuth, schema: { body: ChangePasswordRequestSchema } },
    async (req) => {
      const { user, session } = authed(req);
      const rate = await fixedWindow(`chpw:${user.id}`, 5, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const ok = await argon2.verify(user.passwordHash, req.body.current_password);
      if (!ok) throw new ApiError(401, 'bad_credentials');
      if (req.body.current_password === req.body.new_password) {
        throw new ApiError(400, 'same_password');
      }
      const passwordHash = await argon2.hash(req.body.new_password, ARGON2_OPTS);
      await db
        .update(schema.users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await revokeOtherSessions(user.id, session.id);
      req.log.warn({ userId: user.id, username: user.username }, 'auth: password changed');
      return { ok: true as const };
    },
  );

  // §1.72 POST /api/auth/recover — unauthenticated, scorched earth. Every
  // failure (wrong code / unknown user / already used) is the same 401
  // bad_recovery, byte-identical (no enumeration).
  app.post('/api/auth/recover', { schema: { body: RecoverRequestSchema } }, async (req) => {
    const rate = await fixedWindow(`recover:${req.ip}`, RECOVERY_LOGIN_RATE_PER_HOUR, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const { username_or_email, code } = req.body;
    const [user] = await db
      .select()
      .from(schema.users)
      .where(
        or(eq(schema.users.username, username_or_email), eq(schema.users.email, username_or_email)),
      )
      .limit(1);
    if (!user || !(await consumeRecoveryCode(user.id, code))) {
      throw new ApiError(401, 'bad_recovery');
    }

    // Revoke ALL sessions (rows deleted, sockets 4401) — the common case for
    // recovery is "credentials compromised", not "forgot".
    await revokeAllSessions(user.id);

    // §1.69 Support-conversation notify + its ordinary push.
    await sendSupportMessage(
      user.id,
      "A recovery code was just used on your account. If this wasn't you, your other codes may be compromised — regenerate them after you're back in.",
      null,
    );

    req.log.warn({ userId: user.id, username: user.username }, 'auth: recovery code consumed');

    // NO session yet: recovery forces a new password first (one-shot Redis
    // reset_token, RESET_TOKEN_TTL_S).
    const token = randomBytes(32).toString('base64url');
    await redis.set(resetTokenKey(token), user.id, 'EX', RESET_TOKEN_TTL_S);
    return { reset_token: token };
  });

  // §1.72 POST /api/auth/reset-password — consumes the token, sets the
  // argon2id hash, mints the fresh session. Bypasses TOTP by design (the
  // lost-authenticator path); TOTP stays armed afterward.
  app.post(
    '/api/auth/reset-password',
    { schema: { body: ResetPasswordRequestSchema } },
    async (req, reply) => {
      const rate = await fixedWindow(`resetpw:${req.ip}`, 10, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      // One-shot claim — GETDEL so two racing resets can't both spend it.
      const userId = await redis.getdel(resetTokenKey(req.body.reset_token));
      if (!userId) throw new ApiError(401, 'bad_reset_token');
      const passwordHash = await argon2.hash(req.body.new_password, ARGON2_OPTS);
      const [user] = await db
        .update(schema.users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, userId))
        .returning();
      if (!user) throw new ApiError(401, 'bad_reset_token');
      // §1.1 account-state posture, defensive (their recovery already ran).
      if (user.bannedAt !== null) throw new ApiError(403, 'account_banned');
      if (user.suspendedAt !== null) throw new ApiError(403, 'account_suspended');
      return finishLogin(user, req, reply);
    },
  );
}
