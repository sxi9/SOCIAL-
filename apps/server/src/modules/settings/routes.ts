// Privacy settings (v0.3 — API.md §1.13, ADR-009). Settings are columns on
// users (the avatar_motion pattern: one row read on the presence/typing/
// receipt hot paths — no settings table, no join). Enforcement is
// serialization-only at the edges (REST serializers per viewer, gateway per
// socket); nothing stored is rewritten by a toggle, so changes apply (and
// un-apply) instantly and retroactively. There is deliberately no
// "all notifications off" switch (PSYCHOLOGY §6).
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { UpdateSettingsRequestSchema, type UserSettings } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { authed, requireAuth } from '../auth/guard.js';

type UserRow = typeof schema.users.$inferSelect;

export function settingsDto(u: UserRow): UserSettings {
  return {
    read_receipts: u.readReceipts,
    show_last_seen: u.showLastSeen as UserSettings['show_last_seen'],
    show_typing: u.showTyping,
    invites_paused: u.invitesPaused,
    beacon_default_audience: u.beaconDefaultAudience as UserSettings['beacon_default_audience'],
    group_add_policy: u.groupAddPolicy as UserSettings['group_add_policy'],
    // v0.8a (§1.58): per-VIEWER mood-effects toggle — stored purely for
    // cross-device sync; all rendering is client-side.
    mood_effects: u.moodEffects,
    // v0.8a (§1.59): per-kind activity-strip visibility. Enforced at strip
    // serialization, ALWAYS intersected with the underlying object's own
    // audience — these narrow, never widen.
    activity_beacons: u.activityBeacons as UserSettings['activity_beacons'],
    activity_posts: u.activityPosts as UserSettings['activity_posts'],
    activity_listings: u.activityListings as UserSettings['activity_listings'],
    activity_games: u.activityGames as UserSettings['activity_games'],
  };
}

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.13 GET /api/users/me/settings
  app.get('/api/users/me/settings', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { settings: settingsDto(user) };
  });

  // §1.13 PATCH /api/users/me/settings — any subset; applies immediately.
  app.patch(
    '/api/users/me/settings',
    { preHandler: requireAuth, schema: { body: UpdateSettingsRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const b = req.body;
      const patch: Partial<typeof schema.users.$inferInsert> = { updatedAt: new Date() };
      if (b.read_receipts !== undefined) patch.readReceipts = b.read_receipts;
      if (b.show_last_seen !== undefined) patch.showLastSeen = b.show_last_seen;
      if (b.show_typing !== undefined) patch.showTyping = b.show_typing;
      if (b.invites_paused !== undefined) patch.invitesPaused = b.invites_paused;
      if (b.beacon_default_audience !== undefined) {
        patch.beaconDefaultAudience = b.beacon_default_audience;
      }
      if (b.group_add_policy !== undefined) patch.groupAddPolicy = b.group_add_policy;
      // v0.8a (§1.58/§1.59): applies at the next read — serialization-time,
      // nothing stored is rewritten (the §1.13 doctrine).
      if (b.mood_effects !== undefined) patch.moodEffects = b.mood_effects;
      if (b.activity_beacons !== undefined) patch.activityBeacons = b.activity_beacons;
      if (b.activity_posts !== undefined) patch.activityPosts = b.activity_posts;
      if (b.activity_listings !== undefined) patch.activityListings = b.activity_listings;
      if (b.activity_games !== undefined) patch.activityGames = b.activity_games;
      const [updated] = await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, user.id))
        .returning();
      return { settings: settingsDto(updated!) };
    },
  );
}
