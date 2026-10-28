import argon2 from 'argon2';
import { eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ChangeEmailRequestSchema,
  DeactivateMeRequestSchema,
  DeleteMeRequestSchema,
  PROFILE_PUBLIC_RATE_PER_HOUR_PER_IP,
  SHARE_MEDIA_RATE_PER_HOUR_PER_IP,
  UpdateMeRequestSchema,
  USER_SEARCH_LIMIT,
  UserSearchQuerySchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import {
  avatarDto,
  coParticipantUserIds,
  publishUserUpdated,
  userHidden,
  userPrivateDto,
  userPublicDto,
  viewCtxFor,
} from '../../lib/dto.js';
import { ApiError, badRequest, conflict, notFound, rateLimited } from '../../lib/errors.js';
import { parseMultipart } from '../../lib/multipart.js';
import { profileHeroFor } from '../../lib/profileHero.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { streamObject } from '../sharepages/routes.js';
import { enqueueAvatar } from '../../queues.js';
import { authed, requireAuth } from '../auth/guard.js';
import { revokeAllSessions } from '../auth/service.js';
import { settingsDto } from '../settings/routes.js';
import { loadTrust } from '../listings/reviews.js';
import { loadProfile } from '../profiles/routes.js';
import { stashAvatarSource } from '../uploads/pipeline.js';

async function broadcastUserUpdated(userId: string): Promise<void> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!row) return;
  const peers = await coParticipantUserIds(userId);
  // §1.14: blocked co-members get the frame with last_seen_at clamped.
  await publishUserUpdated(row, peers);
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/api/users/me', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { user: userPrivateDto(user) };
  });

  // Wave 1 (AUDIT-PLAN §1.2, migration 0018) DELETE /api/users/me — password
  // re-proof, then the tombstone is SCHEDULED ACCOUNT_DELETION_GRACE_DAYS out
  // and every device signs out (this one included). Signing in again inside
  // the grace cancels it (auth/routes login); the nightly GC tombstones the
  // rest (lib/accountDeletion). Rate-limited like the password change.
  app.delete(
    '/api/users/me',
    { preHandler: requireAuth, schema: { body: DeleteMeRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`delme:${user.id}`, 5, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      if (user.isAdmin) throw badRequest('bad_admin_target'); // demote via CLI first (ADR-013)
      const ok = await argon2.verify(user.passwordHash, req.body.password);
      if (!ok) throw new ApiError(401, 'bad_credentials');
      const at = new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 24 * 3600 * 1000);
      await db
        .update(schema.users)
        .set({ scheduledDeletionAt: at, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await revokeAllSessions(user.id);
      req.log.warn({ userId: user.id, username: user.username }, 'account: deletion scheduled');
      return { scheduled_deletion_at: at.toISOString() };
    },
  );

  // Wave 1 leftovers (§1.2, migration 0020) POST /api/users/me/deactivate —
  // the pause: password re-proof, deactivated_at set, every device signed
  // out; hidden like a banned account meanwhile. Any later login reactivates
  // (createSession clears it) — no admin needed, no 403.
  app.post(
    '/api/users/me/deactivate',
    { preHandler: requireAuth, schema: { body: DeactivateMeRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`deact:${user.id}`, 5, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      if (user.isAdmin) throw badRequest('bad_admin_target');
      const ok = await argon2.verify(user.passwordHash, req.body.password);
      if (!ok) throw new ApiError(401, 'bad_credentials');
      await db
        .update(schema.users)
        .set({ deactivatedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await revokeAllSessions(user.id);
      await broadcastUserUpdated(user.id);
      req.log.info({ userId: user.id }, 'account: deactivated');
      return { ok: true as const };
    },
  );

  // Wave 1 (§1.2) PATCH /api/users/me/email — re-proof; the new address is
  // unverified until a mailer exists (§1.74). 409 email_taken like register.
  app.patch(
    '/api/users/me/email',
    { preHandler: requireAuth, schema: { body: ChangeEmailRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`chemail:${user.id}`, 5, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const ok = await argon2.verify(user.passwordHash, req.body.password);
      if (!ok) throw new ApiError(401, 'bad_credentials');
      let updated: typeof schema.users.$inferSelect | undefined;
      try {
        [updated] = await db
          .update(schema.users)
          .set({ email: req.body.email, emailVerifiedAt: null, updatedAt: new Date() })
          .where(eq(schema.users.id, user.id))
          .returning();
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('email_taken');
        throw err;
      }
      req.log.warn({ userId: user.id }, 'account: email changed');
      return { user: userPrivateDto(updated!) };
    },
  );

  // Wave 1 (§1.2) GET /api/users/me/export — my data as JSON: the users row
  // (secrets stripped), settings, profile, what I authored, the messages I
  // sent (bodies — they are mine), reviews about me. One per 10 min.
  app.get('/api/users/me/export', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    const rate = await fixedWindow(`export:${user.id}`, 2, 600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    const userRows = (await db.execute(sql`
      SELECT row_to_json(u.*) AS u FROM users u WHERE u.id = ${user.id} LIMIT 1
    `)) as unknown as { u: Record<string, unknown> }[];
    const {
      password_hash: _ph,
      totp_secret: _ts,
      totp_enabled_at: totpEnabledAt,
      registration_ip: _rip,
      ...userRow
    } = userRows[0]!.u;
    const rows = async (q: ReturnType<typeof sql>) =>
      ((await db.execute(q)) as unknown as { r: Record<string, unknown> }[]).map((x) => x.r);
    const posts = await rows(sql`SELECT row_to_json(p.*) AS r FROM posts p WHERE p.author_id = ${user.id} ORDER BY p.created_at DESC`);
    const listings = await rows(sql`SELECT row_to_json(l.*) AS r FROM listings l WHERE l.author_id = ${user.id} ORDER BY l.created_at DESC`);
    const beacons = await rows(sql`SELECT row_to_json(b.*) AS r FROM beacons b WHERE b.creator_id = ${user.id} ORDER BY b.created_at DESC`);
    const messages = await rows(sql`
      SELECT json_build_object('conversation_id', m.conversation_id, 'seq', m.seq, 'type', m.type,
        'body', m.body, 'created_at', m.created_at, 'deleted', m.deleted_at IS NOT NULL) AS r
      FROM messages m WHERE m.sender_id = ${user.id} ORDER BY m.created_at DESC LIMIT 50000`);
    // Reviews keep the §2.11 serialization rule: a blocked reviewer's words
    // never reach me, in the app or in the file.
    const blocked = [...(await blockedSetOf(user.id))];
    const reviews = await rows(sql`
      SELECT row_to_json(pr.*) AS r FROM person_reviews pr
      WHERE pr.subject_id = ${user.id}
        ${blocked.length ? sql`AND pr.reviewer_id NOT IN (${sql.join(blocked.map((b) => sql`${b}::uuid`), sql`, `)})` : sql``}
      ORDER BY pr.created_at DESC`);
    const profile = await loadProfile(user.id, user.interests);
    reply.header('content-disposition', `attachment; filename="bored-chat-${user.username}.json"`);
    return {
      exported_at: new Date().toISOString(),
      user: { ...userRow, totp_enabled: totpEnabledAt != null },
      settings: settingsDto(user) as unknown as Record<string, unknown>,
      profile: profile as unknown as Record<string, unknown>,
      posts,
      listings,
      beacons,
      messages,
      reviews_received: reviews,
    };
  });

  // Wave 1 (§1.8) POST /api/users/me/attest-age — the one-time consent sheet
  // for pre-0018 accounts before discovery / roulette (both 403
  // age_attestation_required until this lands). Idempotent.
  app.post('/api/users/me/attest-age', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const [updated] = await db
      .update(schema.users)
      .set({ ageAttestedAt: user.ageAttestedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .returning();
    return { user: userPrivateDto(updated!) };
  });

  app.patch(
    '/api/users/me',
    { preHandler: requireAuth, schema: { body: UpdateMeRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const patch: Partial<typeof schema.users.$inferInsert> = { updatedAt: new Date() };
      if (req.body.display_name !== undefined) patch.displayName = req.body.display_name;
      if (req.body.bio !== undefined) patch.bio = req.body.bio;
      if (req.body.avatar_motion !== undefined) patch.avatarMotion = req.body.avatar_motion;
      // v0.3 (§1.13): self-declared coarse area — identity, not a setting.
      // OWNER-PRIVATE (UserPrivate only, FEATURES #30); null clears it (and
      // with it all 'area' beacon visibility, both directions).
      if (req.body.area !== undefined) patch.area = req.body.area;
      // v0.8a (§1.58): animated-name style — identity, not privacy; rides the
      // same user.updated fan-out as display_name (CHECK-pinned set).
      if (req.body.name_style !== undefined) patch.nameStyle = req.body.name_style;
      const [updated] = await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, user.id))
        .returning();
      await broadcastUserUpdated(user.id);
      return { user: userPrivateDto(updated!) };
    },
  );

  // §1.2 avatar upload → 202, completion arrives as WS user.updated.
  app.post('/api/users/me/avatar', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    let stashed: { rawKey: string; mime: string } | null = null;
    await parseMultipart(
      req,
      async (fieldname, file, _info) => {
        if (fieldname !== 'file' || stashed) {
          file.resume();
          return;
        }
        stashed = await stashAvatarSource(file);
      },
      { maxFiles: 1 },
    );
    const result = stashed as { rawKey: string; mime: string } | null;
    if (!result) throw badRequest('missing_file');

    const [updated] = await db
      .update(schema.users)
      .set({ avatarStatus: 'processing', updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
      .returning();
    await enqueueAvatar({ target: { user_id: user.id }, raw_key: result.rawKey, mime: result.mime });
    return reply.status(202).send({ avatar: avatarDto(updated!) });
  });

  app.delete('/api/users/me/avatar', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const [updated] = await db
      .update(schema.users)
      .set({
        avatarStatus: 'none',
        avatarStaticKey: null,
        avatarAnimatedKey: null,
        avatarVersion: sql`${schema.users.avatarVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, user.id))
      .returning();
    await broadcastUserUpdated(user.id);
    return { avatar: avatarDto(updated!) };
  });

  // §1.2 user search — prefix ILIKE on username/display_name, limit 20.
  // §1.14: blocked pairs are excluded in BOTH directions (the blocker manages
  // the relationship from GET /api/users/me/blocks).
  app.get(
    '/api/users',
    { preHandler: requireAuth, schema: { querystring: UserSearchQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const q = req.query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      const blocked = await blockedSetOf(user.id);
      const rows = await db
        .select()
        .from(schema.users)
        .where(or(ilike(schema.users.username, `${q}%`), ilike(schema.users.displayName, `${q}%`)))
        .limit(USER_SEARCH_LIMIT + blocked.size);
      const ctx = await viewCtxFor(user);
      return {
        users: rows
          // §1.41: banned accounts are publicly invisible — search included.
          .filter((row) => !blocked.has(row.id) && !userHidden(row))
          .slice(0, USER_SEARCH_LIMIT)
          .map((row) => userPublicDto(row, ctx)),
      };
    },
  );

  app.get(
    '/api/users/:username',
    { preHandler: requireAuth, schema: { params: z.object({ username: z.string() }) } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!row) throw notFound('user_not_found');
      // §1.41: a banned account's profile 404s for everyone but its owner —
      // byte-identical to never existing (serialization-side; unban restores).
      if (row.id !== user.id && userHidden(row)) throw notFound('user_not_found');
      // §1.14: profile 404 in BOTH directions — identical to never existing.
      if (await isBlockedPair(user.id, row.id)) throw notFound('user_not_found');
      // v0.5a (§1.37): the profile page grows a `profile` sibling — additive;
      // UserPublic itself stays lean (it rides every participant list).
      // v0.5b (§1.40): + `trust` — count/avg over ALL reviews, recent minus
      // reviewers blocked w.r.t. the viewer (§2.11 serialization filtering).
      return {
        user: userPublicDto(row, await viewCtxFor(user)),
        profile: await loadProfile(row.id, row.interests),
        trust: await loadTrust(row.id, user.id),
      };
    },
  );

  // Phase 6 (AUDIT-PLAN §1b, 2026-10-28) GET /api/users/:username/public —
  // UNAUTHENTICATED: the logged-out /u/<username> hero (lib/profileHero —
  // the same builder as the profile share token), per-IP rate-limited like
  // the share reads. Unknown and banned answer ONE 404 user_not_found.
  // Blocks don't apply (nobody is signed in); a signed-in viewer never
  // reaches this (the /u/ route serves the authed page to a sid cookie).
  app.get(
    '/api/users/:username/public',
    { schema: { params: z.object({ username: z.string().min(1).max(64) }) } },
    async (req) => {
      const rate = await fixedWindow(`pubprof:${req.ip}`, PROFILE_PUBLIC_RATE_PER_HOUR_PER_IP, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!row || userHidden(row)) throw notFound('user_not_found');
      return { hero: profileHeroFor(row) };
    },
  );

  // GET /api/users/:username/public-avatar?v=static — the hero's avatar,
  // UNAUTHENTICATED (the §1.67 proxy posture: streamed, never a MinIO key;
  // `v=static` only — the animated WebP stays behind sign-in). Same 404 for
  // unknown, banned and no-avatar-yet. /api/media/:key stays authed.
  app.get(
    '/api/users/:username/public-avatar',
    {
      schema: {
        params: z.object({ username: z.string().min(1).max(64) }),
        querystring: z.object({ v: z.enum(['static']).default('static') }),
      },
    },
    async (req, reply) => {
      const rate = await fixedWindow(`pubav:${req.ip}`, SHARE_MEDIA_RATE_PER_HOUR_PER_IP, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!row || userHidden(row) || row.avatarStatus !== 'ready' || !row.avatarStaticKey) {
        throw notFound('user_not_found');
      }
      return streamObject(reply, row.avatarStaticKey, req.headers.range);
    },
  );
}
