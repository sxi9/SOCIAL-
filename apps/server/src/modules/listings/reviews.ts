// Person reviews — marketplace trust (v0.5b — API.md §1.40, ADR-012,
// FEATURES #44). The one place a number attaches to a person, and ADR-012
// argues why it is not a PSYCHOLOGY rule-3 violation: the star average is
// SAFETY INFORMATION for a stranger deciding whether to get in your car — the
// §1.14 safety-bundle class of signal, not social approval. Structural
// guardrails live here: reviews exist only behind a real §1.39 contact, once
// per (listing, reviewer), the average hides below TRUST_AVG_MIN_REVIEWS, and
// nothing anywhere ranks, sorts or compares people by rating. No fan-out, no
// push — the subject discovers reviews on their own profile (rule 4).
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreatePersonReviewRequestSchema,
  ListPersonReviewsQuerySchema,
  PERSON_REVIEW_RATE_PER_HOUR,
  TRUST_AVG_MIN_REVIEWS,
  TRUST_RECENT_REVIEWS_MAX,
  type ListingKind,
  type PersonReview,
  type Trust,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { blockedSetOf, isBlockedPair } from '../../lib/blocks.js';
import { userLiteDto, type UserRow } from '../../lib/dto.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { hasListingContact, loadListingWithAuthor } from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const pr = schema.personReviews;

type ReviewRow = typeof schema.personReviews.$inferSelect;

