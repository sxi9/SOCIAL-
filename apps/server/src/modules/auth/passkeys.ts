// Passkeys (v0.9 — API.md §1.70, ADR-021, FEATURES #82). WebAuthn register +
// login; a verified assertion mints the EXACT same opaque-token sid session a
// password login mints (minting.ts) — passkeys only change how a session
// starts. Anti-enumeration doctrine: an unknown username answers the same 200
// with empty allowCredentials as a user with no passkeys; every login failure
// is one 401 bad_credentials. A signature counter LOWER than stored is a
// cloned-credential signal: refuse + ring-log (level warn).
import { randomBytes } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  PASSKEY_LOGIN_RATE_PER_MIN,
  PASSKEYS_MAX,
  PasskeyLoginOptionsRequestSchema,
  PasskeyLoginRequestSchema,
  PasskeyRegisterRequestSchema,
  RenamePasskeyRequestSchema,
  type PasskeyInfo,
} from '@socialchat/shared';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { ApiError, badRequest, conflict, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from './guard.js';
import { loginOutcome } from './minting.js';
import {
  expectedOrigins,
  RP_NAME,
  rpId,
  storeAuthChallenge,
  storeRegistrationChallenge,
  takeAuthChallenge,
  takeRegistrationChallenge,
  webauthnLib,
} from './webauthn.js';

type PasskeyRow = typeof schema.passkeyCredentials.$inferSelect;

/** §1.70: settings-UI material only — never the public key or counter. */
function passkeyDto(row: PasskeyRow): PasskeyInfo {
  return {
    id: row.id,
    nickname: row.nickname,
    transports: row.transports,
    device_type: row.deviceType as PasskeyInfo['device_type'],
    backed_up: row.backedUp,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

const IdParams = z.object({ id: z.string().uuid() });

export async function passkeyRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.70 POST /api/auth/passkeys/options — registration options (authed).
  app.post('/api/auth/passkeys/options', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const { generateRegistrationOptions } = await webauthnLib();
    const mine = await db
      .select()
      .from(schema.passkeyCredentials)
      .where(eq(schema.passkeyCredentials.userId, user.id));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId(),
      userName: user.username,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: mine.map((c) => ({
        id: c.credentialId,
        transports: c.transports as NonNullable<
          Parameters<typeof generateRegistrationOptions>[0]['excludeCredentials']
        >[number]['transports'],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await storeRegistrationChallenge(user.id, options.challenge);
    return { options };
  });

  // §1.70 POST /api/auth/passkeys — verify + insert, cap under the advisory
  // lock (the 0010 counter-race rule — never check-then-insert).
  app.post(
    '/api/auth/passkeys',
    { preHandler: requireAuth, schema: { body: PasskeyRegisterRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const challenge = await takeRegistrationChallenge(user.id);
      if (!challenge) throw badRequest('bad_passkey');
      const { verifyRegistrationResponse } = await webauthnLib();
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: req.body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins(),
          expectedRPID: rpId(),
          requireUserVerification: false,
        });
      } catch (err) {
        req.log.warn({ err, userId: user.id }, 'passkey: registration verification failed');
        throw badRequest('bad_passkey');
      }
      const info = verification.registrationInfo;
      if (!verification.verified || !info) throw badRequest('bad_passkey');

      const row: PasskeyRow = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}::text, 82))`,
        );
        const countRows = (await tx.execute(
          sql`SELECT count(*)::int AS n FROM passkey_credentials WHERE user_id = ${user.id}`,
        )) as unknown as { n: number }[];
        if ((countRows[0]?.n ?? 0) >= PASSKEYS_MAX) throw conflict('passkeys_cap');
        try {
          const inserted = await tx
            .insert(schema.passkeyCredentials)
            .values({
              id: newId(),
              userId: user.id,
              credentialId: info.credential.id,
              publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
              counter: info.credential.counter,
              transports: info.credential.transports ?? [],
              deviceType: info.credentialDeviceType,
              backedUp: info.credentialBackedUp,
              nickname: req.body.nickname ?? null,
            })
            .returning();
          return inserted[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw conflict('passkey_exists');
          throw err;
        }
      });
      return reply.status(201).send({ passkey: passkeyDto(row) });
    },
  );

  // §1.70 GET /api/auth/passkeys — created_at ASC.
  app.get('/api/auth/passkeys', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select()
      .from(schema.passkeyCredentials)
      .where(eq(schema.passkeyCredentials.userId, user.id))
      .orderBy(asc(schema.passkeyCredentials.createdAt));
    return { passkeys: rows.map(passkeyDto) };
  });

  // §1.70 PATCH /api/auth/passkeys/:id — nickname. 404 if not mine.
  app.patch(
    '/api/auth/passkeys/:id',
    { preHandler: requireAuth, schema: { params: IdParams, body: RenamePasskeyRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db
        .update(schema.passkeyCredentials)
        .set({ nickname: req.body.nickname })
        .where(
          sql`${schema.passkeyCredentials.id} = ${req.params.id} AND ${schema.passkeyCredentials.userId} = ${user.id}`,
        )
        .returning();
      if (!row) throw notFound();
      return { passkey: passkeyDto(row) };
    },
  );

  // §1.70 DELETE /api/auth/passkeys/:id — deleting the last one is fine, the
  // password always remains. 404 if not mine.
  app.delete(
    '/api/auth/passkeys/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const deleted = await db
        .delete(schema.passkeyCredentials)
        .where(
          sql`${schema.passkeyCredentials.id} = ${req.params.id} AND ${schema.passkeyCredentials.userId} = ${user.id}`,
        )
        .returning({ id: schema.passkeyCredentials.id });
      if (deleted.length === 0) throw notFound();
      return reply.status(204).send();
    },
  );

  // §1.70 POST /api/auth/passkey-login/options — unauthenticated. Unknown
  // username = same 200 with empty allowCredentials (never an oracle).
  app.post(
    '/api/auth/passkey-login/options',
    { schema: { body: PasskeyLoginOptionsRequestSchema } },
    async (req) => {
      const rate = await fixedWindow(`pkopts:${req.ip}`, PASSKEY_LOGIN_RATE_PER_MIN, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const { generateAuthenticationOptions } = await webauthnLib();
      let allowCredentials: { id: string; transports?: PasskeyRow['transports'] }[] = [];
      if (req.body.username) {
        const [user] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, req.body.username))
          .limit(1);
        if (user) {
          const rows = await db
            .select()
            .from(schema.passkeyCredentials)
            .where(eq(schema.passkeyCredentials.userId, user.id));
          allowCredentials = rows.map((c) => ({ id: c.credentialId, transports: c.transports }));
        }
      }
      const options = await generateAuthenticationOptions({
        rpID: rpId(),
        userVerification: 'preferred',
        allowCredentials: allowCredentials as NonNullable<
          Parameters<typeof generateAuthenticationOptions>[0]['allowCredentials']
        >,
      });
      const challenge_ref = randomBytes(16).toString('base64url');
      await storeAuthChallenge(challenge_ref, options.challenge);
      return { challenge_ref, options };
    },
  );

  // §1.70 POST /api/auth/passkey-login — LoginOutcome: {user} + cookie, or
  // the §1.73 TOTP challenge. EVERY failure is the same 401 bad_credentials.
  app.post(
    '/api/auth/passkey-login',
    { schema: { body: PasskeyLoginRequestSchema } },
    async (req, reply) => {
      const rate = await fixedWindow(`pklogin:${req.ip}`, PASSKEY_LOGIN_RATE_PER_MIN, 60);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const fail = () => new ApiError(401, 'bad_credentials');

      const challenge = await takeAuthChallenge(req.body.challenge_ref);
      if (!challenge) throw fail();
      const credentialId = (req.body.response as { id?: unknown }).id;
      if (typeof credentialId !== 'string' || credentialId.length === 0) throw fail();
      const [cred] = await db
        .select()
        .from(schema.passkeyCredentials)
        .where(eq(schema.passkeyCredentials.credentialId, credentialId))
        .limit(1);
      if (!cred) throw fail();

      const { verifyAuthenticationResponse } = await webauthnLib();
      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response: req.body.response as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins(),
          expectedRPID: rpId(),
          credential: {
            id: cred.credentialId,
            publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
            counter: cred.counter,
            transports: cred.transports as NonNullable<
              Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports']
            >,
          },
          requireUserVerification: false,
        });
      } catch (err) {
        // The library throws on counter regression too — the cloned-
        // credential signal. Ring-logged (warn) either way, same 401 out.
        req.log.warn({ err, credentialId }, 'passkey: login verification failed');
        throw fail();
      }
      if (!verification.verified) throw fail();
      const newCounter = verification.authenticationInfo.newCounter;
      // Defensive double-check of the clone signal (§1.70: LOWER than stored).
      if (newCounter < cred.counter) {
        req.log.warn(
          { credentialId, stored: cred.counter, got: newCounter },
          'passkey: signature counter went backwards — possible cloned credential',
        );
        throw fail();
      }
      // v0.9.2 (auth-audit minor 1): the row read above is stale by now, so
      // the write is conditional — two concurrent assertions can never leave
      // the stored counter LOWER than the highest one proven. A row that
      // moved past us means a newer assertion already landed: refuse this
      // one like any other regression.
      const [advanced] = await db
        .update(schema.passkeyCredentials)
        .set({ counter: newCounter, lastUsedAt: new Date() })
        .where(
          sql`${schema.passkeyCredentials.id} = ${cred.id} AND ${schema.passkeyCredentials.counter} <= ${newCounter}`,
        )
        .returning({ id: schema.passkeyCredentials.id });
      if (!advanced) {
        req.log.warn({ credentialId, got: newCounter }, 'passkey: counter raced a newer assertion');
        throw fail();
      }

      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, cred.userId))
        .limit(1);
      if (!user) throw fail();
      // §1.1 account-state posture, after the proof.
      if (user.bannedAt !== null) throw new ApiError(403, 'account_banned');
      if (user.suspendedAt !== null) throw new ApiError(403, 'account_suspended');
      return loginOutcome(user, req, reply);
    },
  );
}
