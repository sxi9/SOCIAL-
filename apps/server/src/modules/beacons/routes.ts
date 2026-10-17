// Beacons + plan roles + kudos (v0.3 — API.md §1.15/§1.16, ADR-008).
// Durable writes stay REST; all fan-out rides the Redis `events` channel.
// Visibility ⇔ joinability: blocked pairs and out-of-audience viewers get a
// 404 shaped exactly like "never existed" (ADR-009).
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  BEACON_CREATE_RATE_PER_HOUR,
  BEACON_EDIT_RATE_PER_HOUR,
  BEACON_KUDOS_WINDOW_S,
  BEACON_MAX_HORIZON_S,
  BEACON_MIN_WINDOW_S,
  BEACON_OPEN_MAX,
  BEACON_ROLES_MAX,
  BEACON_SPARK_THRESHOLD_DEFAULT,
  BEACON_STARTS_AT_SLACK_S,
  CreateBeaconRequestSchema,
  CreateRoleRequestSchema,
  PatchBeaconRequestSchema,
  SendKudosRequestSchema,
  type BeaconRole,
  type Location,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockPairsAmong, isBlockedPair } from '../../lib/blocks.js';
import {
  activeParticipantUserIds,
  publishConversationToUsers,
  userLiteDto,
} from '../../lib/dto.js';
import { badRequest, conflict, forbidden, gone, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueAfterglow } from '../../queues.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import {
  audienceUserIds,
  beaconDtosFor,
  editOpenBeacon,
  fanBeacon,
  hasJoin,
  isBeaconVisibleTo,
  joinAndMaybeSpark,
  listVisibleBeacons,
  loadBeacon,
  loadBeaconDtoFor,
  pushBeacon,
  radarCount,
  sparkNow,
  type BeaconRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const RoleParams = z.object({ id: z.string().uuid(), roleId: z.string().uuid() });

const b = schema.beacons;
const br = schema.beaconRoles;

// RITUAL_RRULE_WEEKLY / RITUAL_AUTO_PAUSE_SKIPS imported where needed below.
import { RITUAL_AUTO_PAUSE_SKIPS, RITUAL_RRULE_WEEKLY } from '@socialchat/shared';

