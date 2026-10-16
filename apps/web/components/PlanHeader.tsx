'use client';

// Plan group header (v0.3 — sparked beacon, API.md §1.15/§1.16). Countdown is
// the anticipation feature (PSYCHOLOGY §5); roles are named micro-roles with
// per-person done states — no percentages, no progress bars (PSYCHOLOGY §4);
// "make it a ritual" counts UP and never guilt-trips (PSYCHOLOGY §7).
import { useEffect, useState } from 'react';
import {
  BEACON_ROLE_LABEL_MAX_CHARS,
  BEACON_ROLES_MAX,
  type Beacon,
  type BeaconRole,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  addRole,
  claimRole,
  completeRole,
  deleteRole,
  fetchRoles,
  fmtCountdown,
  releaseRole,
  ritualizeBeacon,
  VIBE_EMOJI,
} from '@/lib/beacons';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import Avatar from './Avatar';
import styles from './beacons.module.css';

export default function PlanHeader({ beacon, meId }: { beacon: Beacon; meId: string }) {
  const state = useAppState();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ritualBusy, setRitualBusy] = useState(false);

  const roles = state.planRoles.get(beacon.id);

  useEffect(() => {
    // Reconcile the roles list from REST (plan.updated keeps it live after).
    void fetchRoles(beacon.id).catch(() => undefined);
  }, [beacon.id]);

  const startsMs = new Date(beacon.starts_at).getTime();
  const countdown =
    startsMs > now
      ? `happening in ${fmtCountdown(beacon.starts_at, now)}`
      : `on now · ${fmtCountdown(beacon.expires_at, now)} left`;

  const isCreator = beacon.my_state === 'creator';
  const claimedCount = (roles ?? []).filter((r) => r.assignee !== null).length;

  async function submitRole(): Promise<void> {
    const text = label.trim();
    if (!text) return;
    setErr(null);
    try {
      await addRole(beacon.id, text);
      setLabel('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'role_limit') {
        setErr(`That's the lot — ${BEACON_ROLES_MAX} roles max.`);
      } else {
        setErr('Could not add that role.');
      }
    }
  }

  async function ritualize(): Promise<void> {
    if (ritualBusy || beacon.ritual) return;
    setRitualBusy(true);
    setErr(null);
    try {
      await ritualizeBeacon(beacon.id);
    } catch {
      setErr('Could not set the ritual just now.');
    } finally {
      setRitualBusy(false);
    }
  }

  return (
    <div className={`${styles.plan} ${styles.beaconVars}`}>
      <button
        type="button"
        className={styles.planBar}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.vibeEmoji} aria-hidden>
          {VIBE_EMOJI[beacon.vibe]}
        </span>
        <span className={styles.planTitle}>IT&rsquo;S ON · {countdown}</span>
        {roles && roles.length > 0 ? (
          <span className={styles.ritualTag}>
            {claimedCount}/{roles.length} roles claimed
          </span>
        ) : null}
        <span aria-hidden style={{ color: 'var(--muted)', fontSize: 12 }}>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div className={styles.planBody}>
          {(roles ?? []).map((role) => (
            <RoleRow key={role.id} role={role} beacon={beacon} meId={meId} isCreator={isCreator} />
          ))}
          {(roles?.length ?? 0) < BEACON_ROLES_MAX ? (
            <div className={styles.roleAdd}>
              <input
                className="input"
                placeholder="Add a role — “books the table”"
                value={label}
                maxLength={BEACON_ROLE_LABEL_MAX_CHARS}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRole();
                }}
              />
              <button type="button" className="btn" disabled={!label.trim()} onClick={() => void submitRole()}>
                Add
              </button>
            </div>
          ) : null}

          {beacon.ritual ? (
            <span className={styles.ritualTag}>
              🔁 It&rsquo;s a ritual — {beacon.ritual.count}{' '}
              {beacon.ritual.count === 1 ? 'time' : 'times'} and counting.
            </span>
          ) : isCreator ? (
            <button
              type="button"
              className={styles.ritualBtn}
              disabled={ritualBusy}
              onClick={() => void ritualize()}
            >
              🔁 Make it a ritual — same time next week
            </button>
          ) : null}
          {err ? <p className="error-text" style={{ margin: 0 }}>{err}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoleRow({
  role,
  beacon,
  meId,
  isCreator,
}: {
  role: BeaconRole;
  beacon: Beacon;
  meId: string;
  isCreator: boolean;
}) {
  const mine = role.assignee?.id === meId;
  const canToggleDone = mine || isCreator;

  return (
    <div className={styles.roleRow}>
      <button
        type="button"
        className={`${styles.roleCheck}${role.done ? ` ${styles.roleDone}` : ''}`}
        aria-label={role.done ? 'Done' : canToggleDone ? 'Mark done' : 'Not done yet'}
        disabled={!canToggleDone || role.done}
        onClick={() => void completeRole(beacon.id, role.id).catch(() => undefined)}
      >
        ✓
      </button>
      <span className={`${styles.roleLabel}${role.done ? ` ${styles.roleLabelDone}` : ''}`}>
        {role.label}
        {role.assignee ? (
          <span className="muted"> — {mine ? 'you' : role.assignee.display_name}</span>
        ) : null}
      </span>
      {role.assignee ? (
        <>
          <Avatar avatar={role.assignee.avatar} name={role.assignee.display_name} size={26} />
          {(mine || isCreator) && !role.done ? (
            <button
              type="button"
              className={styles.roleX}
              aria-label="Release this role"
              onClick={() => void releaseRole(beacon.id, role.id).catch(() => undefined)}
            >
              ↩
            </button>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className={styles.roleClaim}
          onClick={() => void claimRole(beacon.id, role.id).catch(() => undefined)}
        >
          I got this
        </button>
      )}
      {isCreator ? (
        <button
          type="button"
          className={styles.roleX}
          aria-label="Remove this role"
          onClick={() => void deleteRole(beacon.id, role.id).catch(() => undefined)}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
