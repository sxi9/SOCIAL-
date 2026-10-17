// Rich profiles (v0.5a — API.md §1.37, FEATURES #47). Profile depth rides the
// PROFILE PAGE, not the participant DTOs: UserPublic stays lean; the page
// read is GET /api/users/:username (users module) + the owner reads/writes
// here. No endorsement counts, no connection counts, no profile view counters
// — a profile is a page about a person, not a scoreboard (PSYCHOLOGY rule 3).
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { UpdateProfileRequestSchema, type Profile } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { attachmentDto } from '../../lib/dto.js';
import { badRequest } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';

export async function loadProfile(userId: string, interests: string[]): Promise<Profile> {
  const entries = await db
    .select()
    .from(schema.profileEntries)
    .where(eq(schema.profileEntries.userId, userId))
    .orderBy(asc(schema.profileEntries.orderIdx));
  const media = await db
    .select({ a: schema.attachments, orderIdx: schema.profileMedia.orderIdx })
    .from(schema.profileMedia)
    .innerJoin(schema.attachments, eq(schema.profileMedia.attachmentId, schema.attachments.id))
    .where(eq(schema.profileMedia.userId, userId))
    .orderBy(asc(schema.profileMedia.orderIdx));
  return {
    interests,
    entries: entries.map((e) => ({
      id: e.id,
      kind: e.kind as Profile['entries'][number]['kind'],
      title: e.title,
      detail: e.detail,
    })),
    media: media.map((m) => attachmentDto(m.a)),
  };
}

export async function profileRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.37 GET /api/users/me/profile — the settings screen's read.
  app.get('/api/users/me/profile', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { profile: await loadProfile(user.id, user.interests) };
  });

  // §1.37 PATCH /api/users/me/profile — FULL REPLACE per present field, one
  // transaction (delete + insert, order_idx = array order); omitted fields
  // untouched. Profile edits fan NOTHING (profiles are pulled).
  app.patch(
    '/api/users/me/profile',
    { preHandler: requireAuth, schema: { body: UpdateProfileRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const body = req.body;

      await db.transaction(async (tx) => {
        if (body.interests !== undefined) {
          await tx
            .update(schema.users)
            .set({ interests: body.interests, updatedAt: new Date() })
            .where(eq(schema.users.id, user.id));
        }
        if (body.entries !== undefined) {
          await tx.delete(schema.profileEntries).where(eq(schema.profileEntries.userId, user.id));
          if (body.entries.length > 0) {
            await tx.insert(schema.profileEntries).values(
              body.entries.map((e, i) => ({
                id: newId(),
                userId: user.id,
                kind: e.kind,
                title: e.title,
                detail: e.detail,
                orderIdx: i,
              })),
            );
          }
        }
        if (body.media_attachment_ids !== undefined) {
          const ids = body.media_attachment_ids;
          if (new Set(ids).size !== ids.length) throw badRequest('bad_attachment');
          if (ids.length > 0) {
            // Mine, kind image, ready, and not bound elsewhere (already being
            // my profile media is fine — the set is replaced below).
            const ok = (await tx.execute(sql`
              SELECT count(*)::int AS n FROM attachments a
              WHERE a.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
                AND a.uploader_id = ${user.id}
                AND a.kind = 'image'
                AND a.status = 'ready'
                AND a.message_id IS NULL
                AND a.scheduled_message_id IS NULL
                AND a.post_id IS NULL
                AND a.listing_id IS NULL
                AND a.comment_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = a.id)
                AND NOT EXISTS (
                  SELECT 1 FROM profile_media pm
                  WHERE pm.attachment_id = a.id AND pm.user_id <> ${user.id})
            `)) as unknown as { n: number }[];
            if ((ok[0]?.n ?? 0) !== ids.length) throw badRequest('bad_attachment');
          }
          // Replaced media unbinds — orphan GC reaps the rows later; objects
          // stay refcount-guarded (§1.31).
          await tx.delete(schema.profileMedia).where(eq(schema.profileMedia.userId, user.id));
          if (ids.length > 0) {
            await tx.insert(schema.profileMedia).values(
              ids.map((attachmentId, i) => ({
                userId: user.id,
                attachmentId,
                orderIdx: i,
              })),
            );
          }
        }
      });

      const [fresh] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .limit(1);
      return { profile: await loadProfile(user.id, fresh?.interests ?? user.interests) };
    },
  );
}
