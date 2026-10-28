// Admin service (v0.5b — API.md §1.41, ADR-013). The operator surface's
// guard, row loaders and instance settings. Binding boundary: NOTHING in this
// module reads or serializes private message bodies — a reported message is
// who/where/when/what-kind, and the export is the user's own rows minus
// secrets, minus messages.
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LegalTextsSchema,
  ReleaseNoteSchema,
  type AdminReport,
  type AdminUserRow,
  type AuthSettings,
  type AuthSettingsPatch,
  type InstanceSettings,
  type LastSeenBucket,
  type MessageType,
  type UserLite,
} from '@socialchat/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { avatarDto } from '../../lib/dto.js';
import { notFound } from '../../lib/errors.js';
import { sealSecret } from '../../lib/secretbox.js';
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

// v0.9 (§1.74): the STORED auth blob — smtp WITHOUT password/password_set
// (the password lives in its own encrypted key below), features as persisted
// booleans. Malformed values degrade to the 0011-seeded defaults instead of
// refusing the whole settings read.
const STORED_SMTP_DEFAULT = {
  host: null as string | null,
  port: 587,
  secure: true,
  username: null as string | null,
  from: null as string | null,
};
const STORED_FEATURES_DEFAULT = {
  email_verification: false,
  email_otp: false,
  magic_links: false,
  password_reset: false,
};
const StoredAuthSchema = z
  .object({
    smtp: z
      .object({
        host: z.string().nullable().catch(null),
        port: z.number().int().min(1).max(65535).catch(587),
        secure: z.boolean().catch(true),
        username: z.string().nullable().catch(null),
        from: z.string().nullable().catch(null),
      })
      .catch({ ...STORED_SMTP_DEFAULT }),
    features: z
      .object({
        email_verification: z.boolean().catch(false),
        email_otp: z.boolean().catch(false),
        magic_links: z.boolean().catch(false),
        password_reset: z.boolean().catch(false),
      })
      .catch({ ...STORED_FEATURES_DEFAULT }),
  })
  .catch({ smtp: { ...STORED_SMTP_DEFAULT }, features: { ...STORED_FEATURES_DEFAULT } });
type StoredAuth = z.infer<typeof StoredAuthSchema>;

/** §1.74: serialize the auth settings — password_set only (the password
 *  never reads back; SMTP_PASSWORD env takes precedence over the stored
 *  value), mailer_available server-computed: false in v0.9, always (no
 *  mailer ships — golden rule 10, ADR-021). */
function authSettingsDto(stored: StoredAuth, passwordStored: boolean): AuthSettings {
  return {
    smtp: {
      ...stored.smtp,
      password_set: config.smtpPasswordEnv !== null || passwordStored,
    },
    features: stored.features,
    mailer_available: false,
  };
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  const rows = await db
    .select()
    .from(schema.instanceSettings)
    .where(
      inArray(schema.instanceSettings.key, [
        'invites_enabled',
        'release_notes',
        'auth',
        'auth_smtp_password',
        'legal',
        'operator_contact',
        'registration_mode',
      ]),
    );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const invites = byKey.get('invites_enabled');
  // v0.8a (§1.61): the what's-new list rides the settings DTO; a malformed
  // blob degrades to [] instead of refusing the whole admin read.
  const notes = ReleaseNotesListSchema.safeParse(byKey.get('release_notes') ?? []);
  const storedAuth = StoredAuthSchema.parse(byKey.get('auth') ?? {});
  // Wave 1 (§1.1): legal markdown + operator contact; malformed blobs
  // degrade to the defaults, never refuse the read.
  const legal = LegalTextsSchema.safeParse(byKey.get('legal') ?? {});
  const contact = byKey.get('operator_contact');
  return {
    invites_enabled: invites === undefined ? true : invites === true,
    release_notes: notes.success ? notes.data : [],
    auth: authSettingsDto(storedAuth, typeof byKey.get('auth_smtp_password') === 'string'),
    legal: legal.success ? legal.data : { terms: '', privacy: '', guidelines: '' },
    operator_contact: typeof contact === 'string' ? contact : '',
    registration_mode: (() => {
      const m = byKey.get('registration_mode');
      return m === 'invite_only' || m === 'closed' ? m : 'open';
    })(),
  };
}

