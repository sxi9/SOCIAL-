'use client';

// The Profile tab (Royal v2, proto ref 11): your OWN profile, not a settings
// list any more. Centered silver-ring hero, serif name, "@user · mood",
// ritual lines drawn from your real recent activity (never numeric totals —
// PSYCHOLOGY design rule 3), the Edit-profile / Connections pills, the
// 3-photo strip, and the RECENTLY rows. Editing moved to /settings/account;
// the settings categories live behind the prefs-sliders icon → /settings.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  Activity,
  ActivityResponse,
  Attachment,
  FeedResponse,
  GalleryItem,
  GalleryResponse,
  Profile,
  ProfileResponse,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import { refreshMyMood } from '@/lib/mood';
import { useAppState } from '@/lib/useStore';
import { useReducedMotion } from '@/lib/useReducedMotion';
import ActivityStrip from '@/components/ActivityStrip';
import Avatar from '@/components/Avatar';
import StyledName from '@/components/StyledName';
import TabPage from '@/components/TabPage';
import { RescueCard } from '@/components/RescueSheet';
import idm from '@/components/identity.module.css';
import pp from '@/components/profilepage.module.css';
import sm from '@/components/settings.module.css';
import st from '@/components/social.module.css';

/* Stroke icons — 24 viewBox, 1.7px, round caps (the Tabs.tsx family). */
const S = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function LinkIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M10.2 13.8 a3.6 3.6 0 0 0 5.1 0 l2.9 -2.9 a3.6 3.6 0 0 0 -5.1 -5.1 l-1.6 1.6" {...S} />
      <path d="M13.8 10.2 a3.6 3.6 0 0 0 -5.1 0 l-2.9 2.9 a3.6 3.6 0 0 0 5.1 5.1 l1.6 -1.6" {...S} />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M4.5 8 H19.5 M4.5 16 H19.5 M15.5 5.6 V10.4 M8.5 13.6 V18.4" {...S} />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M9.5 6 L15.5 12 L9.5 18" {...S} />
    </svg>
  );
}

/** One scrapbook line per recent activity — words only, no totals, no times. */
function ritualText(a: Activity): string {
  const s = a.summary;
  switch (s.type) {
    case 'beacon': {
      const vibe =
        s.vibe === 'custom' && s.custom_vibe_label ? s.custom_vibe_label : s.vibe;
      return a.kind === 'beacon_sparked' ? `sparked a plan · ${vibe}` : `lit a beacon · ${vibe}`;
    }
    case 'post':
      return s.excerpt ? `posted · ${s.excerpt}` : 'posted on the feed';
    case 'listing':
      return `listed ${s.title}`;
    case 'puzzle':
      return s.solved ? 'solved the daily puzzle' : 'took on the daily puzzle';
    case 'game':
      return s.opponent ? `won tic-tac-toe vs ${s.opponent.display_name}` : 'won tic-tac-toe';
  }
}

/* The POSTS / GALLERY / INTERESTS segments (proto 11). */
const SEGMENTS = [
  { key: 'posts', label: 'Posts' },
  { key: 'gallery', label: 'Gallery' },
  { key: 'interests', label: 'Interests' },
] as const;
type Segment = (typeof SEGMENTS)[number]['key'];

