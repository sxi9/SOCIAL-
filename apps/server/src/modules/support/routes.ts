// Support inbox routes (v0.8b — API.md §1.69, FEATURES #81b, ADR-020). The
// user-facing intake (Settings → Help & feedback) + the admin inbox. Admin
// surfaces answer 404 to everyone else; every admin action is ring-logged.
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AdminSupportReplyRequestSchema,
  CreateSupportTicketRequestSchema,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  SUPPORT_TICKET_RATE_PER_DAY,
  type AdminSupportTicket,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { badRequest, notFound, rateLimited } from '../../lib/errors.js';
import { adminLog } from '../../lib/logring.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { messageDtos, rawToMsgRow, userLiteDto } from '../../lib/dto.js';
import { authed, requireAuth } from '../auth/guard.js';
import { requireAdmin } from '../admin/service.js';
import {
  ensureSupportConversation,
  sendSupportMessage,
  supportTicketDto,
  validSupportAttachment,
  type SupportTicketRow,
} from './service.js';

const st = schema.supportTickets;
const IdParams = z.object({ id: z.string().uuid() });

const AdminSupportQuery = z.object({
  status: z.enum(['open', 'answered', 'closed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

async function adminTicketDto(row: SupportTicketRow): Promise<AdminSupportTicket> {
  const base = await supportTicketDto(row);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
  return { ...base, user: u ? userLiteDto(u) : null };
}

export async function supportRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.69 POST /api/support/tickets — the intake. No fan-out (the inbox is
  // pull for admins).
  app.post(
    '/api/support/tickets',
    { preHandler: requireAuth, schema: { body: CreateSupportTicketRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(
        `supportticket:${user.id}`,
        SUPPORT_TICKET_RATE_PER_DAY,
        86_400,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      if (req.body.attachment_id && !(await validSupportAttachment(req.body.attachment_id, user.id))) {
        throw badRequest('bad_attachment');
      }
      const [row] = await db
        .insert(st)
        .values({
          id: newId(),
          userId: user.id,
          category: req.body.category,
          body: req.body.body,
          attachmentId: req.body.attachment_id ?? null,
        })
        .returning();
      return reply.status(201).send({ ticket: await supportTicketDto(row!) });
    },
  );

  // §1.69 GET /api/support/tickets — mine, created_at DESC.
  app.get('/api/support/tickets', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select()
      .from(st)
      .where(eq(st.userId, user.id))
      .orderBy(sql`${st.createdAt} DESC`)
      .limit(100);
    const tickets = [];
    for (const row of rows) tickets.push(await supportTicketDto(row));
    return { tickets };
  });

  // §1.69 GET /api/admin/support — the inbox: open first, then created_at DESC.
  app.get(
    '/api/admin/support',
    { preHandler: requireAdmin, schema: { querystring: AdminSupportQuery } },
    async (req) => {
      const { status, cursor, limit } = req.query;
      const conds = [];
      if (status) conds.push(sql`t.status = ${status}`);
      if (cursor) {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const [rankS, ts, id] = decoded.split('|');
        if ((rankS !== '0' && rankS !== '1') || !ts || Number.isNaN(Date.parse(ts)) || !id) {
          throw badRequest('bad_cursor');
        }
        conds.push(sql`(
          (CASE WHEN t.status = 'open' THEN 0 ELSE 1 END) > ${Number(rankS)}
          OR ((CASE WHEN t.status = 'open' THEN 0 ELSE 1 END) = ${Number(rankS)}
              AND (t.created_at, t.id) < (${ts}::timestamptz, ${id}::uuid)))`);
      }
      const where = conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
      const raw = (await db.execute(sql`
        SELECT t.id FROM support_tickets t${where}
        ORDER BY (CASE WHEN t.status = 'open' THEN 0 ELSE 1 END) ASC, t.created_at DESC, t.id DESC
        LIMIT ${limit + 1}
      `)) as unknown as { id: string }[];
      const pageIds = raw.slice(0, limit).map((r) => r.id);
      const tickets: AdminSupportTicket[] = [];
      let lastRow: SupportTicketRow | null = null;
      for (const id of pageIds) {
        const [row] = await db.select().from(st).where(eq(st.id, id)).limit(1);
        if (!row) continue;
        lastRow = row;
        tickets.push(await adminTicketDto(row));
      }
      let nextCursor: string | null = null;
      if (raw.length > limit && lastRow) {
        const rank = lastRow.status === 'open' ? 0 : 1;
        nextCursor = Buffer.from(
          `${rank}|${lastRow.createdAt.toISOString()}|${lastRow.id}`,
          'utf8',
        ).toString('base64url');
      }
      return { tickets, next_cursor: nextCursor };
    },
  );

  // §1.69 GET /api/admin/support/:id — the ticket + the user's Support-
  // conversation dialogue. NOT private-chat reading: the Support conversation
  // exists to talk to the operator — consent is structural (ADR-020).
  app.get(
    '/api/admin/support/:id',
    { preHandler: requireAdmin, schema: { params: IdParams } },
    async (req) => {
      const [row] = await db.select().from(st).where(eq(st.id, req.params.id)).limit(1);
      if (!row) throw notFound();
      const rows = (await db.execute(sql`
        SELECT m.* FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ${row.userId}
        WHERE c.metadata @> '{"support": true}'::jsonb
        ORDER BY m.seq ASC
        LIMIT 500
      `)) as unknown as Record<string, unknown>[];
      const messages = await messageDtos(rows.map(rawToMsgRow));
      return { ticket: await adminTicketDto(row), messages };
    },
  );

  // §1.69 POST /api/admin/support/:id/reply — lazily create the user's
  // Support conversation, insert the reply (sender_id NULL +
  // metadata.support), set the ticket 'answered'. A support answer is a
  // message like any other (msg.new + §2.9 push).
  app.post(
    '/api/admin/support/:id/reply',
    { preHandler: requireAdmin, schema: { params: IdParams, body: AdminSupportReplyRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db.select().from(st).where(eq(st.id, req.params.id)).limit(1);
      if (!row) throw notFound();
      await ensureSupportConversation(row.userId);
      await sendSupportMessage(row.userId, req.body.body, row.id);
      const [updated] = await db
        .update(st)
        .set({ status: 'answered', updatedAt: new Date() })
        .where(eq(st.id, row.id))
        .returning();
      adminLog({ id: user.id, username: user.username }, 'admin.support_reply', {
        ticket_id: row.id,
        user_id: row.userId,
      });
      return { ticket: await adminTicketDto(updated!) };
    },
  );

  // §1.69 POST /api/admin/support/:id/close — idempotent; ring-logged.
  app.post(
    '/api/admin/support/:id/close',
    {
      preHandler: requireAdmin,
      schema: { params: IdParams, body: z.object({ note: z.string().max(500).default('') }) },
    },
    async (req) => {
      const { user } = authed(req);
      const [row] = await db.select().from(st).where(eq(st.id, req.params.id)).limit(1);
      if (!row) throw notFound();
      const [updated] =
        row.status === 'closed'
          ? [row]
          : await db
              .update(st)
              .set({ status: 'closed', updatedAt: new Date() })
              .where(eq(st.id, row.id))
              .returning();
      adminLog({ id: user.id, username: user.username }, 'admin.support_close', {
        ticket_id: row.id,
        ...(req.body.note ? { note: req.body.note } : {}),
      });
      return { ticket: await adminTicketDto(updated!) };
    },
  );
}
