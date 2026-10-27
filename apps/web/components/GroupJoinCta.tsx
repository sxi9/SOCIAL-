'use client';

// The join CTA on a group share page (share-everything phase 2, AUDIT-PLAN
// §2.5): the one place a SIGNED-IN visitor joins a public group, asks into
// an invite-only one, sees "Requested" with a withdraw, or opens the chat
// they are already in. Signed-out visitors get the Slice E gate (inline
// sign-in → full reload → this island runs again, now signed in). The page
// itself stays the unauthenticated SSR render; this island asks
// `probeMe()` + GET /api/conversations/:id/join after mount.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ApiError } from '@/lib/api';
import { getJoinState, joinGroup, withdrawJoinRequest } from '@/lib/groups';
import { probeMe } from '@/lib/shareAuth';
import GateCta from './GateCta';
import cm from './community.module.css';

type Standing = 'probing' | 'anon' | 'member' | 'requested' | 'none' | 'closed' | 'error';

export default function GroupJoinCta({
  conversationId,
  kind,
  next,
  fallback,
  signedOutLabel,
}: {
  conversationId: string;
  kind: 'public' | 'invite_only';
  /** Where the sign-in gate lands (this share page). */
  next: string;
  /** The `/register?next=` href the gate keeps for no-JS. */
  fallback: string;
  signedOutLabel: string;
}) {
  const [standing, setStanding] = useState<Standing>('probing');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A tap that landed before the probe answered: honoured once it does.
  const clickedEarly = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await probeMe();
      if (cancelled) return;
      if (!me) {
        setStanding('anon');
        return;
      }
      try {
        const res = await getJoinState(conversationId);
        if (!cancelled) setStanding(res.state);
      } catch (err) {
        if (cancelled) return;
        // 404 = unlisted now (visibility flipped since the token was
        // minted); anything else is a hiccup worth a retry, not a verdict.
        setStanding(err instanceof ApiError && err.status === 404 ? 'closed' : 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, attempt]);

  function onEarlyClick(e: MouseEvent<HTMLAnchorElement>): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    clickedEarly.current = true;
  }

  function openChat(): void {
    // Share pages run outside AppShell: a full load boots the store from
    // /api/sync, which already carries the group.
    window.location.assign(`/c/${conversationId}`);
  }

  async function join(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await joinGroup(conversationId);
      if (res.status === 'joined') {
        openChat();
        return; // stay busy while the page changes
      }
      setStanding('requested');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'group_too_large') {
        setNote('This group is full right now.');
      } else if (err instanceof ApiError && err.status === 404) {
        setStanding('closed');
      } else if (err instanceof ApiError && err.status === 429) {
        setNote('Too many tries — give it a while.');
      } else {
        setNote('Could not do that. Check your connection and try again.');
      }
    }
    setBusy(false);
  }

  async function withdraw(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await withdrawJoinRequest(conversationId);
      setStanding('none');
    } catch {
      setNote('Could not withdraw. Check your connection and try again.');
    }
    setBusy(false);
  }

  if (standing === 'probing') {
    // Not known yet: the same link (no-JS keeps working); a click waits for
    // the answer instead of reloading the page it is already on.
    return (
      <div className={cm.shareGate}>
        <a href={fallback} className="btn btn-primary" aria-busy onClick={onEarlyClick}>
          {signedOutLabel}
        </a>
      </div>
    );
  }
  if (standing === 'anon') {
    // Signed out: the Slice E gate, unchanged.
    return (
      <div className={cm.shareGate}>
        <GateCta
          next={next}
          fallback={fallback}
          word="group"
          className="btn btn-primary"
          autoOpen={clickedEarly.current}
        >
          {signedOutLabel}
        </GateCta>
      </div>
    );
  }
  if (standing === 'error') {
    return (
      <div className={cm.shareGate}>
        <p className="error-text" style={{ margin: '0 0 8px' }}>
          Could not check your standing with this group. Check your connection.
        </p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (standing === 'closed') {
    return (
      <div className={cm.shareGate}>
        <p className="muted small" style={{ margin: 0 }}>
          This group isn’t taking new members right now.
        </p>
      </div>
    );
  }
  if (standing === 'member') {
    return (
      <div className={cm.shareGate}>
        <button type="button" className="btn btn-primary" onClick={openChat}>
          You’re in — open the chat
        </button>
      </div>
    );
  }
  if (standing === 'requested') {
    return (
      <div className={cm.shareGate}>
        <p className="muted small" style={{ margin: '0 0 8px' }}>
          Asked to join — an admin decides. It shows up in your chats when they say yes.
        </p>
        <button type="button" className="btn" disabled={busy} onClick={() => void withdraw()}>
          {busy ? 'Withdrawing…' : 'Withdraw request'}
        </button>
        {note ? <p className="error-text">{note}</p> : null}
      </div>
    );
  }
  return (
    <div className={cm.shareGate}>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void join()}>
        {busy ? (kind === 'public' ? 'Joining…' : 'Asking…') : kind === 'public' ? 'Join this group' : 'Ask to join'}
      </button>
      {note ? <p className="error-text">{note}</p> : null}
    </div>
  );
}
