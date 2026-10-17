// Profile activity strip (v0.8a — API.md §1.59, ADR-018, FEATURES #76).
// Read-only and pull-only: no WS event, no push, ever. Per-viewer resolution
// is THE HARD RULE, enforced at serialization time: an item is served iff
// (a) the owner's per-group setting admits the viewer ('public' = anyone who
// can read the profile, 'connections' = accepted §1.28 connections,
// 'private' = owner only) AND (b) the viewer can see the underlying object
// itself, re-checked LIVE against the object's row — the setting narrows,
// never widens, so a friends-only beacon never shows in a public strip
// regardless of the toggle. Invisible items are silently DROPPED: no
// placeholders, no hidden-item counts (PSYCHOLOGY rule 3).
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ACTIVITY_KIND_GROUP,
  ACTIVITY_STRIP_MAX,
  REPLY_EXCERPT_MAX_CHARS,
  type Activity,
  type ActivityKind,
  type ActivitySummary,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { connectionIdsOf } from '../../lib/connections.js';
import { friendsOfIds } from '../../lib/friends.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { notFound } from '../../lib/errors.js';
import { authed, requireAuth } from '../auth/guard.js';
import { getParticipant } from '../conversations/routes.js';

// Over-fetch factor: the strip serves ≤ ACTIVITY_STRIP_MAX AFTER per-viewer
// filtering; dropped items must not shorten a strip that has more to give.
const FETCH_LIMIT = ACTIVITY_STRIP_MAX * 4;

type ActivityRow = typeof schema.activities.$inferSelect;

interface BeaconRef {
  beacon_id: string;
}
interface PostRef {
  post_id: string;
}
interface ListingRef {
  listing_id: string;
}
interface PuzzleRef {
  date: string;
  solved: boolean;
  attempts_used: number;
}
interface GameRef {
  conversation_id: string;
  seq: number;
  opponent_id: string;
}

function settingFor(owner: UserRow, kind: ActivityKind): string {
  switch (ACTIVITY_KIND_GROUP[kind]) {
    case 'beacons':
      return owner.activityBeacons;
    case 'posts':
      return owner.activityPosts;
    case 'listings':
      return owner.activityListings;
    default:
      return owner.activityGames;
  }
}

