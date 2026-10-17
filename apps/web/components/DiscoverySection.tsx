'use client';

// v0.6 Bored Together — the Local-tab discovery surface (API.md §1.44/§1.45,
// ADR-015, FEATURES #52). Being discoverable is a MOMENT: the opt-in lives 60
// minutes and lapses silently. Cards are mutual-reachability strangers only;
// there is no swipe-reject mechanic — wave, or just scroll on (a single wave
// notifies NOBODY). The encouragement aggregate renders PRE-opt-in only
// (PSYCHOLOGY finding #10) — never as a post-hoc scoreboard.
import { useEffect, useState } from 'react';
import {
  DISCOVERY_NOTE_MAX_CHARS,
  ROULETTE_WINDOW_S,
  type DiscoveryCard,
  type DiscoveryScope,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  blockUser,
  joinRoulette,
  leaveRoulette,
  optIn,
  optOut,
  refreshCards,
  refreshEncouragement,
  refreshOptin,
  waveAt,
} from '@/lib/discovery';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import Mascot from './Mascot';
import Portal from './Portal';
import ReportSheet from './ReportSheet';
import bcn from './beacons.module.css';
import styles from './discovery.module.css';

export default function DiscoverySection() {
  const state = useAppState();
  const now = useNow(30_000);
  const [optinOpen, setOptinOpen] = useState(false);
  const [rouletteOpen, setRouletteOpen] = useState(false);

  const optin = state.discoveryOptin;
  const live = optin !== null && new Date(optin.expires_at).getTime() > now;

  // My opt-in state + the pre-opt-in encouragement aggregate, once.
  useEffect(() => {
    if (!state.discoveryLoaded) void refreshOptin();
  }, [state.discoveryLoaded]);
  useEffect(() => {
    if (state.discoveryLoaded && !live && state.encouragement === null) {
      void refreshEncouragement();
    }
  }, [state.discoveryLoaded, live, state.encouragement]);

  // Cards follow the live opt-in (visibility is symmetric — no lurking).
  useEffect(() => {
    if (live && state.discoveryCards === null) void refreshCards();
  }, [live, state.discoveryCards]);

  const minsLeft = live ? Math.max(1, Math.round((new Date(optin!.expires_at).getTime() - now) / 60000)) : 0;
  const agg = state.encouragement;

  return (
    <section aria-label="Bored Together">
      <div className={styles.boredCard}>
        <div className={styles.boredHead}>
          <Mascot state="watch" size={56} />
          <div>
            <h2>Bored now?</h2>
            <p>
              {live
                ? 'You are discoverable to other bored people — wave at someone.'
                : 'Meet someone else who is bored right now. Opt in for an hour, lapse silently.'}
            </p>
          </div>
        </div>

        {/* Binding client rule (§1.44): the aggregate shows PRE-opt-in only. */}
        {!live && agg && agg.better_percent !== null ? (
          <p className={styles.encourage}>
            💡 {agg.better_percent}% of people here said chatting with a stranger was{' '}
            <strong>better than they expected</strong>.
          </p>
        ) : null}

        {live ? (
          <div className={styles.optedRow}>
            <span className={styles.liveChip}>
              <span className={styles.liveDot} aria-hidden /> Discoverable · {minsLeft}m left
            </span>
            <button type="button" className="btn" onClick={() => setOptinOpen(true)}>
              Extend
            </button>
            <button type="button" className="btn" onClick={() => void optOut()}>
              Go invisible
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setRouletteOpen(true)}>
              🎲 Roulette
            </button>
          </div>
        ) : (
          <div className={styles.boredActions}>
            <button type="button" className="btn btn-primary" onClick={() => setOptinOpen(true)}>
              👋 Make me discoverable
            </button>
            <button type="button" className="btn" onClick={() => setRouletteOpen(true)}>
              🎲 Roulette
            </button>
          </div>
        )}
      </div>

      {live ? <CardStack cards={state.discoveryCards} /> : null}

      {optinOpen ? <OptinSheet onClose={() => setOptinOpen(false)} /> : null}
      {rouletteOpen ? (
        <RouletteSheet
          onClose={() => setRouletteOpen(false)}
          // BUG-5 fix: roulette needs the discoverable hour, so the sheet
          // offers the opt-in itself instead of dead-ending on a disabled
          // Spin button — one tap swaps it for the opt-in sheet.
          onOptin={() => {
            setRouletteOpen(false);
            setOptinOpen(true);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Opt-in sheet
// ---------------------------------------------------------------------------

function OptinSheet({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const existing = state.discoveryOptin;
  const [scope, setScope] = useState<DiscoveryScope>(existing?.scope ?? 'area');
  const [note, setNote] = useState(existing?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasArea = (state.me?.area ?? null) !== null && (state.me?.area ?? '') !== '';
  const agg = state.encouragement;
  const live = existing !== null && new Date(existing.expires_at).getTime() > Date.now();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await optIn(scope, note.trim());
      void refreshCards();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'area_required') {
        setError('Set your area on the Profile tab first — or pick Public.');
      } else {
        setError('Could not opt in. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
    <div
      className={bcn.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bcn.sheet} role="dialog" aria-modal="true" aria-label="Become discoverable">
        <div className={bcn.sheetHead}>
          <h2>👋 Bored together</h2>
          <button type="button" className={bcn.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className={bcn.sheetNote} style={{ marginTop: 0 }}>
          For the next <strong>60 minutes</strong> other bored people can see your card — and you
          see theirs. It expires on its own, silently. Friends and people you already chat with are
          never shown. A wave only matters when it&rsquo;s mutual: nobody is told about a wave that
          isn&rsquo;t returned.
        </p>
        {!live && agg && agg.better_percent !== null ? (
          <p className={styles.encourage}>
            💡 {agg.better_percent}% said it was better than they expected.
          </p>
        ) : null}
        <div className={styles.scopeRow} role="radiogroup" aria-label="Who can see your card">
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'area'}
            className={`${styles.scopeChip}${scope === 'area' ? ` ${styles.scopeOn}` : ''}`}
            onClick={() => setScope('area')}
          >
            📍 My area{hasArea ? '' : ' (set it first)'}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'public'}
            className={`${styles.scopeChip}${scope === 'public' ? ` ${styles.scopeOn}` : ''}`}
            onClick={() => setScope('public')}
          >
            🌍 Anyone
          </button>
        </div>
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label htmlFor="disc-note">A note for your card (optional)</label>
          <input
            id="disc-note"
            className="input"
            placeholder="e.g. up for dumb movie takes"
            value={note}
            maxLength={DISCOVERY_NOTE_MAX_CHARS}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 12, width: '100%' }}
          disabled={busy || (scope === 'area' && !hasArea)}
          onClick={() => void submit()}
        >
          {busy ? 'Opting in…' : live ? 'Extend my hour' : 'Make me discoverable for an hour'}
        </button>
      </div>
    </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Card stack — wave or scroll on; report/block prominent on every card
// ---------------------------------------------------------------------------

function CardStack({ cards }: { cards: DiscoveryCard[] | null }) {
  const [reporting, setReporting] = useState<string | null>(null);

  if (cards === null) {
    return <p className={styles.emptyPool}>Looking around…</p>;
  }
  if (cards.length === 0) {
    return (
      <p className={styles.emptyPool}>
        Nobody else is bored right now — your card is up, so someone may wave at you. Try Roulette
        meanwhile?
      </p>
    );
  }
  return (
    <>
      <div className={styles.stack} aria-label="Bored people near you">
        {cards.map((card) => (
          <StackCard key={card.user.id} card={card} onReport={() => setReporting(card.user.id)} />
        ))}
      </div>
      {reporting ? (
        <ReportSheet target={{ kind: 'user', user_id: reporting }} onClose={() => setReporting(null)} />
      ) : null}
    </>
  );
}

function StackCard({ card, onReport }: { card: DiscoveryCard; onReport: () => void }) {
  const [busy, setBusy] = useState(false);

  async function wave(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await waveAt(card.user.id);
      // matched:true also arrives as discovery.matched → celebration overlay.
    } catch {
      /* lapsed card or rate limit — the next refresh sorts the pool out */
      void refreshCards();
    } finally {
      setBusy(false);
    }
  }

  async function block(): Promise<void> {
    if (!window.confirm(`Block ${card.user.display_name}? They won't be told.`)) return;
    try {
      await blockUser(card.user.id);
    } catch {
      /* already gone */
    }
  }

  return (
    <article className={styles.card}>
      {/* Animated avatar — the §5 motion rules gate inside Avatar. */}
      <Avatar avatar={card.user.avatar} name={card.user.display_name} size={72} animated />
      <h3 className={styles.cardName}>{card.user.display_name}</h3>
      <span className={styles.cardUser}>@{card.user.username}</span>
      <p className={styles.cardNote}>{card.note || 'Bored. That’s the whole bio.'}</p>
      {card.waved ? (
        <span className={styles.wavedChip}>
          <span aria-hidden>👋</span> Waved
        </span>
      ) : (
        <button
          type="button"
          className={styles.waveBtn}
          disabled={busy}
          onClick={() => void wave()}
          aria-label={`Wave at ${card.user.display_name}`}
        >
          <span aria-hidden>👋</span> Wave
        </button>
      )}
      <div className={styles.cardSafety}>
        <button type="button" onClick={onReport}>
          Report
        </button>
        <button type="button" onClick={() => void block()}>
          Block
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Roulette sheet — explainer, queue state, leave
// ---------------------------------------------------------------------------

function RouletteSheet({ onClose, onOptin }: { onClose: () => void; onOptin: () => void }) {
  const state = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queued = state.rouletteQueued;
  const optin = state.discoveryOptin;
  const live = optin !== null && new Date(optin.expires_at).getTime() > Date.now();

  // Closing the sheet while queued keeps you queued (matching may land any
  // second); the explicit "Leave the queue" button is the opt-out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function spin(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!live) {
        setError('Make yourself discoverable first — roulette draws from the bored pool.');
        return;
      }
      await joinRoulette();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'discovery_not_opted_in') {
        setError('Your discoverable hour lapsed — opt in again first.');
      } else {
        setError('Could not join the queue. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
    <div
      className={bcn.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bcn.sheet} role="dialog" aria-modal="true" aria-label="Bored roulette">
        <div className={bcn.sheetHead}>
          <h2>🎲 Bored roulette</h2>
          <button type="button" className={bcn.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {queued ? (
          <div className={styles.queueBox}>
            <Mascot state="watch" size={84} />
            <span className={styles.queueDots} aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <p className="muted small" style={{ margin: 0 }}>
              Finding you a stranger… you can close this — the match will pull you in.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void leaveRoulette();
              }}
            >
              Leave the queue
            </button>
          </div>
        ) : (
          <>
            <p className={bcn.sheetNote} style={{ marginTop: 0 }}>
              A random 1:1 chat with another bored stranger. The rules:
            </p>
            <ul className={bcn.sheetNote} style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>
                You get <strong>5 minutes</strong>. When they&rsquo;re up, the chat vanishes
                completely — no archive, no awkward leftovers.
              </li>
              <li>
                <strong>Both</strong> of you must tap Keep for it to stay. One keep is private —
                the other person never finds out.
              </li>
              <li>Be kind. It&rsquo;s a stranger who was bored, same as you.</li>
            </ul>
            {!live ? (
              <p className={bcn.sheetNote}>
                Roulette draws from the bored pool, so it needs your discoverable hour to be on
                first.
              </p>
            ) : null}
            {error ? <p className="error-text">{error}</p> : null}
            {!live ? (
              // The actionable path when Spin would be dead: one tap opens the
              // opt-in sheet instead of leaving a mystery-disabled button.
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 12, width: '100%' }}
                onClick={onOptin}
              >
                👋 Make me discoverable first
              </button>
            ) : null}
            <button
              type="button"
              className={live ? 'btn btn-primary' : 'btn'}
              style={{ marginTop: live ? 12 : 8, width: '100%' }}
              disabled={busy || !live}
              onClick={() => void spin()}
            >
              {busy
                ? 'Joining…'
                : live
                  ? `Spin (${Math.round(ROULETTE_WINDOW_S / 60)} min chat)`
                  : 'Spin — needs your hour on'}
            </button>
          </>
        )}
      </div>
    </div>
    </Portal>
  );
}
