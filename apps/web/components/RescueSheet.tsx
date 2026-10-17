'use client';

// v0.6 Rescue me (API.md §1.46, FEATURES #53): one tap pings up to three
// friends to call you out of a boring situation. Deliberately tiny — a rescue
// is a message plus an urgent push (the ONE §2.9 exception: it buzzes even
// through a mute; blocks stay structural). Capped at 3/day so it keeps
// meaning something.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  RESCUE_MAX_PER_DAY,
  RESCUE_MAX_TARGETS,
  RESCUE_NOTE_MAX_CHARS,
  type RescueResponse,
  type UserLite,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { sendRescue } from '@/lib/discovery';
import { dmPeer } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import Portal from './Portal';
import bcn from './beacons.module.css';
import styles from './discovery.module.css';

/** Global one-tap SOS entry (fixer r1 — FEATURES #53 pitches ONE tap, not
 * Profile → scroll → Rescue me): a topbar icon button mounted on the Chats
 * list and the Local tab, opening the same sheet the Profile card does. */
export function RescueButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Rescue me — ping friends to call you"
        title="Rescue me"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden>🆘</span>
      </button>
      {open ? <RescueSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The Profile-tab card that opens the sheet. */
export function RescueCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <h2>Rescue me</h2>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>🆘 Stuck somewhere boring?</strong>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Ping up to {RESCUE_MAX_TARGETS} friends to call you out of it — their phones buzz even
            if they muted you. {RESCUE_MAX_PER_DAY} rescues a day.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          Rescue me
        </button>
      </div>
      {open ? <RescueSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export default function RescueSheet({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<RescueResponse | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Candidates = my friends-of set as the client knows it: accepted
  // connections ∪ DM partners (§1.28) — exactly who the server will accept.
  const meId = state.me?.id;
  const candidates = useMemo<UserLite[]>(() => {
    const byId = new Map<string, UserLite>();
    for (const c of state.connections?.connections ?? []) byId.set(c.user.id, c.user);
    for (const conv of state.conversations.values()) {
      if (conv.type !== 'dm') continue;
      const peer = dmPeer(conv, meId);
      if (peer) {
        byId.set(peer.id, {
          id: peer.id,
          username: peer.username,
          display_name: peer.display_name,
          avatar: peer.avatar,
          mood: peer.mood,
          name_style: peer.name_style,
        });
      }
    }
    return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [state.connections, state.conversations, meId]);

  function toggle(id: string): void {
    setPicked((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= RESCUE_MAX_TARGETS ? cur : [...cur, id]
    );
  }

  async function submit(): Promise<void> {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendRescue(picked, note.trim());
      setSent(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(`You've used all ${RESCUE_MAX_PER_DAY} rescues for today — the cap resets at midnight UTC.`);
      } else if (err instanceof ApiError && err.status === 404) {
        setError('One of those people is not available for a rescue right now.');
      } else {
        setError('Could not send the rescue. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.display_name ?? 'them';

  return (
    // Portaled to <body>: this sheet is opened from inside the blurred
    // `.topbar` (a backdrop-filter containing block), which otherwise pins
    // the "fixed" backdrop to the topbar box and shoves the sheet off-screen.
    <Portal>
    <div
      className={bcn.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={bcn.sheet} role="dialog" aria-modal="true" aria-label="Rescue me">
        <div className={bcn.sheetHead}>
          <h2>🆘 Rescue me</h2>
          <button type="button" className={bcn.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {sent ? (
          <>
            <p className="ok-text">
              Rescue sent — {sent.rescues.map((r) => nameOf(r.user_id)).join(', ')}{' '}
              {sent.rescues.length === 1 ? 'got' : 'each got'} the SOS. Phones are buzzing.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {sent.rescues.map((r) => (
                <Link key={r.user_id} href={`/c/${r.conversation_id}`} className="btn" onClick={onClose}>
                  Open the chat with {nameOf(r.user_id)}
                </Link>
              ))}
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <p className={bcn.sheetNote} style={{ marginTop: 0 }}>
              Pick up to {RESCUE_MAX_TARGETS} friends. They get an urgent ping to call you —{' '}
              <strong>it cuts through mutes</strong>, so save it for real boredom emergencies
              ({RESCUE_MAX_PER_DAY} a day).
            </p>
            {candidates.length === 0 ? (
              <p className="muted small">No friends yet — connect with someone first.</p>
            ) : (
              <div role="group" aria-label="Pick who to ping">
                {candidates.map((c) => {
                  const on = picked.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`${styles.rescueRow}${on ? ` ${styles.rescueRowOn}` : ''}`}
                      aria-pressed={on}
                      onClick={() => toggle(c.id)}
                    >
                      <Avatar avatar={c.avatar} name={c.display_name} size={34} />
                      <span className={styles.rescueRowName}>
                        {c.display_name} <span className="muted small">@{c.username}</span>
                      </span>
                      {on ? <span className={styles.rescueCheck} aria-hidden>✓</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
              <label htmlFor="rescue-note">What should they say they need you for? (optional)</label>
              <input
                id="rescue-note"
                className="input"
                placeholder="e.g. family dinner going badly"
                value={note}
                maxLength={RESCUE_NOTE_MAX_CHARS}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 12, width: '100%' }}
              disabled={busy || picked.length === 0}
              onClick={() => void submit()}
            >
              {busy
                ? 'Sending…'
                : picked.length === 0
                  ? 'Pick someone to ping'
                  : `Send the SOS to ${picked.length} ${picked.length === 1 ? 'friend' : 'friends'}`}
            </button>
          </>
        )}
      </div>
    </div>
    </Portal>
  );
}
