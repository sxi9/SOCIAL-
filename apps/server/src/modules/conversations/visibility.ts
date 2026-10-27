// Group visibility modes (v0.8b — API.md §1.68, FEATURES #79d, ADR-020).
// Groups only (DMs/channels stay 'private' — DB CHECK). The binding rules:
// switching TO public is admin-confirmed and stamps public_since_seq =
// last_seq in the SAME transaction (ONLY later messages ever render
// publicly); switching AWAY from public clears the floor AND revokes the
// group's share token (a later re-publicize stamps a FRESH floor — history is
// never retro-exposed); GHOST is a ONE-WAY door (400 ghost_is_forever —
// members spoke under masks and no admin toggle may unmask them); 'private'
// and 'ghost' answer the join endpoint with a 404 byte-identical to an
// unknown id (unlisted means unlisted); a join-request DENY is SILENT (the
// no-rejection-surface rule).
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  GROUP_JOIN_RATE_PER_HOUR,
  MAX_GROUP_PARTICIPANTS,
  SetMaskRequestSchema,
  UpdateGroupVisibilityRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { filterBlockedFrom } from '../../lib/blocks.js';
import { assignMasksTx, groupAdminIdsOf } from '../../lib/ghost.js';
import {
  activeParticipantUserIds,
  loadConversationDto,
  publishConversationToUsers,
  userLiteDto,
  viewCtxFor,
} from '../../lib/dto.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueSocialPush } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import {
  deleteCallMembers,
  loadCall,
  publishCallUpdated,
  stopCallRing,
} from '../calls/service.js';
import { insertSystemMessageTx } from '../discovery/service.js';
import { fanOutNewMessage } from '../messages/service.js';
import { revokeShareTokensFor } from '../sharepages/service.js';
import { getParticipant, requireActiveParticipant } from './routes.js';

const convs = schema.conversations;
const cp = schema.conversationParticipants;
const gjr = schema.groupJoinRequests;

const IdParams = z.object({ id: z.string().uuid() });
const IdUserParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

type ConvRow = typeof schema.conversations.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

/** Phase 2 (§1.68): tell the group's ADMINS the queue changed — a request
 * parked (removed:false → frame + one social push each) or gone
 * (withdrawn / approved / denied → frame only). EVERY admin gets the frame,
 * the acting one included: the queue and `pending_requests` are not
 * block-clamped (the §1.14 group-coexistence rule — the join route runs no
 * block check either), so the live count must move for everyone who holds
 * it. Blocks bite at the NOTIFICATION edge only: no push across a block. */
async function fanJoinRequest(
  conv: ConvRow,
  requester: UserRow,
  createdAt: Date,
  removed: boolean,
): Promise<void> {
  const allAdmins = [...(await groupAdminIdsOf(conv.id))];
  if (allAdmins.length === 0) return;
  await publishToUsers(allAdmins, {
    t: 'group.join_request',
    d: {
      conversation_id: conv.id,
      request: { user: userLiteDto(requester), created_at: createdAt.toISOString() },
      removed,
    },
  });
  if (removed) return;
  const admins = await filterBlockedFrom(requester.id, allAdmins);
  for (const adminId of admins) {
    await enqueueSocialPush({
      kind: 'social',
      user_id: adminId,
      dedupe_key: `joinreq:${conv.id}:${requester.id}`,
      title: conv.title ?? 'Your group',
      body: `${requester.username} asked to join`,
      url: `/c/${conv.id}`,
    });
  }
}

/** The §1.68 "unlisted means unlisted" lookup shared by the join routes. */
async function loadJoinableGroup(id: string): Promise<ConvRow> {
  const [conv] = await db.select().from(convs).where(eq(convs.id, id)).limit(1);
  if (
    !conv ||
    conv.type !== 'group' ||
    conv.visibility === 'private' ||
    conv.visibility === 'ghost'
  ) {
    throw notFound('not_found');
  }
  return conv;
}

const VISIBILITY_COPY: Record<string, string> = {
  private: 'this group is private again',
  invite_only: 'this group now accepts join requests',
  public: 'new messages here are publicly readable',
  ghost: '👻 this group went ghost — everyone wears a mask now',
};

