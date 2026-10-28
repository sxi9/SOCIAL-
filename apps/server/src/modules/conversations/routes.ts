import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  MuteConversationRequestSchema,
  AddParticipantsRequestSchema,
  CONVERSATION_CREATE_RATE_PER_HOUR,
  CreateConversationRequestSchema,
  ListConversationsQuerySchema,
  MAX_GROUP_PARTICIPANTS,
  TransferConversationRequestSchema,
  UpdateConversationRequestSchema,
  UpdateDisappearRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { deleteAttachmentObjects } from '../../jobs/gc.js';
import { banMember, unbanMember, unbanMembers } from '../../lib/bans.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { acceptConversation, dmGateFor } from '../../lib/dmPolicy.js';
import {
  activeParticipantUserIds,
  avatarDto,
  dmPartnerIdsOf,
  loadConversationDto,
  loadListItems,
  publishConversationToUsers,
  userPrivateDto,
  viewCtxFor,
  type PartRow,
  userLiteDto,
} from '../../lib/dto.js';
import { assignMasksTx } from '../../lib/ghost.js';
import { badRequest, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { parseMultipart } from '../../lib/multipart.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueAvatar } from '../../queues.js';
import { authed, requireAuth } from '../auth/guard.js';
import { sendSystemMessage } from '../messages/service.js';
import { fanJoinRequest } from './visibility.js';
import { dropFromLiveCall } from '../calls/service.js';
import { stashAvatarSource } from '../uploads/pipeline.js';

const cp = schema.conversationParticipants;
const convs = schema.conversations;

export async function getParticipant(convId: string, userId: string): Promise<PartRow | null> {
  const [row] = await db
    .select()
    .from(cp)
    .where(and(eq(cp.conversationId, convId), eq(cp.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function requireActiveParticipant(convId: string, userId: string): Promise<PartRow> {
  const row = await getParticipant(convId, userId);
  if (!row || row.leftAt !== null) throw notFound('conversation_not_found');
  return row;
}

/** v0.5a §1.35: a channel's owner + admins — the recipients of membership-
 * level conv.updated frames (the member body never sees membership). */
export async function channelPrivilegedUserIds(convId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: cp.userId })
    .from(cp)
    .where(
      and(eq(cp.conversationId, convId), isNull(cp.leftAt), sql`${cp.role} IN ('owner','admin')`),
    );
  return rows.map((r) => r.userId);
}

// Broadcast conv.* frames go through the per-recipient §1.13/§1.14 clamping
// fan-out (lib/dto.ts) — never an unclamped shared DTO.
async function publishConvUpdated(convId: string, toUserIds?: string[]): Promise<void> {
  const recipients = toUserIds ?? (await activeParticipantUserIds(convId));
  await publishConversationToUsers(convId, recipients, 'conv.updated');
}

async function publishConvNew(convId: string, toUserIds: string[]): Promise<void> {
  await publishConversationToUsers(convId, toUserIds, 'conv.new');
}

const IdParams = z.object({ id: z.string().uuid() });

/**
 * group_add_policy + blocks, checked per TARGET user (API.md §1.13/§1.14):
 * 'nobody' denies; 'dm_partners' denies unless the adder shares an active DM
 * with the target; a block (either direction) denies with the SAME response.
 * Any denial fails the whole request: 403 {error:'group_add_denied',
 * user_ids:[denied]} — byte-identical between policy and block, so the 403
 * reveals *a* refusal, never *which* one.
 */
export async function deniedGroupAddTargets(adderId: string, targetIds: string[]): Promise<string[]> {
  if (targetIds.length === 0) return [];
  const targets = await db
    .select({ id: schema.users.id, groupAddPolicy: schema.users.groupAddPolicy })
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${sql.join(targetIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const adderDmPartners = await dmPartnerIdsOf(adderId);
  const blockRows = (await db.execute(sql`
    SELECT blocked_id AS id FROM blocks WHERE blocker_id = ${adderId}
    UNION
    SELECT blocker_id AS id FROM blocks WHERE blocked_id = ${adderId}
  `)) as unknown as { id: string }[];
  const blocked = new Set(blockRows.map((r) => r.id));
  const denied: string[] = [];
  for (const t of targets) {
    if (
      blocked.has(t.id) ||
      t.groupAddPolicy === 'nobody' ||
      (t.groupAddPolicy === 'dm_partners' && !adderDmPartners.has(t.id))
    ) {
      denied.push(t.id);
    }
  }
  return denied;
}

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.3 GET /api/sync — the reconnect anchor: every active conversation.
  app.get('/api/sync', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select({ conversationId: cp.conversationId })
      .from(cp)
      .where(and(eq(cp.userId, user.id), isNull(cp.leftAt)));
    const conversations = await loadListItems(
      user.id,
      rows.map((r) => r.conversationId),
    );
    return {
      server_time: new Date().toISOString(),
      me: userPrivateDto(user),
      conversations,
    };
  });

  // §1.4 POST /api/conversations
  app.post(
    '/api/conversations',
    { preHandler: requireAuth, schema: { body: CreateConversationRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      // M8 rate-limit sweep: conversation creation.
      const rate = await fixedWindow(
        `convcreate:${user.id}`,
        CONVERSATION_CREATE_RATE_PER_HOUR,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const body = req.body;
      // §1.13: every conversation DTO handed back to the requester is
      // viewer-scoped (receipt reciprocity + last-seen + block clamps).
      const view = await viewCtxFor(user);

      if (body.type === 'dm') {
        if (body.user_id === user.id) throw badRequest('cannot_dm_self');
        const [peer] = await db
          .select({ id: schema.users.id, dmPolicy: schema.users.dmPolicy })
          .from(schema.users)
          .where(eq(schema.users.id, body.user_id))
          .limit(1);
        if (!peer) throw notFound('user_not_found');
        // §1.14: DM create between a blocked pair is 404-shaped, byte-identical
        // to an unknown user_id — never a 403 that would confirm the block.
        if (await isBlockedPair(user.id, body.user_id)) throw notFound('user_not_found');

        // dm_key = sorted 'uuidMin:uuidMax' dedupes creation races.
        const dmKey = [user.id, body.user_id].sort().join(':');
        const [existing] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
        if (existing) {
          // Wave 1.7: the peer left (deleted my request) — asking again
          // re-seats them, parked or open per their policy; 'nobody' says no.
          const peerRow = await getParticipant(existing.id, body.user_id);
          if (peerRow && peerRow.leftAt !== null) {
            const regate = await dmGateFor(user.id, peer);
            if (regate === 'refused') throw notFound('user_not_found');
            await db.execute(sql`
              UPDATE conversation_participants SET
                left_at = NULL, left_seq = NULL,
                joined_at = now(),
                join_seq = (SELECT last_seq FROM conversations WHERE id = ${existing.id}),
                accepted_at = ${regate === 'parked' ? sql`NULL` : sql`now()`}
              WHERE conversation_id = ${existing.id} AND user_id = ${body.user_id}
            `);
            await publishConvNew(existing.id, [body.user_id]);
          }
          const dto = await loadConversationDto(existing.id, view);
          return reply.status(200).send({ conversation: dto });
        }

        // Wave 1.7 (§1.13 dm_policy): 'nobody' refuses in the SAME 404 shape
        // as a block; 'connections' parks the DM in the peer's Requests
        // (their row stays unaccepted) unless we are connected.
        const gate = await dmGateFor(user.id, peer);
        if (gate === 'refused') throw notFound('user_not_found');

        const convId = newId();
        try {
          await db.transaction(async (tx) => {
            await tx.insert(convs).values({ id: convId, type: 'dm', dmKey, createdBy: user.id });
            await tx.insert(cp).values([
              { conversationId: convId, userId: user.id },
              {
                conversationId: convId,
                userId: body.user_id,
                ...(gate === 'parked' ? { acceptedAt: null } : {}),
              },
            ]);
          });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            const [raced] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
            if (raced) {
              const dto = await loadConversationDto(raced.id, view);
              return reply.status(200).send({ conversation: dto });
            }
          }
          throw err;
        }
        await publishConvNew(convId, [user.id, body.user_id]);
        const dto = await loadConversationDto(convId, view);
        return reply.status(201).send({ conversation: dto });
      }

      // v0.5a §1.35: a channel starts with ONE member — its owner. No
      // user_ids: membership arrives through §1.11 invites (channel
      // conversation_id; owner/admin-minted; CHANNEL_MAX-capped).
      if (body.type === 'channel') {
        const convId = newId();
        await db.transaction(async (tx) => {
          await tx
            .insert(convs)
            .values({ id: convId, type: 'channel', title: body.title, createdBy: user.id });
          await tx.insert(cp).values({ conversationId: convId, userId: user.id, role: 'owner' });
        });
        await publishConvNew(convId, [user.id]);
        const dto = await loadConversationDto(convId, view);
        return reply.status(201).send({ conversation: dto });
      }

      // group
      const memberIds = [...new Set(body.user_ids)].filter((id) => id !== user.id);
      if (memberIds.length + 1 > MAX_GROUP_PARTICIPANTS) throw badRequest('group_too_large');
      if (memberIds.length === 0) throw badRequest('group_needs_members');
      const found = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`${schema.users.id} IN (${sql.join(memberIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      if (found.length !== memberIds.length) throw notFound('user_not_found');

      // §1.13 group_add_policy / §1.14 blocks — per-target, whole-request fail.
      const denied = await deniedGroupAddTargets(user.id, memberIds);
      if (denied.length > 0) {
        return reply.status(403).send({ error: 'group_add_denied', user_ids: denied });
      }

      const convId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(convs).values({ id: convId, type: 'group', title: body.title, createdBy: user.id });
        await tx.insert(cp).values([
          { conversationId: convId, userId: user.id, role: 'admin' },
          ...memberIds.map((id) => ({ conversationId: convId, userId: id })),
        ]);
      });
      await publishConvNew(convId, [user.id, ...memberIds]);
      const dto = await loadConversationDto(convId, view);
      return reply.status(201).send({ conversation: dto });
    },
  );

  // §1.4 GET /api/conversations — UI list, keyset-paged by activity.
  app.get(
    '/api/conversations',
    { preHandler: requireAuth, schema: { querystring: ListConversationsQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const { cursor, limit } = req.query;
      const sortExpr = sql`COALESCE(${convs.lastMessageAt}, ${convs.createdAt})`;

      const conditions = [eq(cp.userId, user.id), isNull(cp.leftAt)];
      if (cursor) {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const sep = decoded.lastIndexOf('|');
        if (sep === -1) throw badRequest('bad_cursor');
        const ts = decoded.slice(0, sep);
        const id = decoded.slice(sep + 1);
        if (Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) {
          throw badRequest('bad_cursor');
        }
        conditions.push(sql`(${sortExpr}, ${convs.id}) < (${ts}::timestamptz, ${id}::uuid)`);
      }

      const rows = await db
        .select({ id: convs.id, sortKey: sql<Date | string>`${sortExpr}` })
        .from(cp)
        .innerJoin(convs, eq(cp.conversationId, convs.id))
        .where(and(...conditions))
        .orderBy(sql`${sortExpr} DESC`, desc(convs.id))
        .limit(limit);

      const items = await loadListItems(
        user.id,
        rows.map((r) => r.id),
      );
      const byId = new Map(items.map((i) => [i.id, i]));
      const ordered = rows.flatMap((r) => {
        const item = byId.get(r.id);
        return item ? [item] : [];
      });

      let nextCursor: string | null = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1]!;
        const ts = new Date(last.sortKey).toISOString();
        nextCursor = Buffer.from(`${ts}|${last.id}`, 'utf8').toString('base64url');
      }
      return { conversations: ordered, next_cursor: nextCursor };
    },
  );

  // §1.4 GET /api/conversations/:id
  app.get(
    '/api/conversations/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      // Viewer-scoped serialization (§1.13): receipt clamping + last-seen.
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      if (!dto) throw notFound('conversation_not_found');
      return { conversation: dto };
    },
  );

  // §1.4 PATCH /api/conversations/:id — title (admin, groups).
  app.patch(
    '/api/conversations/:id',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: UpdateConversationRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type !== 'group') throw badRequest('not_a_group');
      if (part.role !== 'admin') throw forbidden('not_admin');

      await db.update(convs).set({ title: req.body.title }).where(eq(convs.id, req.params.id));
      await publishConvUpdated(req.params.id);
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.4 POST /api/conversations/:id/avatar (admin, groups) — same avatar job
  // as users; completion arrives via conv.updated.
  app.post(
    '/api/conversations/:id/avatar',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type !== 'group') throw badRequest('not_a_group');
      if (part.role !== 'admin') throw forbidden('not_admin');

      let stashed: { rawKey: string; mime: string } | null = null;
      await parseMultipart(
        req,
        async (fieldname, file) => {
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
        .update(convs)
        .set({ avatarStatus: 'processing' })
        .where(eq(convs.id, req.params.id))
        .returning();
      await enqueueAvatar({
        target: { conversation_id: req.params.id },
        raw_key: result.rawKey,
        mime: result.mime,
      });
      return reply.status(202).send({ avatar: avatarDto(updated!) });
    },
  );

  // §1.25 PATCH /api/conversations/:id/disappearing — conversation-wide TTL
  // (null = off). DM: any active participant; group: admin only. Every
  // EFFECTIVE change drops a 'disappear_changed' system message (the
  // announcement IS the audit trail); an idempotent re-set is silent.
  app.patch(
    '/api/conversations/:id/disappearing',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: UpdateDisappearRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type === 'group' && part.role !== 'admin') throw forbidden();

      // §1.14: a DM frozen by a block refuses the TTL toggle 404-shaped, like
      // sends/schedules — a blocked user must not push 'disappear_changed'
      // fan-out through the block, nor arm the sweep to destroy the frozen
      // DM's shared history (the blocker may need it for a §1.14 report).
      if (conv.type === 'dm') {
        const peer = (await activeParticipantUserIds(req.params.id)).find((id) => id !== user.id);
        if (peer && (await isBlockedPair(user.id, peer))) throw notFound('conversation_not_found');
      }

      const ttl = req.body.ttl_s;
      if ((conv.disappearTtlS ?? null) !== (ttl ?? null)) {
        await db.update(convs).set({ disappearTtlS: ttl }).where(eq(convs.id, req.params.id));
        const labels: Record<number, string> = {
          3600: '1 hour',
          86400: '24 hours',
          604800: '7 days',
          2592000: '30 days',
        };
        await sendSystemMessage(
          req.params.id,
          'disappear_changed',
          ttl
            ? `new and existing messages disappear after ${labels[ttl] ?? `${ttl}s`}`
            : 'disappearing messages turned off',
          user.id,
          undefined,
          { ttl_s: ttl },
        );
        await publishConvUpdated(req.params.id);
      }
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.4 POST /api/conversations/:id/participants (admin; total ≤ 256).
  app.post(
    '/api/conversations/:id/participants',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: AddParticipantsRequestSchema },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const part = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type !== 'group') throw badRequest('not_a_group');
      if (part.role !== 'admin') throw forbidden('not_admin');

      const existingActive = await activeParticipantUserIds(req.params.id);
      const activeSet = new Set(existingActive);
      const toAdd = [...new Set(req.body.user_ids)].filter((id) => !activeSet.has(id));
      if (existingActive.length + toAdd.length > MAX_GROUP_PARTICIPANTS) {
        throw badRequest('group_too_large');
      }
      if (toAdd.length > 0) {
        const found = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(sql`${schema.users.id} IN (${sql.join(toAdd.map((id) => sql`${id}::uuid`), sql`, `)})`);
        if (found.length !== toAdd.length) throw notFound('user_not_found');

        // §1.13 group_add_policy / §1.14 blocks — per-target, whole-request.
        const denied = await deniedGroupAddTargets(user.id, toAdd);
        if (denied.length > 0) {
          return reply.status(403).send({ error: 'group_add_denied', user_ids: denied });
        }
        // §2.5: an admin adding someone back lifts their ban (admin intent) —
        // only now, with every gate passed and the inserts about to land.
        await unbanMembers(req.params.id, toAdd);

        // join_seq = last_seq at join time (history-visibility floor); the
        // system message below bumps seq past it, so joiners see it. Watermarks
        // start at the floor so unread math stays sane for late joiners.
        const joinSeq = conv.lastSeq;
        // ISO string, not a Date instance: raw db.execute params are passed
        // through to postgres-js untyped, and it cannot serialize Dates.
        const nowIso = new Date().toISOString();
        for (const userId of toAdd) {
          await db.execute(sql`
            INSERT INTO conversation_participants
              (conversation_id, user_id, role, joined_at, join_seq, left_at, last_delivered_seq, last_read_seq)
            VALUES (${req.params.id}, ${userId}, 'member', ${nowIso}::timestamptz, ${joinSeq}::bigint, NULL, ${joinSeq}::bigint, ${joinSeq}::bigint)
            ON CONFLICT (conversation_id, user_id) DO UPDATE SET
              role = 'member',
              joined_at = ${nowIso}::timestamptz,
              join_seq = ${joinSeq}::bigint,
              left_at = NULL,
              left_seq = NULL,
              last_delivered_seq = GREATEST(conversation_participants.last_delivered_seq, ${joinSeq}::bigint),
              last_read_seq = GREATEST(conversation_participants.last_read_seq, ${joinSeq}::bigint)
          `);
        }
        // v0.8b (§1.68): members added to a 👻 ghost group wear masks from
        // the moment they exist in it.
        if (conv.visibility === 'ghost') {
          await assignMasksTx(db, req.params.id, toAdd);
        }
        // ONE system message per add operation (API.md §1.4: "inserts a
        // system message", singular) — one seq bump, one msg.new fan-out,
        // however many users were added.
        await sendSystemMessage(
          req.params.id,
          'participant_added',
          toAdd.length === 1
            ? 'added to the conversation'
            : `${toAdd.length} participants were added`,
          user.id,
          toAdd.length === 1 ? toAdd[0] : undefined,
        );
        await publishConvUpdated(req.params.id, existingActive);
        await publishConvNew(req.params.id, toAdd);
      }
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.4 DELETE /api/conversations/:id — delete a group (any admin) or a
  // channel (its owner) for EVERYONE (owner ask, 2026-10-18). DMs are not
  // deletable (400 not_deletable — leave or block instead). Order matters:
  // mark every member left and fan conv.updated so each client drops the
  // conversation (connection.ts: not active any more → remove), THEN
  // hard-delete the row (messages, participants, pins, invites cascade;
  // listings/beacons that pointed at it go null), then release attachment
  // objects refcount-guarded — the §1.45 roulette-sweep recipe, by hand.
  app.delete(
    '/api/conversations/:id',
    { preHandler: requireAuth, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      const [convRow] = await db
        .select({ type: convs.type })
        .from(convs)
        .where(eq(convs.id, req.params.id))
        .limit(1);
      if (!convRow) throw notFound('conversation_not_found');
      if (convRow.type === 'dm') throw badRequest('not_deletable');
      const allowed =
        convRow.type === 'channel' ? me.role === 'owner' : me.role === 'admin' || me.role === 'owner';
      if (!allowed) throw forbidden('not_admin');

      const members = await activeParticipantUserIds(req.params.id);
      const atts = (await db.execute(sql`
        SELECT a.id, a.original_key, a.thumb_key FROM attachments a
        JOIN messages m ON m.id = a.message_id
        WHERE m.conversation_id = ${req.params.id}
      `)) as unknown as { id: string; original_key: string; thumb_key: string | null }[];

      await db.execute(sql`
        UPDATE conversation_participants SET
          left_at = now(),
          left_seq = (SELECT last_seq FROM conversations WHERE id = ${req.params.id})
        WHERE conversation_id = ${req.params.id} AND left_at IS NULL
      `);
      await publishConversationToUsers(req.params.id, members, 'conv.updated');
      await db.delete(convs).where(eq(convs.id, req.params.id));
      for (const att of atts) {
        // Rows are gone (cascade): the ref check sees only other owners.
        await deleteAttachmentObjects({
          id: att.id,
          originalKey: att.original_key,
          thumbKey: att.thumb_key,
        } as Parameters<typeof deleteAttachmentObjects>[0]);
      }
      return reply.status(204).send();
    },
  );

  // Wave 1.7 POST /api/conversations/:id/accept — I accept a DM parked in my
  // Requests. Idempotent (200 with the conversation either way); the other
  // side only sees the ordinary conv.updated.
  // Wave 1 (AUDIT-PLAN §1.6) PATCH /api/conversations/:id/mute — MY
  // participant row's muted_until (null = unmute). conversation_participants
  // .muted_until existed since 0000 with readers everywhere (pushGuard,
  // jobs/push, sounds.ts) and no writer until now. Viewer-private: the
  // conv.updated goes to me alone and participantDto clamps it to self.
  app.patch(
    '/api/conversations/:id/mute',
    { preHandler: requireAuth, schema: { params: IdParams, body: MuteConversationRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      const until = req.body.until ? new Date(req.body.until) : null;
      if (until && until.getTime() <= Date.now()) throw badRequest('mute_in_past');
      await db
        .update(cp)
        .set({ mutedUntil: until })
        .where(and(eq(cp.conversationId, req.params.id), eq(cp.userId, user.id)));
      await publishConvUpdated(req.params.id, [user.id]);
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  app.post(
    '/api/conversations/:id/accept',
    { preHandler: requireAuth, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { user } = authed(req);
      await requireActiveParticipant(req.params.id, user.id);
      if (await acceptConversation(req.params.id, user.id)) {
        await publishConvUpdated(req.params.id);
      }
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §2.5 GET /api/conversations/:id/bans — the admins' list, newest first.
  app.get(
    '/api/conversations/:id/bans',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      if (me.role !== 'admin' && me.role !== 'owner') throw forbidden('not_admin');
      const rows = await db
        .select({ b: schema.conversationBans, u: schema.users })
        .from(schema.conversationBans)
        .innerJoin(schema.users, eq(schema.conversationBans.userId, schema.users.id))
        .where(eq(schema.conversationBans.conversationId, req.params.id))
        .orderBy(desc(schema.conversationBans.createdAt));
      return {
        bans: rows.map(({ b, u }) => ({ user: userLiteDto(u), created_at: b.createdAt.toISOString() })),
      };
    },
  );

  // §2.5 DELETE /api/conversations/:id/bans/:userId — lift a ban (admins);
  // idempotent 204. Silent: the person simply finds the doors open again.
  app.delete(
    '/api/conversations/:id/bans/:userId',
    {
      preHandler: requireAuth,
      schema: { params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      if (me.role !== 'admin' && me.role !== 'owner') throw forbidden('not_admin');
      await unbanMember(req.params.id, req.params.userId);
      return reply.status(204).send();
    },
  );

  // §2.5 POST /api/conversations/:id/transfer {user_id} — hand it over in one
  // transaction: group → the target becomes admin and I become member;
  // channel (owner only) → the target becomes owner and I become admin.
  app.post(
    '/api/conversations/:id/transfer',
    { preHandler: requireAuth, schema: { params: IdParams, body: TransferConversationRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
      if (!conv || conv.type === 'dm') throw badRequest('bad_role_target');
      if (req.body.user_id === user.id) throw badRequest('bad_role_target');
      const target = await getParticipant(req.params.id, req.body.user_id);
      if (!target || target.leftAt !== null) throw notFound('participant_not_found');
      let topRole: 'admin' | 'owner';
      let myRole: 'member' | 'admin';
      if (conv.type === 'channel') {
        if (me.role !== 'owner') throw forbidden('not_admin');
        topRole = 'owner';
        myRole = 'admin';
      } else {
        if (me.role !== 'admin') throw forbidden('not_admin');
        topRole = 'admin';
        myRole = 'member';
      }
      await db.transaction(async (tx) => {
        await tx
          .update(cp)
          .set({ role: topRole })
          .where(and(eq(cp.conversationId, req.params.id), eq(cp.userId, req.body.user_id)));
        await tx
          .update(cp)
          .set({ role: myRole })
          .where(and(eq(cp.conversationId, req.params.id), eq(cp.userId, user.id)));
      });
      const recipients =
        conv.type === 'channel'
          ? [...new Set([...(await channelPrivilegedUserIds(req.params.id)), req.body.user_id, user.id])]
          : await activeParticipantUserIds(req.params.id);
      await publishConvUpdated(req.params.id, recipients);
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.4 DELETE participant — self = leave; admin = remove. Soft leave.
  app.delete(
    '/api/conversations/:id/participants/:userId',
    {
      preHandler: requireAuth,
      schema: { params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      const isSelf = req.params.userId === user.id;

      const target = await getParticipant(req.params.id, req.params.userId);
      if (!target || target.leftAt !== null) throw notFound('participant_not_found');

      const [convRow] = await db
        .select({ type: convs.type })
        .from(convs)
        .where(eq(convs.id, req.params.id))
        .limit(1);
      if (convRow?.type === 'channel') {
        // §1.35: the owner can NEVER leave or be removed — the channel must
        // never be headless (transfer/deletion is future scope).
        if (target.role === 'owner') throw forbidden('owner_cannot_leave');
        if (!isSelf) {
          // Owner/admins remove members; admins are removable by the owner only.
          if (me.role !== 'owner' && me.role !== 'admin') throw forbidden('not_admin');
          if (target.role === 'admin' && me.role !== 'owner') throw forbidden('not_admin');
        }
        // Self-leave: anyone (but the owner) leaves freely, admins included.
      } else if (!isSelf && me.role !== 'admin') {
        throw forbidden('not_admin');
      }
      // §2.5: the last admin of a group with other members cannot walk out
      // and leave it headless — hand it over first (POST .../transfer) or
      // promote someone. Named 403 like owner_cannot_leave.
      if (isSelf && convRow?.type === 'group' && me.role === 'admin') {
        const others = (await db.execute(sql`
          SELECT count(*)::int AS n, count(*) FILTER (WHERE role = 'admin')::int AS admins
          FROM conversation_participants
          WHERE conversation_id = ${req.params.id} AND left_at IS NULL AND user_id <> ${user.id}
        `)) as unknown as { n: number; admins: number }[];
        const o = others[0];
        if (o && Number(o.n) > 0 && Number(o.admins) === 0) throw forbidden('last_admin');
      }

      // left_seq = last_seq at leave time: the departed-member history floor
      // (seq <= left_seq, API.md §1.5). In DMs/groups the leave system message
      // below bumps seq past it, so the leaver does not see it.
      await db.execute(sql`
        UPDATE conversation_participants SET
          left_at = now(),
          left_seq = (SELECT last_seq FROM conversations WHERE id = ${req.params.id})
        WHERE conversation_id = ${req.params.id} AND user_id = ${req.params.userId}
      `);
      // Phase 5: out of the conversation = out of its live call too.
      await dropFromLiveCall(req.params.id, req.params.userId);
      // §2.5 (migration 0016): a REMOVE is a ban — every door (invite link,
      // public join, parked request) stays shut until an admin lets them back.
      if (!isSelf && convRow?.type !== 'dm') {
        const { droppedRequestAt } = await banMember(req.params.id, req.params.userId, user.id);
        if (droppedRequestAt) {
          const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.userId)).limit(1);
          const [c] = await db.select().from(convs).where(eq(convs.id, req.params.id)).limit(1);
          if (u && c) await fanJoinRequest(c, u, droppedRequestAt, true);
        }
      }
      // §1.35: membership is NEVER exposed to the channel member body (no
      // list, no count) — so a channel leave/remove posts NO system message,
      // mirroring the invite_joined skip on the join path. The message would
      // land on the seq log: msg.new to all 10k members, an unread bump for
      // every one of them, and (since members cannot resolve
      // metadata.system.target_id) an anonymous "left the conversation" pill.
      // Owner/admins learn of the departure through the restricted
      // conv.updated below. DMs/groups keep the §1.4 spec'd message.
      // Wave 1.7: deleting a request I never accepted is silent to the
      // sender — no system row, no frame — like a declined connection.
      const silentDecline = isSelf && target.acceptedAt === null;
      // Wave 1 (§1.8): a DM "End chat" posts no system row either — the
      // other person sees the chat go quiet, not a pill about it.
      const dmLeave = isSelf && convRow?.type === 'dm';
      if (convRow?.type !== 'channel' && !silentDecline && !dmLeave) {
        await sendSystemMessage(
          req.params.id,
          isSelf ? 'participant_left' : 'participant_removed',
          isSelf ? 'left the conversation' : 'was removed from the conversation',
          user.id,
          req.params.userId,
        );
      }
      if (silentDecline) {
        await publishConvUpdated(req.params.id, [req.params.userId]);
        return reply.status(204).send();
      }
      // §1.4: the route emits conv.updated without excluding the affected
      // user — the removed/leaving member's own live clients must learn about
      // the removal too (activeParticipantUserIds no longer includes them).
      // §1.35: in channels the member body never sees membership (no list, no
      // count), so the frame goes to owner/admins + the affected user only —
      // never a 10k fan-out per leave.
      const recipients =
        convRow?.type === 'channel'
          ? await channelPrivilegedUserIds(req.params.id)
          : await activeParticipantUserIds(req.params.id);
      if (!recipients.includes(req.params.userId)) recipients.push(req.params.userId);
      await publishConvUpdated(req.params.id, recipients);
      return reply.status(204).send();
    },
  );
}
