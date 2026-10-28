// Suggestions & find-your-people (v0.8b — API.md §1.64, FEATURES #78,
// ADR-019). People-you-may-know for Feed-Discover and the connections page —
// pull-only (no WS, no push: the §1.38 doctrine). Candidates: connections of
// my connections ∪ same-area users ∪ co-members of my NON-GHOST groups
// (ghost groups are unlisted EVERYWHERE, §1.68 — and the per-user Support
// conversation is one-member by construction, so it never surfaces anyone).
// Excluded entirely: me, §1.14 blocked pairs both ways, the friends-of set,
// ANY connection row either direction (accepted = friends-of; pending =
// no-pressure; a past decline never re-surfaces), dismissed, banned.
// Dismissals are permanent and SILENT (PSYCHOLOGY rule 4).
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DISCOVERY_SHARED_INTERESTS_MAX,
  SUGGESTION_MUTUALS_PREVIEW_MAX,
  SUGGESTIONS_MAX,
  SuggestionsQuerySchema,
  type Suggestion,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { authed, requireAuth } from '../auth/guard.js';

const UserIdParams = z.object({ userId: z.string().uuid() });

interface CandidateRow {
  id: string;
  mutual_count: number | string;
  same_area: boolean;
  shared_groups: number | string;
}

export async function suggestionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.64 GET /api/suggestions — ≤ SUGGESTIONS_MAX, best evidence first
  // (mutual_count DESC, then shared_groups, then same_area, then newest
  // account). same_area is a BOOLEAN (the area TEXT stays owner-private).
  // v1.0 (#78c): ?mutuals=&groups=&area=&interests= each NARROW (the §1.65
  // doctrine); interests also decorates every card with shared_interests.
  app.get(
    '/api/suggestions',
    { preHandler: requireAuth, schema: { querystring: SuggestionsQuerySchema } },
    async (req) => {
    const { user } = authed(req);
    const me = user.id;
    const myArea = user.area;
    const q = req.query;
    const myInterests = user.interests ?? [];
    const interestsCond =
      q.interests && myInterests.length > 0
        ? sql`AND u.interests && ARRAY[${sql.join(myInterests.map((t) => sql`${t}`), sql`, `)}]::text[]`
        : q.interests
          ? sql`AND FALSE` // I have no public tags — an honest empty result
          : sql``;
    const filterCond = sql`
      ${q.mutuals ? sql`AND (SELECT count(*) FROM connections cm
        WHERE cm.status = 'accepted'
          AND ((cm.requester_id = u.id AND cm.addressee_id IN (SELECT uid FROM my_conns))
            OR (cm.addressee_id = u.id AND cm.requester_id IN (SELECT uid FROM my_conns)))) > 0` : sql``}
      ${q.area ? (myArea ? sql`AND u.area = ${myArea}` : sql`AND FALSE`) : sql``}
      ${q.groups ? sql`AND EXISTS (SELECT 1 FROM conversation_participants cg
        WHERE cg.user_id = u.id AND cg.left_at IS NULL
          AND cg.conversation_id IN (SELECT conversation_id FROM my_groups))` : sql``}
      ${interestsCond}
    `;

    const rows = (await db.execute(sql`
      WITH my_conns AS (
        SELECT CASE WHEN c.requester_id = ${me} THEN c.addressee_id ELSE c.requester_id END AS uid
        FROM connections c
        WHERE c.status = 'accepted' AND (c.requester_id = ${me} OR c.addressee_id = ${me})
      ),
      my_groups AS (
        SELECT cp.conversation_id
        FROM conversation_participants cp
        JOIN conversations gc ON gc.id = cp.conversation_id
          AND gc.type = 'group' AND gc.visibility <> 'ghost'
          AND NOT (gc.metadata ? 'support')
        WHERE cp.user_id = ${me} AND cp.left_at IS NULL
      ),
      candidates AS (
        SELECT DISTINCT uid FROM (
          SELECT CASE WHEN c2.requester_id = mc.uid THEN c2.addressee_id ELSE c2.requester_id END AS uid
          FROM my_conns mc
          JOIN connections c2 ON c2.status = 'accepted'
            AND (c2.requester_id = mc.uid OR c2.addressee_id = mc.uid)
          UNION
          SELECT au.id FROM users au
          WHERE ${myArea ?? null}::text IS NOT NULL AND au.area = ${myArea ?? ''}
          UNION
          SELECT cp2.user_id FROM conversation_participants cp2
          WHERE cp2.conversation_id IN (SELECT conversation_id FROM my_groups)
            AND cp2.left_at IS NULL
        ) t
      )
      SELECT u.id,
        (SELECT count(*)::int FROM connections c3
          WHERE c3.status = 'accepted'
            AND ((c3.requester_id = u.id AND c3.addressee_id IN (SELECT uid FROM my_conns))
              OR (c3.addressee_id = u.id AND c3.requester_id IN (SELECT uid FROM my_conns)))
        ) AS mutual_count,
        (${myArea ?? null}::text IS NOT NULL AND u.area = ${myArea ?? ''}) AS same_area,
        (SELECT count(DISTINCT cp3.conversation_id)::int FROM conversation_participants cp3
          WHERE cp3.user_id = u.id AND cp3.left_at IS NULL
            AND cp3.conversation_id IN (SELECT conversation_id FROM my_groups)
        ) AS shared_groups
      FROM candidates cand
      JOIN users u ON u.id = cand.uid
      WHERE u.id <> ${me}
        AND u.banned_at IS NULL AND u.suspended_at IS NULL AND u.deactivated_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blocks bl
          WHERE (bl.blocker_id = ${me} AND bl.blocked_id = u.id)
             OR (bl.blocker_id = u.id AND bl.blocked_id = ${me}))
        AND NOT EXISTS (
          SELECT 1 FROM connections cx
          WHERE (cx.requester_id = ${me} AND cx.addressee_id = u.id)
             OR (cx.addressee_id = ${me} AND cx.requester_id = u.id))
        AND NOT EXISTS (
          SELECT 1 FROM conversation_participants dp1
          JOIN conversation_participants dp2 ON dp2.conversation_id = dp1.conversation_id
          JOIN conversations dc ON dc.id = dp1.conversation_id AND dc.type = 'dm'
          WHERE dp1.user_id = ${me} AND dp2.user_id = u.id
            AND dp1.left_at IS NULL AND dp2.left_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM suggestion_dismissals d
          WHERE d.user_id = ${me} AND d.suggested_user_id = u.id)
        ${filterCond}
      ORDER BY mutual_count DESC, shared_groups DESC, same_area DESC, u.created_at DESC
      LIMIT ${SUGGESTIONS_MAX}
    `)) as unknown as CandidateRow[];

    const ids = rows.map((r) => r.id);
    const userRows =
      ids.length > 0
        ? await db
            .select()
            .from(schema.users)
            .where(sql`${schema.users.id} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
        : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));

    const suggestions: Suggestion[] = [];
    for (const r of rows) {
      const u = userById.get(r.id);
      if (!u) continue;
      // Mutual FACES: ≤ SUGGESTION_MUTUALS_PREVIEW_MAX people I ALREADY know
      // (no new exposure), by username — the count carries the rest.
      const mutuals = (await db.execute(sql`
        SELECT mu.* FROM users mu
        WHERE mu.id IN (
          SELECT CASE WHEN c.requester_id = ${me} THEN c.addressee_id ELSE c.requester_id END
          FROM connections c
          WHERE c.status = 'accepted' AND (c.requester_id = ${me} OR c.addressee_id = ${me})
        )
        AND EXISTS (
          SELECT 1 FROM connections c2
          WHERE c2.status = 'accepted'
            AND ((c2.requester_id = mu.id AND c2.addressee_id = ${r.id})
              OR (c2.addressee_id = mu.id AND c2.requester_id = ${r.id})))
        ORDER BY mu.username ASC
        LIMIT ${SUGGESTION_MUTUALS_PREVIEW_MAX}
      `)) as unknown as Record<string, unknown>[];
      const mine = new Set(myInterests.map((t) => t.toLowerCase()));
      const sharedInterests = (u.interests ?? [])
        .filter((t) => mine.has(t.toLowerCase()))
        .slice(0, DISCOVERY_SHARED_INTERESTS_MAX);
      suggestions.push({
        user: userLiteDto(u),
        mutual_count: Number(r.mutual_count),
        mutuals: mutuals.map((m) => userLiteDto(rawUserRow(m))),
        same_area: Boolean(r.same_area),
        shared_groups: Number(r.shared_groups),
        shared_interests: sharedInterests,
      });
    }
    return { suggestions };
    },
  );

  // §1.64 POST /api/suggestions/:userId/dismiss — 204, idempotent, PERMANENT.
  // The dismissed user is never told; nothing re-surfaces them. An unknown id
  // answers the same 204 (no enumeration oracle on a write).
  app.post(
    '/api/suggestions/:userId/dismiss',
    { preHandler: requireAuth, schema: { params: UserIdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      if (req.params.userId !== user.id) {
        try {
          await db.execute(sql`
            INSERT INTO suggestion_dismissals (user_id, suggested_user_id)
            VALUES (${user.id}, ${req.params.userId})
            ON CONFLICT DO NOTHING
          `);
        } catch (err) {
          // Unknown target (FK) — the dismissal of nobody is a no-op 204.
          if ((err as { code?: string }).code !== '23503') throw err;
        }
      }
      return reply.status(204).send();
    },
  );
}

/** Raw SELECT mu.* rows are snake_case; rebuild the UserRow shape the DTO
 * mapper needs (the rawToMsgRow pattern, users flavor). */
function rawUserRow(r: Record<string, unknown>): UserRow {
  return {
    ...(r as object),
    id: r.id as string,
    username: r.username as string,
    displayName: r.display_name as string,
    avatarStatus: r.avatar_status as string,
    avatarVersion: Number(r.avatar_version),
    avatarStaticKey: (r.avatar_static_key as string | null) ?? null,
    avatarAnimatedKey: (r.avatar_animated_key as string | null) ?? null,
    nameStyle: (r.name_style as string) ?? 'none',
    moodEmoji: (r.mood_emoji as string | null) ?? null,
    moodLabel: (r.mood_label as string | null) ?? null,
    moodKind: (r.mood_kind as string | null) ?? null,
    moodVisibility: (r.mood_visibility as string) ?? 'everyone',
    moodExpiresAt: r.mood_expires_at ? new Date(r.mood_expires_at as string) : null,
  } as UserRow;
}