async function openBeaconCount(creatorId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM beacons
    WHERE creator_id = ${creatorId} AND status = 'open' AND expires_at > now()
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

function validateWindow(startsAt: Date, expiresAt: Date): void {
  const now = Date.now();
  if (startsAt.getTime() < now - BEACON_STARTS_AT_SLACK_S * 1000) throw badRequest('bad_window');
  if (expiresAt.getTime() - startsAt.getTime() < BEACON_MIN_WINDOW_S * 1000) {
    throw badRequest('bad_window');
  }
  if (expiresAt.getTime() > now + BEACON_MAX_HORIZON_S * 1000) throw badRequest('bad_window');
}

interface MintOpts {
  creator: { id: string; area: string | null; beaconDefaultAudience: string };
  vibe: string;
  customVibeEmoji?: string | null;
  customVibeLabel?: string | null;
  note: string;
  audience?: string;
  sparkThreshold?: number;
  startsAt: Date;
  expiresAt: Date;
  location?: Location | null;
}

/** v0.7 (§1.47): vibe 'custom' requires BOTH custom fields; any preset vibe
 * forbids them → 400 bad_custom_vibe (a partial pair included). */
function requireCustomVibePair(
  vibe: string,
  emoji: string | null | undefined,
  label: string | null | undefined,
): void {
  if (vibe === 'custom') {
    if (!emoji || !label) throw badRequest('bad_custom_vibe');
  } else if (emoji !== undefined || label !== undefined) {
    throw badRequest('bad_custom_vibe');
  }
}

/** The human word for a beacon's vibe in push copy (§1.47 custom vibes). */
function vibeWord(row: Pick<BeaconRow, 'vibe' | 'customVibeLabel'>): string {
  return row.vibe === 'custom' ? (row.customVibeLabel ?? 'a plan') : row.vibe;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Shared by POST /api/beacons and run-it-back: mint + karma + fan + push. */
async function mintBeacon(opts: MintOpts): Promise<BeaconRow> {
  const audience = opts.audience ?? opts.creator.beaconDefaultAudience;
  // 'area' beacons snapshot the creator's area at mint (audience cannot drift).
  if (audience === 'area' && opts.creator.area === null) throw badRequest('area_required');
  validateWindow(opts.startsAt, opts.expiresAt);
  if ((await openBeaconCount(opts.creator.id)) >= BEACON_OPEN_MAX) throw conflict('beacon_limit');

  const [row] = await db
    .insert(b)
    .values({
      id: newId(),
      creatorId: opts.creator.id,
      vibe: opts.vibe,
      customVibeEmoji: opts.vibe === 'custom' ? (opts.customVibeEmoji ?? null) : null,
      customVibeLabel: opts.vibe === 'custom' ? (opts.customVibeLabel ?? null) : null,
      note: opts.note,
      audience,
      area: audience === 'area' ? opts.creator.area : null,
      location: opts.location ?? null,
      startsAt: opts.startsAt,
      expiresAt: opts.expiresAt,
      sparkThreshold: opts.sparkThreshold ?? BEACON_SPARK_THRESHOLD_DEFAULT,
    })
    .returning();
  await db.execute(sql`
    UPDATE users SET beacons_created = beacons_created + 1 WHERE id = ${opts.creator.id}
  `);
  // beacon.new ONLY to the audience (never to anyone who cannot join —
  // PSYCHOLOGY rule 2); push to the offline audience (§2.9-style guards
  // re-check at execution).
  await fanBeacon(row!, 'beacon.new');
  const audienceIds = await audienceUserIds(row!);
  const [creatorRow] = await db
    .select({ displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, opts.creator.id))
    .limit(1);
  await pushBeacon(audienceIds, {
    beacon_id: row!.id,
    title: `${creatorRow?.displayName ?? 'Someone'} is up for ${vibeWord(row!)}`,
    body: row!.note || 'Tap to join the plan',
    url: '/beacons',
  });
  return row!;
}

/** Post-commit duties of EVERY spark path (threshold join, §1.47 edit spark,
 * spark-now): afterglow job, conv.new to insiders, beacon.updated to the
 * audience (non-joiners see the card retire with conversation_id null), spark
 * push to insiders only — byte-identical whatever triggered the spark. */
async function sparkPostCommit(
  row: BeaconRow,
  conversationId: string,
  joinerIds: string[],
  fanOpts: { edited?: boolean; changed?: string[] } = {},
): Promise<void> {
  await enqueueAfterglow(row.id, row.expiresAt.getTime() + 2 * 3600 * 1000 - Date.now());
  const insiders = [row.creatorId, ...joinerIds];
  await publishConversationToUsers(conversationId, insiders, 'conv.new');
  await fanBeacon(row, 'beacon.updated', fanOpts);
  await pushBeacon(insiders, {
    beacon_id: row.id,
    title: 'It is officially a plan',
    body: `Your ${vibeWord(row)} beacon sparked — the group chat is open`,
    url: `/c/${conversationId}`,
  });
}

/** Current joiner user ids in join order (the §1.47 notification set). */
async function joinerIdsOf(beaconId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId} ORDER BY created_at ASC
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** Visible-or-404 (API.md §1.14/§1.15: unknown, outside audience and blocked
 * pairs are byte-identical). */
async function requireVisibleBeacon(
  beaconId: string,
  me: { id: string; area: string | null },
): Promise<BeaconRow> {
  const row = await loadBeacon(beaconId);
  if (!row) throw notFound('beacon_not_found');
  if (!(await isBeaconVisibleTo(row, me))) throw notFound('beacon_not_found');
  return row;
}

/** Spark-group membership (creator or joiner); 404 beacon_not_found outside. */
async function requireSparkGroupMember(
  beaconId: string,
  userId: string,
): Promise<BeaconRow> {
  const row = await loadBeacon(beaconId);
  if (!row) throw notFound('beacon_not_found');
  const member = row.creatorId === userId || (await hasJoin(beaconId, userId));
  if (!member) throw notFound('beacon_not_found');
  return row;
}

// ---------------------------------------------------------------------------
// Plan roles (§1.16)
// ---------------------------------------------------------------------------

type RoleRow = typeof schema.beaconRoles.$inferSelect;

async function roleDtos(beaconId: string): Promise<BeaconRole[]> {
  const rows = await db
    .select({ r: br, u: schema.users })
    .from(br)
    .leftJoin(schema.users, eq(br.assigneeId, schema.users.id))
    .where(eq(br.beaconId, beaconId))
    .orderBy(asc(br.createdAt));
  return rows.map(({ r, u }) => ({
    id: r.id,
    beacon_id: r.beaconId,
    label: r.label,
    assignee: u ? userLiteDto(u) : null,
    done: r.done,
    created_at: r.createdAt.toISOString(),
  }));
}

async function roleDto(row: RoleRow): Promise<BeaconRole> {
  let assignee = null;
  if (row.assigneeId) {
    const [u] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, row.assigneeId))
      .limit(1);
    assignee = u ? userLiteDto(u) : null;
  }
  return {
    id: row.id,
    beacon_id: row.beaconId,
    label: row.label,
    assignee,
    done: row.done,
    created_at: row.createdAt.toISOString(),
  };
}