function OwnProfile() {
  const state = useAppState();
  const reduced = useReducedMotion();
  const me = state.me;

  // The 3-photo strip (§1.37 profile media) — read-only here; editing lives
  // in Settings → Account.
  const [profile, setProfile] = useState<Profile | null>(null);
  // Up to two ritual lines from my own recent activity (§1.59 — the same
  // per-viewer endpoint the RECENTLY strip uses).
  const [ritual, setRitual] = useState<Activity[]>([]);
  // Proto 11 segmented row. POSTS = photos off my own feed posts (first
  // friends-lane page, filtered to me — no counts, just the pictures);
  // GALLERY = the /gallery source (first page only); INTERESTS = my chips.
  const [seg, setSeg] = useState<Segment>('posts');
  const [postPics, setPostPics] = useState<Attachment[] | null>(null);
  const [galleryPics, setGalleryPics] = useState<GalleryItem[] | null>(null);

  const myId = me?.id ?? null;
  useEffect(() => {
    if (!myId) return;
    let cancelled = false;
    void api
      .get<FeedResponse>('/api/feed?lane=friends')
      .then((res) => {
        if (cancelled) return;
        setPostPics(
          res.posts
            .filter((p) => p.author.id === myId)
            .flatMap((p) => p.attachments.filter((a) => a.kind === 'image' || a.kind === 'video')),
        );
      })
      .catch(() => {
        if (!cancelled) setPostPics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [myId]);

  // Gallery loads lazily, the first time its segment opens (first page only).
  useEffect(() => {
    if (seg !== 'gallery' || galleryPics !== null) return;
    let cancelled = false;
    void api
      .get<GalleryResponse>('/api/users/me/gallery')
      .then((res) => {
        if (!cancelled) setGalleryPics(res.items);
      })
      .catch(() => {
        if (!cancelled) setGalleryPics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [seg, galleryPics]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<ProfileResponse>('/api/users/me/profile')
      .then((res) => {
        if (!cancelled) setProfile(res.profile);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!me?.username) return;
    let cancelled = false;
    void api
      .get<ActivityResponse>(`/api/users/${encodeURIComponent(me.username)}/activity`)
      .then((res) => {
        if (!cancelled) setRitual(res.activities.slice(0, 2));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [me?.username]);

  // Keep my own mood chip fresh (the hero line reads it from the store).
  useEffect(() => {
    void refreshMyMood().catch(() => undefined);
  }, []);

  if (!me) return null;

  const mood = me.mood ?? state.moodState?.mood ?? null;
  const motion = me.avatar_motion;
  const animateStrip = !reduced && motion === 'auto';

  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <h1 className={sm.tabTitle}>Profile</h1>
        <Link
          href={`/u/${encodeURIComponent(me.username)}`}
          className="btn btn-ghost btn-icon"
          aria-label="View your public profile"
        >
          <LinkIcon />
        </Link>
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Settings">
          <SlidersIcon />
        </Link>
      </header>

      <div className={pp.col}>
        {/* Hero: silver live ring, serif (styled) name, "@user · mood".
            sm.hero (not pp.hero): the public page's hero pulls the avatar up
            -51px into its cover band — under this tab's sticky header the
            full 96px ring must sit clear of it. */}
        <section className={sm.hero} aria-label="My profile">
          <div className={pp.avatarRing}>
            <div className={pp.avatarGap}>
              {/* Profile pages render the animated WebP (motion-gated, §5.4). */}
              <Avatar avatar={me.avatar} name={me.display_name} size={96} animated />
            </div>
          </div>
          <h2 className={pp.heroName}>
            <StyledName userId={me.id} style={me.name_style} name={me.display_name} />
          </h2>
          <p className={pp.handleLine}>
            <span>@{me.username}</span>
            {mood ? (
              <>
                <span aria-hidden>·</span>
                <span className={pp.moodWord}>
                  {mood.label} <span aria-hidden>{mood.emoji}</span>
                </span>
              </>
            ) : null}
          </p>
          {/* Scrapbook lines: real recent activity in words (never counters);
              the bio stands in when there is nothing recent. */}
          {ritual.length > 0 ? (
            <div className={sm.ritualLines}>
              {ritual.map((a, i) => (
                <span key={a.id} className={sm.ritualLine}>
                  <span
                    className={`${sm.ritualDot}${i === 1 ? ` ${sm.ritualDotAlt}` : ''}`}
                    aria-hidden
                  />
                  <span>{ritualText(a)}</span>
                </span>
              ))}
            </div>
          ) : me.bio ? (
            <div className={sm.ritualLines}>
              <span className={sm.ritualLine}>
                <span className={sm.ritualDot} aria-hidden />
                <span>{me.bio}</span>
              </span>
            </div>
          ) : null}
        </section>

        {/* Edit profile / Connections — the two outline pills (ref 11). */}
        <div className={sm.pillRow}>
          <Link href="/settings/account" className={pp.pillBtn}>
            Edit profile
          </Link>
          <Link href="/connections" className={pp.pillBtn}>
            Connections
          </Link>
        </div>

        {/* Proto 11: POSTS / GALLERY / INTERESTS segmented row + square grid.
            Pictures only — never a numeric count (PSYCHOLOGY rule 3). */}
        <div className={sm.tabbed}>
          <div className={sm.segRow} role="tablist" aria-label="Profile sections">
            {SEGMENTS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={seg === s.key}
                className={seg === s.key ? `${sm.segTab} ${sm.segTabActive}` : sm.segTab}
                onClick={() => setSeg(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {seg === 'posts' ? (
            <div key="posts" className={sm.tabPanel} role="tabpanel" aria-label="Posts">
              {postPics === null ? null : postPics.length === 0 ? (
                <p className={sm.tabEmpty}>Nothing posted yet</p>
              ) : (
                <div className={sm.mediaGrid}>
                  {postPics.map((a) => (
                    <span key={a.id} className={sm.mediaTile}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.thumb_url ?? a.url} alt="" loading="lazy" />
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : seg === 'gallery' ? (
            <div key="gallery" className={sm.tabPanel} role="tabpanel" aria-label="Gallery">
              {galleryPics === null ? null : galleryPics.length === 0 ? (
                <p className={sm.tabEmpty}>Nothing saved yet</p>
              ) : (
                <div className={sm.mediaGrid}>
                  {galleryPics.map((item) => (
                    <span key={item.attachment.id} className={sm.mediaTile}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.attachment.thumb_url ?? item.attachment.url}
                        alt=""
                        loading="lazy"
                      />
                    </span>
                  ))}
                </div>
              )}
              <Link href="/gallery" className={sm.moreRow}>
                My gallery <span aria-hidden>›</span>
              </Link>
            </div>
          ) : (
            <div key="interests" className={sm.tabPanel} role="tabpanel" aria-label="Interests">
              {profile === null ? null : profile.interests.length === 0 ? (
                <p className={sm.tabEmpty}>
                  No interests picked yet — <Link href="/settings/account">add some</Link>
                </p>
              ) : (
                <div className={sm.chipWrap}>
                  {profile.interests.map((tag) => (
                    <span key={tag} className={sm.chip}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* §1.37: the 3-photo strip — animation gated by my own settings. */}
        {profile && profile.media.length > 0 ? (
          <div className={st.gifStrip}>
            {profile.media.map((m) => (
              <span key={m.id} className={st.gifTile}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={animateStrip ? m.url : m.thumb_url ?? m.url} alt="" loading="lazy" />
              </span>
            ))}
          </div>
        ) : null}

        {/* RECENTLY — the §1.59 activity rows (server-resolved per viewer;
            the strip's own footnote covers Privacy → Activity). */}
        <div className={pp.flat}>
          <ActivityStrip username={me.username} isMe />
        </div>

        {/* Everything that left this page stays one tap away. */}
        <div className={pp.section}>
          <Link href="/gallery" className={idm.settingsRow}>
            <span className={idm.rowText}>
              My gallery
              <span className={idm.rowHint}>
                Everything you&rsquo;ve shared, plus auto-saved stories — only you see it.
              </span>
            </span>
            <span className={idm.rowChevron} aria-hidden>
              <ChevronRight />
            </span>
          </Link>
          <Link href="/things" className={idm.settingsRow}>
            <span className={idm.rowText}>
              Things you can do
              <span className={idm.rowHint}>
                Every feature on this server, one line each, with a Try-it link.
              </span>
            </span>
            <span className={idm.rowChevron} aria-hidden>
              <ChevronRight />
            </span>
          </Link>
        </div>

        {/* v0.6 §1.46: one tap pings up to 3 friends to call you out of a
            boring situation — the one push that cuts through mutes. */}
        <RescueCard />
      </div>
    </div>
  );
}

export default function ProfileTabPage() {
  return (
    <TabPage active="profile">
      <OwnProfile />
    </TabPage>
  );
}
