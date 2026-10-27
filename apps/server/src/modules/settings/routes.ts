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
    // v0.8b (§1.62): who may open an anonymous thread to me — enforced
    // INVISIBLY at POST /api/anon/threads (every refusal is the same 404).
    anon_messages: u.anonMessages as UserSettings['anon_messages'],
    // v0.8b (§1.63): may the worker send me the batched anonymous wave nudge.
    wave_nudges: u.waveNudges,
    // Migration 0014 (§1b / Wave 1.7): stored now, enforced at their surfaces
    // (DM/call creation; the logged-out profile teaser) in later phases.
    dm_policy: u.dmPolicy as UserSettings['dm_policy'],
    profile_visibility: u.profileVisibility as UserSettings['profile_visibility'],
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
      // v0.8b (§1.62/§1.63): both enforced at their surfaces, never stored
      // state rewrites (the §1.13 doctrine).
      if (b.anon_messages !== undefined) patch.anonMessages = b.anon_messages;
      if (b.wave_nudges !== undefined) patch.waveNudges = b.wave_nudges;
      // Migration 0014: both enforced at their surfaces, never stored-state
      // rewrites (the §1.13 doctrine).
      if (b.dm_policy !== undefined) patch.dmPolicy = b.dm_policy;
      if (b.profile_visibility !== undefined) patch.profileVisibility = b.profile_visibility;
      const [updated] = await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, user.id))
        .returning();
      return { settings: settingsDto(updated!) };
    },
  );
}
