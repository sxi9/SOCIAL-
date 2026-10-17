// Beacons (v0.3 — API.md §1.15, ARCHITECTURE §10, ADR-008). Framework-free
// service shared by the routes AND the worker jobs (expiry sweep, rituals,
// afterglow): audience resolution, per-viewer DTOs, the atomic spark, and the
// beacon.* fan-out over the Redis `events` channel.
//
// Audience (resolved at read/fan-out time, ALWAYS minus §1.14 blocks):
//   friends = users sharing an active DM conversation with the creator;
//   area    = users whose users.area citext-equals the beacon's creator-area
//             SNAPSHOT; public = all users.
// Visibility ⇔ joinability (FoMO-safe, PSYCHOLOGY rule 2): sparked beacons are
// visible only to the creator + joiners; spark details (conversation_id) never
// reach the rest of the audience.
import { asc, eq, sql } from 'drizzle-orm';
import {
  BEACON_ICEBREAKERS,
  BEACON_JOINERS_PREVIEW_MAX,
  BEACON_VENUE_POLL_OPTIONS,
  BEACON_VENUE_POLL_QUESTION,
  type Beacon,
  type BeaconUpdatedEvent,
  type Location,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { recordActivity } from '../../lib/activity.js';
import { blockPairsAmong, blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { friendsOfIds, friendsOfPairCond, isFriendOf } from '../../lib/friends.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { publishToUsers } from '../../ws/events.js';
import { enqueueBeaconPushBulk } from '../../queues.js';

export type BeaconRow = typeof schema.beacons.$inferSelect;

const b = schema.beacons;
const bj = schema.beaconJoins;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Deterministic string hash for icebreaker rotation (hash(id) % len). */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function icebreakerFor(beaconId: string): string {
  return BEACON_ICEBREAKERS[hashString(beaconId) % BEACON_ICEBREAKERS.length]!;
}

function sameArea(a: string | null, b2: string | null): boolean {
  return a !== null && b2 !== null && a.toLowerCase() === b2.toLowerCase();
}

export async function loadBeacon(beaconId: string): Promise<BeaconRow | null> {
  const [row] = await db.select().from(b).where(eq(b.id, beaconId)).limit(1);
  return row ?? null;
}

export async function hasJoin(beaconId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(bj)
    .where(sql`${bj.beaconId} = ${beaconId} AND ${bj.userId} = ${userId}`)
    .limit(1);
  return row !== undefined;
}

/** Any current joiner blocked w.r.t. `meId` (either direction)? §1.14: the
 * server must never place a blocked pair into the same brand-new plan group,
 * so a beacon whose pile already holds a blocked counterpart is unjoinable —
 * and therefore invisible (visibility ⇔ joinability, PSYCHOLOGY rule 2). */
async function hasBlockedJoiner(beaconId: string, meId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM beacon_joins j
    JOIN blocks bl ON (bl.blocker_id = ${meId} AND bl.blocked_id = j.user_id)
                   OR (bl.blocker_id = j.user_id AND bl.blocked_id = ${meId})
    WHERE j.beacon_id = ${beaconId}
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Per-beacon visibility for `me` (join / kudos / report checks). A sparked
 * beacon is visible only to the creator and joiners; otherwise visibility is
 * audience membership. Blocked pairs (either direction) see nothing.
 */
export async function isBeaconVisibleTo(
  row: BeaconRow,
  me: { id: string; area: string | null },
): Promise<boolean> {
  if (row.creatorId === me.id) return true;
  if (await isBlockedPair(me.id, row.creatorId)) return false;
  if (await hasJoin(row.id, me.id)) return true;
  if (row.status === 'sparked') return false; // spark details are joiners-only
  // A pile holding someone blocked w.r.t. me makes the beacon unjoinable for
  // me (the spark would mint a fresh group containing us both), so it reads
  // as nonexistent — 404-shaped like every other §1.14 surface.
  if (await hasBlockedJoiner(row.id, me.id)) return false;
  switch (row.audience) {
    case 'public':
      return true;
    case 'area':
      return sameArea(me.area, row.area);
    case 'friends':
      // v0.5a (§1.28): 'friends' RESOLVES to friends-of (accepted connections
      // ∪ dm-partners) — the stored enum value is unchanged. The block clause
      // above already answered; isFriendOf's own minus-blocks is a no-op here.
      return isFriendOf(me.id, row.creatorId);
    default:
      return false;
  }
}

function visibleOpenCond(me: { id: string; area: string | null }) {
  const clauses = [sql`${b.creatorId} = ${me.id}`, sql`${b.audience} = 'public'`];
  if (me.area !== null) clauses.push(sql`(${b.audience} = 'area' AND ${b.area} = ${me.area})`);
  // v0.5a (§1.28): 'friends' = FRIENDS-OF (dm-partners ∪ accepted
  // connections); the §1.14 block clause rides every caller separately.
  clauses.push(
    sql`(${b.audience} = 'friends' AND ${friendsOfPairCond(me.id, sql`${b.creatorId}`)})`,
  );
  return sql`(${b.status} = 'open' AND ${b.expiresAt} > now() AND (${sql.join(clauses, sql` OR `)}))`;
}

const notBlockedCond = (meId: string) => sql`NOT EXISTS (
  SELECT 1 FROM blocks bl
  WHERE (bl.blocker_id = ${meId} AND bl.blocked_id = ${b.creatorId})
     OR (bl.blocker_id = ${b.creatorId} AND bl.blocked_id = ${meId}))`;

// SQL twin of hasBlockedJoiner for list/radar queries: an open beacon stays
// visible to its creator and to existing joiners, but vanishes for a viewer
// whose blocked counterpart (either direction) already joined — they could no
// longer join it, and FoMO-safety means unjoinable ⇒ invisible.
const noBlockedJoinerCond = (meId: string) => sql`(
  ${b.creatorId} = ${meId}
  OR EXISTS (SELECT 1 FROM beacon_joins j0 WHERE j0.beacon_id = ${b.id} AND j0.user_id = ${meId})
  OR NOT EXISTS (
    SELECT 1 FROM beacon_joins j
    JOIN blocks bl ON (bl.blocker_id = ${meId} AND bl.blocked_id = j.user_id)
                   OR (bl.blocker_id = j.user_id AND bl.blocked_id = ${meId})
    WHERE j.beacon_id = ${b.id}))`;

/**
 * GET /api/beacons: all open beacons visible to me (audience ∪ mine) plus
 * sparked ones where I am creator/joiner and expires_at > now (the countdown
 * card), ordered expires_at ASC (most urgent first).
 */
export async function listVisibleBeacons(me: { id: string; area: string | null }): Promise<
  BeaconRow[]
> {
  const sparkedMine = sql`(${b.status} = 'sparked' AND ${b.expiresAt} > now() AND (
    ${b.creatorId} = ${me.id}
    OR EXISTS (SELECT 1 FROM beacon_joins j WHERE j.beacon_id = ${b.id} AND j.user_id = ${me.id})))`;
  return db
    .select()
    .from(b)
    .where(
      sql`((${visibleOpenCond(me)} AND ${noBlockedJoinerCond(me.id)}) OR ${sparkedMine}) AND ${notBlockedCond(me.id)}`,
    )
    .orderBy(asc(b.expiresAt));
}

/** Boredom radar: AGGREGATE count of open visible beacons, minus my own. */
export async function radarCount(me: { id: string; area: string | null }): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM beacons
    WHERE ${visibleOpenCond(me)} AND ${noBlockedJoinerCond(me.id)}
      AND ${b.creatorId} <> ${me.id} AND ${notBlockedCond(me.id)}
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/**
 * Full audience user ids for fan-out / push: audience minus blocks w.r.t. the
 * creator, creator EXCLUDED (callers add the creator where their own devices
 * should hear the event too).
 */
export async function audienceUserIds(row: BeaconRow): Promise<string[]> {
  let rows: { id: string }[];
  if (row.audience === 'friends') {
    // v0.5a (§1.28): the friends audience IS the friends-of set (already minus
    // blocks w.r.t. the creator; the shared filter below stays as a no-op).
    rows = [...(await friendsOfIds(row.creatorId))].map((id) => ({ id }));
  } else if (row.audience === 'area') {
    rows = (await db.execute(sql`
      SELECT id FROM users WHERE area = ${row.area} AND id <> ${row.creatorId}
    `)) as unknown as { id: string }[];
  } else {
    rows = (await db.execute(sql`
      SELECT id FROM users WHERE id <> ${row.creatorId}
    `)) as unknown as { id: string }[];
  }
  const blocked = await blockedSetOf(row.creatorId);
  return rows.map((r) => r.id).filter((id) => !blocked.has(id));
}

// ---------------------------------------------------------------------------
// DTOs (viewer-specific: my_state, conversation_id, filtered joiner pile)
// ---------------------------------------------------------------------------

interface BeaconParts {
  creator: UserRow;
  joins: { userId: string; u: UserRow }[]; // join order
}

async function loadBeaconParts(rows: BeaconRow[]): Promise<Map<string, BeaconParts>> {
  const map = new Map<string, BeaconParts>();
  if (rows.length === 0) return map;
  const ids = rows.map((r) => r.id);
  const creatorIds = [...new Set(rows.map((r) => r.creatorId))];
  const creators = await db
    .select()
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${sql.join(creatorIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const creatorById = new Map(creators.map((u) => [u.id, u]));
  const joinRows = await db
    .select({ j: bj, u: schema.users })
    .from(bj)
    .innerJoin(schema.users, eq(bj.userId, schema.users.id))
    .where(sql`${bj.beaconId} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
    .orderBy(asc(bj.createdAt));
  const joinsByBeacon = new Map<string, { userId: string; u: UserRow }[]>();
  for (const r of joinRows) {
    const list = joinsByBeacon.get(r.j.beaconId) ?? [];
    list.push({ userId: r.j.userId, u: r.u });
    joinsByBeacon.set(r.j.beaconId, list);
  }
  for (const row of rows) {
    const creator = creatorById.get(row.creatorId);
    if (!creator) continue;
    map.set(row.id, { creator, joins: joinsByBeacon.get(row.id) ?? [] });
  }
  return map;
}

function beaconDtoFromParts(
  row: BeaconRow,
  parts: BeaconParts,
  viewer: { id: string; blockedIds: Set<string> },
): Beacon {
  const joinerCount = parts.joins.length;
  const isCreator = row.creatorId === viewer.id;
  const isJoiner = parts.joins.some((j) => j.userId === viewer.id);
  const myState: Beacon['my_state'] = isCreator ? 'creator' : isJoiner ? 'joined' : 'none';
  // Joiner piles exclude users blocked w.r.t. the viewer (API.md §1.14/§1.15).
  const pile: UserLite[] = parts.joins
    .filter((j) => !viewer.blockedIds.has(j.userId))
    .slice(0, BEACON_JOINERS_PREVIEW_MAX)
    .map((j) => userLiteDto(j.u));
  return {
    id: row.id,
    creator: userLiteDto(parts.creator),
    vibe: row.vibe as Beacon['vibe'],
    // v0.7 (§1.47): the creator's own chip — non-null iff vibe='custom'.
    custom_vibe_emoji: row.customVibeEmoji,
    custom_vibe_label: row.customVibeLabel,
    note: row.note,
    audience: row.audience as Beacon['audience'],
    // Creator-area snapshot; 'area' beacons only ever reach matching viewers.
    area: row.audience === 'area' ? row.area : null,
    starts_at: row.startsAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    spark_threshold: row.sparkThreshold,
    status: row.status as Beacon['status'],
    joiner_count: joinerCount,
    needs: Math.max(0, row.sparkThreshold - joinerCount),
    joiners: pile,
    my_state: myState,
    // Spark details are creator/joiners-only (PSYCHOLOGY rule 2).
    conversation_id:
      row.status === 'sparked' && (isCreator || isJoiner) ? row.conversationId : null,
    ritual: row.ritualRrule
      ? { rrule: row.ritualRrule, count: row.ritualCount, skips: row.ritualSkips }
      : null,
    // v0.7 (§1.52): the optional place chip — visibility is the beacon's own.
    location: (row.location as Location | null) ?? null,
    // v0.7 (§1.47): the "edited" marker (no edit history, the §1.30 pattern).
    edited_at: row.editedAt ? row.editedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function beaconDtosFor(rows: BeaconRow[], viewerId: string): Promise<Beacon[]> {
  const parts = await loadBeaconParts(rows);
  const blockedIds = await blockedSetOf(viewerId);
  const viewer = { id: viewerId, blockedIds };
  return rows.flatMap((row) => {
    const p = parts.get(row.id);
    return p ? [beaconDtoFromParts(row, p, viewer)] : [];
  });
}

export async function loadBeaconDtoFor(row: BeaconRow, viewerId: string): Promise<Beacon> {
  const [dto] = await beaconDtosFor([row], viewerId);
  return dto!;
}

// ---------------------------------------------------------------------------
// Fan-out (beacon.new / beacon.updated) — per-viewer stamped at publish time,
// where the recipient set is known (ADR-009 edge filtering; the Redis events
// channel itself stays an unfiltered firehose: each envelope already names its
// exact recipients).
// ---------------------------------------------------------------------------

export async function fanBeacon(
  row: BeaconRow,
  event: 'beacon.new' | 'beacon.updated',
  // v0.7 (§1.47): edited/changed mark a creator edit on the beacon.updated
  // frame (changed ⊆ BEACON_EDITABLE_FIELDS); Zod defaults keep old clients
  // parsing clean.
  opts: { reping?: boolean; edited?: boolean; changed?: string[] } = {},
): Promise<void> {
  const partsMap = await loadBeaconParts([row]);
  const parts = partsMap.get(row.id);
  if (!parts) return;
  const audience = await audienceUserIds(row); // minus blocks w.r.t. creator
  const recipients = [...new Set([row.creatorId, ...audience])];

  // Block pairs against the FULL joiner set, batched once per fan-out: they
  // filter each recipient's pile AND decide who may hear about the beacon at
  // all (a blocked-pair joiner makes the beacon unjoinable for the blocked
  // counterpart, and no one is ever notified about a beacon they cannot join
  // — PSYCHOLOGY rule 2, §1.14).
  const joinerIds = parts.joins.map((j) => j.userId);
  const joinerSet = new Set(joinerIds);
  const pileUserIds = joinerIds.slice(0, BEACON_JOINERS_PREVIEW_MAX + 4);
  const pairs = await blockPairsAmong(joinerIds);

  // Group recipients by identical serialization so a public beacon costs a
  // handful of envelopes, not one per user.
  const groups = new Map<string, { dto: Beacon; userIds: string[] }>();
  for (const userId of recipients) {
    const isMember = userId === row.creatorId || joinerSet.has(userId);
    if (!isMember && joinerIds.some((jid) => pairs.has(`${userId}:${jid}`))) {
      continue; // unjoinable for them ⇒ they never hear about it
    }
    const blockedIds = new Set<string>();
    for (const pid of pileUserIds) {
      if (pairs.has(`${userId}:${pid}`)) blockedIds.add(pid);
    }
    const dto = beaconDtoFromParts(row, parts, { id: userId, blockedIds });
    const key = `${dto.my_state}|${dto.conversation_id ?? ''}|${dto.joiners.map((j) => j.id).join(',')}`;
    const g = groups.get(key);
    if (g) g.userIds.push(userId);
    else groups.set(key, { dto, userIds: [userId] });
  }

  for (const { dto, userIds } of groups.values()) {
    if (event === 'beacon.new') {
      await publishToUsers(userIds, { t: 'beacon.new', d: { beacon: dto } });
    } else {
      const d: BeaconUpdatedEvent['d'] = {
        beacon: dto,
        reping: opts.reping ?? false,
        edited: opts.edited ?? false,
        changed: opts.changed ?? [],
      };
      await publishToUsers(userIds, { t: 'beacon.updated', d });
    }
  }
  // A recipient outside the audience never appears in `recipients`, so
  // beacon.* can never reach a non-audience user or a blocked pair (rule 2).
}

/**
 * Push for beacon events (§1.15: beacon.new to offline audience; spark to
 * joiners+creator; the single re-ping). Presence + debounce guards re-check at
 * execution in the worker, so enqueueing for everyone is safe.
 */
export async function pushBeacon(
  userIds: string[],
  d: { beacon_id: string; title: string; body: string; url: string },
): Promise<void> {
  // Hotspot H2: one addBulk round trip, not one queue.add per audience member.
  await enqueueBeaconPushBulk(
    userIds.map((userId) => ({
      kind: 'beacon' as const,
      user_id: userId,
      beacon_id: d.beacon_id,
      title: d.title,
      body: d.body,
      url: d.url,
    })),
  );
}

// ---------------------------------------------------------------------------
// The atomic spark (inside the join transaction — API.md §1.15)
// ---------------------------------------------------------------------------

export interface JoinOutcome {
  row: BeaconRow;
  inserted: boolean;
  sparked: boolean;
  repinged: boolean;
  conversationId: string | null;
  joinerIdsAtSpark: string[];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * §1.14 spark-time re-check, under the caller's beacon row lock: a block
 * created AFTER two members entered the pile must never be minted into the
 * brand-new plan group. Re-checks every pair among the would-be founding
 * members (creator + committed joiners) and evicts the stale join of each
 * blocked pair — the non-creator when the creator is involved, otherwise the
 * later joiner. Returns the cleaned joiner list (join order preserved) and
 * the evicted set.
 */
export async function evictStaleBlockedPairs(
  tx: Tx,
  beaconId: string,
  creatorId: string,
  joinerIds: string[],
): Promise<{ joinerIds: string[]; evicted: Set<string> }> {
  const evicted = new Set<string>();
  if (joinerIds.length === 0) return { joinerIds, evicted };
  const stalePairs = (await tx.execute(sql`
    WITH members AS (
      SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId}
      UNION SELECT ${creatorId}::uuid
    )
    SELECT bl.blocker_id AS a, bl.blocked_id AS b FROM blocks bl
    WHERE bl.blocker_id IN (SELECT user_id FROM members)
      AND bl.blocked_id IN (SELECT user_id FROM members)
  `)) as unknown as { a: string; b: string }[];
  if (stalePairs.length === 0) return { joinerIds, evicted };
  const joinOrder = new Map(joinerIds.map((id, i) => [id, i]));
  for (const { a, b } of stalePairs) {
    if (a === creatorId) evicted.add(b);
    else if (b === creatorId) evicted.add(a);
    else evicted.add((joinOrder.get(a) ?? -1) >= (joinOrder.get(b) ?? -1) ? a : b);
  }
  await tx.execute(sql`
    DELETE FROM beacon_joins
    WHERE beacon_id = ${beaconId} AND user_id IN (${sql.join(
      [...evicted].map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  return { joinerIds: joinerIds.filter((id) => !evicted.has(id)), evicted };
}

/**
 * THE §1.15 spark machinery, verbatim, under the caller's beacon row lock:
 * plan group (creator admin, joiners members, join_seq = 0), seq 1 icebreaker,
 * seq 2 auto venue poll, the guarded status flip (belt-and-braces), ritual
 * count + creator karma bumps. Reused unchanged by the threshold spark
 * (joinAndMaybeSpark), the §1.47 edit-transaction spark (threshold lowered to
 * the current count) and POST .../spark-now. Returns the new conversation id.
 * Fan-out, push and the afterglow job stay the caller's post-commit duty.
 */
export async function sparkUnderLock(
  tx: Tx,
  beacon: { id: string; creatorId: string; vibe: string },
  joinerIds: string[],
): Promise<string> {
  const conversationId = newId();
  const nowIso = new Date().toISOString();
  await tx.execute(sql`
    INSERT INTO conversations (id, type, title, created_by, last_seq, last_message_at)
    VALUES (${conversationId}, 'group', ${`${capitalize(beacon.vibe)} plan`}, ${beacon.creatorId}, 2, ${nowIso}::timestamptz)
  `);
  // Founding members: creator admin + all joiners, join_seq = 0 so everyone
  // sees the whole plan from seq 1.
  await tx.execute(sql`
    INSERT INTO conversation_participants (conversation_id, user_id, role, join_seq)
    VALUES (${conversationId}, ${beacon.creatorId}, 'admin', 0)
  `);
  for (const jid of joinerIds) {
    await tx.execute(sql`
      INSERT INTO conversation_participants (conversation_id, user_id, role, join_seq)
      VALUES (${conversationId}, ${jid}, 'member', 0)
      ON CONFLICT DO NOTHING
    `);
  }
  // seq 1: the icebreaker system message (event beacon_sparked).
  await tx.insert(schema.messages).values({
    id: newId(),
    conversationId,
    seq: 1,
    senderId: null,
    type: 'system',
    body: icebreakerFor(beacon.id),
    metadata: { system: { event: 'beacon_sparked' } },
  });
  // seq 2: the auto venue poll (a §1.17 poll message, sender null).
  await tx.insert(schema.messages).values({
    id: newId(),
    conversationId,
    seq: 2,
    senderId: null,
    type: 'poll',
    body: BEACON_VENUE_POLL_QUESTION,
    metadata: {},
  });
  await tx.insert(schema.polls).values({
    id: newId(),
    conversationId,
    seq: 2,
    question: BEACON_VENUE_POLL_QUESTION,
    options: [...BEACON_VENUE_POLL_OPTIONS],
  });
  // The guarded flip — belt-and-braces under the row lock. ritual_count
  // increments ON SPARK (counts UP; API.md §1.15 rituals).
  const flipped = (await tx.execute(sql`
    UPDATE beacons SET
      status = 'sparked',
      conversation_id = ${conversationId},
      ritual_count = ritual_count + (CASE WHEN ritual_rrule IS NOT NULL THEN 1 ELSE 0 END)
    WHERE id = ${beacon.id} AND status = 'open'
    RETURNING id
  `)) as unknown as { id: string }[];
  if (flipped.length === 0) throw new Error('beacon spark race (impossible under lock)');
  await tx.execute(sql`
    UPDATE users SET beacons_sparked = beacons_sparked + 1 WHERE id = ${beacon.creatorId}
  `);
  // v0.8a (§1.59): spark → beacon_sparked, CREATOR ONLY (a joiner's
  // attendance is the plan group's business, not a strip item) — inside the
  // spark transaction through THE one helper. Pointer only.
  await recordActivity(tx, {
    user_id: beacon.creatorId,
    kind: 'beacon_sparked',
    ref: { beacon_id: beacon.id },
  });
  return conversationId;
}

export interface SparkNowOutcome {
  row: BeaconRow;
  conversationId: string;
  joinerIds: string[];
}

// -----------------------------------------------------------------------------
// v0.7 (§1.47) PATCH /api/beacons/:id — the edit transaction. The route owns
// request-shape validation (custom-vibe pairing, window rules, audience
// immutability); this function owns everything that must happen under the
// beacon row lock: the threshold floor against the CURRENT joiner count, the
// field writes + edited_at, and the equality spark (threshold lowered to
// "whoever's here") through the §1.15 machinery verbatim.
// -----------------------------------------------------------------------------

export interface BeaconEditInput {
  vibe?: string;
  /** Effective only when the new vibe is 'custom'; cleared otherwise. */
  customVibeEmoji?: string;
  customVibeLabel?: string;
  note?: string;
  startsAt?: Date;
  expiresAt?: Date;
  sparkThreshold?: number;
  /** undefined = unchanged; null clears the chip. */
  location?: Location | null;
}

export interface BeaconEditOutcome {
  row: BeaconRow;
  changed: string[]; // ⊆ BEACON_EDITABLE_FIELDS
  sparked: boolean;
  conversationId: string | null;
  joinerIds: string[];
}

export async function editOpenBeacon(
  beaconId: string,
  input: BeaconEditInput,
): Promise<BeaconEditOutcome | 'threshold_below_joins' | null> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT * FROM beacons WHERE id = ${beaconId} FOR UPDATE
    `)) as unknown as Record<string, unknown>[];
    if (!locked[0]) return null;
    const row = rawToBeaconRow(locked[0]);
    if (row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) return null;

    const joinRows = (await tx.execute(sql`
      SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId} ORDER BY created_at ASC
    `)) as unknown as { user_id: string }[];
    const joinerIds = joinRows.map((r) => r.user_id);

    // The threshold floor binds against the COMMITTED joiner count under the
    // row lock — a concurrent join cannot slip beneath it.
    if (input.sparkThreshold !== undefined && input.sparkThreshold < joinerIds.length) {
      return 'threshold_below_joins';
    }

    // Effective new values (the route already enforced the custom-vibe pair).
    const newVibe = input.vibe ?? row.vibe;
    const newEmoji =
      newVibe === 'custom' ? (input.customVibeEmoji ?? row.customVibeEmoji) : null;
    const newLabel =
      newVibe === 'custom' ? (input.customVibeLabel ?? row.customVibeLabel) : null;
    const newNote = input.note ?? row.note;
    const newStartsAt = input.startsAt ?? row.startsAt;
    const newExpiresAt = input.expiresAt ?? row.expiresAt;
    const newThreshold = input.sparkThreshold ?? row.sparkThreshold;
    const newLocation =
      input.location === undefined ? ((row.location as Location | null) ?? null) : input.location;

    const changed: string[] = [];
    if (newVibe !== row.vibe) changed.push('vibe');
    if (newEmoji !== row.customVibeEmoji) changed.push('custom_vibe_emoji');
    if (newLabel !== row.customVibeLabel) changed.push('custom_vibe_label');
    if (newNote !== row.note) changed.push('note');
    if (newStartsAt.getTime() !== row.startsAt.getTime()) changed.push('starts_at');
    if (newExpiresAt.getTime() !== row.expiresAt.getTime()) changed.push('expires_at');
    if (newThreshold !== row.sparkThreshold) changed.push('spark_threshold');
    if (JSON.stringify(newLocation) !== JSON.stringify((row.location as Location | null) ?? null)) {
      changed.push('location');
    }

    if (changed.length === 0) {
      // A no-op PATCH is a 200 of the current state — no edited_at bump, no
      // fan-out, no push (nothing changed for anyone).
      return { row, changed, sparked: false, conversationId: null, joinerIds };
    }

    await tx
      .update(b)
      .set({
        vibe: newVibe,
        customVibeEmoji: newEmoji,
        customVibeLabel: newLabel,
        note: newNote,
        startsAt: newStartsAt,
        expiresAt: newExpiresAt,
        sparkThreshold: newThreshold,
        location: newLocation,
        editedAt: new Date(),
      })
      .where(eq(b.id, beaconId));

    // threshold == current count sparks INSIDE the edit transaction — lowering
    // the bar to "whoever's here" is a legitimate way to start (§1.47). The
    // §1.14 stale-pair eviction runs first, exactly like the threshold spark;
    // a cleaned pile that no longer reaches the bar simply does not spark.
    let sparked = false;
    let conversationId: string | null = null;
    let sparkJoinerIds = joinerIds;
    if (
      input.sparkThreshold !== undefined &&
      joinerIds.length > 0 &&
      newThreshold <= joinerIds.length
    ) {
      const cleaned = await evictStaleBlockedPairs(tx, beaconId, row.creatorId, joinerIds);
      sparkJoinerIds = cleaned.joinerIds;
      if (sparkJoinerIds.length >= newThreshold && sparkJoinerIds.length > 0) {
        conversationId = await sparkUnderLock(
          tx,
          { id: beaconId, creatorId: row.creatorId, vibe: newVibe },
          sparkJoinerIds,
        );
        sparked = true;
      }
    }

    const [fresh] = (await tx.execute(
      sql`SELECT * FROM beacons WHERE id = ${beaconId}`,
    )) as unknown as Record<string, unknown>[];
    return {
      row: rawToBeaconRow(fresh!),
      changed,
      sparked,
      conversationId,
      joinerIds: sparkJoinerIds,
    };
  });
}

/**
 * v0.7 (§1.47) POST /api/beacons/:id/spark-now — "start with whoever's here":
 * the existing spark transaction under the beacon row lock, with the threshold
 * simply not consulted. Returns null when the beacon is not 'open' (or past
 * expires_at) under the lock, and 'no_joiners' when the cleaned pile is empty
 * (a plan needs at least two people). The §1.14 stale-pair eviction runs
 * exactly like the threshold-spark path.
 */
export async function sparkNow(beaconId: string): Promise<SparkNowOutcome | 'no_joiners' | null> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT * FROM beacons WHERE id = ${beaconId} FOR UPDATE
    `)) as unknown as Record<string, unknown>[];
    const raw = locked[0];
    if (!raw) return null;
    const status = raw.status as string;
    const expiresAt = new Date(raw.expires_at as string | Date);
    if (status !== 'open' || expiresAt.getTime() <= Date.now()) return null;
    const creatorId = raw.creator_id as string;

    const joinRows = (await tx.execute(sql`
      SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId} ORDER BY created_at ASC
    `)) as unknown as { user_id: string }[];
    const { joinerIds } = await evictStaleBlockedPairs(
      tx,
      beaconId,
      creatorId,
      joinRows.map((r) => r.user_id),
    );
    if (joinerIds.length < 1) return 'no_joiners';

    const conversationId = await sparkUnderLock(
      tx,
      { id: beaconId, creatorId, vibe: raw.vibe as string },
      joinerIds,
    );
    const [fresh] = (await tx.execute(
      sql`SELECT * FROM beacons WHERE id = ${beaconId}`,
    )) as unknown as Record<string, unknown>[];
    return { row: rawToBeaconRow(fresh!), conversationId, joinerIds };
  });
}

/**
 * Join + (maybe) spark, atomically: SELECT … FOR UPDATE on the beacon row
 * serializes concurrent joins; the guarded UPDATE … WHERE status='open' is the
 * belt-and-braces flip. On spark, the plan group conversation (creator admin,
 * joiners members, join_seq = 0 — founding members see the whole plan), the
 * icebreaker system message (seq 1) and the auto venue poll (seq 2) are all
 * created in the SAME transaction; creator karma + ritual_count bump with it.
 * Fan-out and the afterglow job are the caller's post-commit duty.
 *
 * Returns null when the beacon is not 'open' or already past expires_at under
 * the lock (the caller answers 410 beacon_closed), and 'blocked' when the
 * creator or any already-committed joiner is blocked w.r.t. the joining user
 * (the caller answers 404 beacon_not_found — §1.14 shape). The block check
 * runs under the row lock so two blocked users racing the same beacon can
 * never both land in the pile (the loser sees the winner's committed join).
 *
 * §1.14 also binds at spark time: a block created AFTER two members entered
 * the pile must never be minted into the brand-new plan group. So the spark
 * path re-checks every pair among the would-be founding members (creator +
 * all committed joiners) under the same row lock and evicts the stale join
 * of each blocked pair before deciding whether the cleaned pile still
 * crosses the threshold.
 */
export async function joinAndMaybeSpark(
  beaconId: string,
  userId: string,
): Promise<JoinOutcome | 'blocked' | null> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT * FROM beacons WHERE id = ${beaconId} FOR UPDATE
    `)) as unknown as Record<string, unknown>[];
    const raw = locked[0];
    if (!raw) return null;
    const status = raw.status as string;
    const expiresAt = new Date(raw.expires_at as string | Date);
    if (status !== 'open' || expiresAt.getTime() <= Date.now()) return null;

    // §1.14: never mint a plan group containing a blocked pair. Serialized by
    // the row lock above, so the joiner set cannot change underneath us.
    const blockedRows = (await tx.execute(sql`
      WITH members AS (
        SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId}
        UNION SELECT ${raw.creator_id as string}::uuid
      )
      SELECT 1 AS one FROM blocks bl
      WHERE (bl.blocker_id = ${userId} AND bl.blocked_id IN (SELECT user_id FROM members))
         OR (bl.blocked_id = ${userId} AND bl.blocker_id IN (SELECT user_id FROM members))
      LIMIT 1
    `)) as unknown as { one: number }[];
    if (blockedRows.length > 0) return 'blocked';

    const insertedRows = (await tx.execute(sql`
      INSERT INTO beacon_joins (beacon_id, user_id) VALUES (${beaconId}, ${userId})
      ON CONFLICT DO NOTHING RETURNING user_id
    `)) as unknown as { user_id: string }[];
    const inserted = insertedRows.length > 0;

    const joinRows = (await tx.execute(sql`
      SELECT user_id FROM beacon_joins WHERE beacon_id = ${beaconId} ORDER BY created_at ASC
    `)) as unknown as { user_id: string }[];
    let joinerIds = joinRows.map((r) => r.user_id);
    const threshold = Number(raw.spark_threshold);
    const creatorId = raw.creator_id as string;
    const vibe = raw.vibe as string;

    let sparked = false;
    let repinged = false;
    let conversationId: string | null = null;

    if (inserted && joinerIds.length >= threshold) {
      // §1.14 spark-time re-check, still under the row lock: the pre-insert
      // check above only cleared the INCOMING joiner against the pile, but a
      // block created while two members were already sitting in the pile
      // would otherwise be sparked into one brand-new plan group. Evict the
      // stale join of each blocked pair, then re-evaluate the threshold
      // against the cleaned pile.
      const cleaned = await evictStaleBlockedPairs(tx, beaconId, creatorId, joinerIds);
      joinerIds = cleaned.joinerIds;
      // The incoming joiner themselves hit a block committed between the
      // pre-insert check and here: their join is gone again, and the
      // caller answers the same 404-shaped §1.14 refusal as above.
      if (cleaned.evicted.has(userId)) return 'blocked';
    }

    if (inserted && joinerIds.length >= threshold) {
      // ---- SPARK (the §1.15 machinery, shared with spark-now/§1.47) ----
      conversationId = await sparkUnderLock(tx, { id: beaconId, creatorId, vibe }, joinerIds);
      sparked = true;
    } else if (inserted && joinerIds.length === threshold - 1) {
      // Re-ping ("needs 1 more") — the one-shot guarded claim, at most once
      // per beacon row, ever.
      const claimed = (await tx.execute(sql`
        UPDATE beacons SET repinged_at = now()
        WHERE id = ${beaconId} AND repinged_at IS NULL AND status = 'open'
        RETURNING id
      `)) as unknown as { id: string }[];
      repinged = claimed.length > 0;
    }

    const [fresh] = (await tx.execute(sql`SELECT * FROM beacons WHERE id = ${beaconId}`)) as unknown as Record<string, unknown>[];
    return {
      row: rawToBeaconRow(fresh!),
      inserted,
      sparked,
      repinged,
      conversationId,
      joinerIdsAtSpark: joinerIds,
    };
  });
}

export function rawToBeaconRow(r: Record<string, unknown>): BeaconRow {
  return {
    id: r.id as string,
    creatorId: r.creator_id as string,
    vibe: r.vibe as string,
    customVibeEmoji: (r.custom_vibe_emoji as string | null) ?? null,
    customVibeLabel: (r.custom_vibe_label as string | null) ?? null,
    note: r.note as string,
    audience: r.audience as string,
    area: (r.area as string | null) ?? null,
    location: (r.location as unknown) ?? null,
    editedAt: r.edited_at ? new Date(r.edited_at as string | Date) : null,
    startingSoonPingedAt: r.starting_soon_pinged_at
      ? new Date(r.starting_soon_pinged_at as string | Date)
      : null,
    startsAt: new Date(r.starts_at as string | Date),
    expiresAt: new Date(r.expires_at as string | Date),
    sparkThreshold: Number(r.spark_threshold),
    status: r.status as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    repingedAt: r.repinged_at ? new Date(r.repinged_at as string | Date) : null,
    ritualRrule: (r.ritual_rrule as string | null) ?? null,
    ritualCount: Number(r.ritual_count),
    ritualSkips: Number(r.ritual_skips),
    ritualParentId: (r.ritual_parent_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string | Date),
  };
}
