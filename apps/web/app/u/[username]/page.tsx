// /u/<username> (AUDIT-PLAN §1b phase 6, 2026-10-28). SERVER wrapper that
// picks one of two faces by the presence of the `sid` cookie:
//   • no session → the logged-out HERO (lib/ssr fetchProfileHero through
//     API_ORIGIN, XFF re-sent) with full OG tags, honouring the owner's
//     profile_visibility, and the Message / Call doors behind inline
//     sign-in — the "text me / call me" link;
//   • a session → the signed-in profile page (PublicProfileClient, inside
//     AppShell), which reads ?msg=1 / ?call=1 and opens the DM.
// A stale cookie still lands on the client page, whose AppShell bounces to
// /login?next= — nothing is decided from the cookie's VALUE here.
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import GateCta from '@/components/GateCta';
import ProfileHeroCard from '@/components/ProfileHeroCard';
import { profileDescribe } from '@/components/SharePageRoute';
import ShareHeaderPill from '@/components/ShareHeaderPill';
import cm from '@/components/community.module.css';
import { fetchProfileHero, publicOrigin } from '@/lib/ssr';
import PublicProfileClient from './PublicProfileClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ username: string }>;
}

async function signedIn(): Promise<boolean> {
  const jar = await cookies();
  return Boolean(jar.get('sid')?.value);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  // The signed-in page is app chrome: the root template titles it.
  if (await signedIn()) return { title: `@${username}` };
  const hero = await fetchProfileHero(username);
  const origin = await publicOrigin();
  // /u/ is a public page of record (unlike a token page) — indexable when
  // the person is visible; the one 404 state is not.
  if (!hero) {
    return { title: { absolute: 'Bored Chat' }, description: 'Chat for when the group chat is dead.', robots: { index: false, follow: false } };
  }
  const d = profileDescribe(hero);
  const image = d.image ? `${origin}${d.image}` : undefined;
  const path = `/u/${encodeURIComponent(username)}`;
  return {
    title: { absolute: d.title },
    description: d.description,
    // A reduced hero (connections / private) unfurls but is never indexed.
    ...(hero.visibility === 'minimal' ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title: d.title,
      description: d.description,
      siteName: 'Bored Chat',
      type: 'profile',
      url: `${origin}${path}`,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: 'summary',
      title: d.title,
      description: d.description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function ProfileRoute({ params }: PageProps) {
  const { username } = await params;
  if (await signedIn()) {
    return (
      // useSearchParams (the ?msg / ?call doors) needs a Suspense boundary.
      <Suspense fallback={null}>
        <PublicProfileClient username={username} />
      </Suspense>
    );
  }
  const hero = await fetchProfileHero(username);
  const path = `/u/${encodeURIComponent(username)}`;
  return (
    <main className={cm.sharePage}>
      <header className={cm.shareHead}>
        <Link href="/" className={cm.shareBrand}>
          bored.
        </Link>
        <span className={cm.shareHeadMeta}>profile, logged out</span>
        <ShareHeaderPill path={path} className={`btn btn-primary ${cm.shareJoin}`} />
      </header>
      {hero ? (
        <ProfileHeroCard hero={hero} />
      ) : (
        // Unknown ≡ banned ≡ malformed: one honest state. Signing in still
        // lands here — a blocked pair's own 404 then takes over in-app.
        <div className={cm.shareCard} style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 34, margin: 0 }} aria-hidden>
            🫧
          </p>
          <p className={cm.shareBody}>Nobody by that name here.</p>
          <div className={cm.shareGate} style={{ justifyContent: 'center' }}>
            <GateCta next={path} fallback={`/register?next=${encodeURIComponent(path)}`} word="account" className="btn btn-primary">
              Sign in to look again
            </GateCta>
          </div>
        </div>
      )}
      <p className={cm.shareFootnote}>
        Shared from a self-hosted Bored Chat. Viewing is free; joining takes a minute.
      </p>
    </main>
  );
}
