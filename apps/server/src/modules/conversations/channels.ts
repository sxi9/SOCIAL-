// Channel management (v0.5a — API.md §1.35, FEATURES #46, ADR-011): role
// assignment and the paged member read. The Conversation DTO for channels
// carries only the viewer's own row + owner + admins (lib/dto.ts), so the
// member list lives behind this dedicated paged read — owner/admin-only in
// channels (the member body never sees membership, and NO member count is
// ever serialized anywhere — PSYCHOLOGY rule 3).
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ListParticipantsQuerySchema,
  UpdateParticipantRoleRequestSchema,
  type Participant,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import {
  activeParticipantUserIds,
  loadConversationDto,
  participantDto,
  viewCtxFor,
} from '../../lib/dto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import {
  channelPrivilegedUserIds,
  getParticipant,
  requireActiveParticipant,
} from './routes.js';
import { publishConversationToUsers } from '../../lib/dto.js';

const cp = schema.conversationParticipants;

export async function channelRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.35 PUT /api/conversations/:id/participants/:userId/role
  // {role: 'admin'|'member'} — channels: OWNER only; groups: any admin.
  // 'owner' is never assignable; the owner's own role never changes.
  app.put(
    '/api/conversations/:id/participants/:userId/role',
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
        body: UpdateParticipantRoleRequestSchema,
      },
    },
    async (req) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, req.params.id))
        .limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type === 'dm') throw badRequest('bad_role_target');
      if (conv.type === 'channel') {
        if (me.role !== 'owner') throw forbidden();
      } else if (me.role !== 'admin') {
        throw forbidden('not_admin');
      }

      const target = await getParticipant(req.params.id, req.params.userId);
      if (!target || target.leftAt !== null) throw notFound('participant_not_found');
      // The owner's own role is never changeable (and 'owner' itself is never
      // assignable — the request schema only admits admin|member).
      if (target.role === 'owner') throw badRequest('bad_role_target');

      // §2.5: the last admin of a group with other members cannot demote
      // themselves into a headless group — transfer first.
      if (
        conv.type === 'group' &&
        req.params.userId === user.id &&
        req.body.role === 'member' &&
        target.role === 'admin'
      ) {
        const others = (await db.execute(sql`
          SELECT count(*)::int AS n, count(*) FILTER (WHERE role = 'admin')::int AS admins
          FROM conversation_participants
          WHERE conversation_id = ${req.params.id} AND left_at IS NULL AND user_id <> ${user.id}
        `)) as unknown as { n: number; admins: number }[];
        const o = others[0];
        if (o && Number(o.n) > 0 && Number(o.admins) === 0) throw forbidden('last_admin');
      }

      if (target.role !== req.body.role) {
        await db
          .update(cp)
          .set({ role: req.body.role })
          .where(and(eq(cp.conversationId, req.params.id), eq(cp.userId, req.params.userId)));
        // §1.35: membership-level frames reach owner/admins + the affected
        // member in channels; groups fan to everyone as usual.
        const recipients =
          conv.type === 'channel'
            ? [...new Set([...(await channelPrivilegedUserIds(req.params.id)), req.params.userId])]
            : await activeParticipantUserIds(req.params.id);
        await publishConversationToUsers(req.params.id, recipients, 'conv.updated');
      }
      const dto = await loadConversationDto(req.params.id, await viewCtxFor(user));
      return { conversation: dto };
    },
  );

  // §1.35 GET /api/conversations/:id/participants?cursor=&limit=&q= — ordered
  // by username (keyset on username,user_id); `q` is the username/display-name
  // prefix filter powering §1.33 mention autocomplete. Channels: owner/admin
  // only (403); groups/DMs: any active participant. Blocked users serialize
  // normally here (membership is group function, §1.14).
  app.get(
    '/api/conversations/:id/participants',
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: ListParticipantsQuerySchema,
      },
    },
    async (req) => {
      const { user } = authed(req);
      const me = await requireActiveParticipant(req.params.id, user.id);
      const [conv] = await db
        .select({ type: schema.conversations.type })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, req.params.id))
        .limit(1);
      if (!conv) throw notFound('conversation_not_found');
      if (conv.type === 'channel' && me.role !== 'owner' && me.role !== 'admin') {
        throw forbidden();
      }

      const { cursor, limit, q } = req.query;
      const conditions = [eq(cp.conversationId, req.params.id), isNull(cp.leftAt)];
      if (q) {
        const esc = q.replace(/[%_\\]/g, (ch) => `\\${ch}`);
        conditions.push(
          sql`(${schema.users.username} ILIKE ${`${esc}%`} OR ${schema.users.displayName} ILIKE ${`${esc}%`})`,
        );
      }
      if (cursor) {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const sep = decoded.lastIndexOf('|');
        if (sep === -1) throw badRequest('bad_cursor');
        const uname = decoded.slice(0, sep);
        const uid = decoded.slice(sep + 1);
        if (!z.string().uuid().safeParse(uid).success) throw badRequest('bad_cursor');
        conditions.push(
          sql`(lower(${schema.users.username}::text), ${schema.users.id}) > (${uname}, ${uid}::uuid)`,
        );
      }

      const rows = await db
        .select({ p: cp, u: schema.users })
        .from(cp)
        .innerJoin(schema.users, eq(cp.userId, schema.users.id))
        .where(and(...conditions))
        .orderBy(sql`lower(${schema.users.username}::text) ASC`, sql`${schema.users.id} ASC`)
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const view = await viewCtxFor(user);
      const participants: Participant[] = page.map(({ p, u }) => participantDto(p, u, view));
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? Buffer.from(`${last.u.username.toLowerCase()}|${last.u.id}`, 'utf8').toString(
              'base64url',
            )
          : null;
      return { participants, next_cursor: nextCursor };
    },
  );
}
