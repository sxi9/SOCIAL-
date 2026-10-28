// v0.6 Bored Together — discovery (API.md §1.44), expectation feedback + the
// encouragement aggregate (§1.45; PSYCHOLOGY finding #10). Hard rules carried
// here: cards require the viewer's OWN live opt-in (symmetric visibility, no
// lurking); a single wave notifies NOBODY (parked write-only, deleted only by
// the match transaction or the sweep); mutual-wave matching is serialized per
// pair with an advisory lock so concurrent waves mint exactly ONE DM; the
// feedback table is private-in, aggregate-out.
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  DISCOVERY_CARDS_MAX,
  DISCOVERY_OPTIN_TTL_S,
  DISCOVERY_SHARED_INTERESTS_MAX,
  DISCOVERY_WAVE_RATE_PER_HOUR,
  DiscoveryCardsQuerySchema,
  DiscoveryOptinRequestSchema,
  ENCOURAGEMENT_MIN_SAMPLES,
  ExpectationFeedbackRequestSchema,
  WaveRequestSchema,
  type DiscoveryCard,
  type UserLite,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { avatarDto, userLiteDto, type UserRow } from '../../lib/dto.js';
import { badRequest, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { friendsOfPairCond } from '../../lib/friends.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { enqueueSocialPush, enqueueWaveNudge } from '../../queues.js';
import { redis } from '../../redis.js';
import { publishToUsers } from '../../ws/events.js';
import { authed, requireAuth } from '../auth/guard.js';
import { fanOutNewMessage } from '../messages/service.js';
import {
  createMatchedDmTx,
  liveOptinOf,
  optinDto,
  rouletteFeedbackKey,
  type OptinRow,
} from './service.js';

const o = schema.discoveryOptins;
const u = schema.users;

interface CardRow {
  user_id: string;
  scope: string;
  note: string;
  vibe: string | null;
  interests: string[] | null;
  expires_at: Date | string;
  username: string;
  display_name: string;
  name_style: string;
  avatar_status: string;
  avatar_version: number;
  avatar_static_key: string | null;
  avatar_animated_key: string | null;
  waved: boolean;
}

/** v0.8b (§1.65): each filter only ever NARROWS the §1.44 pool. */
export interface CardFilters {
  vibe?: string;
  /** keep cards sharing ≥1 PUBLIC interest tag with me */
  interests?: boolean;
  /** keep cards whose owner's area equals mine (citext; never serialized) */
  area?: boolean;
}

/**
 * §1.44 mutual-reachability card query: users U with a live opt-in where U's
 * scope reaches me AND my scope reaches U (area = citext equality on MY
 * area), excluding both ways: blocks, the friends-of set, suspended/banned,
 * me. The area TEXT itself is never serialized (FEATURES #30).
 */
export async function visibleCards(
  meId: string,
  myOptin: OptinRow,
  myArea: string | null,
  targetId?: string,
  filters: CardFilters = {},
  myInterests: string[] = [],
): Promise<CardRow[]> {
  // NOTE: raw-SQL aliases (o, u) — never Drizzle column refs here, they
  // render fully qualified and miss the alias.
  const theirReach = myArea
    ? sql`(o.scope = 'public' OR u.area = ${myArea})`
    : sql`o.scope = 'public'`;
  const myReach =
    myOptin.scope === 'public' ? sql`TRUE` : myArea ? sql`u.area = ${myArea}` : sql`FALSE`;
  // v0.8b (§1.65): filters only ever NARROW. A card without a vibe simply
  // never matches a vibe filter; interests intersect the two PUBLIC §1.37
  // lists; the area MATCH is computed here — the text never serializes.
  const vibeCond = filters.vibe ? sql`AND o.vibe = ${filters.vibe}` : sql``;
  const interestsCond =
    filters.interests && myInterests.length > 0
      ? sql`AND u.interests && ARRAY[${sql.join(myInterests.map((t) => sql`${t}`), sql`, `)}]::text[]`
      : filters.interests
        ? sql`AND FALSE` // I have no public tags — an honest empty result
        : sql``;
  const areaCond = filters.area
    ? myArea
      ? sql`AND u.area = ${myArea}`
      : sql`AND FALSE`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT o.user_id, o.scope, o.note, o.vibe, o.expires_at, u.interests,
           u.username, u.display_name, u.name_style,
           u.avatar_status, u.avatar_version, u.avatar_static_key, u.avatar_animated_key,
           EXISTS (SELECT 1 FROM discovery_waves w
                   WHERE w.from_user_id = ${meId} AND w.to_user_id = o.user_id) AS waved
    FROM discovery_optins o
    JOIN users u ON u.id = o.user_id
    WHERE o.expires_at > now()
      AND o.user_id <> ${meId}
      ${targetId ? sql`AND o.user_id = ${targetId}` : sql``}
      AND u.suspended_at IS NULL AND u.banned_at IS NULL
      AND ${theirReach}
      AND ${myReach}
      ${vibeCond}
      ${interestsCond}
      ${areaCond}
      AND NOT EXISTS (
        SELECT 1 FROM blocks bl
        WHERE (bl.blocker_id = ${meId} AND bl.blocked_id = o.user_id)
           OR (bl.blocker_id = o.user_id AND bl.blocked_id = ${meId}))
      AND NOT ${friendsOfPairCond(meId, sql`o.user_id`)}
    ORDER BY o.created_at DESC
    LIMIT ${targetId ? 1 : DISCOVERY_CARDS_MAX}
  `)) as unknown as CardRow[];
  return rows;
}

function cardDto(row: CardRow, myInterests: string[] = []): DiscoveryCard {
  const user: UserLite = {
    id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    avatar: avatarDto({
      avatarStatus: row.avatar_status,
      avatarVersion: Number(row.avatar_version),
      avatarStaticKey: row.avatar_static_key,
      avatarAnimatedKey: row.avatar_animated_key,
    }),
    // v0.8a: a discovery card is for strangers — mood serializes null here
    // (§1.57 conservative rule; no per-viewer ctx on this surface).
    mood: null,
    name_style: ((row.name_style ?? 'none') as UserLite['name_style']),
    mask_emoji: null,
  };
  // v0.8b (§1.65): the overlap of the two PUBLIC §1.37 interest lists, first
  // DISCOVERY_SHARED_INTERESTS_MAX by the OWNER's tag order — already-public
  // data, intersected; nothing new revealed.
  const mine = new Set(myInterests.map((t) => t.toLowerCase()));
  const shared = (row.interests ?? [])
    .filter((t) => mine.has(t.toLowerCase()))
    .slice(0, DISCOVERY_SHARED_INTERESTS_MAX);
  return {
    user,
    scope: row.scope as DiscoveryCard['scope'],
    note: row.note,
    vibe: (row.vibe ?? null) as DiscoveryCard['vibe'],
    shared_interests: shared,
    expires_at: new Date(row.expires_at).toISOString(),
    waved: Boolean(row.waved),
  };
}

export async function discoveryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.44 PUT /api/discovery/optin — upsert; a moment, not a setting.
  app.put(
    '/api/discovery/optin',
    { preHandler: requireAuth, schema: { body: DiscoveryOptinRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      // Wave 1 (§1.8): no attestation, no strangers — the client shows the
      // one-time consent sheet on this code and retries.
      if (user.ageAttestedAt === null) throw forbidden('age_attestation_required');
      if (req.body.scope === 'area' && !user.area) throw badRequest('area_required');
      const expiresAt = new Date(Date.now() + DISCOVERY_OPTIN_TTL_S * 1000);
      const [row] = await db
        .insert(o)
        .values({
          userId: user.id,
          scope: req.body.scope,
          note: req.body.note,
          // v0.8b (§1.65): the optional what-for chip.
          vibe: req.body.vibe ?? null,
          createdAt: new Date(),
          expiresAt,
        })
        .onConflictDoUpdate({
          target: o.userId,
          set: {
            scope: req.body.scope,
            note: req.body.note,
            vibe: req.body.vibe ?? null,
            // A re-PUT is a NEW moment: created_at drives card freshness —
            // and clears the §1.63 nudge claim (a fresh hour may nudge once).
            waveNudgedAt: null,
            createdAt: new Date(),
            expiresAt,
          },
        })
        .returning();
      return { optin: optinDto(row!) };
    },
  );

  // §1.44 DELETE /api/discovery/optin — immediate: card vanishes, parked
  // waves die with the opt-in. Idempotent.
  app.delete('/api/discovery/optin', { preHandler: requireAuth }, async (req, reply) => {
    const { user } = authed(req);
    await db.execute(sql`DELETE FROM discovery_waves WHERE from_user_id = ${user.id}`);
    await db.execute(sql`DELETE FROM discovery_optins WHERE user_id = ${user.id}`);
    return reply.status(204).send();
  });

  // §1.44 GET /api/discovery/optin — my own state (owner-only DTO).
  app.get('/api/discovery/optin', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const row = await liveOptinOf(user.id);
    return { optin: row ? optinDto(row) : null };
  });

  // §1.44 GET /api/discovery/cards — symmetric visibility: you are seen
  // while you see, no lurking. v0.8b (§1.65): ?vibe=&interests=&area= each
  // only ever NARROW the pool (never widen, never re-rank).
  app.get(
    '/api/discovery/cards',
    { preHandler: requireAuth, schema: { querystring: DiscoveryCardsQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const mine = await liveOptinOf(user.id);
      if (!mine) throw forbidden('discovery_not_opted_in');
      const rows = await visibleCards(
        user.id,
        mine,
        user.area,
        undefined,
        {
          ...(req.query.vibe ? { vibe: req.query.vibe } : {}),
          ...(req.query.interests ? { interests: true } : {}),
          ...(req.query.area ? { area: true } : {}),
        },
        user.interests ?? [],
      );
      return { cards: rows.map((r) => cardDto(r, user.interests ?? [])) };
    },
  );

  // §1.44 POST /api/discovery/wave — single wave parks silently (NOBODY is
  // notified); mutual wave mints the DM in one advisory-locked transaction.
  app.post(
    '/api/discovery/wave',
    { preHandler: requireAuth, schema: { body: WaveRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const targetId = req.body.user_id;
      if (targetId === user.id) throw notFound('discovery_card_not_found');
      const mine = await liveOptinOf(user.id);
      if (!mine) throw notFound('discovery_card_not_found');
      // Unknown, lapsed, blocked, friends-of: all byte-identical (§1.14).
      const [card] = await visibleCards(user.id, mine, user.area, targetId);
      if (!card) throw notFound('discovery_card_not_found');

      const rate = await fixedWindow(`wave:${user.id}`, DISCOVERY_WAVE_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const pairKey = [user.id, targetId].sort().join(':');
      const result = await db.transaction(async (tx) => {
        // Serialize the pair: two concurrent reciprocal waves must resolve
        // to exactly ONE match transaction (the test pins this).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pairKey}, 42))`);
        // Re-check both opt-ins live under the lock.
        const liveRows = (await tx.execute(sql`
          SELECT user_id FROM discovery_optins
          WHERE user_id IN (${user.id}::uuid, ${targetId}::uuid) AND expires_at > now()
        `)) as unknown as { user_id: string }[];
        if (liveRows.length < 2) return { matched: false as const, existing_wave: false };

        const reciprocal = (await tx.execute(sql`
          DELETE FROM discovery_waves
          WHERE from_user_id = ${targetId} AND to_user_id = ${user.id}
          RETURNING from_user_id
        `)) as unknown as { from_user_id: string }[];

        if (reciprocal.length === 0) {
          const inserted = (await tx.execute(sql`
            INSERT INTO discovery_waves (from_user_id, to_user_id)
            VALUES (${user.id}, ${targetId})
            ON CONFLICT DO NOTHING
            RETURNING from_user_id
          `)) as unknown as { from_user_id: string }[];
          return { matched: false as const, existing_wave: inserted.length === 0 };
        }

        // Mutual: both rows die, the DM is born with its icebreaker.
        await tx.execute(sql`
          DELETE FROM discovery_waves
          WHERE from_user_id = ${user.id} AND to_user_id = ${targetId}
        `);
        const match = await createMatchedDmTx(tx, user.id, targetId, 'discovery');
        return { matched: true as const, match };
      });

      if (!result.matched) {
        // v0.8b (§1.63): a freshly PARKED wave may enqueue the anonymous
        // nudge job — the worker re-checks everything (opt-in live and
        // un-nudged, pool ≥ NUDGE_MIN_POOL) BEFORE claiming wave_nudged_at.
        // Still: a single wave notifies nobody by name, ever.
        if (!result.existing_wave) {
          const [targetRow] = (await db.execute(sql`
            SELECT u.wave_nudges, o2.wave_nudged_at
            FROM users u
            JOIN discovery_optins o2 ON o2.user_id = u.id AND o2.expires_at > now()
            WHERE u.id = ${targetId}
            LIMIT 1
          `)) as unknown as { wave_nudges: boolean; wave_nudged_at: Date | null }[];
          if (targetRow && targetRow.wave_nudges && targetRow.wave_nudged_at === null) {
            await enqueueWaveNudge(targetId);
          }
        }
        // Parked silently — idempotent re-wave included (§1.44).
        return { matched: false, conversation_id: null };
      }

      const { conversationId, icebreaker } = result.match;
      // Fan-out: discovery.matched to BOTH, each stamped with the OTHER party
      // (the connection.updated pattern); the icebreaker as ordinary msg.new;
      // push to an offline party via the §2.9 social-push guards.
      const [meRow] = await db.select().from(u).where(sql`${u.id} = ${user.id}`).limit(1);
      const [otherRow] = await db.select().from(u).where(sql`${u.id} = ${targetId}`).limit(1);
      if (meRow && otherRow) {
        await publishToUsers([user.id], {
          t: 'discovery.matched',
          d: { conversation_id: conversationId, user: userLiteDto(otherRow as UserRow) },
        });
        await publishToUsers([targetId], {
          t: 'discovery.matched',
          d: { conversation_id: conversationId, user: userLiteDto(meRow as UserRow) },
        });
        await enqueueSocialPush({
          kind: 'social',
          user_id: targetId,
          dedupe_key: `discovery:${conversationId}`,
          title: `${meRow.displayName} waved back`,
          body: 'You matched on Bored Together — say hi!',
          url: `/c/${conversationId}`,
        });
        await enqueueSocialPush({
          kind: 'social',
          user_id: user.id,
          dedupe_key: `discovery:${conversationId}`,
          title: `${otherRow.displayName} waved back`,
          body: 'You matched on Bored Together — say hi!',
          url: `/c/${conversationId}`,
        });
      }
      await fanOutNewMessage(icebreaker);
      return { matched: true, conversation_id: conversationId };
    },
  );

  // §1.45 GET /api/discovery/encouragement — the anonymous instance-wide
  // aggregate; null under ENCOURAGEMENT_MIN_SAMPLES. Shown pre-opt-in only
  // (client rule; PSYCHOLOGY finding #10).
  app.get('/api/discovery/encouragement', { preHandler: requireAuth }, async () => {
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE verdict = 'better')::int AS better
      FROM expectation_feedback
    `)) as unknown as { total: number; better: number }[];
    const total = Number(row?.total ?? 0);
    const better = Number(row?.better ?? 0);
    return {
      sample_size: total,
      better_percent: total >= ENCOURAGEMENT_MIN_SAMPLES ? Math.round((better / total) * 100) : null,
    };
  });

  // §1.45 POST /api/discovery/feedback — the PRIVATE one-tap. The
  // conversation id is a dedupe key, not an FK: live conversations check the
  // participant row directly; hard-deleted roulette DMs check the sweep's
  // 24 h Redis tombstone. First verdict wins; repeat taps 204.
  app.post(
    '/api/discovery/feedback',
    { preHandler: requireAuth, schema: { body: ExpectationFeedbackRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const { conversation_id: convId, context, verdict } = req.body;

      const [conv] = (await db.execute(sql`
        SELECT id FROM conversations WHERE id = ${convId} LIMIT 1
      `)) as unknown as { id: string }[];
      if (conv) {
        const [part] = (await db.execute(sql`
          SELECT 1 AS one FROM conversation_participants
          WHERE conversation_id = ${convId} AND user_id = ${user.id}
          LIMIT 1
        `)) as unknown as { one: number }[];
        if (!part) throw notFound('not_found');
      } else {
        const tombstone = await redis.get(rouletteFeedbackKey(convId));
        const parties = tombstone ? (JSON.parse(tombstone) as string[]) : [];
        if (!parties.includes(user.id)) throw notFound('not_found');
      }

      await db.execute(sql`
        INSERT INTO expectation_feedback (id, user_id, conversation_id, context, verdict)
        VALUES (${newId()}, ${user.id}, ${convId}, ${context}, ${verdict})
        ON CONFLICT (user_id, conversation_id) DO NOTHING
      `);
      return reply.status(204).send();
    },
  );
}
