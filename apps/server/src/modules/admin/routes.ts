// Admin routes (v0.5b — API.md §1.41, ADR-013, FEATURES #54). The operator
// surface. Adminhood is CLI-only (grant-admin / revoke-admin — no web path);
// all routes answer 404 to non-admins (the surface does not exist for them);
// EVERY admin action appends to the Redis log ring; admin mutations targeting
// an admin account (including yourself) → 400 bad_admin_target. Binding
// boundary: no private message content in any payload, ever.
import { eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ADMIN_METRICS_WINDOW_DAYS,
  AdminActionRequestSchema,
  AdminLogsQuerySchema,
  AdminReportsQuerySchema,
  AdminUsersQuerySchema,
  CloseReportRequestSchema,
  UpdateInstanceSettingsRequestSchema,
  type AdminMetrics,
  type DayCount,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { adminLog, readLogRing } from '../../lib/logring.js';
import { authed } from '../auth/guard.js';
import { revokeAllSessions } from '../auth/service.js';
import {
  ADMIN_REPORT_SELECT,
  adminReportFromRaw,
  getInstanceSettings,
  loadAdminUserRow,
  pageAdminUsers,
  requireAdmin,
  setInstanceSetting,
  type AdminReportRaw,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });

function encodeUserCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeUserCursor(cursor: string): { ts: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep === -1) throw badRequest('bad_cursor');
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) {
    throw badRequest('bad_cursor');
  }
  return { ts, id };
}

