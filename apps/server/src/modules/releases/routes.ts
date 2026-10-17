// Discoverability release markers (v0.8a — API.md §1.61, ADR-018, FEATURES
// #80). The instance's shipped releases live in instance_settings key
// 'release_notes' (seeded by migration 0009, appended by future release
// migrations, curable via the §1.41 admin PATCH); the per-user cursor is
// users.last_seen_release. Cards are informational, never engagement bait:
// no badges, no re-surfacing — the client dismisses once and POSTs here.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ReleaseNoteSchema,
  ReleaseSeenRequestSchema,
  type ReleaseNote,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { authed, requireAuth } from '../auth/guard.js';

/** The release list, newest first, Zod-validated (a malformed blob serves []
 * rather than 500ing every client's what's-new read). */
export async function loadReleaseNotes(): Promise<ReleaseNote[]> {
  const [row] = await db
    .select()
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, 'release_notes'))
    .limit(1);
  const parsed = z.array(ReleaseNoteSchema).safeParse(row?.value ?? []);
  return parsed.success ? parsed.data : [];
}

/** §1.61: register stamps the newest version at signup so day-one users
 * never get a card storm. */
export async function newestReleaseVersion(): Promise<string | null> {
  const notes = await loadReleaseNotes();
  return notes[0]?.version ?? null;
}

export async function releaseRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.61 GET /api/releases — the shipped releases + MY cursor.
  app.get('/api/releases', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return {
      releases: await loadReleaseNotes(),
      last_seen_release: user.lastSeenRelease,
    };
  });

  // §1.61 POST /api/releases/seen — moves my cursor (idempotent).
  app.post(
    '/api/releases/seen',
    { preHandler: requireAuth, schema: { body: ReleaseSeenRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      await db
        .update(schema.users)
        .set({ lastSeenRelease: req.body.version, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      return reply.status(204).send();
    },
  );
}
