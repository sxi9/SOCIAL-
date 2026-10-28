'use client';

// Phase 5 (AUDIT-PLAN §1b): the Join island on a call room page. Signed
// out → the inline sign-in sheet, landing back here. Signed in → POST
// /api/calls/links/:token/join (joins the GROUP through the token), then a
// full navigation to /c/<conversation_id>?call=<call_id> where the chat
// page's CallAutoAccept runs the ordinary §1.42 join (media prompt, mesh
// cap). The GroupJoinCta pattern: probe once, never dead-end.
import { useEffect, useRef, useState } from 'react';
import type { CallLinkJoinResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { probeMe } from '@/lib/shareAuth';
import GateCta from './GateCta';

type Standing = 'probing' | 'anon' | 'ready' | 'joining' | 'gone' | 'error';

export default function CallJoinCta({
  token,
  kind,
  full,
  next,
  fallback,
}: {
  token: string;
  kind: 'audio' | 'video';
  full: boolean;
  next: string;
  fallback: string;
}) {
  const [standing, setStanding] = useState<Standing>('probing');
  const [note, setNote] = useState<string | null>(null);
  const clickedEarly = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void probeMe().then((me) => {
      if (cancelled) return;
      setStanding(me ? 'ready' : 'anon');
      // A tap that landed while probing: a signed-in visitor meant "join".
      if (me && clickedEarly.current) void join();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function join(): Promise<void> {
    if (standing === 'joining') return;
    setStanding('joining');
    setNote(null);
    try {
      const res = await api.post<CallLinkJoinResponse>(`/api/calls/links/${encodeURIComponent(token)}/join`);
      window.location.assign(`/c/${res.conversation_id}?call=${encodeURIComponent(res.call_id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStanding('gone');
      } else if (err instanceof ApiError && err.code === 'group_too_large') {
        setStanding('error');
        setNote('This group is full.');
      } else if (err instanceof ApiError && err.status === 429) {
        setStanding('ready');
        setNote('Too many tries — give it a minute.');
      } else {
        setStanding('error');
        setNote('Could not join. Try again.');
      }
    }
  }

  const label = `Join the ${kind} call`;
  if (standing === 'probing') {
    return (
      <a
        href={fallback}
        className="btn btn-primary"
        aria-busy
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          clickedEarly.current = true;
        }}
      >
        {label}
      </a>
    );
  }
  if (standing === 'anon') {
    return (
      <GateCta next={next} fallback={fallback} word="call" className="btn btn-primary" autoOpen={clickedEarly.current}>
        {label} — sign in free
      </GateCta>
    );
  }
  if (standing === 'gone') {
    return <p className="muted small">That call has ended, or the link was revoked.</p>;
  }
  return (
    <>
      {full ? (
        <p className="muted small" style={{ margin: '0 0 6px' }}>
          The call is full right now (8 people). Joining the group still works — try the call again
          when someone leaves.
        </p>
      ) : null}
      <button type="button" className="btn btn-primary" disabled={standing === 'joining'} onClick={() => void join()}>
        {standing === 'joining' ? 'Joining…' : label}
      </button>
      {note ? <p className="error-text">{note}</p> : null}
    </>
  );
}
