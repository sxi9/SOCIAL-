// v0.6 Rescue me (API.md §1.46, FEATURES #53). Deliberately almost nothing:
// no table, no acknowledgement state — a rescue is an ordinary message
// (metadata.rescue:true, SERVER-written) in up to three friends-of DMs, plus
// the ONE push that bypasses the §2.9 guards (mute overridden — the §1.33
// mention precedent; blocks stay structural: the friends-of gate below can
// never pass a blocked pair). Capped RESCUE_MAX_PER_DAY per UTC day.
import { inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  RESCUE_DEFAULT_BODY,
  RESCUE_MAX_PER_DAY,
  RescueRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { activeParticipantUserIds, messageDtos, publishConversationToUsers } from '../../lib/dto.js';
import { notFound, rateLimited } from '../../lib/errors.js';
import { isFriendOf } from '../../lib/friends.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueRescuePush } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { insertMessage } from '../messages/service.js';

const convs = schema.conversations;
const cp = schema.conversationParticipants;

/** Create-or-dedupe the DM via dm_key (§1.4 semantics, race-safe). */
async function ensureDm(meId: string, targetId: string): Promise<{ id: string; created: boolean }> {
  const dmKey = [meId, targetId].sort().join(':');
  const [existing] = await db.select({ id: convs.id }).from(convs).where(sql`${convs.dmKey} = ${dmKey}`).limit(1);
  if (existing) return { id: existing.id, created: false };
  const convId = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(convs).values({ id: convId, type: 'dm', dmKey, createdBy: meId });
      await tx.insert(cp).values([
        { conversationId: convId, userId: meId },
        { conversationId: convId, userId: targetId },
      ]);
    });
    return { id: convId, created: true };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const [raced] = await db.select({ id: convs.id }).from(convs).where(sql`${convs.dmKey} = ${dmKey}`).limit(1);
      if (raced) return { id: raced.id, created: false };
    }
    throw err;
  }
}

function secondsToUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

export async function rescueRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.46 POST /api/rescue
  app.post(
    '/api/rescue',
    { preHandler: requireAuth, schema: { body: RescueRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const targetIds = [...new Set(req.body.user_ids)].filter((id) => id !== user.id);
      if (targetIds.length === 0) throw notFound('not_found');

      // Every target must be in my friends-of set (accepted connections ∪
      // dm-partners, minus blocks/banned) and not suspended. ANY bad id fails
      // the whole request 404-shaped — unknown, stranger and blocked are
      // byte-identical (§1.14).
      const targetRows = await db
        .select()
        .from(schema.users)
        .where(inArray(schema.users.id, targetIds));
      if (targetRows.length !== targetIds.length) throw notFound('not_found');
      for (const target of targetRows) {
        if (target.suspendedAt !== null || target.bannedAt !== null) throw notFound('not_found');
        if (!(await isFriendOf(user.id, target.id))) throw notFound('not_found');
      }

      // RESCUE_MAX_PER_DAY per UTC day (Redis fixed window, date-keyed).
      const day = new Date().toISOString().slice(0, 10);
      const rate = await fixedWindow(
        `rescue:${user.id}:${day}`,
        RESCUE_MAX_PER_DAY,
        secondsToUtcMidnight(),
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const note = req.body.note.trim();
      const body = note || RESCUE_DEFAULT_BODY;
      const rescues: { user_id: string; conversation_id: string }[] = [];

      for (const target of targetRows) {
        const dm = await ensureDm(user.id, target.id);
        if (dm.created) {
          await publishConversationToUsers(dm.id, [user.id, target.id], 'conv.new');
        }
        const msg = await insertMessage({
          conversationId: dm.id,
          senderId: user.id,
          type: 'text',
          body,
          // SERVER-written SOS flag (§1.46): renders the rescue card with the
          // one-tap call-back into a §1.42 call.
          metadata: { rescue: true },
        });
        // msg.new fan-out WITHOUT the ordinary offline push — the rescue push
        // below replaces it (and fires even with a live socket: the point is
        // a buzzing phone, not an unread dot).
        const [dto] = await messageDtos([msg]);
        const participants = await activeParticipantUserIds(dm.id);
        if (dto) {
          await publishToUsers(participants, {
            t: 'msg.new',
            d: { conversation_id: dm.id, message: dto },
          });
        }
        await enqueueRescuePush({
          kind: 'rescue',
          user_id: target.id,
          sender_id: user.id,
          conversation_id: dm.id,
          title: `${user.displayName} needs a rescue call 📞`,
          body: note,
        });
        rescues.push({ user_id: target.id, conversation_id: dm.id });
      }

      return reply.status(201).send({ rescues });
    },
  );
}
