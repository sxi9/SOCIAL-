'use client';

// The local board (v0.5b — API.md §1.38, FEATURES #39-43/#45, ADR-012).
// PULL-BASED by contract: cards load when the viewer opens or refilters the
// tab — no WS, no push, no unread dots, deliberately (PSYCHOLOGY rules 2/4).
// Plan beacons share this tab client-side (FEATURES #43) via the strip above;
// the 🔥 Plans chip just points back at it — beacons keep their own API.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Listing, ListingKind } from '@socialchat/shared';
import { AREA_MAX_CHARS, LISTING_KINDS, LISTING_SEARCH_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  expiryLine,
  getListing,
  KIND_CHIP_LABEL,
  KIND_LABEL,
  listBoard,
  listMine,
} from '@/lib/listings';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import ListingCreateSheet from './ListingCreateSheet';
import ListingDetailSheet from './ListingDetailSheet';
import Stars from './Stars';
import st from './board.module.css';

type Filter = 'all' | 'plans' | 'mine' | ListingKind;

export default function BoardView({
  initialListingId,
  onDeepLinkDone,
}: {
  /** /local?l=<id> deep link (chat context pills) — opens the detail sheet. */
  initialListingId?: string | null;
  onDeepLinkDone?: () => void;
}) {
  const state = useAppState();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [areaFilter, setAreaFilter] = useState<string | null>(null); // null = mine (server default)
  const [areaEditing, setAreaEditing] = useState(false);
  const [areaDraft, setAreaDraft] = useState('');
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const fetchSeq = useRef(0);

  // Debounced search (the board is a pull surface — typing shouldn't hammer it).
  useEffect(() => {
    const t = setTimeout(() => setQ(qDraft.trim()), 350);
    return () => clearTimeout(t);
  }, [qDraft]);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = (fetchSeq.current += 1);
    setLoading(true);
    setError(null);
    try {
      if (filter === 'mine') {
        const mine = await listMine();
        if (fetchSeq.current !== seq) return;
        setListings(mine);
        setCursor(null);
      } else if (filter === 'plans') {
        if (fetchSeq.current !== seq) return;
        setListings([]);
        setCursor(null);
      } else {
        const res = await listBoard({
          kind: filter === 'all' ? undefined : filter,
          area: areaFilter ?? undefined,
          q: q || undefined,
        });
        if (fetchSeq.current !== seq) return;
        setListings(res.listings);
        setCursor(res.next_cursor);
      }
    } catch {
      if (fetchSeq.current === seq) setError('Could not load the board — try again.');
    } finally {
      if (fetchSeq.current === seq) setLoading(false);
    }
  }, [filter, areaFilter, q]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Deep link (?l=…): fetch and open the sheet; 404 = invisible, say so quietly.
  useEffect(() => {
    if (!initialListingId) return;
    let cancelled = false;
    void getListing(initialListingId)
      .then((listing) => {
        if (!cancelled) setSelected(listing);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError && err.status === 404
              ? 'That listing is gone.'
              : 'Could not open that listing.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialListingId]);

  async function more(): Promise<void> {
    if (!cursor || moreBusy || filter === 'mine' || filter === 'plans') return;
    setMoreBusy(true);
    try {
      const res = await listBoard({
        kind: filter === 'all' ? undefined : filter,
        area: areaFilter ?? undefined,
        q: q || undefined,
        cursor,
      });
      setListings((prev) => {
        const seen = new Set((prev ?? []).map((l) => l.id));
        return [...(prev ?? []), ...res.listings.filter((l) => !seen.has(l.id))];
      });
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    } finally {
      setMoreBusy(false);
    }
  }

  const myArea = state.me?.area ?? null;
  const areaLabel = areaFilter ?? myArea ?? 'public cards';

  // Royal v2 (ref 10): typographic chips — no emoji as UI icons.
  const chips: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'plans', label: 'Plans' },
    ...LISTING_KINDS.map((k) => ({ key: k as Filter, label: KIND_CHIP_LABEL[k] })),
    { key: 'mine', label: 'Mine' },
  ];

  return (
    <div>
      {/* Royal v2 (ref 10): serif head + the letterspaced "+ list something"
          action on the same row (it opens the existing create sheet). */}
      <div className={st.boardHeadRow}>
        <h2 className={st.boardHead}>The board</h2>
        <button type="button" className={st.listCta} onClick={() => setCreateOpen(true)}>
          + List something
        </button>
      </div>
      <div className={st.chipRow} role="radiogroup" aria-label="Board filter">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={filter === c.key}
            className={`${st.kindChip}${filter === c.key ? ` ${st.kindChipOn}` : ''}`}
            onClick={() => setFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {filter !== 'mine' && filter !== 'plans' ? (
        <>
          <div className={st.controlRow}>
            <button
              type="button"
              className={st.areaPill}
              aria-label={`Area filter: ${areaLabel}. Tap to change`}
              onClick={() => {
                setAreaDraft(areaFilter ?? myArea ?? '');
                setAreaEditing((v) => !v);
              }}
            >
              <span aria-hidden>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 21 C8 16.6 5.5 13.4 5.5 10.2 a6.5 6.5 0 0 1 13 0 C18.5 13.4 16 16.6 12 21 Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.7" />
                </svg>
              </span>
              <span>{areaLabel}</span>
            </button>
            <input
              className={`input ${st.searchBox}`}
              type="search"
              placeholder="Search the board…"
              aria-label="Search listings"
              value={qDraft}
              maxLength={LISTING_SEARCH_MAX_CHARS}
              onChange={(e) => setQDraft(e.target.value)}
            />
          </div>
          {areaEditing ? (
            <div className={st.controlRow}>
              <input
                className="input"
                placeholder="Area to browse — e.g. Indiranagar"
                value={areaDraft}
                maxLength={AREA_MAX_CHARS}
                onChange={(e) => setAreaDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setAreaFilter(areaDraft.trim() ? areaDraft.trim() : null);
                    setAreaEditing(false);
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setAreaFilter(areaDraft.trim() ? areaDraft.trim() : null);
                  setAreaEditing(false);
                }}
              >
                Go
              </button>
              {areaFilter !== null ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAreaFilter(null);
                    setAreaEditing(false);
                  }}
                >
                  Mine
                </button>
              ) : null}
            </div>
          ) : null}
          {areaFilter === null && myArea === null ? (
            <p className="muted small" style={{ margin: '0 20px 4px' }}>
              No area set — you&rsquo;re seeing public cards only. Tap the area pill to browse an
              area, or set yours when you post.
            </p>
          ) : null}
          {areaFilter !== null ? (
            <p className="muted small" style={{ margin: '0 20px 4px' }}>
              Browsing “{areaFilter}” — only cards shared publicly show outside their own area.
            </p>
          ) : null}
        </>
      ) : null}

      <div className={st.cardList}>
        {filter === 'plans' ? (
          <div className={st.boardEmpty}>
            <h3>Plans are the live cards up top</h3>
            <p>
              Beacons burn out fast, so they get the strip above. Everything else on the board just
              waits for you — nothing here will ever ping you.
            </p>
          </div>
        ) : loading && listings === null ? (
          <p className="muted small" style={{ textAlign: 'center' }}>
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Loading the board…
          </p>
        ) : listings !== null && listings.length === 0 ? (
          <div className={st.boardEmpty}>
            <h3>{filter === 'mine' ? 'Nothing posted yet' : 'The board is bare'}</h3>
            <p>
              {filter === 'mine'
                ? 'Your gigs, rides, rooms and place reviews will sit here.'
                : 'Pin something up — a gig, a ride, a room, or a place worth knowing about.'}
            </p>
          </div>
        ) : listings !== null ? (
          <>
            {listings.map((l) => (
              <ListingCard
                key={l.id}
                listing={l}
                now={now}
                mineView={filter === 'mine'}
                meId={state.me?.id}
                onOpen={() => setSelected(l)}
              />
            ))}
            {cursor !== null ? (
              <button type="button" className={st.morePill} onClick={() => void more()} disabled={moreBusy}>
                {moreBusy ? 'Loading…' : 'Show more'}
              </button>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p className="error-text" style={{ textAlign: 'center' }}>
            {error}
          </p>
        ) : null}
      </div>

      {createOpen ? (
        <ListingCreateSheet
          onClose={() => setCreateOpen(false)}
          onCreated={(listing) => {
            // Straight back onto the board — the new card sits on top.
            setListings((prev) => (prev === null ? [listing] : [listing, ...prev]));
          }}
        />
      ) : null}
      {selected ? (
        <ListingDetailSheet
          listing={selected}
          onClose={() => {
            setSelected(null);
            onDeepLinkDone?.();
          }}
          onChanged={(updated) => {
            setSelected(updated);
            setListings((prev) => prev?.map((l) => (l.id === updated.id ? updated : l)) ?? prev);
          }}
          onDeleted={(id) => {
            setListings((prev) => prev?.filter((l) => l.id !== id) ?? prev);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ListingCard({
  listing,
  now,
  mineView,
  meId,
  onOpen,
}: {
  listing: Listing;
  now: number;
  mineView: boolean;
  meId: string | undefined;
  onOpen: () => void;
}) {
  const expiry = expiryLine(listing, now);
  // v1.0a (#91): every kind can carry photos now.
  const thumb =
    listing.photos.length > 0 ? listing.photos[0].thumb_url ?? listing.photos[0].url : null;
  const mine = meId !== undefined && listing.author.id === meId;

  // Royal v2 (ref 10): one right-aligned value per row — seats for rides,
  // the price text otherwise; place reviews carry their stars.
  const value =
    listing.kind === 'ride'
      ? `${listing.details.seats} ${listing.details.seats === 1 ? 'seat' : 'seats'}`
      : listing.kind === 'room'
        ? listing.details.monthly_price_text
        : listing.price_text;

  return (
    // Royal v2 (ref 10): 76px board ROWS — 56px photo thumb on the left,
    // letterspaced kind tag over the title, hairline between rows.
    <button type="button" className={st.lCard} onClick={onOpen}>
      {thumb ? (
        <span className={st.lThumb} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb} alt="" loading="lazy" />
        </span>
      ) : null}
      <div className={st.lCardMain}>
        <span className={st.lKindTag}>{KIND_LABEL[listing.kind]}</span>
        <span className={st.lTitle}>{listing.title}</span>
        <span className={st.lMeta}>
          <Avatar avatar={listing.author.avatar} name={listing.author.display_name} size={16} />
          <span>{mine ? 'You' : listing.author.display_name}</span>
          <span aria-hidden>·</span>
          <span>{listing.area}</span>
          {listing.my_contacted ? <span>· messaged ✓</span> : null}
        </span>
      </div>
      <span className={st.lRight}>
        {listing.kind === 'place_review' ? (
          <Stars value={listing.details.rating} />
        ) : value ? (
          <span className={st.lValue}>{value}</span>
        ) : null}
        {mineView && listing.status !== 'active' ? (
          <span className={st.statusTag}>{listing.status}</span>
        ) : expiry ? (
          <span className={st.lExpiry}>{expiry}</span>
        ) : null}
      </span>
    </button>
  );
}
