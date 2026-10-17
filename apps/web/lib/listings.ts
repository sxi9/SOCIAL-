// Local board client (v0.5b — API.md §1.38–§1.40, ADR-012). PULL-BASED by
// contract: no WS events, no push, no store mirror — the board is fetched when
// the viewer opens it, and that is the whole sync story (PSYCHOLOGY design
// rules 2/4). Prices are DISPLAY TEXT; nothing here parses money.
import type {
  ContactListingResponse,
  ConversationResponse,
  CreateListingRequest,
  CreatePersonReviewRequest,
  Listing,
  ListingContactsResponse,
  ListingKind,
  ListingResponse,
  ListListingsResponse,
  ListPersonReviewsResponse,
  PersonReviewResponse,
} from '@socialchat/shared';
import { api } from './api';

export const KIND_EMOJI: Record<ListingKind, string> = {
  gig: '🧑‍💻',
  ride: '🚲',
  room: '🏠',
  place_review: '📍',
};

export const KIND_LABEL: Record<ListingKind, string> = {
  gig: 'Gig',
  ride: 'Ride',
  room: 'Room',
  place_review: 'Place',
};

/** Filter-chip copy (plural; the board chips read "Gigs", "Rides", …). */
export const KIND_CHIP_LABEL: Record<ListingKind, string> = {
  gig: 'Gigs',
  ride: 'Rides',
  room: 'Rooms',
  place_review: 'Places',
};

export interface BoardQuery {
  kind?: ListingKind;
  area?: string;
  q?: string;
  cursor?: string;
}

export async function listBoard(query: BoardQuery): Promise<ListListingsResponse> {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.area) params.set('area', query.area);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return api.get<ListListingsResponse>(`/api/listings${qs ? `?${qs}` : ''}`);
}

export async function listMine(): Promise<Listing[]> {
  const res = await api.get<{ listings: Listing[] }>('/api/listings/mine');
  return res.listings;
}

export async function getListing(id: string): Promise<Listing> {
  const res = await api.get<ListingResponse>(`/api/listings/${id}`);
  return res.listing;
}

export async function createListing(req: CreateListingRequest): Promise<Listing> {
  const res = await api.post<ListingResponse>('/api/listings', req);
  return res.listing;
}

export async function closeListing(id: string): Promise<Listing> {
  const res = await api.post<ListingResponse>(`/api/listings/${id}/close`);
  return res.listing;
}

export async function deleteListing(id: string): Promise<void> {
  await api.del(`/api/listings/${id}`);
}

/** "Message me" — the board's only CTA (§1.39). Idempotent per listing. */
export async function contactListing(id: string): Promise<string> {
  const res = await api.post<ContactListingResponse>(`/api/listings/${id}/contact`);
  return res.conversation_id;
}

/** Author-only pick pool for team-up (everyone who contacted). */
export async function listingContacts(id: string): Promise<ListingContactsResponse> {
  return api.get<ListingContactsResponse>(`/api/listings/${id}/contacts`);
}

export async function teamUp(id: string, userIds: string[]): Promise<ConversationResponse> {
  return api.post<ConversationResponse>(`/api/listings/${id}/team-up`, { user_ids: userIds });
}

export async function createPersonReview(
  listingId: string,
  req: CreatePersonReviewRequest
): Promise<PersonReviewResponse> {
  return api.post<PersonReviewResponse>(`/api/listings/${listingId}/reviews`, req);
}

export async function listPersonReviews(
  username: string,
  cursor: string | null
): Promise<ListPersonReviewsResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return api.get<ListPersonReviewsResponse>(
    `/api/users/${encodeURIComponent(username)}/reviews${qs}`
  );
}

// ---------------------------------------------------------------------------
// Review-nudge bookkeeping (§1.40 UI): ONE gentle prompt per listing DM, after
// the listing closes — then silence forever, whatever the answer. Per-device
// (localStorage) on purpose: a nudge is client courtesy, not server state, and
// the server never pings anyone about reviews (PSYCHOLOGY rule 4).
// ---------------------------------------------------------------------------

const NUDGE_KEY = 'listing_review_nudge_done';

function readNudgeSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(NUDGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function reviewNudgeDone(listingId: string): boolean {
  if (typeof window === 'undefined') return true;
  return readNudgeSet().has(listingId);
}

export function markReviewNudgeDone(listingId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readNudgeSet();
    set.add(listingId);
    // Keep the list bounded — oldest entries fall off past 200.
    const arr = [...set].slice(-200);
    window.localStorage.setItem(NUDGE_KEY, JSON.stringify(arr));
  } catch {
    /* storage unavailable — the prompt may show again on this device */
  }
}

// ---------------------------------------------------------------------------

/** Short per-kind summary line for cards and chat pills. */
export function listingKindLine(listing: Listing): string {
  switch (listing.kind) {
    case 'gig':
      return listing.details.direction === 'offering' ? 'offering work' : 'looking for people';
    case 'ride':
      return `${listing.details.from_text} → ${listing.details.to_text}`;
    case 'room':
      return listing.details.monthly_price_text ?? 'room / space';
    case 'place_review':
      return listing.details.place_name;
  }
}

/** "expires in 3d" / "departs in 2h" copy; null for evergreen place reviews. */
export function expiryLine(listing: Listing, now: number): string | null {
  if (!listing.expires_at) return null;
  const ms = new Date(listing.expires_at).getTime() - now;
  const verb = listing.kind === 'ride' ? 'departs' : 'expires';
  if (ms <= 0) return listing.kind === 'ride' ? 'departed' : 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${verb} in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${verb} in ${hours}h`;
  return `${verb} in ${Math.round(hours / 24)}d`;
}
