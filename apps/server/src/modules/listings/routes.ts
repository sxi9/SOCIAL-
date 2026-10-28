// Local board routes (v0.5b — API.md §1.38/§1.39, ADR-012, FEATURES #39–#43,
// #45). ONE listing system, four card kinds; per-kind payloads validated by
// the shared Zod discriminated union. HARD RULES carried here:
// - NO payments: price fields are display text — never parsed, never charged.
// - PULL-BASED: no WS events, no push, anywhere on this surface (PSYCHOLOGY
//   design rules 2/4). The §1.39 contact/team-up fan-out is the ordinary
//   DM/group machinery, nothing board-specific.
// - Visibility = same-area OR is_public, minus §1.14 blocks both ways, minus
//   banned authors (§1.41) — 404-shaped (blocks confirm nothing).
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateListingRequestSchema,
  LISTING_ACTIVE_MAX_PER_USER,
  LISTING_CONTACT_RATE_PER_HOUR,
  LISTING_CREATE_RATE_PER_HOUR,
  LISTING_EDIT_RATE_PER_HOUR,
  LISTING_TTL_S,
  ListListingsQuerySchema,
  TeamUpRequestSchema,
  UpdateListingRequestSchema,
  type ListingRef,
  type RideDetails,
  ContactListingRequestSchema,
} from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { newId } from '../../ids.js';
import { recordActivity } from '../../lib/activity.js';
import { isBlockedPair } from '../../lib/blocks.js';
import { dmGateFor } from '../../lib/dmPolicy.js';
import {
  loadConversationDto,
  publishConversationToUsers,
  userLiteDto,
  viewCtxFor,
  type UserRow,
} from '../../lib/dto.js';
import { badRequest, conflict, forbidden, gone, notFound, rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { authed, requireAuth } from '../auth/guard.js';
import { deniedGroupAddTargets } from '../conversations/routes.js';
import { loadOpenTokenByToken, revokeShareTokensFor } from '../sharepages/service.js';
import { fanOutNewMessage, insertMessage } from '../messages/service.js';
import {
  derivedListingStatus,
  hasListingContact,
  isListingLive,
  listingDtos,
  loadListingWithAuthor,
  type ListingRow,
} from './service.js';

const IdParams = z.object({ id: z.string().uuid() });
const listings = schema.listings;

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

/** §1.14/§1.41 SQL arm: the author is not banned and not blocked w.r.t. me. */
function authorVisibleCond(viewerId: string) {
  return sql`${schema.users.bannedAt} IS NULL AND NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = ${listings.authorId})
       OR (b.blocker_id = ${listings.authorId} AND b.blocked_id = ${viewerId}))`;
}

/**
 * Direct-read visibility (§1.38): the author always; otherwise never across a
 * block or a ban (404, confirms nothing); contacters keep reading closed/
 * expired cards (the DM context must stay explicable); everyone else needs a
 * live card in their area or a public one. Returns the row or throws the
 * uniform 404 listing_not_found.
 */
async function requireVisibleListing(
  id: string,
  viewer: UserRow,
): Promise<{ l: ListingRow; u: UserRow }> {
  const row = await loadListingWithAuthor(id);
  if (!row) throw notFound('listing_not_found');
  const { l, u } = row;
  if (l.authorId === viewer.id) return row;
  if (u.bannedAt !== null) throw notFound('listing_not_found');
  if (await isBlockedPair(viewer.id, l.authorId)) throw notFound('listing_not_found');
  if (await hasListingContact(l.id, viewer.id)) return row;
  const areaOk =
    l.isPublic || (viewer.area !== null && l.area.toLowerCase() === viewer.area.toLowerCase());
  if (!isListingLive(l) || !areaOk) throw notFound('listing_not_found');
  return row;
}

export async function listingRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // §1.38 POST /api/listings — create (no fan-out: the board is pull-based).
  app.post(
    '/api/listings',
    { preHandler: requireAuth, schema: { body: CreateListingRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(
        `listingcreate:${user.id}`,
        LISTING_CREATE_RATE_PER_HOUR,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);
      const body = req.body;

      // `area` defaults to my users.area; neither → 400 area_required (§1.15).
      const area = body.area ?? user.area;
      if (!area) throw badRequest('area_required');

      // Ride departures must be ahead of us; departs_at IS the expiry column
      // (denormalized at write time so sweeps/reads never parse jsonb).
      let expiresAt: Date | null = null;
      if (body.kind === 'ride') {
        const departs = new Date((body.details as RideDetails).departs_at);
        if (departs.getTime() <= Date.now()) throw badRequest('departs_at_past');
        expiresAt = departs;
      } else if (body.kind === 'gig' || body.kind === 'room') {
        expiresAt = new Date(Date.now() + LISTING_TTL_S * 1000);
      } // place_review: evergreen (NULL — the CHECK pins exactly this kind).

      // 10 simultaneously ACTIVE per author — live-expiry counted, so expired
      // rows the sweep has not flipped yet never block a new card.
      const activeRows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM listings
        WHERE author_id = ${user.id} AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
      `)) as unknown as { n: number }[];
      if ((activeRows[0]?.n ?? 0) >= LISTING_ACTIVE_MAX_PER_USER) {
        throw conflict('listing_limit');
      }

      const id = newId();
      await db.transaction(async (tx) => {
        await tx.insert(listings).values({
          id,
          authorId: user.id,
          kind: body.kind,
          title: body.title,
          body: body.body,
          priceText: body.price_text ?? null,
          area,
          isPublic: body.is_public,
          details: body.details,
          status: 'active',
          location: body.location ?? null, // v0.7 (§1.52)
          expiresAt,
        });
        // v0.8a (§1.59): POST /api/listings → listing_posted, inside the
        // create transaction through THE one helper. Pointer only — the strip
        // read re-checks §1.38 visibility live.
        await recordActivity(tx, {
          user_id: user.id,
          kind: 'listing_posted',
          ref: { listing_id: id },
        });
        // Photos (v1.0a #91 — every kind) bind via attachments.listing_id
        // (the post_id GC-shield pattern): mine, kind image, unbound anywhere
        // → else 400 bad_attachment (whole create rolls back).
        {
          const ids = ((body.details as { attachment_ids?: string[] }).attachment_ids ??
            []) as string[];
          if (ids.length > 0) {
            const bound = (await tx.execute(sql`
              UPDATE attachments SET listing_id = ${id}, share_import_id = NULL
              WHERE id IN (${sql.join(ids.map((a) => sql`${a}::uuid`), sql`, `)})
                AND uploader_id = ${user.id}
                AND kind = 'image'
                AND message_id IS NULL AND scheduled_message_id IS NULL
                AND post_id IS NULL AND listing_id IS NULL AND comment_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
                AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
              RETURNING id
            `)) as unknown as { id: string }[];
            if (bound.length !== ids.length) throw badRequest('bad_attachment');
          }
        }
      });

      const row = await loadListingWithAuthor(id);
      const [dto] = await listingDtos([row!], user.id);
      return reply.status(201).send({ listing: dto });
    },
  );

  // §1.38 GET /api/listings — the board read. `area` defaults to MINE (no
  // param and no users.area → public cards only); a foreign area filter shows
  // only that area's is_public cards — the visibility rule binds whatever the
  // filter says. Live expiry filter; blocked pairs and banned authors out.
  app.get(
    '/api/listings',
    { preHandler: requireAuth, schema: { querystring: ListListingsQuerySchema } },
    async (req) => {
      const { user } = authed(req);
      const { kind, q, cursor, limit } = req.query;
      const area = req.query.area ?? user.area ?? null;

      const conds = [
        eq(listings.status, 'active'),
        sql`(${listings.expiresAt} IS NULL OR ${listings.expiresAt} > now())`,
        authorVisibleCond(user.id),
      ];
      if (area) {
        conds.push(sql`${listings.area} = ${area}`);
        // Visibility: same-area OR is_public (citext equality decides "same").
        if (user.area) {
          conds.push(sql`(${listings.isPublic} OR ${listings.area} = ${user.area})`);
        } else {
          conds.push(eq(listings.isPublic, true));
        }
      } else {
        conds.push(eq(listings.isPublic, true));
      }
      if (kind) conds.push(eq(listings.kind, kind));
      if (q) {
        const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
        conds.push(
          sql`(${listings.title} ILIKE ${'%' + escaped + '%'} OR ${listings.details}->>'place_name' ILIKE ${'%' + escaped + '%'})`,
        );
      }
      if (cursor) {
        const { ts, id } = decodeCursor(cursor);
        conds.push(sql`(${listings.createdAt}, ${listings.id}) < (${ts}::timestamptz, ${id}::uuid)`);
      }

      const rows = await db
        .select({ l: listings, u: schema.users })
        .from(listings)
        .innerJoin(schema.users, eq(schema.users.id, listings.authorId))
        .where(and(...conds))
        .orderBy(sql`${listings.createdAt} DESC`, sql`${listings.id} DESC`)
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const dtos = await listingDtos(page, user.id);
      const last = page[page.length - 1];
      return {
        listings: dtos,
        next_cursor: hasMore && last ? encodeCursor(last.l.createdAt, last.l.id) : null,
      };
    },
  );

  // §1.38 GET /api/listings/mine — the management list: every status,
  // created_at DESC, capped at 100 (no cursor).
  app.get('/api/listings/mine', { preHandler: requireAuth }, async (req) => {
    const { user } = authed(req);
    const rows = await db
      .select({ l: listings, u: schema.users })
      .from(listings)
      .innerJoin(schema.users, eq(schema.users.id, listings.authorId))
      .where(eq(listings.authorId, user.id))
      .orderBy(desc(listings.createdAt), desc(listings.id))
      .limit(100);
    return { listings: await listingDtos(rows, user.id) };
  });

  // §1.38 GET /api/listings/:id — 404 listing_not_found for unknown, blocked,
  // banned-author and out-of-audience alike (blocks confirm nothing).
  app.get(
    '/api/listings/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await requireVisibleListing(req.params.id, user);
      const [dto] = await listingDtos([row], user.id);
      return { listing: dto };
    },
  );

  // §1.38 POST /api/listings/:id/close — author only; idempotent re-close 200.
  // Cards retire silently from the board (no fan-out, ever).
  app.post(
    '/api/listings/:id/close',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadListingWithAuthor(req.params.id);
      if (!row) throw notFound('listing_not_found');
      if (row.l.authorId !== user.id) throw forbidden();
      if (row.l.status !== 'closed') {
        await db.update(listings).set({ status: 'closed' }).where(eq(listings.id, row.l.id));
      }
      const fresh = await loadListingWithAuthor(row.l.id);
      const [dto] = await listingDtos([fresh!], user.id);
      return { listing: dto };
    },
  );

  // v0.7 §1.48 PATCH /api/listings/:id — author only, status 'active' only.
  // `kind` is echoed to pick the Zod branch and must match the row (it is
  // immutable); `details`, when present, is the COMPLETE per-kind payload
  // revalidated exactly like create. NO fan-out, no push — the board stays
  // pull-based; contacters' listing_ref snapshots are deliberately untouched.
  app.patch(
    '/api/listings/:id',
    { preHandler: requireAuth, schema: { params: IdParams, body: UpdateListingRequestSchema } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadListingWithAuthor(req.params.id);
      if (!row) throw notFound('listing_not_found');
      const l = row.l;
      if (l.authorId !== user.id) throw forbidden();
      if (l.kind !== req.body.kind) throw badRequest('kind_immutable');
      if (derivedListingStatus(l) !== 'active') throw gone('listing_closed');
      const rate = await fixedWindow(`listingedit:${user.id}`, LISTING_EDIT_RATE_PER_HOUR, 3600);
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const body = req.body;

      // Per-kind consequences (§1.48). Ride: departs_at must be future and is
      // re-copied to expires_at (sweeps never parse jsonb, §1.38).
      let newExpiresAt = l.expiresAt;
      if (body.kind === 'ride' && body.details !== undefined) {
        const departs = new Date((body.details as RideDetails).departs_at);
        if (departs.getTime() <= Date.now()) throw badRequest('departs_at_past');
        newExpiresAt = departs;
      }

      // Effective new values — omitted = unchanged; location null clears.
      const next = {
        title: body.title ?? l.title,
        body: body.body ?? l.body,
        priceText: body.price_text === undefined ? l.priceText : body.price_text,
        isPublic: body.is_public ?? l.isPublic,
        location:
          body.location === undefined ? ((l.location as unknown) ?? null) : body.location,
        details: body.details === undefined ? l.details : body.details,
        expiresAt: newExpiresAt,
      };
      const changed =
        next.title !== l.title ||
        next.body !== l.body ||
        next.priceText !== l.priceText ||
        next.isPublic !== l.isPublic ||
        JSON.stringify(next.location) !== JSON.stringify((l.location as unknown) ?? null) ||
        JSON.stringify(next.details) !== JSON.stringify(l.details) ||
        (next.expiresAt?.getTime() ?? null) !== (l.expiresAt?.getTime() ?? null);

      if (changed) {
        await db.transaction(async (tx) => {
          await tx
            .update(listings)
            .set({ ...next, editedAt: new Date() })
            .where(eq(listings.id, l.id));
          // v0.8b (§1.67): changing is_public EITHER way revokes the share
          // token in the SAME transaction. Narrowing: the public page must
          // die. Widening (§1b, 2026-10-27): an owner-minted TEASER link on
          // an area-only listing would otherwise silently become the FULL
          // page the moment the listing goes public — "a link already sent
          // never silently widens". The owner re-mints from the sheet.
          if (l.isPublic !== next.isPublic) {
            await revokeShareTokensFor(tx, 'listing', l.id);
          }
          // Photos re-bind (§1.48; v1.0a #91 — every kind): new ids must be
          // mine/kind-image/unbound (400 bad_attachment rolls the edit back);
          // dropped ones unbind into the orphan GC (refcount-guarded, §1.31).
          if (body.details !== undefined) {
            const nextIds = ((body.details as { attachment_ids?: string[] }).attachment_ids ??
              []) as string[];
            const prevIds = ((l.details as { attachment_ids?: string[] }).attachment_ids ??
              []) as string[];
            const added = nextIds.filter((id) => !prevIds.includes(id));
            const dropped = prevIds.filter((id) => !nextIds.includes(id));
            if (dropped.length > 0) {
              await tx.execute(sql`
                UPDATE attachments SET listing_id = NULL
                WHERE listing_id = ${l.id}
                  AND id IN (${sql.join(dropped.map((a) => sql`${a}::uuid`), sql`, `)})
              `);
            }
            if (added.length > 0) {
              const bound = (await tx.execute(sql`
                UPDATE attachments SET listing_id = ${l.id}, share_import_id = NULL
                WHERE id IN (${sql.join(added.map((a) => sql`${a}::uuid`), sql`, `)})
                  AND uploader_id = ${user.id}
                  AND kind = 'image'
                  AND message_id IS NULL AND scheduled_message_id IS NULL
                  AND post_id IS NULL AND listing_id IS NULL AND comment_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.attachment_id = attachments.id)
                  AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.attachment_id = attachments.id)
                RETURNING id
              `)) as unknown as { id: string }[];
              if (bound.length !== added.length) throw badRequest('bad_attachment');
            }
          }
        });
      }

      const fresh = await loadListingWithAuthor(l.id);
      const [dto] = await listingDtos([fresh!], user.id);
      return { listing: dto };
    },
  );

  // §1.38 DELETE /api/listings/:id — hard delete, author only (404 if not
  // mine). Contacts cascade; room-photo attachments unbind (FK SET NULL) into
  // the orphan GC, objects refcount-guarded (§1.31). Person reviews written
  // through this listing SURVIVE: listing_id goes null, the listing_kind
  // snapshot keeps them rendering (§1.40, ADR-012 — a cascading FK would let
  // authors purge bad reviews by deleting the listing).
  app.delete(
    '/api/listings/:id',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req, reply) => {
      const { user } = authed(req);
      const rows = (await db.execute(sql`
        DELETE FROM listings WHERE id = ${req.params.id} AND author_id = ${user.id}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (rows.length === 0) throw notFound();
      // v0.8b (§1.67): the share token dies with the object.
      await revokeShareTokensFor(db, 'listing', req.params.id);
      return reply.status(204).send();
    },
  );

  // §1.39 POST /api/listings/:id/contact — the board's only call to action.
  // Reuses the §1.4 DM path verbatim (dm_key create-or-dedupe) + ONE
  // 'listing_contact' system message carrying the server-written listing_ref
  // snapshot; the listing_contacts row (idempotency key, team-up pick pool,
  // §1.40 review gate) lands in the SAME transaction as the message.
  app.post(
    '/api/listings/:id/contact',
    // The body is optional AND may be absent entirely (older callers send
    // none): Fastify hands an absent body to the validator as null.
    { preHandler: requireAuth, schema: { params: IdParams, body: ContactListingRequestSchema.nullable().optional() } },
    async (req, reply) => {
      const { user } = authed(req);
      const rate = await fixedWindow(
        `listingcontact:${user.id}`,
        LISTING_CONTACT_RATE_PER_HOUR,
        3600,
      );
      if (!rate.allowed) throw rateLimited(rate.retryAfterS);

      const row = await loadListingWithAuthor(req.params.id);
      if (!row) throw notFound('listing_not_found');
      const { l, u: author } = row;
      // §1.14/§1.41 404-shape BEFORE the own-listing 400: an invisible listing
      // does not exist, so nothing about it (not even "it is yours to a
      // blocked prober") is confirmed.
      if (l.authorId !== user.id) {
        if (author.bannedAt !== null) throw notFound('listing_not_found');
        if (await isBlockedPair(user.id, l.authorId)) throw notFound('listing_not_found');
      } else {
        throw badRequest('listing_own');
      }

      // Idempotent re-contact: the existing DM, no second system message, no
      // new row — resolves BEFORE the closed/expired gate (the DM context must
      // stay reachable after the card retires).
      const existing = (await db.execute(sql`
        SELECT conversation_id FROM listing_contacts
        WHERE listing_id = ${l.id} AND user_id = ${user.id}
        LIMIT 1
      `)) as unknown as { conversation_id: string }[];
      if (existing.length > 0) {
        return reply.status(200).send({ conversation_id: existing[0]!.conversation_id });
      }

      // First contact needs the card visible (same-area or public) — or,
      // phase 3 (§1b), a LIVE share token for THIS listing: the author sent
      // the link, so the door it opens is exactly this one. Checked BEFORE
      // the closed gate: an invisible listing is 404 whatever its state
      // (§1.38 — a 410 would confirm it exists).
      let areaOk =
        l.isPublic || (user.area !== null && l.area.toLowerCase() === user.area.toLowerCase());
      if (!areaOk && req.body?.share_token) {
        const t = await loadOpenTokenByToken(req.body.share_token);
        if (t && t.objectType === 'listing' && t.objectId === l.id) areaOk = true;
      }
      if (!areaOk) throw notFound('listing_not_found');
      if (derivedListingStatus(l) !== 'active') throw gone('listing_closed');

      // §1.4 DM create-or-dedupe via dm_key.
      const dmKey = [user.id, l.authorId].sort().join(':');
      const convs = schema.conversations;
      const cp = schema.conversationParticipants;
      let convId: string;
      let createdDm = false;
      const [existingDm] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
      if (existingDm) {
        convId = existingDm.id;
      } else {
        // Wave 1.7: the poster's dm_policy — 'nobody' is the listing's own
        // 404 shape; 'connections' parks the contact in their Requests.
        const gate = await dmGateFor(user.id, { id: author.id, dmPolicy: author.dmPolicy });
        if (gate === 'refused') throw notFound('listing_not_found');
        convId = newId();
        try {
          await db.transaction(async (tx) => {
            await tx.insert(convs).values({ id: convId, type: 'dm', dmKey, createdBy: user.id });
            await tx.insert(cp).values([
              { conversationId: convId, userId: user.id },
              {
                conversationId: convId,
                userId: l.authorId,
                ...(gate === 'parked' ? { acceptedAt: null } : {}),
              },
            ]);
          });
          createdDm = true;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            const [raced] = await db.select().from(convs).where(eq(convs.dmKey, dmKey)).limit(1);
            if (!raced) throw err;
            convId = raced.id;
          } else {
            throw err;
          }
        }
      }

      // ONE context system message + the contact row, atomically: the row's PK
      // is the idempotency key, so a create race rolls the duplicate message
      // back with it. listing_ref is a SNAPSHOT (the forwarded_from pattern) —
      // it keeps rendering after the listing closes, expires or is deleted.
      const listingRef: ListingRef = { listing_id: l.id, kind: l.kind as ListingRef['kind'], title: l.title };
      const RACE = new Error('contact_race');
      let msg;
      try {
        msg = await insertMessage({
          conversationId: convId,
          senderId: null,
          type: 'system',
          body: `asked about: ${l.title}`,
          metadata: {
            system: { event: 'listing_contact', actor_id: user.id },
            listing_ref: listingRef,
          },
          withinTx: async (tx) => {
            const inserted = (await tx.execute(sql`
              INSERT INTO listing_contacts (listing_id, user_id, conversation_id)
              VALUES (${l.id}, ${user.id}, ${convId})
              ON CONFLICT (listing_id, user_id) DO NOTHING
              RETURNING listing_id
            `)) as unknown as { listing_id: string }[];
            if (inserted.length === 0) throw RACE;
          },
        });
      } catch (err) {
        if (err === RACE) {
          const [raced] = (await db.execute(sql`
            SELECT conversation_id FROM listing_contacts
            WHERE listing_id = ${l.id} AND user_id = ${user.id} LIMIT 1
          `)) as unknown as { conversation_id: string }[];
          return reply
            .status(200)
            .send({ conversation_id: raced?.conversation_id ?? convId });
        }
        throw err;
      }

      // Ordinary DM machinery fan-out — nothing board-specific (§1.39).
      if (createdDm) {
        await publishConversationToUsers(convId, [user.id, l.authorId], 'conv.new');
      }
      await fanOutNewMessage(msg);
      return reply.status(201).send({ conversation_id: convId });
    },
  );

  // §1.39 GET /api/listings/:id/contacts — AUTHOR-ONLY team-up picker read:
  // everyone who contacted, username order, minus contacters blocked w.r.t.
  // the author since contacting.
  app.get(
    '/api/listings/:id/contacts',
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (req) => {
      const { user } = authed(req);
      const row = await loadListingWithAuthor(req.params.id);
      if (!row || row.l.authorId !== user.id) throw notFound();
      const rows = (await db.execute(sql`
        SELECT row_to_json(u.*) AS u
        FROM listing_contacts lc
        JOIN users u ON u.id = lc.user_id
        WHERE lc.listing_id = ${row.l.id}
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = ${user.id} AND b.blocked_id = lc.user_id)
               OR (b.blocker_id = lc.user_id AND b.blocked_id = ${user.id}))
        ORDER BY u.username ASC
      `)) as unknown as { u: Record<string, unknown> }[];
      return {
        contacts: rows.map((r) =>
          userLiteDto({
            id: r.u.id as string,
            username: r.u.username as string,
            displayName: r.u.display_name as string,
            avatarStatus: r.u.avatar_status as string,
            avatarVersion: Number(r.u.avatar_version),
            avatarStaticKey: (r.u.avatar_static_key as string | null) ?? null,
            avatarAnimatedKey: (r.u.avatar_animated_key as string | null) ?? null,
            nameStyle: ((r.u.name_style as string | undefined) ?? 'none'), // v0.8a §1.58
          } as UserRow),
        ),
      };
    },
  );

  // §1.39 POST /api/listings/:id/team-up — author only, gigs only, picks from
  // the contact pool, ONE team-up per listing (guarded UPDATE ... WHERE
  // conversation_id IS NULL — the invite/spark claim pattern). Reuses the §1.4
  // group-create machinery: group_add_policy/block denials answer the
  // byte-identical 403 group_add_denied, all-or-nothing.
  app.post(
    '/api/listings/:id/team-up',
    { preHandler: requireAuth, schema: { params: IdParams, body: TeamUpRequestSchema } },
    async (req, reply) => {
      const { user } = authed(req);
      const row = await loadListingWithAuthor(req.params.id);
      if (!row || row.l.authorId !== user.id) throw notFound('listing_not_found');
      const l = row.l;
      if (l.kind !== 'gig') throw badRequest('not_a_gig');

      const picks = [...new Set(req.body.user_ids)].filter((id) => id !== user.id);
      if (picks.length === 0 || picks.length !== req.body.user_ids.length) {
        throw badRequest('bad_team_pick');
      }

      // Every pick must be in the contact pool.
      const poolRows = (await db.execute(sql`
        SELECT user_id FROM listing_contacts
        WHERE listing_id = ${l.id}
          AND user_id IN (${sql.join(picks.map((id) => sql`${id}::uuid`), sql`, `)})
      `)) as unknown as { user_id: string }[];
      if (poolRows.length !== picks.length) throw badRequest('bad_team_pick');

      // §1.13 group_add_policy / §1.14 blocks — per-target, whole-request
      // fail, byte-identical to the §1.4 denial (confirms nothing).
      const denied = await deniedGroupAddTargets(user.id, picks);
      if (denied.length > 0) {
        return reply.status(403).send({ error: 'group_add_denied', user_ids: denied });
      }

      // Group create + the one-per-listing claim, atomically. join_seq = 0:
      // founding members see the whole plan (the §1.15 spark semantics).
      const convs = schema.conversations;
      const cp = schema.conversationParticipants;
      const convId = newId();
      await db.transaction(async (tx) => {
        await tx
          .insert(convs)
          .values({ id: convId, type: 'group', title: l.title, createdBy: user.id });
        await tx.insert(cp).values([
          { conversationId: convId, userId: user.id, role: 'admin' },
          ...picks.map((id) => ({ conversationId: convId, userId: id })),
        ]);
        const claimed = (await tx.execute(sql`
          UPDATE listings SET conversation_id = ${convId}
          WHERE id = ${l.id} AND conversation_id IS NULL
          RETURNING id
        `)) as unknown as { id: string }[];
        if (claimed.length === 0) throw conflict('team_up_exists');
      });

      // Kickoff system message with the listing_ref snapshot (§1.39), then the
      // §1.4 group-create fan-out verbatim.
      const listingRef: ListingRef = { listing_id: l.id, kind: 'gig', title: l.title };
      const msg = await insertMessage({
        conversationId: convId,
        senderId: null,
        type: 'system',
        body: `team up: ${l.title}`,
        metadata: {
          system: { event: 'team_up', actor_id: user.id },
          listing_ref: listingRef,
        },
      });
      await publishConversationToUsers(convId, [user.id, ...picks], 'conv.new');
      await fanOutNewMessage(msg);

      const dto = await loadConversationDto(convId, await viewCtxFor(user));
      return reply.status(201).send({ conversation: dto });
    },
  );
}
