'use client';

// Live beacon strip (v0.3 — API.md §1.15, FEATURES #23-26). Cards show faces,
// not counters: creator + joiner avatar pile + "needs N more 🔥". Sparked
// cards flip to "IT'S ON" and deep-link into the plan group. WS beacon.new /
// beacon.updated patch live; sweep retires expired cards between frames.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Beacon, ShareLanding } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { getShareLanding } from '@/lib/share';
import OutsideAudienceSheet from './OutsideAudienceSheet';
import { toast } from '@/lib/toast';
import {
  cancelBeacon,
  fmtCountdown,
  joinBeacon,
  leaveBeacon,
  refreshBeacons,
  vibeLabelOf,
} from '@/lib/beacons';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import BeaconDetailSheet from './BeaconDetailSheet';
import ReportSheet from './ReportSheet';
import styles from './beacons.module.css';

const PILE_MAX = 3;

export default function BeaconStrip({
  initialBeaconId = null,
  shareToken = null,
  onDeepLinkDone,
}: {
  /** Phase 3: the share token the deep link arrived with. */
  shareToken?: string | null;
  /** /local/b/<id> (§1b deep-link back): open that plan's sheet once the
   * strip has loaded. There is no GET /api/beacons/:id — a plan resolves
   * from the strip's own store, so one I cannot see is simply "not
   * available" (the §1.14 shape). */
  initialBeaconId?: string | null;
  onDeepLinkDone?: () => void;
} = {}) {
  const state = useAppState();
  const now = useNow(30_000);
  // Captured once: the sheet must survive the URL being stripped (the prop
  // going null) while it is open.
  const [deepId] = useState(initialBeaconId);
  const [deepOpen, setDeepOpen] = useState(false);
  const [outside, setOutside] = useState<ShareLanding | null>(null);
  const deepHandled = useRef(false);

  useEffect(() => {
    void refreshBeacons();
  }, []);

  // Retire cards whose window closed between WS frames.
  useEffect(() => {
    store.sweepBeacons();
  }, [now]);

  useEffect(() => {
    if (!deepId || deepHandled.current) return;
    if (state.beaconsLoaded) {
      deepHandled.current = true;
      if (state.beacons.has(deepId)) setDeepOpen(true);
      else if (shareToken) {
        // Phase 3: not in my strip — with a live token, maybe "outside".
        void getShareLanding(shareToken)
          .then((landing) => {
            if (landing.state === 'outside') setOutside(landing);
            else {
              toast('That plan is not available.');
              onDeepLinkDone?.();
            }
          })
          .catch(() => {
            toast('That plan is not available.');
            onDeepLinkDone?.();
          });
      } else {
        toast('That plan is not available.');
        onDeepLinkDone?.();
      }
      return;
    }
    // refreshBeacons swallows failures (the strip never shows a loading
    // state), so a deep link must not wait forever for beaconsLoaded.
    const t = window.setTimeout(() => {
      if (deepHandled.current) return;
      deepHandled.current = true;
      toast('Could not open that plan.');
      onDeepLinkDone?.();
    }, 8000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepId, state.beaconsLoaded]);

  const deepBeacon = deepOpen && deepId ? (state.beacons.get(deepId) ?? null) : null;
  const deepSheet = deepBeacon ? (
    <BeaconDetailSheet
      beacon={deepBeacon}
      onClose={() => {
        setDeepOpen(false);
        onDeepLinkDone?.();
      }}
    />
  ) : outside && shareToken ? (
    <OutsideAudienceSheet
      landing={outside}
      token={shareToken}
      onClose={() => {
        setOutside(null);
        onDeepLinkDone?.();
      }}
    />
  ) : null;

  if (!state.beaconsLoaded && state.beacons.size === 0) return deepSheet; // never a loading state

  const items = [...state.beacons.values()].sort((a, b) => {
    // My own live card sits first, then most-urgent-first (server order).
    const mineA = a.my_state === 'creator' ? 0 : 1;
    const mineB = b.my_state === 'creator' ? 0 : 1;
    if (mineA !== mineB) return mineA - mineB;
    return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
  });

  if (items.length === 0) {
    // Royal v2: the dashed "+ I'm bored" pill below is the create affordance,
    // so an empty strip only ever shows the quiet radar fact (never two CTAs).
    const radar = state.radarCount ?? 0;
    if (radar === 0) return deepSheet;
    return (
      <>
        <div className={`${styles.radarLine} ${styles.beaconVars}`}>
          <span>
            {radar} {radar === 1 ? 'plan' : 'plans'} live around you
          </span>
        </div>
        {deepSheet}
      </>
    );
  }

  return (
    <>
      <div className={`${styles.strip} ${styles.beaconVars}`} role="list" aria-label="Live beacons">
        {items.map((b) => (
          <BeaconCard key={b.id} beacon={b} now={now} />
        ))}
      </div>
      {deepSheet}
    </>
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

  // Royal v2 (ref 10): "Jonas · chai run · Dolores Park" title + the quiet
  // "needs N more to spark" meta line (faces, never counters).
  const title = sparked
    ? `IT’S ON 🎉 · ${vibeLabelOf(b)}`
    : `${creatorName} · ${vibeLabelOf(b)}${b.location ? ` · ${b.location.label}` : ''}`;
  const metaParts: string[] = [];
  if (!sparked && b.my_state === 'creator') metaParts.push('your beacon');
  if (!sparked) metaParts.push(b.needs > 0 ? `needs ${b.needs} more to spark` : 'sparking any moment');
  metaParts.push(countdown);

  return (
    <div
      role="listitem"
      className={`${styles.card} ${styles.cardRel}${!sparked ? ` ${styles.cardLive}` : ''}${sparked ? ` ${styles.cardSparked}` : ''}`}
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
        <Avatar avatar={b.creator.avatar} name={b.creator.display_name} size={46} />
        <span className={styles.cardTitle}>
          <strong>{title}</strong>
          <span className={`${styles.cardMeta}${soon && !sparked ? ` ${styles.cardMetaSoon}` : ''}${b.needs === 1 && !sparked ? ` ${styles.needsOne}` : ''}`}>
            {metaParts.join(' · ')}
          </span>
        </span>
        <span className={styles.cardSide}>
          {/* FEATURES #60: the pile is a button — tap to see WHO is in. */}
          {pile.length > 0 ? (
            <button
              type="button"
              className={styles.pile}
              key={b.joiner_count}
              aria-label={`${b.joiner_count} in — see who`}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              onClick={() => setDetail(true)}
            >
              {pile.map((j) => (
                <span key={j.id} className={styles.pilePop}>
                  <Avatar avatar={j.avatar} name={j.display_name} size={26} />
                </span>
              ))}
              {overflow > 0 ? <span className={styles.pileMore}>+{overflow}</span> : null}
            </button>
          ) : null}
          {sparked && b.conversation_id ? (
            <button
              type="button"
              className={`${styles.joinBtn} ${styles.joinSm} ${styles.sparkBtn}`}
              onClick={() => router.push(`/c/${b.conversation_id}`)}
            >
              Open chat
            </button>
          ) : !sparked && b.my_state === 'joined' ? (
            <button type="button" className={`${styles.joinBtn} ${styles.joinSm} ${styles.joinedBtn} ${styles.joinPop}`} disabled>
              You&rsquo;re in
            </button>
          ) : !sparked && b.my_state === 'none' ? (
            <button
              type="button"
              className={`${styles.joinBtn} ${styles.joinSm}`}
              disabled={joinBusy}
              onClick={() => void join()}
            >
              Join
            </button>
          ) : null}
        </span>
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
          plan updated
        </span>
      ) : b.edited_at ? (
        <span className={styles.editedNote}>edited</span>
      ) : null}
      {b.note ? <p className={styles.cardNote}>{b.note}</p> : null}
      {b.ritual ? (
        <span className={styles.ritualTag}>
          ritual{b.ritual.count > 0 ? ` · ${b.ritual.count} so far` : ''}
        </span>
      ) : null}
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
