'use client';

// Client half of /join/:token — v2 Royal (proto 31): the "what a stranger
// sees" page. Deep bg, serif wordmark header with a Sign in pill, a centered
// card (silver-ring inviter avatar, name, gradient Connect CTA) and a
// blurred-locked "join to see their world" grid — the tiles are DECORATIVE
// gradients, no real media ever leaks to a logged-out visitor. Behavior is
// unchanged: signed-out visitors register with the invite_token carried
// through (or sign in and come back here), signed-in ones POST
// /api/invites/:token/accept and land in the conversation. Every action on
// this page still gates to signup.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AcceptInviteResponse, InvitePublic } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { probeMe } from '@/lib/shareAuth';
import Mascot from '@/components/Mascot';
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
    // Phase 2: the one per-page probe every public SSR island shares.
    void probeMe().then((me) => {
      if (cancelled) return;
      if (me) {
        setAuthedAs(me.display_name);
        // "Sign in" from this page round-trips through /login?next=/join/<t>?then=accept:
        // when the visitor lands back here signed in, accept without another tap.
        const wantsAccept = new URLSearchParams(window.location.search).get('then') === 'accept';
        if (wantsAccept && invite?.status === 'valid') void accept();
      }
      setProbed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [accept, invite]);

  const loginHref = `/login?next=${encodeURIComponent(`/join/${token}?then=accept`)}`;
  const registerHref = `/register?invite=${encodeURIComponent(token)}`;

  let body: ReactNode;
  if (!invite) {
    body = (
      <section className={`${styles.card} pageFadeUp`}>
        <Mascot state="wince" size={96} />
        <h1 className={styles.headline}>Hmm, that link doesn&rsquo;t work</h1>
        <p className={styles.sub}>
          It may have a typo, or it never existed. Invite links look like <code>/join/…</code> and
          come from someone already on Bored Chat.
        </p>
        <div className={styles.actions}>
          <Link href="/register" className="btn btn-primary">
            Get your own Bored Chat
          </Link>
        </div>
      </section>
    );
  } else if (invite.status !== 'valid') {
    const name = invite.inviter.display_name;
    const reason =
      invite.status === 'expired'
        ? 'This invite has expired — they only last 7 days.'
        : invite.status === 'exhausted'
          ? 'This invite hit its join limit. Popular crowd.'
          : 'This invite was taken back by its owner.';
    body = (
      <section className={`${styles.card} pageFadeUp`}>
        <span className={styles.ring}>
          <span className={styles.ringGap}>
            <InviteAvatar invite={invite} />
          </span>
        </span>
        <h1 className={styles.headline}>So close!</h1>
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
      </section>
    );
  } else {
    const name = invite.inviter.display_name;
    body = (
      <>
        <section className={`${styles.card} pageFadeUp`}>
          <span className={styles.ring}>
            <span className={styles.ringGap}>
              <InviteAvatar invite={invite} />
            </span>
          </span>
          <h1 className={styles.name}>{name}</h1>
          <p className={styles.handle}>@{invite.inviter.username} · on Bored Chat</p>
          {invite.kind === 'group' && invite.group_title ? (
            <p className={styles.groupLine}>invited you to &ldquo;{invite.group_title}&rdquo;</p>
          ) : null}
          {/* Phase 2 (§2.5): the group card — face, blurb and size, the same
              join-decision utility the group share page shows. */}
          {invite.kind === 'group' && invite.group ? (
            <div className={styles.groupCard}>
              {invite.group.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.groupAvatar} src={invite.group.avatar_url} alt="" width={44} height={44} />
              ) : (
                <span className={styles.groupAvatarFallback} aria-hidden>
                  {invite.group_title?.trim()[0]?.toUpperCase() ?? '#'}
                </span>
              )}
              <span className={styles.groupCardText}>
                <strong>{invite.group_title}</strong>
                <span>
                  {invite.group.member_count} {invite.group.member_count === 1 ? 'member' : 'members'}
                </span>
                {invite.group.description ? <p>{invite.group.description}</p> : null}
              </span>
            </div>
          ) : null}
          {acceptError ? <p className="error-text">{acceptError}</p> : null}
          {!probed ? (
            <span className="spinner" />
          ) : authedAs ? (
            <>
              <button
                type="button"
                className={`btn btn-primary ${styles.cta}`}
                disabled={accepting}
                onClick={() => void accept()}
              >
                {accepting ? 'Joining…' : 'Jump into the chat'}
              </button>
              <p className={styles.note}>Signed in as {authedAs}</p>
            </>
          ) : (
            <>
              <Link href={registerHref} className={`btn btn-primary ${styles.cta}`}>
                {invite.kind === 'group' && invite.group_title
                  ? `Join “${invite.group_title}”`
                  : `Connect with ${name}`}
              </Link>
              <p className={styles.note}>
                joining takes a minute — {name}&rsquo;s link lands you straight in the chat
              </p>
            </>
          )}
        </section>
        {/* proto 31: the blurred-locked grid. Decorative tiles only — nothing
            of theirs is browsable logged-out; the tap gates to signup. */}
        {probed && !authedAs ? (
          <Link href={registerHref} className={styles.lockedGrid}>
            <span className={styles.lockedTiles} aria-hidden>
              <span className={styles.lockTile} />
              <span className={styles.lockTile} />
              <span className={styles.lockTile} />
            </span>
            <span className={styles.lockedOverlay}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="5.5" y="10.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0 v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <strong>Join to see {name}&rsquo;s world</strong>
            </span>
          </Link>
        ) : null}
      </>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <Link href="/" className={styles.headBack} aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M14.5 5.5 8 12l6.5 6.5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <Link href="/" className={styles.brand}>
          bored.
        </Link>
        <span className={styles.headMeta}>what a stranger sees</span>
        {probed && !authedAs ? (
          <Link href={loginHref} className="btn btn-primary">
            Sign in
          </Link>
        ) : null}
      </header>
      {body}
    </main>
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
