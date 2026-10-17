'use client';

// Live beacon strip (v0.3 — API.md §1.15, FEATURES #23-26). Cards show faces,
// not counters: creator + joiner avatar pile + "needs N more 🔥". Sparked
// cards flip to "IT'S ON" and deep-link into the plan group. WS beacon.new /
// beacon.updated patch live; sweep retires expired cards between frames.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Beacon } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  cancelBeacon,
  fmtCountdown,
  joinBeacon,
  leaveBeacon,
  refreshBeacons,
  vibeEmojiOf,
  vibeLabelOf,
} from '@/lib/beacons';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import BeaconCreateSheet from './BeaconCreateSheet';
import BeaconDetailSheet from './BeaconDetailSheet';
import ReportSheet from './ReportSheet';
import styles from './beacons.module.css';

const PILE_MAX = 5;

export default function BeaconStrip() {
  const state = useAppState();
  const now = useNow(30_000);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void refreshBeacons();
  }, []);

  // Retire cards whose window closed between WS frames.
  useEffect(() => {
    store.sweepBeacons();
  }, [now]);

  if (!state.beaconsLoaded && state.beacons.size === 0) return null; // never a loading state

  const items = [...state.beacons.values()].sort((a, b) => {
    // My own live card sits first, then most-urgent-first (server order).
    const mineA = a.my_state === 'creator' ? 0 : 1;
    const mineB = b.my_state === 'creator' ? 0 : 1;
    if (mineA !== mineB) return mineA - mineB;
    return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
  });

  if (items.length === 0) {
    const radar = state.radarCount ?? 0;
    return (
      <div className={`${styles.radarLine} ${styles.radarNothing} ${styles.beaconVars}`}>
        {radar > 0 ? (
          <span>
            🔥 {radar} {radar === 1 ? 'plan' : 'plans'} live around you
          </span>
        ) : (
          <span>Nothing&rsquo;s brewing right now. Fix that?</span>
        )}
        <button type="button" className={styles.radarCta} onClick={() => setCreateOpen(true)}>
          I&rsquo;m bored
        </button>
        {createOpen ? <BeaconCreateSheet onClose={() => setCreateOpen(false)} /> : null}
      </div>
    );
  }

  return (
    <div className={`${styles.strip} ${styles.beaconVars}`} role="list" aria-label="Live beacons">
      {items.map((b) => (
        <BeaconCard key={b.id} beacon={b} now={now} />
      ))}
    </div>
  );
}

