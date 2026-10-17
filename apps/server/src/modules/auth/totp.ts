// TOTP 2FA (v0.9 — API.md §1.73, ADR-021, FEATURES #85). RFC 6238 by hand
// (lib/totp.ts); the secret lives AES-256-GCM-encrypted in users.totp_secret
// (lib/secretbox.ts, HKDF info 'totp:'). Setup is a PENDING secret in Redis —
// nothing touches the users row until a valid code proves the authenticator
// holds it. A verified step is burned in Redis so one code never
// authenticates twice. The half-login (§1.1/§1.70 → totp_token → here) mints
// the standard session only after the code checks out.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_ISSUER,
  TOTP_PERIOD_S,
  TOTP_SECRET_BYTES,
  TOTP_SETUP_TTL_S,
  TOTP_VERIFY_RATE_PER_MIN,
  TotpEnableRequestSchema,
  TotpDisableRequestSchema,
  TotpVerifyRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { publishToUsers } from '../../ws/events.js';
import { userPrivateDto, userPublicDto } from '../../lib/dto.js';
import { ApiError, badRequest, conflict, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { openSecret, sealSecret } from '../../lib/secretbox.js';
import { base32Encode, base32Decode, groupedManualKey, verifyTotp } from '../../lib/totp.js';
import { redis } from '../../redis.js';
import { consumeRecoveryCode } from './recovery.js';
import { authed, requireAuth } from './guard.js';
import { finishLogin, totpTokenKey } from './minting.js';
import type { UserRow } from './service.js';

const pendingKey = (userId: string) => `totp:pending:${userId}`;
const usedStepKey = (userId: string, step: number) => `totp:used:${userId}:${step}`;
// A burned step must outlive the drift window around it: period × (2·drift+1).
const USED_STEP_TTL_S = TOTP_PERIOD_S * (2 * TOTP_DRIFT_STEPS + 1);

/** Verify AND burn: the matched step is claimed atomically (SET NX) so the
 *  same code can never authenticate twice — a replay inside the window
 *  answers exactly like a wrong code. */
async function verifyAndBurn(userId: string, secret: Buffer, code: string): Promise<boolean> {
  const step = verifyTotp(secret, code);
  if (step === null) return false;
  const claimed = await redis.set(usedStepKey(userId, step), '1', 'EX', USED_STEP_TTL_S, 'NX');
  return claimed === 'OK';
}

/** Fan user.updated after arming/disarming; the OWNER's frame additionally
 *  carries totp_enabled (§1.73 — the settings row flips without a refetch). */
async function fanTotpChanged(user: UserRow): Promise<void> {
  const owner = { ...userPublicDto(user), totp_enabled: user.totpEnabledAt !== null };
  await publishToUsers([user.id], { t: 'user.updated', d: { user: owner } });
}

export async function totpRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.73 POST /api/auth/totp/setup — a PENDING secret (Redis, TTL); re-call
  // replaces it. The QR renders CLIENT-side (the §1.71 hand-rolled encoder);
  // manual_key is ALWAYS shown + copyable.
  app.post('/api/auth/totp/setup', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    if (user.totpSecret !== null) throw conflict('totp_enabled');
    const b32 = base32Encode(randomBytes(TOTP_SECRET_BYTES));
    await redis.set(pendingKey(user.id), b32, 'EX', TOTP_SETUP_TTL_S);
    const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(user.username)}`;
    const otpauth_uri =
      `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(TOTP_ISSUER)}` +
      `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
    return {
      otpauth_uri,
      manual_key: groupedManualKey(b32),
      expires_at: new Date(Date.now() + TOTP_SETUP_TTL_S * 1000).toISOString(),
    };
  });

  // §1.73 POST /api/auth/totp/enable — verifies against the PENDING secret,
  // then writes both columns in one update (the 0011 shape CHECK moves them
  // together). Wrong code → pending survives until TTL.
  app.post(
    '/api/auth/totp/enable',
    { preHandler: requireAuth, schema: { body: TotpEnableRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      if (user.totpSecret !== null) throw conflict('totp_enabled');
      const b32 = await redis.get(pendingKey(user.id));
      const secret = b32 ? base32Decode(b32) : null;
      if (!b32 || !secret) throw badRequest('bad_totp_code');
      if (!(await verifyAndBurn(user.id, secret, req.body.code))) {
        throw badRequest('bad_totp_code');
      }
      const [updated] = await db
        .update(schema.users)
        .set({
          totpSecret: sealSecret('totp:', b32),
          totpEnabledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id))
        .returning();
      await redis.del(pendingKey(user.id));
      await fanTotpChanged(updated!);
      return { user: userPrivateDto(updated!) };
    },
  );

  // §1.73 POST /api/auth/totp — unauthenticated: the second half of a
  // TOTP-gated password/passkey login. Wrong code burns attempt budget
  // (per token AND per IP); token expiry/consumption → start the login over.
  app.post('/api/auth/totp', { schema: { body: TotpVerifyRequestSchema } }, async (req, reply) => {
    const ipRate = await fixedWindow(`totpverify:${req.ip}`, TOTP_VERIFY_RATE_PER_MIN, 60);
    if (!ipRate.allowed) throw rateLimited(ipRate.retryAfterS);
    const tokRate = await fixedWindow(
      `totptok:${req.body.totp_token}`,
      TOTP_VERIFY_RATE_PER_MIN,
      60,
    );
    if (!tokRate.allowed) throw rateLimited(tokRate.retryAfterS);

    const userId = await redis.get(totpTokenKey(req.body.totp_token));
    if (!userId) throw new ApiError(401, 'bad_totp_token');
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    // TOTP disarmed (or SESSION_SECRET rotated — ADR-021's documented
    // orphaning) mid-login: the half-login can't finish; recovery codes are
    // the way back in.
    const b32 = user?.totpSecret ? openSecret('totp:', user.totpSecret) : null;
    const secret = b32 ? base32Decode(b32) : null;
    if (!user || !secret) throw new ApiError(401, 'bad_totp_token');

    if (!(await verifyAndBurn(user.id, secret, req.body.code))) {
      throw new ApiError(401, 'bad_totp_code');
    }
    // One-shot consume AFTER the code checks out (wrong codes keep the token
    // alive inside its attempt budget). GETDEL: racing corrects mint once.
    const claimed = await redis.getdel(totpTokenKey(req.body.totp_token));
    if (!claimed) throw new ApiError(401, 'bad_totp_token');
    // §1.1 account-state posture (checked after proof, leaks only to owner).
    if (user.bannedAt !== null) throw new ApiError(403, 'account_banned');
    if (user.suspendedAt !== null) throw new ApiError(403, 'account_suspended');
    return finishLogin(user, req, reply);
  });

  // §1.73 POST /api/auth/totp/disable — proof required: the current code, or
  // one recovery code (CONSUMED — the §1.72 atomic claim). Ring-logged.
  app.post(
    '/api/auth/totp/disable',
    { preHandler: requireAuth, schema: { body: TotpDisableRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      if (req.body.code !== undefined) {
        const b32 = user.totpSecret ? openSecret('totp:', user.totpSecret) : null;
        const secret = b32 ? base32Decode(b32) : null;
        if (!secret || !(await verifyAndBurn(user.id, secret, req.body.code))) {
          throw badRequest('bad_totp_code');
        }
      } else {
        if (!(await consumeRecoveryCode(user.id, req.body.recovery_code!))) {
          throw new ApiError(401, 'bad_recovery');
        }
      }
      const [updated] = await db
        .update(schema.users)
        .set({ totpSecret: null, totpEnabledAt: null, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id))
        .returning();
      req.log.warn({ userId: user.id, username: user.username }, 'auth: TOTP disabled');
      await fanTotpChanged(updated!);
      return { user: userPrivateDto(updated!) };
    },
  );
}
