'use client';

// Gig team-up picker (v0.5b — API.md §1.39). Author-only: pick up to
// TEAM_UP_MAX_PICKS people WHO CONTACTED the gig; the server reuses the §1.4
// group-create machinery (join_seq=0 founders, 'team_up' kickoff message).
// One team-up per listing — the server claims it atomically.
import { useEffect, useState } from 'react';
import type { Listing, UserLite } from '@socialchat/shared';
import { TEAM_UP_MAX_PICKS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { listingContacts, teamUp } from '@/lib/listings';
import { upsertConversation } from '@/lib/store';
import Avatar from './Avatar';
import bz from './beacons.module.css';
import st from './board.module.css';

export default function TeamUpSheet({
  listing,
  onClose,
  onCreated,
}: {
  listing: Listing;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [contacts, setContacts] = useState<UserLite[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listingContacts(listing.id)
      .then((res) => {
        if (!cancelled) setContacts(res.contacts);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load who messaged you.');
      });
    return () => {
      cancelled = true;
    };
  }, [listing.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < TEAM_UP_MAX_PICKS) next.add(id);
      return next;
    });
  }

  async function go(): Promise<void> {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await teamUp(listing.id, [...picked]);
      upsertConversation(res.conversation);
      onCreated(res.conversation.id);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'team_up_exists') {
        setError('This gig already has its team — one crew per listing.');
      } else if (err instanceof ApiError && err.code === 'group_add_denied') {
        setError('Someone in that pick can’t be added to groups — try without them.');
      } else if (err instanceof ApiError && err.code === 'bad_team_pick') {
        setError('Only people who messaged about this gig can be picked.');
      } else {
        setError('Could not create the project chat — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div
      className={`${bz.sheetBackdrop} ${bz.beaconVars}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bz.sheet} role="dialog" aria-modal="true" aria-label="Pick your team">
        <div className={bz.sheetHead}>
          {/* Royal v2 (ref 39): serif "Team up · <listing>" title. */}
          <h2>Team up · {listing.title}</h2>
          <button type="button" className={bz.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Pick up to {TEAM_UP_MAX_PICKS} of the people who messaged about this — you all land in a
          project group chat together. Leave anytime.
        </p>

        {contacts === null && !error ? (
          <p className="muted small" style={{ textAlign: 'center' }}>
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Loading…
          </p>
        ) : contacts !== null && contacts.length === 0 ? (
          <p className="muted small" style={{ textAlign: 'center', padding: '14px 0' }}>
            No one has messaged about this gig yet — the pick list fills itself.
          </p>
        ) : contacts !== null ? (
          <div role="group" aria-label="People who contacted this gig" style={{ marginTop: 8 }}>
            {contacts.map((u) => {
              const on = picked.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={st.pickRow}
                  aria-pressed={on}
                  onClick={() => toggle(u.id)}
                >
                  <Avatar avatar={u.avatar} name={u.display_name} size={34} />
                  <span className={st.pickName}>
                    <strong>{u.display_name}</strong>
                    <span>@{u.username}</span>
                  </span>
                  <span className={`${st.pickBox}${on ? ` ${st.pickBoxOn}` : ''}`} aria-hidden>
                    {on ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className={st.msgBtn}
          style={{ marginTop: 12 }}
          disabled={picked.size === 0 || busy}
          onClick={() => void go()}
        >
          {busy
            ? 'Creating…'
            : picked.size === 0
              ? 'Pick your crew'
              : `Start the project chat (${picked.size + 1} of you)`}
        </button>
      </div>
    </div>
  );
}
