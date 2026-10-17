// Local board (v0.5b — API.md §1.38/§1.39, ADR-012, FEATURES #39–#43, #45).
// Row → Listing DTO serialization and the shared visibility/contact helpers.
// The board is PULL-BASED: nothing in this module fans out WS events or push
// (PSYCHOLOGY design rules 2/4) — the §1.39 contact/team-up paths reuse the
// ordinary DM/group machinery, which is theirs, not the board's.
import { inArray, sql } from 'drizzle-orm';
import type { Listing, ListingKind, ListingStatus, Location } from '@socialchat/shared';
import { db, schema } from '../../db/index.js';
import { attachmentDto, userLiteDto, type AttRow, type UserRow } from '../../lib/dto.js';

export type ListingRow = typeof schema.listings.$inferSelect;

/**
 * `status` as the board means it: an 'active' row whose expires_at has passed
 * but which the hourly sweep has not yet flipped serializes 'expired' — the
 * sweep is bookkeeping, reads are the live truth (API.md §1.38).
 */
export function derivedListingStatus(row: ListingRow): ListingStatus {
  if (row.status === 'active' && row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return 'expired';
  }
  return row.status as ListingStatus;
}

export function isListingLive(row: ListingRow): boolean {
  return derivedListingStatus(row) === 'active';
}

/** Does `userId` hold the (listing, user) contact row (§1.39)? */
export async function hasListingContact(listingId: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM listing_contacts
    WHERE listing_id = ${listingId} AND user_id = ${userId}
    LIMIT 1
  `)) as unknown as { one: number }[];
  return rows.length > 0;
}

/**
 * Batch Listing DTO serialization from the viewer's perspective:
 * - `my_contacted` = the viewer's own §1.39 contact row (false for authors);
 * - `conversation_id` (the gig team-up group) serializes ONLY to the author
 *   and its active members — everyone else reads null (the §1.15
 *   sparked-beacon rule: never show people a room they are not in);
 * - room photos resolved from details.attachment_ids in the author's order.
 * Callers are responsible for visibility (area/public, blocks, bans) — this
 * function serializes whatever rows it is handed.
 */
export async function listingDtos(
  rows: { l: ListingRow; u: UserRow }[],
  viewerId: string,
): Promise<Listing[]> {
  if (rows.length === 0) return [];
  const listingIds = rows.map((r) => r.l.id);

  // my_contacted, batched.
  const contactRows = (await db.execute(sql`
    SELECT listing_id FROM listing_contacts
    WHERE user_id = ${viewerId}
      AND listing_id IN (${sql.join(listingIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { listing_id: string }[];
  const contacted = new Set(contactRows.map((r) => r.listing_id));

  // Team-up membership: the viewer sees conversation_id only as the author or
  // an active member of that group.
  const convIds = rows
    .filter((r) => r.l.conversationId !== null && r.l.authorId !== viewerId)
    .map((r) => r.l.conversationId!);
  const memberOf = new Set<string>();
  if (convIds.length > 0) {
    const memberRows = (await db.execute(sql`
      SELECT conversation_id FROM conversation_participants
      WHERE user_id = ${viewerId} AND left_at IS NULL
        AND conversation_id IN (${sql.join(convIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { conversation_id: string }[];
    for (const r of memberRows) memberOf.add(r.conversation_id);
  }

  // Photos (v1.0a #91 — every kind): details.attachment_ids resolved in the
  // author's order.
  const photoIds = rows.flatMap(
    (r) => ((r.l.details as { attachment_ids?: string[] }).attachment_ids ?? []) as string[],
  );
  const attById = new Map<string, AttRow>();
  if (photoIds.length > 0) {
    const attRows = await db
      .select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.id, [...new Set(photoIds)]));
    for (const a of attRows) attById.set(a.id, a);
  }

  return rows.map(({ l, u }) => {
    const photos = (((l.details as { attachment_ids?: string[] }).attachment_ids ?? []) as string[])
      .map((id) => attById.get(id))
      .filter((a): a is AttRow => a !== undefined)
      .map(attachmentDto);
    const convVisible =
      l.conversationId !== null &&
      (l.authorId === viewerId || memberOf.has(l.conversationId));
    return {
      id: l.id,
      author: userLiteDto(u),
      kind: l.kind as ListingKind,
      title: l.title,
      body: l.body,
      price_text: l.priceText,
      area: l.area,
      is_public: l.isPublic,
      details: l.details,
      status: derivedListingStatus(l),
      photos,
      my_contacted: l.authorId !== viewerId && contacted.has(l.id),
      conversation_id: convVisible ? l.conversationId : null,
      // v0.7 (§1.52): the optional place chip — visibility is the card's own.
      location: (l.location as Location | null) ?? null,
      // v0.7 (§1.48): the "edited" marker (no edit history, the §1.30 pattern).
      edited_at: l.editedAt ? l.editedAt.toISOString() : null,
      created_at: l.createdAt.toISOString(),
      expires_at: l.expiresAt ? l.expiresAt.toISOString() : null,
    } as Listing;
  });
}

export async function loadListingWithAuthor(
  id: string,
): Promise<{ l: ListingRow; u: UserRow } | null> {
  const [row] = await db
    .select({ l: schema.listings, u: schema.users })
    .from(schema.listings)
    .innerJoin(schema.users, sql`${schema.users.id} = ${schema.listings.authorId}`)
    .where(sql`${schema.listings.id} = ${id}`)
    .limit(1);
  return row ?? null;
}

/**
 * Hourly expiry sweep (worker queue `timers`, LISTING_SWEEP_INTERVAL_S) —
 * bookkeeping ONLY: board reads filter `expires_at > now()` live, so sweep
 * precision never shows a stale card. No fan-out, no notification, ever
 * (nothing "expired on you" is pushed — unsparked-beacon semantics, §1.15).
 */
export async function runListingSweep(): Promise<void> {
  await db.execute(sql`
    UPDATE listings SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()
  `);
}
