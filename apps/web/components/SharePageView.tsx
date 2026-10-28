// Public share pages (v0.8b — API.md §1.67, FEATURES #79c, ADR-020).
// SERVER component: renders every SharePage variant for logged-out strangers.
// Viewing is free; ANY interaction routes to /register?next=<deep link>.
// Author chips carry username + display_name + the token-gated avatar path —
// no ids, no UserLite. All media URLs are token-gated proxy paths.
import Link from 'next/link';
import type { SharePage, ShareAuthorChip, ShareMedia } from '@socialchat/shared';
import { LISTING_SAFETY_NOTE, LISTING_SAFETY_NOTE_KINDS } from '@socialchat/shared';
import GateCta from './GateCta';
import GroupJoinCta from './GroupJoinCta';
import ProfileHeroCard from './ProfileHeroCard';
import CallJoinCta from './CallJoinCta';
import ShareHeaderPill from './ShareHeaderPill';
import ShareReportLink from './ShareReportLink';
import cm from './community.module.css';

const VIBE_EMOJI: Record<string, string> = {
  food: '🍜',
  chai: '☕',
  walk: '🚶',
  game: '🎮',
  movie: '🎬',
  study: '📚',
  sport: '🏸',
  chill: '🛋️',
  custom: '✨',
};

function gate(next: string): string {
  return `/register?next=${encodeURIComponent(next)}`;
}

function AuthorChip({ chip, label }: { chip: ShareAuthorChip; label?: string }) {
  return (
    <div className={cm.shareAuthor}>
      {chip.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={cm.shareAvatar} src={chip.avatar_url} alt="" width={42} height={42} />
      ) : (
        <span className={cm.shareAvatarFallback} aria-hidden>
          {chip.display_name.trim() ? chip.display_name.trim()[0].toUpperCase() : '?'}
        </span>
      )}
      <span className={cm.shareAuthorText}>
        <strong>{chip.display_name}</strong>
        <span>
          @{chip.username}
          {label ? ` · ${label}` : ''}
        </span>
      </span>
    </div>
  );
}

