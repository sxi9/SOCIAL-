// Admin service (v0.5b — API.md §1.41, ADR-013). The operator surface's
// guard, row loaders and instance settings. Binding boundary: NOTHING in this
// module reads or serializes private message bodies — a reported message is
// who/where/when/what-kind, and the export is the user's own rows minus
// secrets, minus messages.
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ReleaseNoteSchema,
  type AdminReport,
  type AdminUserRow,
  type InstanceSettings,
  type LastSeenBucket,
  type MessageType,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { avatarDto } from '../../lib/dto.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, authed } from '../auth/guard.js';

// ---------------------------------------------------------------------------
// Guard: /api/admin/* requires is_admin AND a non-suspended, non-banned
// account; for everyone else the surface answers 404 not_found — it does not
// exist (the §1.14 shape). Adminhood itself is CLI-only (ADR-013).
// ---------------------------------------------------------------------------

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  const { user } = authed(req);
  if (!user.isAdmin || user.suspendedAt !== null || user.bannedAt !== null) {
    throw notFound('not_found');
  }
}

// ---------------------------------------------------------------------------
// Instance settings (key PK + jsonb value; seeded by migrations 0006/0009).
// ---------------------------------------------------------------------------

const ReleaseNotesListSchema = z.array(ReleaseNoteSchema);

export async function getInstanceSettings(): Promise<InstanceSettings> {
  const rows = await db
    .select()
    .from(schema.instanceSettings)
    .where(inArray(schema.instanceSettings.key, ['invites_enabled', 'release_notes']));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const invites = byKey.get('invites_enabled');
  // v0.8a (§1.61): the what's-new list rides the settings DTO; a malformed
  // blob degrades to [] instead of refusing the whole admin read.
  const notes = ReleaseNotesListSchema.safeParse(byKey.get('release_notes') ?? []);
  return {
    invites_enabled: invites === undefined ? true : invites === true,
    release_notes: notes.success ? notes.data : [],
  };
}

/** §1.41: invites_enabled is enforced at invite MINT and ACCEPT. */
export async function invitesEnabled(): Promise<boolean> {
  return (await getInstanceSettings()).invites_enabled;
}

export async function setInstanceSetting(key: string, value: unknown): Promise<void> {
  await db.execute(sql`
    INSERT INTO instance_settings (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
  `);
}

// ---------------------------------------------------------------------------
// AdminUserRow loading (§1.41): coarse last-seen bucket (liveness, not a
// surveillance feed), session metadata, storage sum.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

export function lastSeenBucketOf(lastSeenAt: Date | null): LastSeenBucket {
  if (!lastSeenAt) return 'never';
  const age = Date.now() - lastSeenAt.getTime();
  if (age < DAY_MS) return 'today';
  if (age < 7 * DAY_MS) return 'this_week';
  if (age < 30 * DAY_MS) return 'this_month';
  return 'older';
}

interface AdminUserRaw {
  u: Record<string, unknown>;
  session_count: number;
  storage_bytes: string | number;
  ls_ip: string | null;
  ls_ua: string | null;
  ls_seen: string | Date | null;
}

function adminUserRowFromRaw(r: AdminUserRaw): AdminUserRow {
  const u = r.u;
  // Fixer r1: presence-derived users.last_seen_at can lag (or be NULL for a
  // user who logged in but never connected WS), which read as "never" next to
  // a fresh session timestamp. Bucket on the newest of presence and the most
  // recent session's last_seen_at — still coarse, never contradictory.
  const presenceSeen = u.last_seen_at ? new Date(u.last_seen_at as string) : null;
  const sessionSeen = r.ls_seen ? new Date(r.ls_seen) : null;
  const lastSeen =
    presenceSeen && sessionSeen
      ? presenceSeen.getTime() >= sessionSeen.getTime()
        ? presenceSeen
        : sessionSeen
      : (presenceSeen ?? sessionSeen);
  return {
    id: u.id as string,
    username: u.username as string,
    display_name: u.display_name as string,
    created_at: new Date(u.created_at as string).toISOString(),
    last_seen_bucket: lastSeenBucketOf(lastSeen),
    registration_ip: (u.registration_ip as string | null) ?? null,
    last_session: r.ls_seen
      ? {
          ip: r.ls_ip,
          user_agent: r.ls_ua,
          last_seen_at: new Date(r.ls_seen).toISOString(),
        }
      : null,
    session_count: Number(r.session_count),
    storage_bytes: Number(r.storage_bytes),
    is_admin: u.is_admin === true,
    suspended: u.suspended_at !== null && u.suspended_at !== undefined,
    banned: u.banned_at !== null && u.banned_at !== undefined,
  };
}

const ADMIN_USER_SELECT = sql`
  SELECT row_to_json(u.*) AS u,
    (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id) AS session_count,
    COALESCE((SELECT sum(a.size_bytes) FROM attachments a WHERE a.uploader_id = u.id), 0) AS storage_bytes,
    ls.ip AS ls_ip, ls.user_agent AS ls_ua, ls.last_seen_at AS ls_seen
  FROM users u
  LEFT JOIN LATERAL (
    SELECT ip, user_agent, last_seen_at FROM sessions
    WHERE user_id = u.id ORDER BY last_seen_at DESC LIMIT 1
  ) ls ON true`;

