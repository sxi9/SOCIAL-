'use client';

// The SIGNED-IN profile page (ARCHITECTURE §5.4; v0.5a §1.37): animated
// avatar + the rich profile — 3-GIF strip, interest chips, work/skills —
// plus connect and message actions (§1.28). No endorsement counts, no
// connection counts, no profile view counters: a page about a person, not a
// scoreboard. Phase 6 (§1b): mounted by the /u/[username] server route for
// a session; the logged-out hero lives there. ?msg=1 / ?call=1 are the
// hero's doors landing here after sign-in — the DM opens itself.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  Attachment,
  ConversationResponse,
  Profile,
  Trust,
  UserProfileResponse,
  UserPublic,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { connectionStateFor, connectTo, refreshConnections, removeConnection } from '@/lib/connections';
import { formatLastSeen } from '@/lib/format';
import { refreshMyMood } from '@/lib/mood';
import { upsertConversation } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import MediaLightbox from '@/components/MediaLightbox';
import { useReducedMotion } from '@/lib/useReducedMotion';
import ActivityStrip from '@/components/ActivityStrip';
import AnonSendSheet from '@/components/AnonSendSheet';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import MoodChip from '@/components/MoodChip';
import MoodSheet from '@/components/MoodSheet';
import ReportSheet from '@/components/ReportSheet';
import StyledName from '@/components/StyledName';
import TrustPanel from '@/components/TrustPanel';
import { ShareButton } from '@/components/ShareSheet';
import { toast } from '@/lib/toast';
import bz from '@/components/beacons.module.css';
import idm from '@/components/identity.module.css';
import pp from '@/components/profilepage.module.css';
import st from '@/components/social.module.css';
import { confirmDialog } from '@/lib/confirm';