function MediaGrid({ media }: { media: ShareMedia[] }) {
  if (media.length === 0) return null;
  return (
    <div className={cm.shareMediaGrid}>
      {media.map((m) =>
        m.kind === 'video' ? (
          <video key={m.attachment_id} src={m.url} poster={m.thumb_url ?? undefined} controls playsInline preload="metadata" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={m.attachment_id} src={m.url} alt="" loading="lazy" />
        )
      )}
    </div>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// v2 (proto 07): the state note beside the wordmark names what this is.
function headMeta(page: SharePage): string {
  switch (page.type) {
    case 'post':
      return page.preview === 'teaser' ? 'post preview, logged out' : 'shared post, logged out';
    case 'beacon':
      return page.preview === 'teaser' ? 'plan preview, logged out' : 'shared plan, logged out';
    case 'listing':
      return page.preview === 'teaser' ? 'listing preview, logged out' : 'board listing, logged out';
    case 'story':
      return 'shared story, logged out';
    case 'profile':
      return 'profile, logged out';
    case 'call':
      return 'call room, logged out';
    default:
      return 'shared group, logged out';
  }
}

export default function SharePageView({
  page,
  token,
  path,
}: {
  page: SharePage;
  token: string;
  path: string;
}) {
  return (
    <main className={cm.sharePage}>
      {/* proto 07: lowercase serif wordmark · state note · Sign in pill.
          Viewing stays free; every INTERACTION still gates to /register. */}
      <header className={cm.shareHead}>
        <Link href="/" className={cm.shareBrand}>
          bored.
        </Link>
        <span className={cm.shareHeadMeta}>{headMeta(page)}</span>
        <ShareHeaderPill path={path} className={`btn btn-primary ${cm.shareJoin}`} />
      </header>

      <PageBody page={page} path={path} token={token} />

      <p className={cm.shareFootnote}>
        Shared from a self-hosted Bored Chat. Viewing is free; joining takes a minute.{' '}
        <ShareReportLink token={token} />
      </p>
    </main>
  );
}

function deepLink(page: SharePage, path: string, token: string): string {
  // Phase 3: the token rides along (`?s=`) so the object route can ask
  // GET /api/share/:token/landing when its own read 404s — outside the
  // audience becomes a request instead of "not available".
  const s = `?s=${encodeURIComponent(token)}`;
  // The §1.67 ?next deep-link-back, now ON the object (§1b, 2026-10-27):
  // the object routes open the real tab with that thing's sheet up.
  switch (page.type) {
    case 'post':
      return `/feed/${page.id}${s}`;
    case 'beacon':
      return `/local/b/${page.id}${s}`;
    case 'listing':
      return `/local/${page.id}${s}`;
    case 'story':
      // Phase 4 (§3.3): the Chats tab with that author's stories open.
      return `/?story=${encodeURIComponent(page.author.username)}`;
    case 'profile':
      // Phase 6: the card's own address (the doors carry their own ?msg/?call).
      return `/u/${encodeURIComponent(page.username)}`;
    case 'call':
      return path; // phase 5: back here — the Join island does the rest
    default:
      return path; // group pages: back here, where the join CTA lives in-app
  }
}

/** §1b: the one gated CTA every teaser page ends with. */
function TeaserGate({ deep, next, word }: { deep: string; next: string; word: string }) {
  return (
    <div className={cm.shareGate}>
      <GateCta next={deep} fallback={next} word={word} className="btn btn-primary">
        Join to see the whole {word} — it&rsquo;s free
      </GateCta>
    </div>
  );
}

/** The object word for the sheet title and the teaser line. */
const GATE_WORD: Record<SharePage['type'], string> = {
  post: 'post',
  beacon: 'plan',
  listing: 'listing',
  story: 'story',
  group_card: 'group',
  group_live: 'group',
  profile: 'profile',
  call: 'call',
};

function PageBody({ page, path, token }: { page: SharePage; path: string; token: string }) {
  // Slice E: a click opens the inline sign-in sheet and lands on `deep`;
  // the href keeps the `/register?next=` form for crawlers and no-JS.
  const deep = deepLink(page, path, token);
  const next = gate(deep);
  const word = GATE_WORD[page.type];
  switch (page.type) {
    case 'post':
      return (
        <>
          <article className={cm.shareCard}>
          <AuthorChip chip={page.author} label={fmt(page.created_at)} />
          {page.body ? <p className={cm.shareBody}>{page.body}</p> : null}
          <MediaGrid media={page.media} />
          {page.poll ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p className={cm.shareBody} style={{ fontWeight: 600 }}>
                📊 {page.poll.question}
              </p>
              {page.poll.options.map((opt, i) => {
                const count = page.poll!.counts[i] ?? 0;
                const total = page.poll!.counts.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={i} className={cm.sharePollOpt}>
                    <span className={cm.sharePollBar} style={{ width: `${pct}%` }} aria-hidden />
                    <span className={cm.sharePollLabel}>
                      <span>{opt}</span>
                      <span>{count}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {page.location_label ? (
            <div className={cm.shareMetaRow}>
              <span>📍 {page.location_label}</span>
            </div>
          ) : null}
          {/* §1b teaser: ONE gated CTA replaces the React/Reply row and the
              invite aside below — the template's contract, not three doors. */}
          {page.preview === 'teaser' ? <TeaserGate deep={deep} next={next} word="post" /> : null}
          {/* proto 07: React / Reply read like the real post row — every tap
              still lands on the same /register?next= gate. */}
          {page.preview !== 'teaser' ? (
          <div className={cm.shareActions}>
            <GateCta next={deep} fallback={next} word={word} className={cm.shareAct}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 19.5 C7.2 15.9 4.3 13 4.3 9.9 a4.1 4.1 0 0 1 7.1 -2.8 L12 7.8 l0.6 -0.7 a4.1 4.1 0 0 1 7.1 2.8 c0 3.1 -2.9 6 -7.7 9.6 Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
              React
            </GateCta>
            <GateCta next={deep} fallback={next} word={word} className={cm.shareAct}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 4.5 c4.9 0 8.2 2.8 8.2 6.5 c0 3.7 -3.3 6.5 -8.2 6.5 c-0.9 0 -1.8 -0.1 -2.6 -0.3 L5.5 19 l1 -3.2 c-1.7 -1.2 -2.7 -3 -2.7 -4.8 C3.8 7.3 7.1 4.5 12 4.5 Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
              Reply
            </GateCta>
            <span className={cm.shareActNote}>sign in to interact</span>
          </div>
          ) : null}
          </article>
          {/* proto 07: the invite-framed join card under the post. */}
          {page.preview !== 'teaser' ? (
          <aside className={cm.shareWorld}>
            <h2 className={cm.shareWorldTitle}>See the rest of {page.author.display_name}&rsquo;s world</h2>
            <p className={cm.shareWorldSub}>This link is your way in — joining takes a minute, and it&rsquo;s free.</p>
            <GateCta next={deep} fallback={next} word={word} className={`btn btn-primary ${cm.shareWorldCta}`}>
              Join Bored Chat
            </GateCta>
          </aside>
          ) : null}
        </>
      );
    case 'beacon': {
      const live = page.status === 'open';
      return (
        <article className={cm.shareCard}>
          <AuthorChip chip={page.creator} label="lit a beacon" />
          <p className={cm.shareBody} style={{ fontSize: 18, fontWeight: 700 }}>
            {page.vibe === 'custom' && page.custom_vibe_emoji ? page.custom_vibe_emoji : VIBE_EMOJI[page.vibe] ?? '🔥'}{' '}
            {page.vibe === 'custom' && page.custom_vibe_label ? page.custom_vibe_label : page.vibe}
            {page.note ? ` — ${page.note}` : ''}
          </p>
          <div className={cm.shareMetaRow}>
            <span>
              {live
                ? page.needs > 0
                  ? `needs ${page.needs} more and it's a plan 🔥`
                  : 'about to spark'
                : page.status === 'sparked'
                  ? 'it sparked 🎉'
                  : page.status === 'cancelled'
                    ? 'called off'
                    : 'wrapped up'}
            </span>
            <span>starts {fmt(page.starts_at)}</span>
            {page.location_label ? (
              <span>📍 {page.location_label}</span>
            ) : page.area ? (
              <span>📍 around {page.area}</span>
            ) : null}
          </div>
          <div className={cm.shareGate}>
            <GateCta next={deep} fallback={next} word={word} className="btn btn-primary">
              {live
                ? page.preview === 'teaser'
                  ? 'Join to see where and who — sign up free'
                  : 'Join this plan — sign up free'
                : 'See what else is on — join free'}
            </GateCta>
          </div>
        </article>
      );
    }
    case 'listing':
      return (
        <article className={cm.shareCard}>
          <AuthorChip chip={page.author} label={fmt(page.created_at)} />
          <p className={cm.shareBody} style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {page.title}
          </p>
          {page.body ? <p className={cm.shareBody}>{page.body}</p> : null}
          <MediaGrid media={page.media} />
          <div className={cm.shareMetaRow}>
            <span>📍 {page.area}</span>
            {page.price_text ? <span>{page.price_text}</span> : null}
            {page.location_label ? <span>🗺 {page.location_label}</span> : null}
            <span>{page.status === 'active' ? 'still up' : page.status}</span>
          </div>
          {/* FEATURES #45: the bulletin-board terms ride every gig/ride/room
              card where the money talk happens — strangers included (§1b). */}
          {(LISTING_SAFETY_NOTE_KINDS as readonly string[]).includes(page.kind) ? (
            <p className={cm.shareMetaRow} role="note" style={{ margin: 0 }}>
              {LISTING_SAFETY_NOTE}
            </p>
          ) : null}
          <div className={cm.shareGate}>
            <GateCta next={deep} fallback={next} word={word} className="btn btn-primary">
              {page.preview === 'teaser'
                ? 'Join to see the details and message the poster — free'
                : 'Message the poster — join free'}
            </GateCta>
          </div>
        </article>
      );
    case 'story':
      return (
        <article className={cm.shareCard}>
          <AuthorChip chip={page.author} label={`story · gone ${fmt(page.expires_at)}`} />
          <div className={`${cm.shareStoryFrame} ${cm.shareStoryMedia}`}>
            {page.media.kind === 'video' ? (
              <video src={page.media.url} poster={page.media.thumb_url ?? undefined} controls playsInline preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={page.media.url} alt={page.caption || 'Story'} />
            )}
            {/* §1.66 overlays render read-only with public attribution. */}
            {page.overlays.length > 0 ? (
              <div className={cm.overlayLayer} aria-hidden>
                <svg viewBox="0 0 512 512" preserveAspectRatio="none">
                  {page.overlays.map((o, i) =>
                    o.payload.kind === 'stroke' ? (
                      <path
                        key={i}
                        d={o.payload.points
                          .map((p, j) => `${j === 0 ? 'M' : 'L'}${(p.x * 512).toFixed(1)} ${(p.y * 512).toFixed(1)}`)
                          .join(' ')}
                        stroke={o.payload.color}
                        strokeWidth={o.payload.width}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null
                  )}
                </svg>
                {page.overlays.map((o, i) =>
                  o.payload.kind === 'emoji' ? (
                    <span
                      key={i}
                      className={cm.overlayEmoji}
                      style={{ left: `${o.payload.x * 100}%`, top: `${o.payload.y * 100}%`, fontSize: `${Math.round(34 * o.payload.scale)}px`, pointerEvents: 'none' }}
                    >
                      {o.payload.emoji}
                    </span>
                  ) : o.payload.kind === 'text' ? (
                    <span
                      key={i}
                      className={cm.overlayText}
                      style={{ left: `${o.payload.x * 100}%`, top: `${o.payload.y * 100}%`, pointerEvents: 'none' }}
                    >
                      {o.payload.text}
                    </span>
                  ) : null
                )}
              </div>
            ) : null}
          </div>
          {page.caption ? <p className={cm.shareBody}>{page.caption}</p> : null}
          {page.overlays.length > 0 ? (
            <p className={cm.shareMetaRow} style={{ margin: 0 }}>
              🎨 drawn on by {[...new Set(page.overlays.map((o) => `@${o.author_username}`))].join(', ')}
            </p>
          ) : null}
          <div className={cm.shareGate}>
            <GateCta next={deep} fallback={next} word={word} className="btn btn-primary">
              Draw back — join free
            </GateCta>
          </div>
        </article>
      );
    case 'profile':
      // Phase 6: the same hero the logged-out /u/<username> route renders.
      return <ProfileHeroCard hero={page} />;
    case 'call':
      // Phase 5: who invites you, what kind, how many are in — never who.
      return (
        <article className={cm.shareCard}>
          <AuthorChip chip={page.inviter} label="invites you" />
          <h1 className={cm.shareWorldTitle} style={{ margin: '6px 0 0' }}>
            {page.kind === 'video' ? '📹 Video call' : '📞 Voice call'} · {page.title}
          </h1>
          <p className={cm.shareBody} style={{ margin: 0 }}>
            {page.member_count === 0
              ? 'Nobody is in yet.'
              : `${page.member_count} ${page.member_count === 1 ? 'person is' : 'people are'} in right now.`}{' '}
            Joining adds you to the group, then drops you straight into the call.
          </p>
          <div className={cm.shareGate}>
            <CallJoinCta token={token} kind={page.kind} full={page.full} next={deep} fallback={next} />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            The link stops working when the call ends.
          </p>
        </article>
      );
    case 'group_card':
      return (
        <article className={cm.shareCard}>
          <div className={cm.shareAuthor}>
            {page.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={cm.shareAvatar} src={page.avatar_url} alt="" width={42} height={42} />
            ) : (
              <span className={cm.shareAvatarFallback} aria-hidden>
                {page.title.trim() ? page.title.trim()[0].toUpperCase() : '?'}
              </span>
            )}
            <span className={cm.shareAuthorText}>
              <strong>{page.title}</strong>
              {/* member_count is join-decision utility (ADR-020) — it never
                  appears on any in-app surface. */}
              <span>group · {page.member_count} members</span>
            </span>
          </div>
          {page.description ? <p className={cm.shareBody}>{page.description}</p> : null}
          <p className="muted small" style={{ margin: 0 }}>
            Invite-only: messages stay between members. Ask to join and an admin decides.
          </p>
          {/* Phase 2: signed-in visitors ask / withdraw / open right here. */}
          <GroupJoinCta
            conversationId={page.id}
            kind="invite_only"
            next={deep}
            fallback={next}
            signedOutLabel="Ask to join — sign up free"
          />
        </article>
      );
    case 'group_live':
      return (
        <article className={cm.shareCard}>
          <div className={cm.shareAuthor}>
            {page.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={cm.shareAvatar} src={page.avatar_url} alt="" width={42} height={42} />
            ) : (
              <span className={cm.shareAvatarFallback} aria-hidden>
                {page.title.trim() ? page.title.trim()[0].toUpperCase() : '?'}
              </span>
            )}
            <span className={cm.shareAuthorText}>
              <strong>{page.title}</strong>
              <span>public group · {page.member_count} members · read-only here</span>
            </span>
          </div>
          {page.description ? <p className={cm.shareBody}>{page.description}</p> : null}
          <div>
            {page.next_cursor ? (
              <Link className="btn" href={`${path}?cursor=${encodeURIComponent(page.next_cursor)}`} style={{ marginBottom: 8 }}>
                ← Older messages
              </Link>
            ) : null}
            {page.messages.length === 0 ? (
              <p className="muted small">Nothing public yet — only messages sent after the group went public show here.</p>
            ) : (
              page.messages.map((m) => (
                <div key={m.seq} className={cm.shareMsg}>
                  {m.sender?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={cm.shareAvatar} style={{ width: 30, height: 30 }} src={m.sender.avatar_url} alt="" width={30} height={30} />
                  ) : (
                    <span className={cm.shareAvatarFallback} style={{ width: 30, height: 30, fontSize: 13 }} aria-hidden>
                      {m.sender ? m.sender.display_name.trim()[0]?.toUpperCase() ?? '?' : '?'}
                    </span>
                  )}
                  <span className={cm.shareMsgBody}>
                    <strong>{m.sender ? m.sender.display_name : 'deleted account'}</strong>
                    {m.body ? <p>{m.body}</p> : null}
                    {m.media.length > 0 ? <MediaGrid media={m.media} /> : null}
                  </span>
                  <span className={cm.shareMsgTime}>{fmt(m.created_at)}</span>
                </div>
              ))
            )}
          </div>
          <GroupJoinCta
            conversationId={page.id}
            kind="public"
            next={deep}
            fallback={next}
            signedOutLabel="Reply in the group — join free"
          />
        </article>
      );
  }
}
