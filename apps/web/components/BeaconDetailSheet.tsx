'use client';

// Beacon detail sheet (v0.7 — API.md §1.47, FEATURES #60–#62). Opens from a
// card tap: the full card (vibe incl. custom, note, window, place chip with
// map links, edited marker), the complete "Who's in" list (GET .../joins —
// faces in join order, every one linking to the §1.37 profile where Connect /
// Message live), and the creator tools: Edit (sheet), "Start with whoever's
// here" (spark-now with an explicit confirm — threshold not consulted) and
// Take it down. Joiners get join/leave; everyone gets report via the card.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Beacon, UserLite } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  cancelBeacon,
  fetchBeaconJoiners,
  fmtCountdown,
  joinBeacon,
  leaveBeacon,
  sparkNow,
  vibeLabelOf,
} from '@/lib/beacons';
import { copyShareLink } from '@/lib/share';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import BeaconEditSheet from './BeaconEditSheet';
import { LocationChip } from './LocationPicker';
import Portal from './Portal';
import styles from './beacons.module.css';
import { confirmDialog } from '@/lib/confirm';

export default function BeaconDetailSheet({
  beacon: initial,
  onClose,
}: {
  beacon: Beacon;
  onClose: () => void;
}) {
  const state = useAppState();
  const router = useRouter();
  const now = useNow(30_000);
  // Live truth: beacon.updated frames patch the store while the sheet is open.
  const beacon = state.beacons.get(initial.id) ?? initial;

  const [joiners, setJoiners] = useState<UserLite[] | null>(null);
  const [joinersError, setJoinersError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmSpark, setConfirmSpark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The full "Who's in" list — audience-gated server-side, faces only, join
  // order, no timestamps (§1.47). Refreshed when the joiner count moves.
  const joinerCount = beacon.joiner_count;
  useEffect(() => {
    let cancelled = false;
    setJoinersError(null);
    void fetchBeaconJoiners(beacon.id)
      .then((list) => {
        if (!cancelled) setJoiners(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setJoinersError(
          err instanceof ApiError && err.status === 404
            ? 'This beacon is gone.'
            : 'Could not load who’s in.'
        );
      });
    return () => {
      cancelled = true;
    };
  }, [beacon.id, joinerCount]);

  const mine = beacon.my_state === 'creator';
  const sparked = beacon.status === 'sparked';
  const open = beacon.status === 'open';
  const startsMs = new Date(beacon.starts_at).getTime();
  const upcoming = startsMs > now;
  const edited = beacon.edited_at !== null;
  const recentEdit = state.beaconEdits.get(beacon.id);

  async function doJoin(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await joinBeacon(beacon.id);
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) {
        setError('Could not join — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function doLeave(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await leaveBeacon(beacon.id);
    } catch {
      setError('Could not leave — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function doSparkNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await sparkNow(beacon.id);
      setConfirmSpark(false);
      if (updated.conversation_id) {
        onClose();
        router.push(`/c/${updated.conversation_id}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'beacon_no_joiners') {
        setError('No one has tapped in yet — a plan needs at least two people.');
      } else if (err instanceof ApiError && err.status === 410) {
        setError('This beacon already closed.');
      } else {
        setError('Could not start it — try again.');
      }
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  async function doCancel(): Promise<void> {
    if (busy) return;
    if (!(await confirmDialog('Take this beacon down? Joiners get a quiet heads-up; everyone else just sees it go.'))) return;
    setBusy(true);
    try {
      await cancelBeacon(beacon.id);
      onClose();
    } catch {
      setError('Could not take it down — try again.');
      setBusy(false);
    }
  }

  const whenLine = upcoming
    ? `starts in ${fmtCountdown(beacon.starts_at, now)}`
    : sparked
      ? 'happening now'
      : `${fmtCountdown(beacon.expires_at, now)} left to join`;

  return (
    <Portal>
      <div
        className={`${styles.sheetBackdrop} ${styles.beaconVars}`}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Beacon details">
          <div className={styles.sheetHead}>
            {/* Royal v2 (ref 35): plain serif "Beacon" title. */}
            <h2>Beacon</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>

          {/* Royal v2 (ref 35): decorative map strip — pulsing pin + the
              place pill (the chip keeps its link-out behavior). The pulse
              stills under prefers-reduced-motion. */}
          {beacon.location ? (
            <div className={styles.mapStrip} aria-hidden={false}>
              <span className={styles.mapPin} aria-hidden />
              <LocationChip location={beacon.location} />
            </div>
          ) : null}

          {/* By-line: avatar + serif name + the when/needs meta (ref 35). */}
          <Link
            href={`/u/${encodeURIComponent(beacon.creator.username)}`}
            className={styles.detailBy}
          >
            <Avatar avatar={beacon.creator.avatar} name={beacon.creator.display_name} size={46} />
            <span className={styles.detailByName}>
              <strong>
                {mine ? 'You' : beacon.creator.display_name} · {vibeLabelOf(beacon)}
                {sparked ? ' · it’s on 🎉' : ''}
              </strong>
              <span>
                {new Date(beacon.starts_at).toLocaleString([], {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {whenLine}
                {!sparked && beacon.needs > 0 ? ` · needs ${beacon.needs} more to spark` : ''}
              </span>
            </span>
          </Link>

          {edited ? (
            <p className={styles.editedNote} role="status">
              plan updated
              {recentEdit && recentEdit.changed.length > 0
                ? ` — ${recentEdit.changed
                    .map((f) =>
                      f === 'spark_threshold'
                        ? 'group size'
                        : f === 'starts_at' || f === 'expires_at'
                          ? 'time'
                          : f.startsWith('custom_vibe')
                            ? 'vibe'
                            : f
                    )
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(', ')}`
                : ''}
            </p>
          ) : null}

          {beacon.note ? (
            <div className={styles.detailFactRow}>
              <span>Note</span>
              <span>{beacon.note}</span>
            </div>
          ) : null}

          {/* Who's in — the FULL list, join order; every face is a door to a
              profile with Connect/Message (blocked pairs 404 there, §1.14).
              Royal v2 (ref 35): rendered as the roles-style card. */}
          <div className={styles.rolesCard}>
            <div className={styles.rolesLabel}>Who&rsquo;s in</div>
            {joinersError ? (
              <p className={styles.receiptMuted}>{joinersError}</p>
            ) : joiners === null ? (
              <p className={styles.receiptMuted}>Looking…</p>
            ) : joiners.length === 0 ? (
              <p className={styles.receiptMuted}>No one yet — be the first</p>
            ) : (
              joiners.map((u) => (
                <Link
                  key={u.id}
                  href={`/u/${encodeURIComponent(u.username)}`}
                  className={styles.whoRow}
                  aria-label={`${u.display_name} — open profile`}
                >
                  <Avatar avatar={u.avatar} name={u.display_name} size={34} />
                  <span className={styles.whoName}>
                    {u.id === state.me?.id ? 'You' : u.display_name}
                    <span>@{u.username}</span>
                  </span>
                  <span className={styles.whoHint} aria-hidden>
                    profile →
                  </span>
                </Link>
              ))
            )}
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          {/* v0.8b §1.67: PUBLIC beacons get the one stable share link. The
              page shows the utility "needs N" number and never joiner faces. */}
          {beacon.audience === 'public' && open ? (
            <button
              type="button"
              className="btn"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => void copyShareLink('beacon', beacon.id)}
            >
              Copy a public link
            </button>
          ) : null}

          {/* ---- actions ---- */}
          {sparked && beacon.conversation_id ? (
            <button
              type="button"
              className={styles.sparkNowBtn}
              onClick={() => {
                onClose();
                router.push(`/c/${beacon.conversation_id}`);
              }}
            >
              Open the plan →
            </button>
          ) : null}

          {mine && open ? (
            <>
              {beacon.joiner_count >= 1 && !confirmSpark ? (
                <button
                  type="button"
                  className={styles.sparkNowBtn}
                  disabled={busy}
                  onClick={() => setConfirmSpark(true)}
                >
                  Start with whoever&rsquo;s here
                </button>
              ) : null}
              {confirmSpark ? (
                <div className={styles.confirmBox} role="alertdialog" aria-label="Start the plan now?">
                  <p>
                    Start now with {beacon.joiner_count} {beacon.joiner_count === 1 ? 'person' : 'people'}?
                    The card closes to everyone else and your group chat opens — same as a full spark.
                  </p>
                  <div className={styles.confirmRow}>
                    <button type="button" className="btn" disabled={busy} onClick={() => setConfirmSpark(false)}>
                      Not yet
                    </button>
                    <button type="button" className={styles.sparkNowBtn} style={{ marginTop: 0 }} disabled={busy} onClick={() => void doSparkNow()}>
                      {busy ? 'Starting…' : 'Start it'}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className={styles.confirmRow} style={{ marginTop: 10 }}>
                <button type="button" className="btn" disabled={busy} onClick={() => setEditOpen(true)}>
                  Edit the plan
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void doCancel()}>
                  Take it down
                </button>
              </div>
            </>
          ) : null}

          {!mine && open ? (
            beacon.my_state === 'joined' ? (
              <div className={styles.pillRow}>
                <button type="button" className={`${styles.joinBtn} ${styles.joinedBtn}`} disabled>
                  You&rsquo;re in
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void doLeave()}>
                  Never mind
                </button>
              </div>
            ) : (
              <div className={styles.pillRow}>
                <button type="button" className={styles.joinBtn} disabled={busy} onClick={() => void doJoin()}>
                  Join
                </button>
              </div>
            )
          ) : null}

          {/* Royal v2 (ref 35): the quiet ownership/expiry line. */}
          {open ? (
            <p className={styles.detailFoot}>
              Expires in {fmtCountdown(beacon.expires_at, now)} · only{' '}
              {mine ? 'you' : beacon.creator.display_name} can edit or end it
            </p>
          ) : null}

          {editOpen ? <BeaconEditSheet beacon={beacon} onClose={() => setEditOpen(false)} /> : null}
        </div>
      </div>
    </Portal>
  );
}
