'use client';

// Client half of /join/:token. Shows the inviter's ANIMATED avatar big (the
// token-gated proxy variant, gated by prefers-reduced-motion per the §5
// motion-hygiene contract; static fallback, initial-letter fallback on 404),
// then routes by auth state: signed-out visitors register with the
// invite_token carried through (or log in and come back here), signed-in
// ones POST /api/invites/:token/accept and land in the conversation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AcceptInviteResponse, InvitePublic, MeResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import styles from './join.module.css';

interface JoinClientProps {
  token: string;
  invite: InvitePublic | null;
}

export default function JoinClient({ token, invite }: JoinClientProps) {
  const router = useRouter();
  // null = still probing; the join page lives outside AppShell on purpose
  // (it must render for visitors with no session at all).
  const [authedAs, setAuthedAs] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const acceptingRef = useRef(false);

  const accept = useCallback(async (): Promise<void> => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await api.post<AcceptInviteResponse>(`/api/invites/${encodeURIComponent(token)}/accept`);
      router.replace(`/c/${res.conversation_id}`);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invite_own') {
        setAcceptError('That’s your own invite link — send it to someone else!');
      } else if (err instanceof ApiError && err.code === 'invite_expired') {
        setAcceptError('This invite expired while you were looking at it. Ask for a fresh one.');
      } else if (err instanceof ApiError && err.code === 'invite_exhausted') {
        setAcceptError('This invite hit its join limit. Ask for a fresh one.');
      } else if (err instanceof ApiError && err.code === 'invite_revoked') {
        setAcceptError('This invite was taken back. Ask for a fresh one.');
      } else if (err instanceof ApiError && err.code === 'group_too_large') {
        setAcceptError('This group is full (256 people — a legend of a group chat).');
      } else {
        setAcceptError('Could not join right now. Check your connection and try again.');
      }
      acceptingRef.current = false;
      setAccepting(false);
    }
  }, [token, router]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<MeResponse>('/api/users/me')
      .then((res) => {
        if (cancelled) return;
        setAuthedAs(res.user.display_name);
        // "Log in" from this page round-trips through /login?next=/join/<t>?then=accept:
        // when the visitor lands back here signed in, accept without another tap.
        const wantsAccept = new URLSearchParams(window.location.search).get('then') === 'accept';
        if (wantsAccept && invite?.status === 'valid') void accept();
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setProbed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accept, invite]);

  if (!invite) {
    return (
      <div className={styles.body}>
        <h2 className={styles.headline}>Hmm, that link doesn&rsquo;t work</h2>
        <p className={styles.sub}>
          It may have a typo, or it never existed. Invite links look like{' '}
          <code>/join/…</code> and come from someone already on Bored Chat.
        </p>
        <div className={styles.actions}>
          <Link href="/register" className="btn btn-primary">
            Get your own Bored Chat
          </Link>
        </div>
      </div>
    );
  }

  const name = invite.inviter.display_name;

  if (invite.status !== 'valid') {
    const reason =
      invite.status === 'expired'
        ? 'This invite has expired — they only last 7 days.'
        : invite.status === 'exhausted'
          ? 'This invite hit its join limit. Popular crowd.'
          : 'This invite was taken back by its owner.';
    return (
      <div className={styles.body}>
        <InviteAvatar invite={invite} />
        <h2 className={styles.headline}>So close!</h2>
        <p className={styles.sub}>
          {reason} Ask {name} for a fresh link — or just start your own corner of Bored Chat.
        </p>
        <div className={styles.actions}>
          <Link href="/register" className="btn btn-primary">
            Join Bored Chat anyway
          </Link>
          <Link href="/login" className="btn">
            Log in
          </Link>
        </div>
      </div>
    );
  }

  const headline =
    invite.kind === 'group' && invite.group_title
      ? `${name} invited you to “${invite.group_title}”`
      : `${name} invited you to Bored Chat`;

  return (
    <div className={styles.body}>
      <InviteAvatar invite={invite} />
      <h2 className={styles.headline}>{headline}</h2>
      <p className={styles.sub}>
        {invite.kind === 'group'
          ? 'One tap and you’re in the group — boredom not included.'
          : `One tap and you’re chatting with ${name} — boredom not included.`}
      </p>
      {acceptError ? <p className="error-text">{acceptError}</p> : null}
      {!probed ? (
        <div className={styles.actions}>
          <span className="spinner" />
        </div>
      ) : authedAs ? (
        <div className={styles.actions}>
          <button type="button" className="btn btn-primary" disabled={accepting} onClick={() => void accept()}>
            {accepting ? 'Joining…' : 'Jump into the chat'}
          </button>
          <p className="muted small">Signed in as {authedAs}</p>
        </div>
      ) : (
        <div className={styles.actions}>
          <Link href={`/register?invite=${encodeURIComponent(token)}`} className="btn btn-primary">
            Join Bored Chat
          </Link>
          <Link href={`/login?next=${encodeURIComponent(`/join/${token}?then=accept`)}`} className="btn">
            I have an account — log in
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * Big inviter avatar: animated variant first (unless the visitor prefers
 * reduced motion), static on error, initial letter when nothing loads —
 * the proxy 404s the moment the invite stops being valid.
 */
function InviteAvatar({ invite }: { invite: InvitePublic }) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const candidates = useMemo(() => {
    const { animated_url, static_url } = invite.inviter.avatar;
    const list: string[] = [];
    if (!reducedMotion && animated_url) list.push(animated_url);
    if (static_url) list.push(static_url);
    return list;
  }, [invite, reducedMotion]);

  const src = failed < candidates.length ? candidates[failed] : null;
  const initial = invite.inviter.display_name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span className={styles.bigAvatar}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" draggable={false} onError={() => setFailed((n) => n + 1)} />
      ) : (
        <span aria-hidden>{initial}</span>
      )}
    </span>
  );
}