/**
 * v0.9 (§1.74): apply the deep-partial auth PATCH. smtp.password is
 * WRITE-ONLY: a string stores it AES-256-GCM-encrypted (HKDF info 'smtp:')
 * under its own instance_settings key, null clears it — it never rides the
 * admin-readable 'auth' blob. Feature toggles persist even while inert.
 */
export async function applyAuthSettingsPatch(patch: AuthSettingsPatch): Promise<void> {
  const rows = await db
    .select()
    .from(schema.instanceSettings)
    .where(inArray(schema.instanceSettings.key, ['auth']));
  const stored = StoredAuthSchema.parse(rows[0]?.value ?? {});
  const { password, ...smtpPatch } = patch.smtp ?? {};
  const merged: StoredAuth = {
    smtp: { ...stored.smtp, ...smtpPatch },
    features: { ...stored.features, ...(patch.features ?? {}) },
  };
  await setInstanceSetting('auth', merged);
  if (password !== undefined) {
    await setInstanceSetting(
      'auth_smtp_password',
      password === null ? null : sealSecret('smtp:', password),
    );
  }
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
    mask_emoji: null,
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
  context_consent: boolean;
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
  // v0.8b previews (§1.62/§1.66/§1.67)
  target_anon_thread_id: string | null;
  target_anon_message_id: string | null;
  am_body: string | null;
  am_created_at: string | Date | null;
  target_object_type: string | null;
  target_object_id: string | null;
  target_overlay_id: string | null;
  so_kind: string | null;
  so_payload: unknown;
  so_status: string | null;
  sp_live: boolean | null;
  // Wave 1 (§1.5)
  category: string;
  obj_live: boolean | null;
  outcome: string;
}

export const ADMIN_REPORT_SELECT = sql`
  SELECT r.id, r.kind, r.reason, r.status, r.created_at, r.closed_at, r.close_note,
    r.context_consent, r.category, r.outcome,
    r.target_anon_thread_id, r.target_anon_message_id,
    r.target_object_type, r.target_object_id, r.target_overlay_id,
    row_to_json(rep.*) AS reporter,
    row_to_json(cb.*) AS closed_by_user,
    row_to_json(tu.*) AS target_user,
    tm.conversation_id AS tm_conversation_id, tm.seq AS tm_seq, tm.type AS tm_type,
    tm.created_at AS tm_created_at, (tm.deleted_at IS NOT NULL) AS tm_deleted,
    row_to_json(ms.*) AS tm_sender,
    tb.id AS tb_id, tb.vibe AS tb_vibe, tb.status AS tb_status,
    row_to_json(bc.*) AS tb_creator,
    am.body AS am_body, am.created_at AS am_created_at,
    so.kind AS so_kind, so.payload AS so_payload, so.status AS so_status,
    EXISTS (
      SELECT 1 FROM share_tokens st
      WHERE st.object_type = r.target_object_type AND st.object_id = r.target_object_id
        AND st.revoked_at IS NULL
    ) AS sp_live,
    (CASE r.kind
      WHEN 'post' THEN EXISTS (SELECT 1 FROM posts x WHERE x.id = r.target_object_id)
      WHEN 'comment' THEN EXISTS (SELECT 1 FROM post_comments x WHERE x.id = r.target_object_id)
      WHEN 'story' THEN EXISTS (SELECT 1 FROM stories x WHERE x.id = r.target_object_id AND x.expires_at > now())
      WHEN 'listing' THEN EXISTS (SELECT 1 FROM listings x WHERE x.id = r.target_object_id)
      WHEN 'group' THEN EXISTS (SELECT 1 FROM conversations x WHERE x.id = r.target_object_id)
      ELSE NULL END) AS obj_live
  FROM reports r
  LEFT JOIN users rep ON rep.id = r.reporter_id
  LEFT JOIN users cb ON cb.id = r.closed_by
  LEFT JOIN users tu ON tu.id = r.target_user_id
  LEFT JOIN messages tm ON tm.conversation_id = r.target_conversation_id AND tm.seq = r.target_seq
  LEFT JOIN users ms ON ms.id = tm.sender_id
  LEFT JOIN beacons tb ON tb.id = r.target_beacon_id
  LEFT JOIN users bc ON bc.id = tb.creator_id
  LEFT JOIN anon_messages am ON am.id = r.target_anon_message_id
  LEFT JOIN story_overlays so ON so.id = r.target_overlay_id`;

