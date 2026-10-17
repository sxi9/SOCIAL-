// Admin content tab, takedowns, report-context viewer & update banner
// (v0.8b — API.md §1.69, FEATURES #81, ADR-020). All §1.41 framing holds:
// admin-only (404-shaped to everyone else), every action ring-logged, NO
// private-message reader — the content tab is PUBLIC surfaces only
// (structurally: private chats and friends-only objects are not representable
// in its query), and the ONE bounded exception (the consented context viewer)
// opens only where the REPORTER chose include_context at report time.
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AdminContentQuerySchema,
  REPORT_CONTEXT_RADIUS,
  TakedownRequestSchema,
  type AdminContentRow,
  type AdminContextMessage,
  type AdminUpdateStatus,
} from '@socialchat/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { userLiteDto } from '../../lib/dto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { adminLog } from '../../lib/logring.js';
import { redis } from '../../redis.js';
import { authed } from '../auth/guard.js';
import { hardDeletePost, loadPost } from '../feed/service.js';
import { fanBeacon, loadBeacon } from '../beacons/service.js';
import { revokeShareTokensFor } from '../sharepages/service.js';
import { sendSupportMessage } from '../support/service.js';
import { getInstanceSettings, requireAdmin } from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const TakedownParams = z.object({
  type: z.enum(['post', 'beacon', 'listing']),
  id: z.string().uuid(),
});

export const UPDATE_CHECK_REDIS_KEY = 'update:check';

interface ContentRaw {
  type: string;
  id: string;
  author_id: string;
  title: string;
  excerpt: string;
  status: string;
  created_at: string | Date;
}