export async function groupVisibilityRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.68 PATCH /api/conversations/:id/visibility — group admins only.
  app.patch(
    '/api/conversations/:id/visibility',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: UpdateGroupVisibilityRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type !== 'group') throw badRequest('bad_conversation_type');
      if (part.role !== 'admin') throw forbidden('forbidden');

      const target = req.body.visibility;
      const nextDescription = req.body.description;

      if (target !== undefined && target !== conv.visibility) {
        // A ghost group NEVER switches away — one-way door (ADR-020).
        if (conv.visibility === 'ghost') throw badRequest('ghost_is_forever');
        // The admin-confirmed switches.
        if ((target === 'public' || target === 'ghost') && !req.body.confirm) {
          throw badRequest('confirm_required');
        }

        const sysMsg = await db.transaction(async (tx) => {
          // Lock the row so last_seq is the floor the system message lands on.
          const locked = (await tx.execute(sql`
            SELECT last_seq, visibility FROM conversations WHERE id = ${conv.id} FOR UPDATE
          `)) as unknown as { last_seq: number | string; visibility: string }[];
          if (!locked[0] || locked[0].visibility === 'ghost') throw badRequest('ghost_is_forever');
          const lastSeq = Number(locked[0].last_seq);

          if (target === 'public') {
            // Stamp the floor: ONLY seq > public_since_seq renders publicly.
            await tx.execute(sql`
              UPDATE conversations SET visibility = 'public',
                public_since_seq = ${lastSeq}::bigint
                ${nextDescription !== undefined ? sql`, description = ${nextDescription}` : sql``}
              WHERE id = ${conv.id}
            `);
          } else {
            // Leaving public clears the floor + revokes the share token in
            // the SAME transaction (history never retro-exposed). Ghost also
            // never has a token (none can be minted for it).
            await tx.execute(sql`
              UPDATE conversations SET visibility = ${target},
                public_since_seq = NULL
                ${nextDescription !== undefined ? sql`, description = ${nextDescription}` : sql``}
              WHERE id = ${conv.id}
            `);
            if (conv.visibility === 'public' || target === 'ghost') {
              await revokeShareTokensFor(tx, 'group', conv.id);
            }
            if (target === 'ghost') {
              // Auto-assign masks to every CURRENT member in the switch tx.
              const members = (await tx.execute(sql`
                SELECT user_id FROM conversation_participants
                WHERE conversation_id = ${conv.id} AND left_at IS NULL
              `)) as unknown as { user_id: string }[];
              await assignMasksTx(tx, conv.id, members.map((m) => m.user_id));
            }
          }
          // Every member's timeline says it plainly (§1.68).
          const msg = await insertSystemMessageTx(
            tx,
            conv.id,
            'visibility_changed',
            VISIBILITY_COPY[target] ?? 'visibility changed',
          );
          // Stamp the new visibility onto the system rider after insert (the
          // helper writes only {event}).
          await tx.execute(sql`
            UPDATE messages SET metadata = jsonb_set(metadata, '{system,visibility}', ${JSON.stringify(target)}::jsonb)
            WHERE id = ${msg.id}
          `);
          msg.metadata = { system: { event: 'visibility_changed', visibility: target } };
          return msg;
        });
        await fanOutNewMessage(sysMsg);
        if (target === 'ghost') {
          // §1.68: no calls exist in 👻 ghost groups (creation is refused) — a
          // live call straddling the switch would keep relaying REAL user ids
          // between freshly-masked members, so it ends WITH the switch.
          const live = (await db.execute(sql`
            UPDATE calls SET status = 'completed', ended_at = now()
            WHERE conversation_id = ${conv.id} AND status IN ('ringing', 'ongoing')
            RETURNING id
          `)) as unknown as { id: string }[];
          for (const ended of live) {
            await deleteCallMembers(ended.id);
            await stopCallRing(ended.id);
            const fresh = await loadCall(ended.id);
            if (fresh) await publishCallUpdated(fresh);
          }
        }
      } else if (nextDescription !== undefined && nextDescription !== conv.description) {
        if (conv.type !== 'group') throw badRequest('bad_conversation_type');
        await db.update(convs).set({ description: nextDescription }).where(eq(convs.id, conv.id));
      }

      await publishConversationToUsers(
        conv.id,
        await activeParticipantUserIds(conv.id),
        'conv.updated',
      );
      const dto = await loadConversationDto(conv.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.68 POST /api/conversations/:id/join — 'public' joins at once;
  // 'invite_only' parks a request; 'private'/'ghost' answer a 404
  // byte-identical to an unknown id.
  app.post(
    '/api/conversations/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`groupjoin:${user.id}`, GROUP_JOIN_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const conv = await loadJoinableGroup(req.params.id); // unlisted means unlisted

      // Already a member → the join is idempotent.
      const mine = await getParticipant(conv.id, user.id);
      if (mine && mine.leftAt === null) {
        const dto = await loadConversationDto(conv.id, await viewCtxFor(user));
        return reply.status(200).send({ status: 'joined', conversation: dto });
      }

      if (conv.visibility === 'invite_only') {
        // Park a request — idempotent re-request answers 202 too, but only
        // the FIRST parks a row and tells the admins (phase 2).
        const inserted = (await db.execute(sql`
          INSERT INTO group_join_requests (conversation_id, user_id)
          VALUES (${conv.id}, ${user.id})
          ON CONFLICT DO NOTHING
          RETURNING created_at
        `)) as unknown as { created_at: string | Date }[];
        if (inserted.length > 0) {
          await fanJoinRequest(conv, user, new Date(inserted[0]!.created_at), false);
        }
        return reply.status(202).send({ status: 'requested' });
      }

      // public: any non-banned user; §1.4 floor; the §1.14 group-coexistence
      // rule applies to blocks (no block check here by design).
      const active = await activeParticipantUserIds(conv.id);
      if (active.length + 1 > MAX_GROUP_PARTICIPANTS) throw badRequest('group_too_large');
      await joinGroupTx(conv.id, user.id);
      await publishConversationToUsers(conv.id, [user.id], 'conv.new');
      await publishConversationToUsers(conv.id, active, 'conv.updated');
      const dto = await loadConversationDto(conv.id, await viewCtxFor(user));
      return reply.status(200).send({ status: 'joined', conversation: dto });
    },
  );

  // Phase 2 (§1.68) GET /api/conversations/:id/join — my own standing with
  // a public|invite_only group; the same 404 as the POST for anything else.
  app.get(
    '/api/conversations/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const conv = await loadJoinableGroup(req.params.id);
      const mine = await getParticipant(conv.id, user.id);
      if (mine && mine.leftAt === null) return { state: 'member' };
      const [row] = await db
        .select({ userId: gjr.userId })
        .from(gjr)
        .where(and(eq(gjr.conversationId, conv.id), eq(gjr.userId, user.id)))
        .limit(1);
      return { state: row ? 'requested' : 'none' };
    },
  );

  // Phase 2 (§1.68) DELETE /api/conversations/:id/join — withdraw my own
  // request. Idempotent 204; the admins' queue shrinks (frame, no push).
  app.delete(
    '/api/conversations/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const conv = await loadJoinableGroup(req.params.id);
      const gone = (await db.execute(sql`
        DELETE FROM group_join_requests
        WHERE conversation_id = ${conv.id} AND user_id = ${user.id}
        RETURNING created_at
      `)) as unknown as { created_at: string | Date }[];
      if (gone.length > 0) await fanJoinRequest(conv, user, new Date(gone[0]!.created_at), true);
      return reply.status(204).send();
    },
  );

  // §1.68 GET /api/conversations/:id/join-requests — admins only, oldest
  // first (a queue, not a ranking).
  app.get(
    '/api/conversations/:id/join-requests',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      if (part.role !== 'admin') throw forbidden('forbidden');
      const rows = await db
        .select({ r: gjr, u: schema.users })
        .from(gjr)
        .innerJoin(schema.users, eq(gjr.userId, schema.users.id))
        .where(eq(gjr.conversationId, req.params.id))
        .orderBy(asc(gjr.createdAt));
      return {
        requests: rows.map(({ r, u }) => ({
          user: userLiteDto(u),
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  );

  // §1.68 POST .../join-requests/:userId/approve — one transaction: insert
  // participant (§1.4 floor + system message), delete the request, conv.new
  // to the joiner. Gone request → 404.
  app.post(
    '/api/conversations/:id/join-requests/:userId/approve',
    { preHandler: requireAuth, schema: { params: IdUserParams } },
    async (req) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      if (part.role !== 'admin') throw forbidden('forbidden');
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv || conv.type !== 'group') throw notFound('not_found');
      const active = await activeParticipantUserIds(conv.id);
      if (active.length + 1 > MAX_GROUP_PARTICIPANTS) throw badRequest('group_too_large');

      const [joiner] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.params.userId))
        .limit(1);
      if (!joiner) throw notFound('not_found');
      let requestedAt = new Date();
      const msgRow = await db.transaction(async (tx) => {
        const deleted = (await tx.execute(sql`
          DELETE FROM group_join_requests
          WHERE conversation_id = ${conv.id} AND user_id = ${req.params.userId}
          RETURNING user_id, created_at
        `)) as unknown as { user_id: string; created_at: string | Date }[];
        if (deleted.length === 0) throw notFound('not_found');
        requestedAt = new Date(deleted[0]!.created_at);
        const locked = (await tx.execute(sql`
          SELECT last_seq FROM conversations WHERE id = ${conv.id} FOR UPDATE
        `)) as unknown as { last_seq: number | string }[];
        const joinSeq = Number(locked[0]!.last_seq);
        const nowIso = new Date().toISOString();
        await tx.execute(sql`
          INSERT INTO conversation_participants
            (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
          VALUES (${conv.id}, ${req.params.userId}, 'member', ${nowIso}::timestamptz,
                  ${joinSeq}::bigint, NULL, ${joinSeq}::bigint, ${joinSeq}::bigint)
          ON CONFLICT (conversation_id, user_id) DO UPDATE SET
            role = 'member',
            joined_at = ${nowIso}::timestamptz,
            join_seq = ${joinSeq}::bigint,
            left_at = NULL,
            left_seq = NULL,
            last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${joinSeq}::bigint),
            last_read_seq = GREATEST(conversation_participants.last_read_seq, ${joinSeq}::bigint)
        `);
        return insertSystemMessageTx(tx, conv.id, 'participant_added', 'joined the group');
      });
      await fanOutNewMessage(msgRow);
      await fanJoinRequest(conv, joiner, requestedAt, true); // the queue shrank
      await publishConversationToUsers(conv.id, [req.params.userId], 'conv.new');
      await publishConversationToUsers(conv.id, active, 'conv.updated');
      const dto = await loadConversationDto(conv.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.68 DELETE .../join-requests/:userId — deny: deletes the row SILENTLY
  // (no event, no notice; the requester's button simply stays "requested").
  app.delete(
    '/api/conversations/:id/join-requests/:userId',
    { preHandler: requireAuth, schema: { params: IdUserParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      if (part.role !== 'admin') throw forbidden('forbidden');
      const gone = (await db.execute(sql`
        DELETE FROM group_join_requests
        WHERE conversation_id = ${req.params.id} AND user_id = ${req.params.userId}
        RETURNING created_at
      `)) as unknown as { created_at: string | Date }[];
      if (gone.length > 0) {
        // Silent to the requester; the OTHER admins' queue still shrinks.
        const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
        const [denied] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, req.params.userId))
          .limit(1);
        if (conv && denied) await fanJoinRequest(conv, denied, new Date(gone[0]!.created_at), true);
      }
      return reply.status(204).send();
    },
  );

  // §1.68 PUT /api/conversations/:id/mask — MY mask in a GHOST group I'm a
  // member of. Unique name per group (case-insensitive) → 409 mask_taken.
  app.put(
    '/api/conversations/:id/mask',
    { preHandler: requireAuth, schema: { params: IdParams, body: SetMaskRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.visibility !== 'ghost') throw badRequest('not_ghost');

      const taken = (await db.execute(sql`
        SELECT 1 AS one FROM conversation_masks
        WHERE conversation_id = ${conv.id}
          AND lower(mask_name) = lower(${req.body.mask_name})
          AND user_id <> ${user.id}
        LIMIT 1
      `)) as unknown as { one: number }[];
      if (taken.length > 0) throw conflict('mask_taken');
      try {
        await db.execute(sql`
          INSERT INTO conversation_masks (conversation_id, user_id, mask_name, mask_emoji)
          VALUES (${conv.id}, ${user.id}, ${req.body.mask_name}, ${req.body.mask_emoji})
          ON CONFLICT (conversation_id, user_id) DO UPDATE
            SET mask_name = ${req.body.mask_name}, mask_emoji = ${req.body.mask_emoji}
        `);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('mask_taken');
        throw err;
      }
      // Members see the mask change; nothing links old to new for non-admins.
      await publishConversationToUsers(
        conv.id,
        await activeParticipantUserIds(conv.id),
        'conv.updated',
      );
      const dto = await loadConversationDto(conv.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );
}

/** The §1.4 join upsert (floor = last_seq) + the join system message, in one
 * transaction; the message fans AFTER commit via the caller. */
async function joinGroupTx(convId: string, userId: string): Promise<void> {
  const msg = await db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT last_seq FROM conversations WHERE id = ${convId} FOR UPDATE
    `)) as unknown as { last_seq: number | string }[];
    const joinSeq = Number(locked[0]!.last_seq);
    const nowIso = new Date().toISOString();
    await tx.execute(sql`
      INSERT INTO conversation_participants
        (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
      VALUES (${convId}, ${userId}, 'member', ${nowIso}::timestamptz,
              ${joinSeq}::bigint, NULL, ${joinSeq}::bigint, ${joinSeq}::bigint)
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET
        role = 'member',
        joined_at = ${nowIso}::timestamptz,
        join_seq = ${joinSeq}::bigint,
        left_at = NULL,
        left_seq = NULL,
        last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${joinSeq}::bigint),
        last_read_seq = GREATEST(conversation_participants.last_read_seq, ${joinSeq}::bigint)
    `);
    return insertSystemMessageTx(tx, convId, 'participant_added', 'joined the group');
  });
  await fanOutNewMessage(msg);
}