export function adminReportFromRaw(r: AdminReportRaw): AdminReport {
  const kind = r.kind as AdminReport['kind'];
  return {
    id: r.id,
    kind,
    category: r.category as AdminReport['category'],
    outcome: (r.outcome ?? '') as AdminReport['outcome'],
    // The server-attached person (null for beacon/message/share_page rows).
    // A tombstoned account is no longer a person to warn or suspend.
    target_user_id:
      typeof (r.target_user as { id?: unknown } | null)?.id === 'string' &&
      (r.target_user as { deleted_at?: unknown }).deleted_at == null
        ? (r.target_user as { id: string }).id
        : null,
    reporter: rawUserLite(r.reporter),
    reason: r.reason,
    status: r.status as AdminReport['status'],
    created_at: new Date(r.created_at).toISOString(),
    closed_at: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closed_by: rawUserLite(r.closed_by_user),
    close_note: r.close_note,
    // Exactly one preview matches the kind — target_user doubles as the
    // ATTACHED identity on anon/overlay/share rows and rides THEIR previews.
    target_user: kind === 'user' ? rawUserLite(r.target_user) : null,
    target_message: r.tm_conversation_id
      ? {
          conversation_id: r.tm_conversation_id,
          seq: Number(r.tm_seq),
          sender: rawUserLite(r.tm_sender),
          type: r.tm_type as MessageType,
          created_at: new Date(r.tm_created_at!).toISOString(),
          deleted: r.tm_deleted === true,
          // v0.8b (§1.69): the reporter consented at report time — the
          // context viewer exists for this report.
          context_available: r.context_consent === true,
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
    // v0.8b (§1.62): the reported anon message — the ATTACHED identity plus
    // the reported words (the recipient was always allowed to show them).
    // Null once the thread was hard-deleted (reports outlive their targets;
    // the identity survives in close notes / the ring either way).
    target_anon_message:
      kind === 'anon_message' && r.target_anon_thread_id && r.target_anon_message_id && r.am_body !== null
        ? {
            thread_id: r.target_anon_thread_id,
            message_id: r.target_anon_message_id,
            author: rawUserLite(r.target_user),
            body: r.am_body,
            created_at: new Date(r.am_created_at!).toISOString(),
          }
        : null,
    // v0.8b (§1.66): the reported overlay — vector payload + ATTACHED author.
    target_overlay:
      kind === 'story_overlay' && r.target_object_id && r.target_overlay_id && r.so_kind
        ? {
            story_id: r.target_object_id,
            overlay_id: r.target_overlay_id,
            author: rawUserLite(r.target_user),
            kind: r.so_kind as NonNullable<AdminReport['target_overlay']>['kind'],
            payload: (r.so_payload ?? null) as NonNullable<AdminReport['target_overlay']>['payload'],
            status: r.so_status as NonNullable<AdminReport['target_overlay']>['status'],
          }
        : null,
    // v0.8b (§1.67): the non-user share-page report's resolved target.
    target_share_page:
      kind === 'share_page' && r.target_object_type && r.target_object_id
        ? {
            object_type: r.target_object_type as NonNullable<
              AdminReport['target_share_page']
            >['object_type'],
            object_id: r.target_object_id,
            author: rawUserLite(r.target_user),
            gone: r.sp_live !== true,
          }
        : null,
    // Wave 1 (§1.5): the object kinds — id + ATTACHED author + liveness.
    target_object:
      (kind === 'post' || kind === 'comment' || kind === 'story' || kind === 'listing' || kind === 'group') &&
      r.target_object_id
        ? {
            object_type: kind,
            object_id: r.target_object_id,
            author: rawUserLite(r.target_user),
            gone: r.obj_live !== true,
          }
        : null,
  };
}
