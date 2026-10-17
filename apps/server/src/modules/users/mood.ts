// Moods & 🍻 drunk mode (v0.8a — API.md §1.57, ADR-018, FEATURES #72–#73).
// A mood lives ONLY in users.mood_* columns (the ADR-009 one-row-read
// pattern) — never a table, never history: clearing/expiry leaves NO trace
// anywhere. Binding rules enforced here:
//   - every PUT (re)sets mood_expires_at = now() + MOOD_TTL_S (re-set extends);
//   - 'drunk' pins emoji/label and DEFAULTS visibility to 'connections' even
//     when the user's other moods were public (route-side policy; still
//     overridable by an explicit visibility);
//   - 'swing' materializes the FIRST entry as the current chip and stamps
//     mood_swing_rotated_at (the worker rotates from there);
//   - a mood change NEVER generates push; the fan-out is one user.updated
//     envelope, per-recipient stamped (lib/dto publishUserUpdated), and is
//     skipped entirely for 'nobody' mood-only changes (owner's own sockets
//     still sync — the owner always sees their own chip).
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  MOOD_DRUNK_DEFAULT_VISIBILITY,
  MOOD_DRUNK_EMOJI,
  MOOD_DRUNK_LABEL,
  MOOD_PRESETS,
  MOOD_SET_RATE_PER_HOUR,
  MOOD_TTL_S,
  SetMoodRequestSchema,
  type MoodState,
  type MoodSwingEntry,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import {
  broadcastUserUpdatedOf,
  moodLive,
  publishUserUpdated,
  type UserRow,
} from '../../lib/dto.js';
import { badRequest, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';

/** The OWNER's full state (§1.57): the ONLY payload carrying visibility /
 * expires_at / swing_set. An expired-but-unswept mood reads as unset — the
 * live filter applies to the owner read too (never a stale chip). */
export function moodStateDto(u: UserRow): MoodState {
  const visibility = u.moodVisibility as MoodState['visibility'];
  if (!moodLive(u)) return { mood: null, visibility, expires_at: null, swing_set: null };
  return {
    mood: {
      emoji: u.moodEmoji!,
      label: u.moodLabel!,
      kind: u.moodKind as NonNullable<MoodState['mood']>['kind'],
    },
    visibility,
    expires_at: u.moodExpiresAt!.toISOString(),
    swing_set: u.moodKind === 'swing' ? (u.moodSwingSet as MoodSwingEntry[]) : null,
  };
}

/** §1.57 fan-out scope: 'nobody' mood-only changes never fan to others —
 * the owner's own sockets still get the frame (cross-device chip sync). */
async function fanMoodChange(row: UserRow, visibleToOthers: boolean): Promise<void> {
  if (visibleToOthers) await broadcastUserUpdatedOf(row.id);
  else await publishUserUpdated(row, [row.id]);
}

export async function moodRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.57 GET /api/users/me/mood — my full state.
  app.get('/api/users/me/mood', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { mood_state: moodStateDto(user) };
  });

  // §1.57 PUT /api/users/me/mood — set/replace. Re-setting extends the TTL.
  app.put(
    '/api/users/me/mood',
    { preHandler: requireAuth, schema: { body: SetMoodRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`moodset:${user.id}`, MOOD_SET_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const b = req.body;
      let emoji: string;
      let label: string;
      let swingSet: MoodSwingEntry[] | null = null;
      switch (b.kind) {
        case 'preset': {
          // label must name a MOOD_PRESETS entry; the server fills the emoji.
          const preset = MOOD_PRESETS.find((p) => p.label === b.label);
          if (!preset) throw badRequest('bad_mood_preset');
          emoji = preset.emoji;
          label = preset.label;
          break;
        }
        case 'custom':
          emoji = b.emoji;
          label = b.label;
          break;
        case 'swing':
          // Materialize the FIRST entry as the current chip (§1.57).
          swingSet = b.swing_set;
          emoji = b.swing_set[0]!.emoji;
          label = b.swing_set[0]!.label;
          break;
        case 'drunk':
          emoji = MOOD_DRUNK_EMOJI;
          label = MOOD_DRUNK_LABEL;
          break;
      }
      // The 🍻 guardrail: drunk defaults to connections-only even when the
      // user's other moods were public — explicit visibility still overrides.
      const visibility =
        b.visibility ?? (b.kind === 'drunk' ? MOOD_DRUNK_DEFAULT_VISIBILITY : 'everyone');

      const [updated] = await db
        .update(schema.users)
        .set({
          moodEmoji: emoji,
          moodLabel: label,
          moodKind: b.kind,
          moodVisibility: visibility,
          moodSwingSet: swingSet,
          moodExpiresAt: new Date(Date.now() + MOOD_TTL_S * 1000),
          moodSwingRotatedAt: b.kind === 'swing' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id))
        .returning();

      await fanMoodChange(updated!, visibility !== 'nobody');
      return { mood_state: moodStateDto(updated!) };
    },
  );

  // §1.57 DELETE /api/users/me/mood — clears every mood_* column
  // (idempotent). No trace survives anywhere; the goodbye frame fans only
  // where the chip was ever visible.
  app.delete('/api/users/me/mood', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    const wasVisibleToOthers = moodLive(user) && user.moodVisibility !== 'nobody';
    const [updated] = await db
      .update(schema.users)
      .set({
        moodEmoji: null,
        moodLabel: null,
        moodKind: null,
        moodVisibility: 'everyone',
        moodSwingSet: null,
        moodExpiresAt: null,
        moodSwingRotatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, user.id))
      .returning();
    await fanMoodChange(updated!, wasVisibleToOthers);
    return reply.status(204).send();
  });
}