/** §1.16 fan-out decision (binding): one plan.updated frame carrying the FULL
 * roles list, to the plan conversation's active participants — deliberately
 * NOT conv.updated. Idempotent replace; reconcile via GET roles. */
async function fanPlanUpdated(beacon: BeaconRow): Promise<void> {
  if (!beacon.conversationId) return;
  const roles = await roleDtos(beacon.id);
  const recipients = await activeParticipantUserIds(beacon.conversationId);
  await publishToUsers(recipients, {
    t: 'plan.updated',
    d: { beacon_id: beacon.id, conversation_id: beacon.conversationId, roles },
  });
}

/** In-group + sparked gate for all role mutations (404 → 409 precedence). */
async function requireSparkedPlanMember(beaconId: string, userId: string): Promise<BeaconRow> {
  const row = await requireSparkGroupMember(beaconId, userId);
  if (row.status !== 'sparked') throw conflict('beacon_not_sparked');
  return row;
}

export async function beaconRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.15 POST /api/beacons — mint. The 201 returns the full DTO immediately:
  // the creator lands on the live plan card, never a waiting state.
  app.post(
    '/api/beacons',
    { preHandler: requireAuth, schema: { body: CreateBeaconRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(`beaconcreate:${user.id}`, BEACON_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      // v0.7 (§1.47): both-or-neither, and only on vibe 'custom'.
      requireCustomVibePair(req.body.vibe, req.body.custom_vibe_emoji, req.body.custom_vibe_label);
      const row = await mintBeacon({
        creator: { id: user.id, area: user.area, beaconDefaultAudience: user.beaconDefaultAudience },
        vibe: req.body.vibe,
        customVibeEmoji: req.body.custom_vibe_emoji ?? null,
        customVibeLabel: req.body.custom_vibe_label ?? null,
        note: req.body.note,
        audience: req.body.audience,
        sparkThreshold: req.body.spark_threshold,
        startsAt: new Date(req.body.starts_at),
        expiresAt: new Date(req.body.expires_at),
        location: req.body.location ?? null,
      });
      return reply.status(201).send({ beacon: await loadBeaconDtoFor(row, user.id) });
    },
  );

  // §1.15 GET /api/beacons — open visible + sparked-where-mine, expires ASC.
  app.get('/api/beacons', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await listVisibleBeacons({ id: user.id, area: user.area });
    return { beacons: await beaconDtosFor(rows, user.id) };
  });

  // §1.15 GET /api/beacons/radar — AGGREGATE only (FEATURES #26).
  app.get('/api/beacons/radar', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    return { active_visible_count: await radarCount({ id: user.id, area: user.area }) };
  });

  // v0.7 §1.47 PATCH /api/beacons/:id — creator only, status 'open' only.
  // Audience is IMMUTABLE (400 audience_immutable — re-aiming a live invite is
  // a new beacon); the Zod schema has no audience field, so the raw body is
  // checked in preValidation before Zod strips the key.
  app.patch(
    '/api/beacons/:id',
    {
      preHandler: requireAuth,
      preValidation: (req, _reply, done) => {
        const raw = req.body as Record<string, unknown> | null;
        if (raw && typeof raw === 'object' && 'audience' in raw) {
          done(badRequest('audience_immutable'));
          return;
        }
        done();
      },
      schema: { params: IdParams, body: PatchBeaconRequestSchema },
    },
    async (req) => {
      const { user } = authed(req);
      const row = await loadBeacon(req.params.id);
      if (!row) throw notFound('beacon_not_found');
      if (row.creatorId !== user.id) {
        // Non-creators: invisible beacons must stay invisible (§1.14).
        if (!(await isBeaconVisibleTo(row, user))) throw notFound('beacon_not_found');
        throw forbidden();
      }
      if (row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) {
        throw conflict('beacon_not_open');
      }
      const rate = await fixedWindow(`beaconedit:${user.id}`, BEACON_EDIT_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const body = req.body;
      // Custom-vibe shape against the EFFECTIVE new vibe (§1.47): 'custom'
      // needs both fields present or inherited; a preset vibe forbids them.
      const effectiveVibe = body.vibe ?? row.vibe;
      if (effectiveVibe === 'custom') {
        const emoji = body.custom_vibe_emoji ?? row.customVibeEmoji;
        const label = body.custom_vibe_label ?? row.customVibeLabel;
        if (!emoji || !label) throw badRequest('bad_custom_vibe');
      } else if (body.custom_vibe_emoji !== undefined || body.custom_vibe_label !== undefined) {
        throw badRequest('bad_custom_vibe');
      }
      // Window fields revalidate under the §1.15 rules — both must be sent
      // together when either changes.
      if ((body.starts_at === undefined) !== (body.expires_at === undefined)) {
        throw badRequest('bad_window');
      }
      if (body.starts_at !== undefined && body.expires_at !== undefined) {
        validateWindow(new Date(body.starts_at), new Date(body.expires_at));
      }

      const outcome = await editOpenBeacon(row.id, {
        ...(body.vibe !== undefined ? { vibe: body.vibe } : {}),
        ...(body.custom_vibe_emoji !== undefined
          ? { customVibeEmoji: body.custom_vibe_emoji }
          : {}),
        ...(body.custom_vibe_label !== undefined
          ? { customVibeLabel: body.custom_vibe_label }
          : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.starts_at !== undefined ? { startsAt: new Date(body.starts_at) } : {}),
        ...(body.expires_at !== undefined ? { expiresAt: new Date(body.expires_at) } : {}),
        ...(body.spark_threshold !== undefined ? { sparkThreshold: body.spark_threshold } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
      });
      if (outcome === null) throw conflict('beacon_not_open'); // raced close/expiry
      if (outcome === 'threshold_below_joins') throw badRequest('threshold_below_joins');

      if (outcome.changed.length > 0) {
        if (outcome.sparked && outcome.conversationId) {
          // threshold == count sparked inside the edit transaction: the spark
          // fan-out/push replaces the edited push (joiners get the room).
          await sparkPostCommit(outcome.row, outcome.conversationId, outcome.joinerIds, {
            edited: true,
            changed: outcome.changed,
          });
        } else {
          await fanBeacon(outcome.row, 'beacon.updated', {
            edited: true,
            changed: outcome.changed,
          });
          // Push to current JOINERS ONLY — people who committed (§1.47,
          // PSYCHOLOGY rule 2); §2.9 guards re-check at execution.
          await pushBeacon(outcome.joinerIds, {
            beacon_id: outcome.row.id,
            title: capitalize(vibeWord(outcome.row)),
            body: `${user.displayName} changed the plan`,
            url: '/plans',
          });
        }
      }
      return { beacon: await loadBeaconDtoFor(outcome.row, user.id) };
    },
  );

  // v0.7 §1.47 POST /api/beacons/:id/spark-now — "start with whoever's here":
  // the §1.15 spark transaction verbatim, the threshold simply not consulted.
  app.post(
    '/api/beacons/:id/spark-now',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadBeacon(req.params.id);
      if (!row) throw notFound('beacon_not_found');
      if (row.creatorId !== user.id) {
        if (!(await isBeaconVisibleTo(row, user))) throw notFound('beacon_not_found');
        throw forbidden();
      }
      if (row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) {
        throw gone('beacon_closed');
      }
      const outcome = await sparkNow(row.id);
      if (outcome === null) throw gone('beacon_closed'); // raced close/expiry
      if (outcome === 'no_joiners') throw conflict('beacon_no_joiners');
      // Fan-out and push byte-identical to a threshold spark (§1.47).
      await sparkPostCommit(outcome.row, outcome.conversationId, outcome.joinerIds);
      return { beacon: await loadBeaconDtoFor(outcome.row, user.id) };
    },
  );

  // v0.7 §1.47 GET /api/beacons/:id/joins — the "Who's in" sheet: the FULL
  // joiner list in join order, audience-gated like the beacon itself (404
  // identical for unknown/invisible/blocked), joiners blocked w.r.t. the
  // viewer omitted. Faces only — join timestamps are never serialized.
  app.get(
    '/api/beacons/:id/joins',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisibleBeacon(req.params.id, user);
      const rows = (await db.execute(sql`
        SELECT row_to_json(u.*) AS u
        FROM beacon_joins j
        JOIN users u ON u.id = j.user_id
        WHERE j.beacon_id = ${row.id}
          AND NOT EXISTS (
            SELECT 1 FROM blocks bl
            WHERE (bl.blocker_id = ${user.id} AND bl.blocked_id = j.user_id)
               OR (bl.blocker_id = j.user_id AND bl.blocked_id = ${user.id}))
        ORDER BY j.created_at ASC
      `)) as unknown as { u: Record<string, unknown> }[];
      return {
        joiners: rows.map((r) =>
          userLiteDto({
            id: r.u.id as string,
            username: r.u.username as string,
            displayName: r.u.display_name as string,
            avatarStatus: r.u.avatar_status as string,
            avatarVersion: Number(r.u.avatar_version),
            avatarStaticKey: (r.u.avatar_static_key as string | null) ?? null,
            avatarAnimatedKey: (r.u.avatar_animated_key as string | null) ?? null,
          } as Parameters<typeof userLiteDto>[0]),
        ),
      };
    },
  );

  // §1.15 POST /api/beacons/:id/join — may spark or re-ping, atomically.
  app.post(
    '/api/beacons/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisibleBeacon(req.params.id, user);
      if (row.creatorId === user.id) throw badRequest('beacon_own');
      if (row.status === 'sparked' && (await hasJoin(row.id, user.id))) {
        // Idempotent re-join of a beacon I already sparked into.
        return { beacon: await loadBeaconDtoFor(row, user.id) };
      }
      if (row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) {
        throw gone('beacon_closed');
      }

      const outcome = await joinAndMaybeSpark(row.id, user.id);
      // §1.14: a pile already holding someone blocked w.r.t. me (committed
      // under the row lock, so visibility checks cannot race it) reads as
      // nonexistent — the server never sparks a blocked pair into a group.
      if (outcome === 'blocked') throw notFound('beacon_not_found');
      if (!outcome) throw gone('beacon_closed');

      if (outcome.sparked && outcome.conversationId) {
        await sparkPostCommit(outcome.row, outcome.conversationId, outcome.joinerIdsAtSpark);
      } else if (outcome.inserted) {
        await fanBeacon(outcome.row, 'beacon.updated', { reping: outcome.repinged });
        if (outcome.repinged) {
          // The single "needs 1 more" push to the audience non-joiners —
          // minus anyone blocked w.r.t. a current joiner (they can no longer
          // join, so they are never notified; PSYCHOLOGY rule 2 / §1.14).
          const audience = await audienceUserIds(outcome.row);
          const joined = new Set(outcome.joinerIdsAtSpark);
          const pairs = await blockPairsAmong(outcome.joinerIdsAtSpark);
          await pushBeacon(
            audience.filter(
              (id) =>
                !joined.has(id) &&
                !outcome.joinerIdsAtSpark.some((jid) => pairs.has(`${id}:${jid}`)),
            ),
            {
              beacon_id: outcome.row.id,
              title: `One more for ${outcome.row.vibe}?`,
              body: 'This plan needs exactly one more person',
              url: '/beacons',
            },
          );
        }
      }
      return { beacon: await loadBeaconDtoFor(outcome.row, user.id) };
    },
  );

  // §1.15 DELETE /api/beacons/:id/join — leave while open; idempotent.
  app.delete(
    '/api/beacons/:id/join',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisibleBeacon(req.params.id, user);
      if (row.status === 'sparked') throw conflict('beacon_sparked');
      const deleted = (await db.execute(sql`
        DELETE FROM beacon_joins WHERE beacon_id = ${row.id} AND user_id = ${user.id}
        RETURNING user_id
      `)) as unknown as { user_id: string }[];
      const fresh = (await loadBeacon(row.id))!;
      if (deleted.length > 0) await fanBeacon(fresh, 'beacon.updated');
      return { beacon: await loadBeaconDtoFor(fresh, user.id) };
    },
  );

  // §1.15 POST /api/beacons/:id/cancel — creator; cards silently retire.
  app.post(
    '/api/beacons/:id/cancel',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadBeacon(req.params.id);
      if (!row) throw notFound('beacon_not_found');
      if (row.creatorId !== user.id) {
        // Non-creators: invisible beacons must stay invisible.
        if (!(await isBeaconVisibleTo(row, user))) throw notFound('beacon_not_found');
        throw forbidden();
      }
      if (row.status === 'sparked') throw conflict('beacon_sparked');
      const wasOpen = row.status === 'open';
      await db.update(b).set({ status: 'cancelled' }).where(eq(b.id, row.id));
      const fresh = (await loadBeacon(row.id))!;
      await fanBeacon(fresh, 'beacon.updated');
      // v0.7 (§1.47/FEATURES #63): joiners COMMITTED, so they get the one
      // cancellation push ("<creator> called it off") — the non-joiner
      // audience still sees only the silent card-retire above. §2.9 guards
      // re-check at execution; blocks are structural (a blocked pair can
      // never share the pile).
      if (wasOpen) {
        await pushBeacon(await joinerIdsOf(fresh.id), {
          beacon_id: fresh.id,
          title: capitalize(vibeWord(fresh)),
          body: `${user.displayName} called it off`,
          url: '/plans',
        });
      }
      return { beacon: await loadBeaconDtoFor(fresh, user.id) };
    },
  );

  // §1.15 POST /api/beacons/:id/ritualize — creator; sparked, or the latest
  // run of a paused chain in any status (the resume path, re-arms skips: 0).
  app.post(
    '/api/beacons/:id/ritualize',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadBeacon(req.params.id);
      if (!row) throw notFound('beacon_not_found');
      if (row.creatorId !== user.id) {
        if (!(await isBeaconVisibleTo(row, user))) throw notFound('beacon_not_found');
        throw forbidden();
      }
      const [child] = (await db.execute(sql`
        SELECT 1 AS one FROM beacons WHERE ritual_parent_id = ${row.id} LIMIT 1
      `)) as unknown as { one: number }[];
      // A paused chain's latest run: has a rrule, no child, already terminal
      // and unsparked, and the worker declined the next run (skips+1 ≥ cap).
      const pausedLatestRun =
        row.ritualRrule !== null &&
        !child &&
        row.status !== 'sparked' &&
        row.expiresAt.getTime() <= Date.now() &&
        row.ritualSkips + 1 >= RITUAL_AUTO_PAUSE_SKIPS;
      if (row.status !== 'sparked' && !pausedLatestRun) throw conflict('beacon_not_sparked');

      if (row.ritualRrule === null) {
        // First ritualize after a good plan: this sparked run is run #1.
        await db
          .update(b)
          .set({ ritualRrule: RITUAL_RRULE_WEEKLY, ritualCount: Math.max(row.ritualCount, 1), ritualSkips: 0 })
          .where(eq(b.id, row.id));
      } else {
        // Resume / re-arm: skips reset, count (the scrapbook) carries on.
        await db.update(b).set({ ritualSkips: 0 }).where(eq(b.id, row.id));
      }
      const fresh = (await loadBeacon(row.id))!;
      return { beacon: await loadBeaconDtoFor(fresh, user.id) };
    },
  );

  // §1.15 POST /api/beacons/:id/run-it-back — one-tap re-create from the
  // afterglow recap. The beacon id IS the token; spark-group membership is the
  // authorization. New beacon owned by the TAPPER.
  app.post(
    '/api/beacons/:id/run-it-back',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const source = await requireSparkGroupMember(req.params.id, user.id);
      if (source.status !== 'sparked') throw notFound('beacon_not_found');
      // run-it-back IS a mint: it shares the POST /api/beacons budget
      // (same fixed-window key), or a member of any sparked beacon could loop
      // run-it-back → cancel → run-it-back and push-spam the whole audience —
      // every mint is a fresh beacon id, so the per-(user,beacon) push
      // debounce never engages. Membership is checked first so 404 probes
      // cannot burn the caller's budget.
      const rate = await fixedWindow(`beaconcreate:${user.id}`, BEACON_CREATE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const durationMs = source.expiresAt.getTime() - source.startsAt.getTime();
      const now = Date.now();
      const row = await mintBeacon({
        creator: { id: user.id, area: user.area, beaconDefaultAudience: user.beaconDefaultAudience },
        vibe: source.vibe,
        note: source.note,
        audience: source.audience,
        sparkThreshold: source.sparkThreshold,
        startsAt: new Date(now),
        expiresAt: new Date(now + durationMs),
      });
      return reply.status(201).send({ beacon: await loadBeaconDtoFor(row, user.id) });
    },
  );

  // §1.15 POST /api/beacons/:id/kudos — private, idempotent, recipient-only
  // delivery; never aggregated publicly anywhere (PSYCHOLOGY §9, rule 3).
  app.post(
    '/api/beacons/:id/kudos',
    { preHandler: requireAuth, schema: { params: IdParams, body: SendKudosRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const { to_user_id: toUserId, kind } = req.body;
      const row = await requireSparkGroupMember(req.params.id, user.id);
      if (row.status !== 'sparked') throw gone('beacon_closed'); // window not open yet
      if (toUserId === user.id) throw badRequest('kudos_self');
      if (await isBlockedPair(user.id, toUserId)) throw notFound();
      const targetInGroup =
        row.creatorId === toUserId || (await hasJoin(row.id, toUserId));
      if (!targetInGroup) throw notFound();
      if (kind === 'glad_you_posted' && toUserId !== row.creatorId) {
        throw badRequest('kudos_target');
      }
      if (Date.now() > row.expiresAt.getTime() + BEACON_KUDOS_WINDOW_S * 1000) {
        throw gone('beacon_closed');
      }

      const inserted = (await db.execute(sql`
        INSERT INTO beacon_kudos (beacon_id, from_user_id, to_user_id, kind)
        VALUES (${row.id}, ${user.id}, ${toUserId}, ${kind})
        ON CONFLICT DO NOTHING RETURNING kind
      `)) as unknown as { kind: string }[];

      if (inserted.length > 0) {
        // Effective kudos → beacon.kudos WS + push, to the RECIPIENT ONLY.
        await publishToUsers([toUserId], {
          t: 'beacon.kudos',
          d: { beacon_id: row.id, kind, from: userLiteDto(user) },
        });
        await pushBeacon([toUserId], {
          beacon_id: row.id,
          title: user.displayName,
          body: kind === 'glad_you_posted' ? 'was glad you posted that beacon' : 'was glad you came',
          url: '/beacons',
        });
      }
      return reply.status(204).send();
    },
  );

  // ------------------------------- §1.16 roles ------------------------------

  app.get(
    '/api/beacons/:id/roles',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      await requireSparkedPlanMember(req.params.id, user.id);
      return { roles: await roleDtos(req.params.id) };
    },
  );

  app.post(
    '/api/beacons/:id/roles',
    { preHandler: requireAuth, schema: { params: IdParams, body: CreateRoleRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const beacon = await requireSparkedPlanMember(req.params.id, user.id);
      // Advisory lock serializes the count-then-insert cap (role_limit).
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended('beacon_roles:' || ${beacon.id}::text, 0))
        `);
        return (await tx.execute(sql`
          INSERT INTO beacon_roles (id, beacon_id, label)
          SELECT ${newId()}::uuid, ${beacon.id}::uuid, ${req.body.label}
          WHERE (SELECT count(*) FROM beacon_roles WHERE beacon_id = ${beacon.id}) < ${BEACON_ROLES_MAX}
          RETURNING *
        `)) as unknown as Record<string, unknown>[];
      });
      if (inserted.length === 0) throw conflict('role_limit');
      const [row] = await db
        .select()
        .from(br)
        .where(eq(br.id, inserted[0]!.id as string))
        .limit(1);
      await fanPlanUpdated(beacon);
      return reply.status(201).send({ role: await roleDto(row!) });
    },
  );

  app.post(
    '/api/beacons/:id/roles/:roleId/claim',
    { preHandler: requireAuth, schema: { params: RoleParams } },
    async (req) => {
      const { user } = authed(req);
      const beacon = await requireSparkedPlanMember(req.params.id, user.id);
      const updated = (await db.execute(sql`
        UPDATE beacon_roles SET assignee_id = ${user.id}
        WHERE id = ${req.params.roleId} AND beacon_id = ${beacon.id}
          AND (assignee_id IS NULL OR assignee_id = ${user.id})
        RETURNING id
      `)) as unknown as { id: string }[];
      const [row] = await db
        .select()
        .from(br)
        .where(and(eq(br.id, req.params.roleId), eq(br.beaconId, beacon.id)))
        .limit(1);
      if (!row) throw notFound();
      if (updated.length === 0) throw conflict('role_taken');
      if (row.assigneeId === user.id) await fanPlanUpdated(beacon);
      return { role: await roleDto(row) };
    },
  );

  // Release a claim (assignee or beacon creator); idempotent on unassigned.
  app.delete(
    '/api/beacons/:id/roles/:roleId/claim',
    { preHandler: requireAuth, schema: { params: RoleParams } },
    async (req) => {
      const { user } = authed(req);
      const beacon = await requireSparkedPlanMember(req.params.id, user.id);
      const [row] = await db
        .select()
        .from(br)
        .where(and(eq(br.id, req.params.roleId), eq(br.beaconId, beacon.id)))
        .limit(1);
      if (!row) throw notFound();
      if (row.assigneeId !== null) {
        if (row.assigneeId !== user.id && beacon.creatorId !== user.id) throw forbidden();
        await db.update(br).set({ assigneeId: null }).where(eq(br.id, row.id));
        await fanPlanUpdated(beacon);
      }
      const [fresh] = await db.select().from(br).where(eq(br.id, row.id)).limit(1);
      return { role: await roleDto(fresh!) };
    },
  );

  // Per-person checkmarks — no percentages, no progress bars (PSYCHOLOGY §4).
  app.post(
    '/api/beacons/:id/roles/:roleId/complete',
    { preHandler: requireAuth, schema: { params: RoleParams } },
    async (req) => {
      const { user } = authed(req);
      const beacon = await requireSparkedPlanMember(req.params.id, user.id);
      const [row] = await db
        .select()
        .from(br)
        .where(and(eq(br.id, req.params.roleId), eq(br.beaconId, beacon.id)))
        .limit(1);
      if (!row) throw notFound();
      if (row.assigneeId !== user.id && beacon.creatorId !== user.id) throw forbidden();
      if (!row.done) {
        await db.update(br).set({ done: true }).where(eq(br.id, row.id));
        await fanPlanUpdated(beacon);
      }
      const [fresh] = await db.select().from(br).where(eq(br.id, row.id)).limit(1);
      return { role: await roleDto(fresh!) };
    },
  );

  app.delete(
    '/api/beacons/:id/roles/:roleId',
    { preHandler: requireAuth, schema: { params: RoleParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const beacon = await requireSparkedPlanMember(req.params.id, user.id);
      if (beacon.creatorId !== user.id) throw forbidden();
      const deleted = (await db.execute(sql`
        DELETE FROM beacon_roles WHERE id = ${req.params.roleId} AND beacon_id = ${beacon.id}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (deleted.length === 0) throw notFound();
      await fanPlanUpdated(beacon);
      return reply.status(204).send();
    },
  );
}