/** Zero-filled ADMIN_METRICS_WINDOW_DAYS day series ending today (UTC). */
function fillDays(rows: { d: string; n: number | string }[]): DayCount[] {
  const byDay = new Map(rows.map((r) => [r.d, Number(r.n)]));
  const out: DayCount[] = [];
  const today = new Date();
  for (let i = ADMIN_METRICS_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 24 * 3600 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.41 GET /api/admin/users — created_at DESC, keyset-paged; coarse
  // last-seen buckets, storage sums, flags. IPs show only until the retention
  // GC ages them out — the UI shows whatever is left, never more.
  app.get(
    '/api/admin/users',
    { preHandler: requireAdmin, schema: { querystring: AdminUsersQuerySchema } },
    async (req) => {
      const { q, cursor, limit } = req.query;
      let cursorCond: SQL | null = null;
      if (cursor) {
        const { ts, id } = decodeUserCursor(cursor);
        cursorCond = sql`(u.created_at, u.id) < (${ts}::timestamptz, ${id}::uuid)`;
      }
      const rows = await pageAdminUsers(q, cursorCond, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        users: page,
        next_cursor:
          rows.length > limit && last ? encodeUserCursor(last.created_at, last.id) : null,
      };
    },
  );

  // Shared suspend/ban/unsuspend/unban plumbing: 404 unknown target, 400
  // bad_admin_target (demote via CLI first), idempotent, always ring-logged.
  async function accountAction(
    actorId: string,
    actorUsername: string,
    targetId: string,
    action: 'suspend' | 'unsuspend' | 'ban' | 'unban',
    note: string,
  ) {
    const [target] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .limit(1);
    if (!target) throw notFound();
    if (target.isAdmin) throw badRequest('bad_admin_target');

    switch (action) {
      case 'suspend':
        await db.execute(
          sql`UPDATE users SET suspended_at = COALESCE(suspended_at, now()) WHERE id = ${targetId}`,
        );
        break;
      case 'unsuspend':
        await db.execute(sql`UPDATE users SET suspended_at = NULL WHERE id = ${targetId}`);
        break;
      case 'ban':
        await db.execute(
          sql`UPDATE users SET banned_at = COALESCE(banned_at, now()) WHERE id = ${targetId}`,
        );
        break;
      case 'unban':
        await db.execute(sql`UPDATE users SET banned_at = NULL WHERE id = ${targetId}`);
        break;
    }
    if (action === 'suspend' || action === 'ban') {
      // §1.1 revocation machinery: session rows deleted, live sockets 4401.
      await revokeAllSessions(targetId);
    }
    adminLog({ id: actorId, username: actorUsername }, `admin.${action}`, {
      target_id: targetId,
      target_username: target.username,
      ...(note ? { note } : {}),
    });
    const row = await loadAdminUserRow(targetId);
    return { user: row! };
  }

  for (const action of ['suspend', 'unsuspend', 'ban', 'unban'] as const) {
    app.post(
      `/api/admin/users/:id/${action}`,
      { preHandler: requireAdmin, schema: { params: IdParams, body: AdminActionRequestSchema } },
      async (req) => {
        const { user } = authed(req);
        return accountAction(user.id, user.username, req.params.id, action, req.body.note);
      },
    );
  }

  // §1.41 GET /api/admin/reports — open first, then created_at DESC; keyset
  // over (rank, created_at, id). Metadata-only target previews; previews go
  // null where the target is gone (reports outlive their targets, v0.3).
  app.get(
    '/api/admin/reports',
    { preHandler: requireAdmin, schema: { querystring: AdminReportsQuerySchema } },
    async (req) => {
      const { status, cursor, limit } = req.query;
      const conds: SQL[] = [];
      if (status) conds.push(sql`r.status = ${status}`);
      if (cursor) {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const [rankS, ts, id] = decoded.split('|');
        if (
          (rankS !== '0' && rankS !== '1') ||
          !ts ||
          Number.isNaN(Date.parse(ts)) ||
          !z.string().uuid().safeParse(id).success
        ) {
          throw badRequest('bad_cursor');
        }
        const rank = Number(rankS);
        conds.push(sql`(
          (CASE WHEN r.status = 'open' THEN 0 ELSE 1 END) > ${rank}
          OR ((CASE WHEN r.status = 'open' THEN 0 ELSE 1 END) = ${rank}
              AND (r.created_at, r.id) < (${ts}::timestamptz, ${id}::uuid)))`);
      }
      const where = conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
      const rows = (await db.execute(sql`
        ${ADMIN_REPORT_SELECT}${where}
        ORDER BY (CASE WHEN r.status = 'open' THEN 0 ELSE 1 END) ASC, r.created_at DESC, r.id DESC
        LIMIT ${limit + 1}
      `)) as unknown as AdminReportRaw[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      let nextCursor: string | null = null;
      if (rows.length > limit && last) {
        const rank = last.status === 'open' ? 0 : 1;
        nextCursor = Buffer.from(
          `${rank}|${new Date(last.created_at).toISOString()}|${last.id}`,
          'utf8',
        ).toString('base64url');
      }
      return { reports: page.map(adminReportFromRaw), next_cursor: nextCursor };
    },
  );

  // §1.41 POST /api/admin/reports/:id/close — 409 report_closed on re-close.
  app.post(
    '/api/admin/reports/:id/close',
    { preHandler: requireAdmin, schema: { params: IdParams, body: CloseReportRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const [existing] = await db
        .select({ id: schema.reports.id, status: schema.reports.status })
        .from(schema.reports)
        .where(eq(schema.reports.id, req.params.id))
        .limit(1);
      if (!existing) throw notFound();
      if (existing.status === 'closed') throw conflict('report_closed');
      await db.execute(sql`
        UPDATE reports SET status = 'closed', closed_at = now(),
          closed_by = ${user.id}, close_note = ${req.body.note}
        WHERE id = ${req.params.id} AND status = 'open'
      `);
      adminLog({ id: user.id, username: user.username }, 'admin.report_close', {
        report_id: req.params.id,
        ...(req.body.note ? { note: req.body.note } : {}),
      });
      const rows = (await db.execute(sql`
        ${ADMIN_REPORT_SELECT} WHERE r.id = ${req.params.id} LIMIT 1
      `)) as unknown as AdminReportRaw[];
      return { report: adminReportFromRaw(rows[0]!) };
    },
  );

  // §1.41 GET /api/admin/metrics — 30-day series + totals. DAU is a PROXY:
  // distinct users whose sessions were seen that day (sliding sessions make
  // this approximate — documented honesty, not precision).
  app.get('/api/admin/metrics', { preHandler: requireAdmin }, async () => {
    const windowStart = sql`now() - (${ADMIN_METRICS_WINDOW_DAYS}::int * interval '1 day')`;
    const registrations = (await db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*)::int AS n
      FROM users WHERE created_at >= ${windowStart} GROUP BY 1
    `)) as unknown as { d: string; n: number }[];
    const active = (await db.execute(sql`
      SELECT to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
             count(DISTINCT user_id)::int AS n
      FROM sessions WHERE last_seen_at >= ${windowStart} GROUP BY 1
    `)) as unknown as { d: string; n: number }[];
    const messages = (await db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*)::int AS n
      FROM messages WHERE created_at >= ${windowStart} GROUP BY 1
    `)) as unknown as { d: string; n: number }[];
    const [totals] = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users) AS users_total,
        (SELECT count(*)::int FROM beacons WHERE status = 'open') AS open_beacons,
        (SELECT count(*)::int FROM listings
          WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS active_listings,
        (SELECT count(*)::int FROM reports WHERE status = 'open') AS open_reports,
        (SELECT COALESCE(sum(size_bytes), 0) FROM attachments) AS storage_total_bytes
    `)) as unknown as {
      users_total: number;
      open_beacons: number;
      active_listings: number;
      open_reports: number;
      storage_total_bytes: string | number;
    }[];
    const metrics: AdminMetrics = {
      registrations_per_day: fillDays(registrations),
      active_users_per_day: fillDays(active),
      messages_per_day: fillDays(messages),
      users_total: Number(totals?.users_total ?? 0),
      open_beacons: Number(totals?.open_beacons ?? 0),
      active_listings: Number(totals?.active_listings ?? 0),
      open_reports: Number(totals?.open_reports ?? 0),
      storage_total_bytes: Number(totals?.storage_total_bytes ?? 0),
    };
    return { metrics };
  });

  // §1.41 GET /api/admin/logs — the capped Redis ring, newest first,
  // offset-paged (a ring has no stable cursors).
  app.get(
    '/api/admin/logs',
    { preHandler: requireAdmin, schema: { querystring: AdminLogsQuerySchema } },
    async (req) => {
      return readLogRing(req.query.offset, req.query.limit);
    },
  );

  // §1.41 GET/PATCH /api/admin/settings — invites_enabled: enforced at invite
  // mint AND accept (403 invites_disabled); register-with-token degrades to
  // invite: null (§1.1). Ring-logged.
  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    return { settings: await getInstanceSettings() };
  });

  app.patch(
    '/api/admin/settings',
    { preHandler: requireAdmin, schema: { body: UpdateInstanceSettingsRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      if (req.body.invites_enabled !== undefined) {
        await setInstanceSetting('invites_enabled', req.body.invites_enabled);
        adminLog({ id: user.id, username: user.username }, 'admin.settings_update', {
          invites_enabled: req.body.invites_enabled,
        });
      }
      // v0.8a (§1.61): curation of the what's-new list — migrations remain
      // the normal writer; ring-logged like every admin write.
      if (req.body.release_notes !== undefined) {
        await setInstanceSetting('release_notes', req.body.release_notes);
        adminLog({ id: user.id, username: user.username }, 'admin.settings_update', {
          release_notes: req.body.release_notes.map((n) => n.version),
        });
      }
      return { settings: await getInstanceSettings() };
    },
  );

  // §1.41 GET /api/admin/users/:id/export — the user's OWN rows: users row
  // (secrets stripped), session METADATA (no token_hash), listings, posts,
  // reviews received. NOT their messages — a member's conversations contain
  // their counterparties' words; bulk operator access to those is exactly what
  // this product promises not to build (ADR-013).
  app.get(
    '/api/admin/users/:id/export',
    { preHandler: requireAdmin, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const userRows = (await db.execute(sql`
        SELECT row_to_json(u.*) AS u FROM users u WHERE u.id = ${req.params.id} LIMIT 1
      `)) as unknown as { u: Record<string, unknown> }[];
      if (userRows.length === 0) throw notFound();
      const { password_hash: _ph, ...userRow } = userRows[0]!.u;

      const sessions = (await db.execute(sql`
        SELECT id, user_id, user_agent, ip, created_at, last_seen_at, expires_at
        FROM sessions WHERE user_id = ${req.params.id} ORDER BY created_at DESC
      `)) as unknown as Record<string, unknown>[];
      const listings = (await db.execute(sql`
        SELECT row_to_json(l.*) AS r FROM listings l
        WHERE l.author_id = ${req.params.id} ORDER BY l.created_at DESC
      `)) as unknown as { r: Record<string, unknown> }[];
      const posts = (await db.execute(sql`
        SELECT row_to_json(p.*) AS r FROM posts p
        WHERE p.author_id = ${req.params.id} ORDER BY p.created_at DESC
      `)) as unknown as { r: Record<string, unknown> }[];
      const reviews = (await db.execute(sql`
        SELECT row_to_json(pr.*) AS r FROM person_reviews pr
        WHERE pr.subject_id = ${req.params.id} ORDER BY pr.created_at DESC
      `)) as unknown as { r: Record<string, unknown> }[];

      adminLog({ id: user.id, username: user.username }, 'admin.user_export', {
        target_id: req.params.id,
      });
      return {
        export: {
          exported_at: new Date().toISOString(),
          user: userRow,
          sessions,
          listings: listings.map((x) => x.r),
          posts: posts.map((x) => x.r),
          reviews_received: reviews.map((x) => x.r),
        },
      };
    },
  );
}