const sameArea = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export async function activityRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.59 GET /api/users/:username/activity — newest first, ≤ 20 after
  // filtering. Unknown/blocked/banned owner → 404 not_found, byte-identical
  // to the §1.14 profile shape. The owner sees all their own items.
  app.get(
    '/api/users/:username/activity',
    { preHandler: requireAuth, schema: { params: z.object({ username: z.string() }) } },
    async (req) => {
      const { user } = authed(req);
      const [owner] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!owner) throw notFound('user_not_found');
      // §1.41: banned owners' strips hide with their profiles.
      if (owner.id !== user.id && owner.bannedAt !== null) throw notFound('user_not_found');
      // §1.14: 404 in BOTH directions — identical to never existing.
      if (await isBlockedPair(user.id, owner.id)) throw notFound('user_not_found');

      const isOwner = owner.id === user.id;
      const rows = await db
        .select()
        .from(schema.activities)
        .where(eq(schema.activities.userId, owner.id))
        .orderBy(desc(schema.activities.createdAt))
        .limit(FETCH_LIMIT);
      if (rows.length === 0) return { activities: [] };

      // Viewer facts, resolved ONCE per read (lazily where they may not be
      // needed): accepted connection (settings), friends-of (beacon 'friends'
      // and post 'friends_of' audiences).
      const isConnection = isOwner || (await connectionIdsOf(user.id)).has(owner.id);
      let friendOfSet: Set<string> | null = null;
      const viewerIsFriendOfOwner = async (): Promise<boolean> => {
        if (isOwner) return true;
        if (friendOfSet === null) friendOfSet = await friendsOfIds(user.id);
        return friendOfSet.has(owner.id);
      };

      // Batch-load the underlying objects this page references.
      const beaconIds = [
        ...new Set(
          rows
            .filter((r) => r.kind === 'beacon_lit' || r.kind === 'beacon_sparked')
            .map((r) => (r.ref as unknown as BeaconRef).beacon_id),
        ),
      ];
      const postIds = [
        ...new Set(
          rows.filter((r) => r.kind === 'post_created').map((r) => (r.ref as unknown as PostRef).post_id),
        ),
      ];
      const listingIds = [
        ...new Set(
          rows
            .filter((r) => r.kind === 'listing_posted')
            .map((r) => (r.ref as unknown as ListingRef).listing_id),
        ),
      ];
      const opponentIds = [
        ...new Set(
          rows
            .filter((r) => r.kind === 'game_won')
            .map((r) => (r.ref as unknown as GameRef).opponent_id),
        ),
      ];
      const beaconById = new Map(
        beaconIds.length > 0
          ? (
              await db.select().from(schema.beacons).where(inArray(schema.beacons.id, beaconIds))
            ).map((b) => [b.id, b])
          : [],
      );
      const postById = new Map(
        postIds.length > 0
          ? (await db.select().from(schema.posts).where(inArray(schema.posts.id, postIds))).map(
              (p) => [p.id, p],
            )
          : [],
      );
      const listingById = new Map(
        listingIds.length > 0
          ? (
              await db.select().from(schema.listings).where(inArray(schema.listings.id, listingIds))
            ).map((l) => [l.id, l])
          : [],
      );
      const opponentById = new Map(
        opponentIds.length > 0
          ? (await db.select().from(schema.users).where(inArray(schema.users.id, opponentIds))).map(
              (u) => [u.id, u],
            )
          : [],
      );

      const now = Date.now();
      const out: Activity[] = [];
      for (const row of rows) {
        if (out.length >= ACTIVITY_STRIP_MAX) break;
        const kind = row.kind as ActivityKind;

        // (a) The owner's per-group setting — skipped for the owner.
        if (!isOwner) {
          const setting = settingFor(owner, kind);
          if (setting === 'private') continue;
          if (setting === 'connections' && !isConnection) continue;
        }

        // (b) The underlying object's own audience, resolved LIVE — the
        // setting can only narrow, never widen (§1.59 table). A missing
        // object (deleted post/listing) drops the item for everyone.
        let summary: ActivitySummary | null = null;
        switch (kind) {
          case 'beacon_lit':
          case 'beacon_sparked': {
            const b = beaconById.get((row.ref as unknown as BeaconRef).beacon_id);
            if (!b) break;
            if (!isOwner) {
              // The §1.15 audience AS STORED: friends → friends-of(owner);
              // area → the viewer's area equals the beacon's snapshot; public
              // → anyone. A friends-only beacon therefore never shows in a
              // public strip, whatever the toggle says.
              if (b.audience === 'friends' && !(await viewerIsFriendOfOwner())) break;
              if (b.audience === 'area' && !sameArea(user.area, b.area)) break;
            }
            // Summary only — vibe/note/status, NO joiner faces (the pile
            // stays on GET /api/beacons/:id with its own §1.14 filtering).
            summary = {
              type: 'beacon',
              beacon_id: b.id,
              vibe: b.vibe as Extract<ActivitySummary, { type: 'beacon' }>['vibe'],
              custom_vibe_emoji: b.customVibeEmoji,
              custom_vibe_label: b.customVibeLabel,
              note: b.note,
              status: b.status as Extract<ActivitySummary, { type: 'beacon' }>['status'],
            };
            break;
          }
          case 'post_created': {
            const p = postById.get((row.ref as unknown as PostRef).post_id);
            if (!p) break; // deleted post → dropped
            if (!isOwner && p.audience !== 'public' && !(await viewerIsFriendOfOwner())) break;
            // excerpt = the CURRENT body's first 80 chars (§1.29 rule).
            summary = {
              type: 'post',
              post_id: p.id,
              kind: p.kind as Extract<ActivitySummary, { type: 'post' }>['kind'],
              excerpt: p.body ? p.body.slice(0, REPLY_EXCERPT_MAX_CHARS) : null,
            };
            break;
          }
          case 'listing_posted': {
            const l = listingById.get((row.ref as unknown as ListingRef).listing_id);
            if (!l) break;
            // §1.38 visibility: is_public → anyone; else same-area only.
            if (!isOwner && !l.isPublic && !sameArea(user.area, l.area)) break;
            // Closed/expired listings still show, WITH their status (live).
            const status =
              l.status === 'active' && l.expiresAt !== null && l.expiresAt.getTime() <= now
                ? 'expired'
                : (l.status as Extract<ActivitySummary, { type: 'listing' }>['status']);
            summary = { type: 'listing', listing_id: l.id, kind: l.kind as Extract<ActivitySummary, { type: 'listing' }>['kind'], title: l.title, status };
            break;
          }
          case 'puzzle_played': {
            // No underlying audience — the ref is the player's own no-spoiler
            // facts; the per-group setting alone governs.
            const ref = row.ref as unknown as PuzzleRef;
            summary = {
              type: 'puzzle',
              date: ref.date,
              solved: ref.solved,
              attempts_used: ref.attempts_used,
            };
            break;
          }
          case 'game_won': {
            const ref = row.ref as unknown as GameRef;
            if (!isOwner) {
              // The §1.5 visibility floor: the viewer was a participant of
              // the game's conversation AT that seq.
              const part = await getParticipant(ref.conversation_id, user.id);
              if (!part) break;
              if (ref.seq <= part.joinSeq) break;
              if (part.leftAt !== null && ref.seq > (part.leftSeq ?? 0)) break;
            }
            const opp = opponentById.get(ref.opponent_id);
            summary = {
              type: 'game',
              conversation_id: ref.conversation_id,
              seq: ref.seq,
              // Deleted account → null; a banned opponent serializes like
              // every banned serialization: invisible (§1.41).
              opponent: opp && opp.bannedAt === null ? userLiteDto(opp) : null,
            };
            break;
          }
        }
        if (!summary) continue; // dropped silently — no placeholders

        out.push({
          id: row.id,
          kind,
          created_at: row.createdAt.toISOString(),
          summary,
        });
      }
      return { activities: out };
    },
  );
}