export async function adminContentRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.69 GET /api/admin/content — PUBLIC surfaces ONLY: audience='public'
  // posts, audience='public' beacons, ALL board listings (instance-readable
  // by design). created_at DESC, keyset over (created_at, id).
  app.get(
    '/api/admin/content',
    { preHandler: requireAdmin, schema: { querystring: AdminContentQuerySchema } },
    async (req) => {
      const { type, q, cursor, limit } = req.query;
      const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
      let cursorCond = sql``;
      if (cursor) {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const sep = decoded.lastIndexOf('|');
        const ts = decoded.slice(0, sep);
        const id = decoded.slice(sep + 1);
        if (sep === -1 || Number.isNaN(Date.parse(ts))) throw badRequest('bad_cursor');
        cursorCond = sql`WHERE (t.created_at, t.id) < (${ts}::timestamptz, ${id}::uuid)`;
      }
      const parts = [];
      if (!type || type === 'post') {
        parts.push(sql`
          SELECT 'post' AS type, p.id, p.author_id, '' AS title,
                 left(p.body, 80) AS excerpt, 'active' AS status, p.created_at
          FROM posts p
          WHERE p.audience = 'public'
            ${like ? sql`AND p.body ILIKE ${like}` : sql``}`);
      }
      if (!type || type === 'beacon') {
        parts.push(sql`
          SELECT 'beacon' AS type, b.id, b.creator_id AS author_id,
                 COALESCE(b.custom_vibe_label, b.vibe) AS title,
                 left(b.note, 80) AS excerpt, b.status, b.created_at
          FROM beacons b
          WHERE b.audience = 'public'
            ${like ? sql`AND (b.note ILIKE ${like} OR b.vibe ILIKE ${like} OR b.custom_vibe_label ILIKE ${like})` : sql``}`);
      }
      if (!type || type === 'listing') {
        parts.push(sql`
          SELECT 'listing' AS type, l.id, l.author_id, l.title,
                 left(l.body, 80) AS excerpt, l.status, l.created_at
          FROM listings l
          ${like ? sql`WHERE (l.title ILIKE ${like} OR l.body ILIKE ${like})` : sql``}`);
      }
      const union = sql.join(parts, sql` UNION ALL `);
      const rows = (await db.execute(sql`
        SELECT t.* FROM (${union}) t
        ${cursorCond}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limit + 1}
      `)) as unknown as ContentRaw[];

      const page = rows.slice(0, limit);
      const authorIds = [...new Set(page.map((r) => r.author_id))];
      const authors =
        authorIds.length > 0
          ? await db
              .select()
              .from(schema.users)
              .where(
                sql`${schema.users.id} IN (${sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
              )
          : [];
      const byId = new Map(authors.map((u) => [u.id, u]));
      const items: AdminContentRow[] = page.map((r) => ({
        type: r.type as AdminContentRow['type'],
        id: r.id,
        author: byId.has(r.author_id) ? userLiteDto(byId.get(r.author_id)!) : null,
        title: r.title,
        excerpt: r.excerpt,
        status: r.status,
        created_at: new Date(r.created_at).toISOString(),
      }));
      const last = page[page.length - 1];
      return {
        items,
        next_cursor:
          rows.length > limit && last
            ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`, 'utf8').toString(
                'base64url',
              )
            : null,
      };
    },
  );

  // §1.69 POST /api/admin/content/:type/:id/takedown — removes via the owning
  // module's own semantics, neutrally notifies the author through their
  // Support conversation (sender_id NULL — never a named admin), ring-logs.
  // 400 bad_admin_target for an admin's own content (demote first, §1.41).
  app.post(
    '/api/admin/content/:type/:id/takedown',
    { preHandler: requireAdmin, schema: { params: TakedownParams, body: TakedownRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const { type, id } = req.params;
      const reason = req.body.reason;

      let authorId: string;
      if (type === 'post') {
        const row = await loadPost(id);
        if (!row) throw notFound();
        authorId = row.authorId;
        await assertNotAdmin(authorId);
        await hardDeletePost(row); // the §1.36 delete cascade + token revoke
      } else if (type === 'beacon') {
        const row = await loadBeacon(id);
        if (!row) throw notFound();
        authorId = row.creatorId;
        await assertNotAdmin(authorId);
        await db.execute(sql`UPDATE beacons SET status = 'cancelled' WHERE id = ${id}`);
        await revokeShareTokensFor(db, 'beacon', id);
        const fresh = await loadBeacon(id);
        if (fresh) await fanBeacon(fresh, 'beacon.updated'); // the §1.15 fan-out
      } else {
        const [l] = await db
          .select()
          .from(schema.listings)
          .where(eq(schema.listings.id, id))
          .limit(1);
        if (!l) throw notFound();
        authorId = l.authorId;
        await assertNotAdmin(authorId);
        await revokeShareTokensFor(db, 'listing', id);
        // The author-delete path: the row goes; contacts cascade; photos
        // unbind (FK SET NULL) into the orphan GC; reviews survive (§1.40).
        await db.execute(sql`DELETE FROM listings WHERE id = ${id}`);
      }

      // One neutral Support-conversation message — never a public mark.
      await sendSupportMessage(
        authorId,
        `A moderator removed your ${type}. Reason: ${reason}`,
        null,
      );
      adminLog({ id: user.id, username: user.username }, 'admin.takedown', {
        type,
        id,
        author_id: authorId,
        reason,
      });
      return { ok: true as const };
    },
  );

  // §1.69 GET /api/admin/reports/:id/context — THE one admin surface with
  // message bodies, and ONLY because the reporter consented at report time.
  // 404 report_context_unavailable byte-identical for wrong-kind / no-consent
  // / unknown (consent is never probeable). Every call is ring-logged.
  app.get(
    '/api/admin/reports/:id/context',
    { preHandler: requireAdmin, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const [report] = await db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.id, req.params.id))
        .limit(1);
      if (
        !report ||
        report.kind !== 'message' ||
        !report.contextConsent ||
        !report.targetConversationId ||
        report.targetSeq === null
      ) {
        throw notFound('report_context_unavailable');
      }
      const lo = Math.max(1, report.targetSeq - REPORT_CONTEXT_RADIUS);
      const hi = report.targetSeq + REPORT_CONTEXT_RADIUS;
      // Resolved LIVE: tombstones render deleted, edits show current text.
      // Ghost masks do NOT apply (the server was never anonymous, §1.68).
      const rows = (await db.execute(sql`
        SELECT m.id, m.seq, m.type, m.body, m.created_at, m.deleted_at,
               row_to_json(u.*) AS sender
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${report.targetConversationId}
          AND m.seq BETWEEN ${lo}::bigint AND ${hi}::bigint
        ORDER BY m.seq ASC
      `)) as unknown as {
        id: string;
        seq: string | number;
        type: string;
        body: string | null;
        created_at: string | Date;
        deleted_at: string | Date | null;
        sender: Record<string, unknown> | null;
      }[];
      const msgIds = rows.map((r) => r.id);
      const attRows =
        msgIds.length > 0
          ? ((await db.execute(sql`
              SELECT message_id, kind, mime FROM attachments
              WHERE message_id IN (${sql.join(msgIds.map((i) => sql`${i}::uuid`), sql`, `)})
              ORDER BY created_at ASC
            `)) as unknown as { message_id: string; kind: string; mime: string }[])
          : [];
      const attsByMsg = new Map<string, { kind: string; mime: string }[]>();
      for (const a of attRows) {
        const list = attsByMsg.get(a.message_id) ?? [];
        list.push({ kind: a.kind, mime: a.mime });
        attsByMsg.set(a.message_id, list);
      }
      const senderIds = [
        ...new Set(
          rows
            .map((r) => (r.sender as { id?: string } | null)?.id)
            .filter((v): v is string => Boolean(v)),
        ),
      ];
      const users =
        senderIds.length > 0
          ? await db
              .select()
              .from(schema.users)
              .where(
                sql`${schema.users.id} IN (${sql.join(senderIds.map((i) => sql`${i}::uuid`), sql`, `)})`,
              )
          : [];
      const userById = new Map(users.map((u) => [u.id, u]));
      const messages: AdminContextMessage[] = rows.map((r) => {
        const senderId = (r.sender as { id?: string } | null)?.id ?? null;
        const deleted = r.deleted_at !== null;
        return {
          seq: Number(r.seq),
          sender: senderId && userById.has(senderId) ? userLiteDto(userById.get(senderId)!) : null,
          type: r.type as AdminContextMessage['type'],
          body: deleted ? null : r.body,
          // Attachments are kind/mime METADATA only — no admin media URLs.
          attachments: (attsByMsg.get(r.id) ?? []).map((a) => ({
            kind: a.kind as 'image' | 'video' | 'file' | 'audio',
            mime: a.mime,
          })),
          created_at: new Date(r.created_at).toISOString(),
          deleted,
          reported: Number(r.seq) === report.targetSeq,
        };
      });
      adminLog({ id: user.id, username: user.username }, 'admin.report_context_view', {
        report_id: report.id,
      });
      return { context: { conversation_id: report.targetConversationId, messages } };
    },
  );

  // §1.69 GET /api/admin/update — the "update available" banner's read.
  app.get('/api/admin/update', { preHandler: requireAdmin }, async () => {
    const settings = await getInstanceSettings();
    let latestCommit: string | null = null;
    let checkedAt: string | null = null;
    try {
      const cached = await redis.get(UPDATE_CHECK_REDIS_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { latest_commit?: string; checked_at?: string };
        latestCommit = parsed.latest_commit ?? null;
        checkedAt = parsed.checked_at ?? null;
      }
    } catch {
      // cache miss / parse hiccup — honesty below handles it
    }
    const update: AdminUpdateStatus = {
      running_commit: config.gitCommit,
      running_version: settings.release_notes[0]?.version ?? null,
      latest_commit: latestCommit,
      // NULL when unknown (no commit baked, or remote unreachable) — never a
      // guess. The update itself runs on the HOST (./bored update).
      update_available:
        config.gitCommit && latestCommit ? config.gitCommit !== latestCommit : null,
      checked_at: checkedAt,
    };
    return { update };
  });
}

async function assertNotAdmin(userId: string): Promise<void> {
  const [u] = await db
    .select({ isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (u?.isAdmin) throw badRequest('bad_admin_target');
}