function BeaconCard({ beacon: b, now }: { beacon: Beacon; now: number }) {
  const router = useRouter();
  const state = useAppState();
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [detail, setDetail] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startsMs = new Date(b.starts_at).getTime();
  const upcoming = startsMs > now;
  // Fixer r1: "in 1h 57m" not "starts in 1h 57m" — the pill competed with the
  // card title for row width and ellipsized custom vibe labels at 360px (the
  // detail sheet keeps the long "starts in" wording).
  const countdown = upcoming
    ? `in ${fmtCountdown(b.starts_at, now)}`
    : `${fmtCountdown(b.expires_at, now)} left`;
  const soon = !upcoming && new Date(b.expires_at).getTime() - now < 3600_000;

  const sparked = b.status === 'sparked';
  const creatorName = b.my_state === 'creator' ? 'You' : b.creator.display_name;

  async function join(): Promise<void> {
    if (joinBusy) return;
    setJoinBusy(true);
    setErr(null);
    try {
      await joinBeacon(b.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'beacon_own') setErr('That one is yours 😄');
      else if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) {
        setErr('Could not join — try again.');
      }
    } finally {
      setJoinBusy(false);
    }
  }

  async function leave(): Promise<void> {
    setMenu(false);
    try {
      await leaveBeacon(b.id);
    } catch {
      /* beacon.updated reconciles */
    }
  }

  async function cancel(): Promise<void> {
    setMenu(false);
    try {
      await cancelBeacon(b.id);
    } catch {
      /* already closed/sparked — the next frame settles it */
    }
  }

  const pile = b.joiners.slice(0, PILE_MAX);
  const overflow = Math.max(0, b.joiner_count - pile.length);

  // v0.7 (§1.47): a recent creator edit flashes a "plan updated" note; the
  // persistent "edited" marker is edited_at on the DTO.
  const recentEdit = state.beaconEdits.get(b.id);
  const editNote = recentEdit && Date.now() - recentEdit.at < 60_000;

  return (
    <div
      role="listitem"
      className={`${styles.card} ${styles.cardRel}${b.my_state === 'creator' ? ` ${styles.cardMine}` : ''}${sparked ? ` ${styles.cardSparked}` : ''}`}
      // FEATURES #60: tapping the card expands the detail sheet (Who's in,
      // edit, spark-now). Inner buttons/links keep their own behavior, and
      // clicks from PORTALED children (the sheets render into <body> but
      // React still bubbles their events here) are ignored via contains().
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (!e.currentTarget.contains(t)) return; // portaled overlay click
        if (t.closest('button, a')) return;
        setDetail(true);
      }}
    >
      <div className={styles.cardTop}>
        <span className={styles.vibeEmoji} aria-hidden>
          {vibeEmojiOf(b)}
        </span>
        <span className={styles.cardTitle}>
          {sparked ? 'IT’S ON 🎉' : `${creatorName} · ${vibeLabelOf(b)}`}
        </span>
        <span className={`${styles.countdown}${soon ? ` ${styles.countdownSoon}` : ''}`}>{countdown}</span>
        <button
          type="button"
          className={styles.cardKebab}
          aria-label="Beacon options"
          onClick={() => setMenu((v) => !v)}
        >
          ⋯
        </button>
      </div>
      {menu ? (
        <>
          <button type="button" className={styles.menuBackdrop} aria-label="Close menu" onClick={() => setMenu(false)} />
          <div className={styles.cardMenu} role="menu">
            {b.my_state === 'creator' && !sparked ? (
              <button type="button" role="menuitem" className={styles.menuDanger} onClick={() => void cancel()}>
                Take it down
              </button>
            ) : null}
            {b.my_state === 'joined' && !sparked ? (
              <button type="button" role="menuitem" onClick={() => void leave()}>
                Never mind, I&rsquo;m out
              </button>
            ) : null}
            {b.my_state !== 'creator' ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setReport(true);
                }}
              >
                Report beacon
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {report ? <ReportSheet target={{ kind: 'beacon', beacon_id: b.id }} onClose={() => setReport(false)} /> : null}
      {detail ? <BeaconDetailSheet beacon={b} onClose={() => setDetail(false)} /> : null}

      {editNote ? (
        <span className={styles.editedNote} role="status">
          ✏️ plan updated
        </span>
      ) : b.edited_at ? (
        <span className={styles.editedNote}>✏️ edited</span>
      ) : null}
      {b.note ? <p className={styles.cardNote}>{b.note}</p> : null}
      {b.location ? (
        <span className={styles.ritualTag}>📍 {b.location.label}</span>
      ) : null}
      {b.ritual ? (
        <span className={styles.ritualTag}>
          🔁 ritual{b.ritual.count > 0 ? ` · ${b.ritual.count} so far` : ''}
        </span>
      ) : null}

      <div className={styles.cardPeople}>
        {/* FEATURES #60: the pile is a button — tap to see WHO is in. */}
        <button
          type="button"
          className={styles.pile}
          key={b.joiner_count}
          aria-label={`${b.joiner_count} in — see who`}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          onClick={() => setDetail(true)}
        >
          <span className={styles.pilePop}>
            <Avatar avatar={b.creator.avatar} name={b.creator.display_name} size={28} />
          </span>
          {pile.map((j) => (
            <span key={j.id} className={styles.pilePop}>
              <Avatar avatar={j.avatar} name={j.display_name} size={28} />
            </span>
          ))}
          {overflow > 0 ? <span className={styles.pileMore}>+{overflow}</span> : null}
        </button>
        {!sparked && b.needs > 0 ? (
          <span className={`${styles.needs}${b.needs === 1 ? ` ${styles.needsOne}` : ''}`}>
            needs {b.needs} more 🔥
          </span>
        ) : null}
      </div>

      <div className={styles.cardActions}>
        {sparked && b.conversation_id ? (
          <button
            type="button"
            className={`${styles.joinBtn} ${styles.sparkBtn}`}
            onClick={() => router.push(`/c/${b.conversation_id}`)}
          >
            Open the plan →
          </button>
        ) : b.my_state === 'creator' ? (
          <button type="button" className={`${styles.joinBtn} ${styles.joinedBtn}`} disabled>
            Your beacon · watching the pile
          </button>
        ) : b.my_state === 'joined' ? (
          <button type="button" className={`${styles.joinBtn} ${styles.joinedBtn} ${styles.joinPop}`} disabled>
            You&rsquo;re in 🙌
          </button>
        ) : (
          <button type="button" className={styles.joinBtn} disabled={joinBusy} onClick={() => void join()}>
            I&rsquo;m in 🙋
          </button>
        )}
      </div>
      {err ? <p className="error-text" style={{ margin: 0 }}>{err}</p> : null}
    </div>
  );
}

/** Private "N people were glad you came" banner — recipient-only (§1.15). */
export function KudosBanner() {
  const state = useAppState();
  if (!state.kudos.length) return null;
  const came = state.kudos.filter((k) => k.kind === 'glad_you_came').length;
  const posted = state.kudos.filter((k) => k.kind === 'glad_you_posted').length;
  const parts: string[] = [];
  if (came > 0) parts.push(`${came} ${came === 1 ? 'person was' : 'people were'} glad you came`);
  if (posted > 0) {
    parts.push(
      came > 0
        ? `${posted} glad you posted the plan`
        : `${posted} ${posted === 1 ? 'person was' : 'people were'} glad you posted the plan`
    );
  }
  return (
    <div className={`${styles.kudosBanner} ${styles.beaconVars}`} role="status">
      <p>
        💛 {parts.join(' · ')}. Just for you — no one else sees this.
      </p>
      <button type="button" className={styles.kudosDismiss} aria-label="Dismiss" onClick={() => store.clearKudos()}>
        ×
      </button>
    </div>
  );
}