function PublicProfile({ username }: { username: string }) {
  const state = useAppState();
  const router = useRouter();
  const search = useSearchParams();
  const [user, setUser] = useState<UserPublic | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [trust, setTrust] = useState<Trust | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [picZoom, setPicZoom] = useState(false); // v1.0a #93
  const [report, setReport] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // v0.8a §1.57: the mood picker lives on MY OWN profile.
  const [moodOpen, setMoodOpen] = useState(false);
  // v0.8b §1.62: the anonymous-send entry. Whether THEY take anonymous
  // messages is enforced invisibly server-side (one 404 shape) — the entry
  // renders for everyone else and the refusal copy never disambiguates.
  const [anonOpen, setAnonOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUser(null);
    setProfile(null);
    setTrust(null);
    setError(null);
    void api
      .get<UserProfileResponse>(`/api/users/${encodeURIComponent(username)}`)
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setProfile(res.profile ?? null);
        // v0.5b §1.40: defaulted server-side; guard keeps old payloads clean.
        setTrust(res.trust ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This user does not exist.'
            : 'Could not load this profile.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  // Connection state powers the Connect button (§1.28).
  useEffect(() => {
    void refreshConnections();
  }, []);

  // user.updated keeps an open profile live (avatar transcode landing, etc.).
  const peer = user
    ? [...state.conversations.values()]
        .flatMap((c) => c.participants)
        .find((p) => p.user.id === user.id)?.user ?? user
    : null;
  const shown = peer ?? user;
  const presence = shown ? state.presence.get(shown.id) : undefined;
  const isMe = shown !== null && shown.id === state.me?.id;
  const connState = shown && !isMe && state.connections ? connectionStateFor(shown.id) : null;

  // My own full mood state (fade time, owner-only) for the picker card.
  useEffect(() => {
    if (isMe) void refreshMyMood().catch(() => undefined);
  }, [isMe]);

  // v0.8a §1.57: the chip to render — mine stays live via me.mood/moodState;
  // someone else's rides their (per-viewer resolved) UserPublic.
  const shownMood = isMe ? state.me?.mood ?? null : shown?.mood ?? null;

  // v2 (proto 30): shared interests get the white-border chip. My own public
  // tags are fetched once, client-side; when unavailable every chip renders
  // standard — purely presentational, nothing new is revealed either way.
  const [myInterests, setMyInterests] = useState<Set<string> | null>(null);
  const myUsername = state.me?.username ?? null;
  const theirInterestCount = profile?.interests.length ?? 0;
  useEffect(() => {
    if (isMe || !myUsername || theirInterestCount === 0) return;
    let cancelled = false;
    void api
      .get<UserProfileResponse>(`/api/users/${encodeURIComponent(myUsername)}`)
      .then((res) => {
        if (cancelled) return;
        setMyInterests(new Set((res.profile?.interests ?? []).map((t) => t.toLowerCase())));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isMe, myUsername, theirInterestCount]);

  async function block(): Promise<void> {
    if (!shown || blockBusy) return;
    setMenu(false);
    // Wave 1 §1.8: a block is a decision, not a mis-tap — confirm first.
    const ok = await confirmDialog(
      `Block ${shown.display_name}? You disappear from each other everywhere. They are not told.`,
      { confirmLabel: 'Block', danger: true },
    );
    if (!ok) return;
    setBlockBusy(true);
    try {
      await api.put(`/api/users/${shown.id}/block`);
      setBlocked(true);
    } catch {
      /* idempotent — a failure here just leaves the profile up */
    } finally {
      setBlockBusy(false);
    }
  }

  async function connect(): Promise<void> {
    if (!shown || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await connectTo(shown.id);
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 429
          ? 'Easy there — too many requests this hour.'
          : 'Could not send the request right now.',
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function message(door?: 'msg' | 'call'): Promise<void> {
    if (!shown || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'dm',
        user_id: shown.id,
      });
      upsertConversation(res.conversation);
      if (door) {
        // A door landing: REPLACE the ?msg/?call entry with the chat (one
        // navigation — the App Router discards a replace that is still
        // pending when a push follows it), so Back returns to the plain
        // profile instead of re-opening the chat.
        if (door === 'call') toast('Use the call button at the top of the chat to ring them');
        router.replace(`/c/${res.conversation.id}`);
        return;
      }
      router.push(`/c/${res.conversation.id}`);
    } catch (err) {
      // dm_policy 'nobody' answers the one 404 (§1.14 shape).
      setActionError(
        err instanceof ApiError && err.status === 404
          ? 'They are not taking new messages right now.'
          : 'Could not open a chat.',
      );
      setActionBusy(false);
    }
  }

  // Phase 6: the hero's doors — once the person is loaded and is not me,
  // open the DM exactly once (a StrictMode double-run must not send twice).
  const doorRef = useRef(false);
  const door = search.get('call') ? 'call' : search.get('msg') ? 'msg' : null;
  useEffect(() => {
    if (!door || !shown || isMe || doorRef.current) return;
    doorRef.current = true;
    // Consumed once per tab: a restored /u/<u>?msg=1 (bfcache, a reopened
    // tab) must not mint again — it just shows the profile.
    const key = `door:${username}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* storage blocked: fall through, the ref still guards this mount */
    }
    void message(door);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [door, shown?.id, isMe]);

  const connectButton = (() => {
    if (!connState) return null;
    switch (connState.kind) {
      case 'none':
        return (
          <button
            type="button"
            className={`${pp.pillBtn} ${pp.pillPrimary}`}
            disabled={actionBusy}
            onClick={() => void connect()}
          >
            Connect
          </button>
        );
      case 'outgoing':
        return (
          <button
            type="button"
            className={pp.pillBtn}
            disabled={actionBusy}
            onClick={() => {
              setActionBusy(true);
              void removeConnection(connState.connection)
                .catch(() => setActionError('Could not cancel.'))
                .finally(() => setActionBusy(false));
            }}
          >
            Requested · cancel
          </button>
        );
      case 'incoming':
        // Their request to me — connect() auto-accepts it server-side (§1.28).
        return (
          <button
            type="button"
            className={`${pp.pillBtn} ${pp.pillPrimary}`}
            disabled={actionBusy}
            onClick={() => void connect()}
          >
            Accept request
          </button>
        );
      case 'accepted':
        return (
          <button
            type="button"
            className={pp.pillBtn}
            disabled={actionBusy}
            onClick={() => {
              void confirmDialog(`Remove ${shown?.display_name ?? 'them'} as a friend? They won't be told.`).then(
                (ok) => {
                  if (!ok) return;
                  setActionBusy(true);
                  void removeConnection(connState.connection)
                    .catch(() => setActionError('Could not remove.'))
                    .finally(() => setActionBusy(false));
                }
              );
            }}
          >
            ✓ Friends
          </button>
        );
    }
  })();

  return (
    <div className="page">
      {/* v2 (proto 30): cover band with floating back orb + ··· overflow —
          the sticky topbar retired on this screen; heading stays for SRs. */}
      <div className={pp.cover}>
        <div className={pp.coverBar}>
          <Link href="/" className={pp.orbBtn} aria-label="Back">
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
          <h1 className={pp.srOnly}>Profile</h1>
          {shown && !isMe && !blocked ? (
            <div className={bz.cardRel}>
              <button
                type="button"
                className={pp.orbBtn}
                aria-label="Profile options"
                onClick={() => setMenu((v) => !v)}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5.5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="18.5" cy="12" r="1.6" />
                </svg>
              </button>
              {menu ? (
                <>
                  <button
                    type="button"
                    className={bz.menuBackdrop}
                    aria-label="Close menu"
                    onClick={() => setMenu(false)}
                  />
                  <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 40 }}>
                    <button type="button" role="menuitem" className={bz.menuDanger} onClick={() => void block()}>
                      Block @{shown.username}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        setReport(true);
                      }}
                    >
                      Report
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : isMe ? (
            <Link href="/settings/account" className={pp.coverPill}>
              Edit
            </Link>
          ) : (
            <span />
          )}
        </div>
      </div>
      {report && shown ? (
        <ReportSheet target={{ kind: 'user', user_id: shown.id }} onClose={() => setReport(false)} />
      ) : null}

      {blocked ? (
        <div className="settings-section">
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: 0 }}>Blocked.</p>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              You won&rsquo;t see each other around here any more. Change your mind any time in{' '}
              <Link href="/settings/blocked">Blocked people</Link>.
            </p>
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => router.push('/')}>
              Back to chats
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="center-screen muted" role="alert">
          {error}
        </div>
      ) : !shown ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : (
        <div className={pp.col}>
          {/* v1.1 Royal (owner fix round): centered hero — ringed avatar,
              serif name, "@handle · mood" line — per the design prototype. */}
          <section className={pp.hero}>
            <div className={pp.avatarRing}>
              <div className={pp.avatarGap}>
                {/* Profile pages render the animated WebP (motion-gated, §5.4).
                    v1.0a (#93): tap opens the full-screen pinch-zoom viewer. */}
                <button
                  type="button"
                  className="avatarZoomTap"
                  aria-label="View profile picture full screen"
                  disabled={shown.avatar.static_url === null}
                  onClick={() => setPicZoom(true)}
                >
                  <Avatar avatar={shown.avatar} name={shown.display_name} size={96} animated />
                </button>
              </div>
            </div>
            {picZoom && shown.avatar.static_url !== null ? (
              <MediaLightbox
                src={shown.avatar.animated_url ?? shown.avatar.static_url}
                alt={`${shown.display_name}'s profile picture`}
                onClose={() => setPicZoom(false)}
              />
            ) : null}
            {/* v0.8a §1.58: the profile page is a pinned animated-name site. */}
            <h2 className={pp.heroName}>
              <StyledName userId={shown.id} style={shown.name_style} name={shown.display_name} />
            </h2>
            {/* v0.8a §1.57: the mood chip — server-resolved for this viewer. */}
            <p className={pp.handleLine}>
              <span>@{shown.username}</span>
              {shownMood ? (
                <>
                  <span aria-hidden>·</span>
                  <span className={pp.moodWord}>
                    <MoodChip mood={shownMood} />
                  </span>
                </>
              ) : null}
            </p>
            {isMe ? (
              <p className={pp.moodTools}>
                {/* The owner's own fade time shows subtly, never to others. */}
                {shownMood && state.moodState?.expires_at ? (
                  <span className={idm.moodFade}>
                    fades by{' '}
                    {new Date(state.moodState.expires_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                ) : null}
                <button type="button" className={pp.moodBtn} onClick={() => setMoodOpen(true)}>
                  {shownMood ? 'Change mood' : '+ Set a mood'}
                </button>
              </p>
            ) : null}
            <p className={pp.heroSub}>
              <span className={presence?.online ? `${pp.subDot} ${pp.subDotOn}` : pp.subDot} aria-hidden />
              {presence?.online ? 'online' : formatLastSeen(presence?.last_seen_at ?? shown.last_seen_at)}
            </p>
          </section>
          {moodOpen ? <MoodSheet onClose={() => setMoodOpen(false)} /> : null}
          {anonOpen && shown ? (
            <AnonSendSheet userId={shown.id} displayName={shown.display_name} onClose={() => setAnonOpen(false)} />
          ) : null}

          {/* v2 (proto 30): interest chips sit right under the identity —
              shared tags wear the white border + a " · shared" word. */}
          {profile && profile.interests.length > 0 ? (
            <div className={pp.intChips}>
              {profile.interests.map((tag) => {
                const shared = !isMe && myInterests !== null && myInterests.has(tag.toLowerCase());
                return (
                  <span key={tag} className={shared ? `${pp.intChip} ${pp.intChipShared}` : pp.intChip}>
                    {tag}
                    {shared ? (
                      <span className={pp.sharedWord}>
                        <span aria-hidden>· </span>shared
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* proto 30: Connect (filled) / Message (outline) / anon orb in one
              row; own profile keeps the stacked outline pill. */}
          {isMe ? (
            <div className={pp.actionsRow}>
              <Link href="/settings/account" className={pp.pillBtn}>
                Edit profile
              </Link>
              {/* Phase 6: MY card — an owner-minted profile token (revocable
                  in Settings → Privacy) plus Copy @username. */}
              <ShareButton type="profile" id={shown.id} className={pp.pillBtn} handle={shown.username} />
            </div>
          ) : (
            <div className={pp.actionsRow}>
              {connectButton}
              <button type="button" className={pp.pillBtn} disabled={actionBusy} onClick={() => void message()}>
                Message
              </button>
              {/* Phase 6: someone else's profile shares as its /u/ address —
                  no token (only the owner mints one). */}
              <ShareButton
                type="profile"
                id={shown.id}
                className={pp.pillBtn}
                handle={shown.username}
                fixedUrl={`/u/${encodeURIComponent(shown.username)}`}
              />
              {/* v0.8b §1.62: the anonymous reveal game — words first, face
                  later. The mask emoji is content (the anon system's masks). */}
              <button type="button" className={pp.anonOrb} aria-label="Send anonymously" onClick={() => setAnonOpen(true)}>
                <span aria-hidden>👻</span>
              </button>
              {actionError ? (
                <p className="error-text" style={{ width: '100%', margin: 0 }}>
                  {actionError}
                </p>
              ) : null}
            </div>
          )}

          {/* §1.37: the 3-GIF strip — animation gated by the VIEWER's settings. */}
          {profile && profile.media.length > 0 ? (
            <div className={pp.section}>
              <h3 className={pp.sectionLabel}>Pics</h3>
              <div className={st.gifStrip}>
                {profile.media.map((m) => (
                  <ProfileGif key={m.id} media={m} />
                ))}
              </div>
            </div>
          ) : null}

          {shown.bio ? (
            <div className={pp.section}>
              <p className={pp.bioText}>{shown.bio}</p>
            </div>
          ) : null}

          {profile && profile.entries.length > 0 ? (
            <div className={pp.section}>
              {(['work', 'skill'] as const).map((kind) => {
                const list = profile.entries.filter((e) => e.kind === kind);
                if (list.length === 0) return null;
                return (
                  <div key={kind}>
                    <h3 className={pp.sectionLabel}>{kind === 'work' ? 'Work' : 'Skills'}</h3>
                    {list.map((entry) => (
                      <div key={entry.id} className={st.entryRow}>
                        <span className={st.entryText}>
                          <strong>{entry.title}</strong>
                          {entry.detail ? <span>{entry.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* v0.8a §1.59: recent activity — server-resolved per viewer
              (per-kind setting ∩ the thing's own audience); invisible items
              were silently dropped, moods never appear. The .flat wrapper
              melts the strip's card into the page (hairline rows). */}
          <div className={pp.flat}>
            <ActivityStrip username={shown.username} isMe={isMe} />
          </div>

          {/* v0.5b §1.40: marketplace trust — safety information from real
              listing contacts, shown ONLY here (never ranked, never compared;
              the no-scores argument lives in ADR-012). */}
          {trust ? (
            <div className={pp.flat}>
              <TrustPanel username={shown.username} trust={trust} />
            </div>
          ) : null}

          {/* Plan karma (§1.15): a private fact about yourself, never a score
              against anyone else — shown on your OWN profile only, never
              ranked, never compared (PSYCHOLOGY design rule 3). */}
          {isMe && (shown.beacons_created > 0 || shown.beacons_sparked > 0) ? (
            <div className={pp.section}>
              <p className={pp.privateFact}>
                🔥 lit {shown.beacons_created} {shown.beacons_created === 1 ? 'beacon' : 'beacons'} ·{' '}
                {shown.beacons_sparked} sparked
              </p>
              <p className="muted small" style={{ margin: '4px 0 0', textAlign: 'center' }}>
                Only you see this line.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One tile of the 3-GIF strip. Animation is gated by the VIEWER's settings
 * (prefers-reduced-motion + their own avatar_motion — §1.37/§5 motion rules):
 * 'auto' plays, 'reduced' plays on hover, 'off' stays static.
 */
function ProfileGif({ media }: { media: Attachment }) {
  const state = useAppState();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const motion = state.me?.avatar_motion ?? 'auto';
  const animate = !reduced && motion !== 'off' && (motion === 'auto' || hovered);
  const src = animate ? media.url : media.thumb_url ?? media.url;
  return (
    <span
      className={st.gifTile}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" />
    </span>
  );
}

export default function PublicProfileClient({ username }: { username: string }) {
  return (
    <AppShell>
      <PublicProfile username={username} />
    </AppShell>
  );
}