export function personReviewDto(row: ReviewRow, reviewer: UserRow): PersonReview {
  return {
    id: row.id,
    reviewer: userLiteDto(reviewer),
    rating: row.rating,
    body: row.body,
    // SNAPSHOT — the review survives deletion of the listing that brokered it.
    listing_kind: row.listingKind as ListingKind,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The §1.40 profile trust panel: review_count and avg over ALL reviews
 * (filtering is serialization-time, §2.11 doctrine — blocked reviewers are
 * omitted from `recent` only); avg_rating rounded to 1 decimal and null under
 * TRUST_AVG_MIN_REVIEWS (one angry star must not read as a verdict).
 */
export async function loadTrust(subjectId: string, viewerId: string): Promise<Trust> {
  const [agg] = (await db.execute(sql`
    SELECT count(*)::int AS n, avg(rating)::float AS a
    FROM person_reviews WHERE subject_id = ${subjectId}
  `)) as unknown as { n: number; a: number | null }[];
  const count = agg?.n ?? 0;
  const avg =
    count >= TRUST_AVG_MIN_REVIEWS && agg?.a != null ? Math.round(agg.a * 10) / 10 : null;

  const blocked = await blockedSetOf(viewerId);
  const fetchN = TRUST_RECENT_REVIEWS_MAX + Math.min(blocked.size, 50);
  const rows = await db
    .select({ r: pr, u: schema.users })
    .from(pr)
    .innerJoin(schema.users, eq(schema.users.id, pr.reviewerId))
    .where(eq(pr.subjectId, subjectId))
    .orderBy(sql`${pr.createdAt} DESC`, sql`${pr.id} DESC`)
    .limit(fetchN);
  const recent = rows
    .filter(({ r }) => !blocked.has(r.reviewerId))
    .slice(0, TRUST_RECENT_REVIEWS_MAX)
    .map(({ r, u }) => personReviewDto(r, u));

  return { review_count: count, avg_rating: avg, recent };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: string } {
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

export async function personReviewRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.40 POST /api/listings/:id/reviews — gate: a listing_contacts row ties
  // me and the subject to this listing, {reviewer, subject} = {author,
  // contacter}, each reviewing the OTHER. Closed/expired listings stay
  // reviewable (transactions finish after cards retire); a deleted listing
  // does not (the gate row is gone → 404). Blocked pairs 404 (§1.14 shape).
  app.post(
    '/api/listings/:id/reviews',
    {
      preHandler: requireAuth,
      schema: { params: IdParams, body: CreatePersonReviewRequestSchema },
    },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(
        `personreview:${user.id}`,
        PERSON_REVIEW_RATE_PER_HOUR,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const row = await loadListingWithAuthor(req.params.id);
      if (!row) throw notFound('listing_not_found');
      const { l } = row;

      // Resolve the subject per side (§1.40): the author names which contacter
      // they are reviewing; a contacter's subject is always the author.
      let subjectId: string;
      if (l.authorId === user.id) {
        if (!req.body.subject_id || req.body.subject_id === user.id) {
          throw badRequest('bad_subject');
        }
        subjectId = req.body.subject_id;
      } else {
        if (req.body.subject_id !== undefined && req.body.subject_id !== l.authorId) {
          throw badRequest('bad_subject');
        }
        subjectId = l.authorId;
      }

      // Blocked pairs cannot review, both directions — 404-shaped (§1.14).
      if (await isBlockedPair(user.id, subjectId)) throw notFound('listing_not_found');

      // The gate: the contact row between the two parties, tied to this
      // listing. {reviewer, subject} = {author, contacter}.
      const contacterId = l.authorId === user.id ? subjectId : user.id;
      if (!(await hasListingContact(l.id, contacterId))) {
        throw forbidden('review_not_eligible');
      }

      const [subject] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, subjectId))
        .limit(1);
      if (!subject) throw badRequest('bad_subject');

      let inserted: ReviewRow;
      try {
        const rows = await db
          .insert(pr)
          .values({
            id: newId(),
            listingId: l.id,
            listingKind: l.kind,
            reviewerId: user.id,
            subjectId,
            rating: req.body.rating,
            body: req.body.body,
          })
          .returning();
        inserted = rows[0]!;
      } catch (err) {
        // Once per (listing, reviewer) — the partial unique index is the law.
        if ((err as { code?: string }).code === '23505') throw conflict('review_exists');
        throw err;
      }
      return reply.status(201).send({ review: personReviewDto(inserted, user) });
    },
  );

  // §1.40 GET /api/users/:username/reviews — reviews ABOUT that user,
  // created_at DESC. Blocked pairs (viewer⊥subject) and banned subjects 404
  // like the profile; rows by reviewers blocked w.r.t. the VIEWER are omitted
  // from the list (count/avg elsewhere stay computed over all — §2.11).
  app.get(
    '/api/users/:username/reviews',
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ username: z.string() }),
        querystring: ListPersonReviewsQuerySchema,
      },
    },
    async (req) => {
      const { user } = authed(req);
      const [subject] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, req.params.username))
        .limit(1);
      if (!subject) throw notFound('user_not_found');
      if (subject.id !== user.id) {
        if (subject.bannedAt !== null) throw notFound('user_not_found');
        if (await isBlockedPair(user.id, subject.id)) throw notFound('user_not_found');
      }

      const { cursor, limit } = req.query;
      const blocked = await blockedSetOf(user.id);
      const conds = [eq(pr.subjectId, subject.id)];
      if (cursor) {
        const { ts, id } = decodeCursor(cursor);
        conds.push(sql`(${pr.createdAt}, ${pr.id}) < (${ts}::timestamptz, ${id}::uuid)`);
      }
      // Over-fetch to keep the page honest under serialization-time filtering.
      const fetchN = limit + Math.min(blocked.size, 100) + 1;
      const rows = await db
        .select({ r: pr, u: schema.users })
        .from(pr)
        .innerJoin(schema.users, eq(schema.users.id, pr.reviewerId))
        .where(and(...conds))
        .orderBy(sql`${pr.createdAt} DESC`, sql`${pr.id} DESC`)
        .limit(fetchN);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        reviews: page
          .filter(({ r }) => !blocked.has(r.reviewerId))
          .map(({ r, u }) => personReviewDto(r, u)),
        next_cursor: hasMore && last ? encodeCursor(last.r.createdAt, last.r.id) : null,
      };
    },
  );
}