export async function pageAdminUsers(
  q: string | undefined,
  cursorCond: SQL | null,
  limit: number,
): Promise<AdminUserRow[]> {
  const conds: SQL[] = [];
  if (q) {
    const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
    conds.push(
      sql`(u.username ILIKE ${escaped + '%'} OR u.display_name ILIKE ${escaped + '%'})`,
    );
  }
  if (cursorCond) conds.push(cursorCond);
  const where = conds.length > 0 ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  const rows = (await db.execute(sql`
    ${ADMIN_USER_SELECT}${where}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${limit}
  `)) as unknown as AdminUserRaw[];
  return rows.map(adminUserRowFromRaw);
}

export async function loadAdminUserRow(id: string): Promise<AdminUserRow | null> {
  const rows = (await db.execute(sql`
    ${ADMIN_USER_SELECT}
    WHERE u.id = ${id}
    LIMIT 1
  `)) as unknown as AdminUserRaw[];
  return rows.length > 0 ? adminUserRowFromRaw(rows[0]!) : null;
}

// ---------------------------------------------------------------------------
// AdminReport assembly (§1.41): metadata-only target previews. The reporter's
// own `reason` is the only quoted content; a reported message serializes
// who/where/when/what-kind — NEVER its body.
// ---------------------------------------------------------------------------

function rawUserLite(o: Record<string, unknown> | null): UserLite | null {
  if (!o) return null;
  return {
    id: o.id as string,
    username: o.username as string,
    display_name: o.display_name as string,
    avatar: avatarDto({
      avatarStatus: o.avatar_status as string,
      avatarVersion: Number(o.avatar_version),
      avatarStaticKey: (o.avatar_static_key as string | null) ?? null,
      avatarAnimatedKey: (o.avatar_animated_key as string | null) ?? null,
    }),
    // v0.8a: moods never serialize into the operator surface (§1.57 — the
    // admin is not in anyone's visibility set); name_style is identity.
    mood: null,
    name_style: (((o.name_style as string | undefined) ?? 'none') as UserLite['name_style']),
  };
}

export interface AdminReportRaw {
  id: string;
  kind: string;
  reason: string;
  status: string;
  created_at: string | Date;
  closed_at: string | Date | null;
  close_note: string;
  reporter: Record<string, unknown> | null;
  closed_by_user: Record<string, unknown> | null;
  target_user: Record<string, unknown> | null;
  tm_conversation_id: string | null;
  tm_seq: string | number | null;
  tm_type: string | null;
  tm_created_at: string | Date | null;
  tm_deleted: boolean | null;
  tm_sender: Record<string, unknown> | null;
  tb_id: string | null;
  tb_vibe: string | null;
  tb_status: string | null;
  tb_creator: Record<string, unknown> | null;
}

export const ADMIN_REPORT_SELECT = sql`
  SELECT r.id, r.kind, r.reason, r.status, r.created_at, r.closed_at, r.close_note,
    row_to_json(rep.*) AS reporter,
    row_to_json(cb.*) AS closed_by_user,
    row_to_json(tu.*) AS target_user,
    tm.conversation_id AS tm_conversation_id, tm.seq AS tm_seq, tm.type AS tm_type,
    tm.created_at AS tm_created_at, (tm.deleted_at IS NOT NULL) AS tm_deleted,
    row_to_json(ms.*) AS tm_sender,
    tb.id AS tb_id, tb.vibe AS tb_vibe, tb.status AS tb_status,
    row_to_json(bc.*) AS tb_creator
  FROM reports r
  LEFT JOIN users rep ON rep.id = r.reporter_id
  LEFT JOIN users cb ON cb.id = r.closed_by
  LEFT JOIN users tu ON tu.id = r.target_user_id
  LEFT JOIN messages tm ON tm.conversation_id = r.target_conversation_id AND tm.seq = r.target_seq
  LEFT JOIN users ms ON ms.id = tm.sender_id
  LEFT JOIN beacons tb ON tb.id = r.target_beacon_id
  LEFT JOIN users bc ON bc.id = tb.creator_id`;

export function adminReportFromRaw(r: AdminReportRaw): AdminReport {
  return {
    id: r.id,
    kind: r.kind as AdminReport['kind'],
    reporter: rawUserLite(r.reporter),
    reason: r.reason,
    status: r.status as AdminReport['status'],
    created_at: new Date(r.created_at).toISOString(),
    closed_at: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closed_by: rawUserLite(r.closed_by_user),
    close_note: r.close_note,
    target_user: rawUserLite(r.target_user),
    target_message: r.tm_conversation_id
      ? {
          conversation_id: r.tm_conversation_id,
          seq: Number(r.tm_seq),
          sender: rawUserLite(r.tm_sender),
          type: r.tm_type as MessageType,
          created_at: new Date(r.tm_created_at!).toISOString(),
          deleted: r.tm_deleted === true,
        }
      : null,
    target_beacon: r.tb_id
      ? {
          id: r.tb_id,
          vibe: r.tb_vibe as NonNullable<AdminReport['target_beacon']>['vibe'],
          status: r.tb_status as NonNullable<AdminReport['target_beacon']>['status'],
          creator: rawUserLite(r.tb_creator),
        }
      : null,
  };
}
