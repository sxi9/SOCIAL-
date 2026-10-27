// Shared SSR plumbing for the public share routes /p/<token> and /s/<token>
// (v0.8b — API.md §1.67). Server-module only (lib/ssr uses next/headers).
import type { Metadata } from 'next';
import Link from 'next/link';
import type { SharePage } from '@socialchat/shared';
import SharePageView from './SharePageView';
import { fetchSharePage, publicOrigin } from '@/lib/ssr';
import cm from './community.module.css';

function describe(page: SharePage): { title: string; description: string; image: string | null } {
  switch (page.type) {
    case 'post':
      return {
        title: `${page.author.display_name} on Bored Chat`,
        description: page.body.slice(0, 160) || 'A public post on Bored Chat.',
        image: page.media[0]?.thumb_url ?? page.media[0]?.url ?? page.author.avatar_url,
      };
    case 'beacon':
      return {
        title: `${page.creator.display_name} lit a beacon 🔥`,
        description: page.note || 'Someone is up for something — join in on Bored Chat.',
        image: page.creator.avatar_url,
      };
    case 'listing':
      return {
        title: page.title,
        description: page.body.slice(0, 160) || `On the local board in ${page.area}.`,
        image: page.media[0]?.thumb_url ?? page.media[0]?.url ?? page.author.avatar_url,
      };
    case 'story':
      return {
        title: `${page.author.display_name}'s story`,
        description: page.caption || 'A 24-hour story on Bored Chat.',
        image: page.media.thumb_url ?? page.media.url,
      };
    case 'group_card':
      return {
        title: `${page.title} — a group on Bored Chat`,
        description: page.description || `${page.member_count} members. Ask to join.`,
        image: page.avatar_url,
      };
    case 'group_live':
      return {
        title: `${page.title} — a public group on Bored Chat`,
        description: page.description || `${page.member_count} members, readable live.`,
        image: page.avatar_url,
      };
  }
}

/** OG/twitter tags — absolute via PUBLIC_ORIGIN; og:image is the token-gated
 * proxy path (unfurlers get exactly what any stranger gets; §1.67 binding). */
export async function sharePageMetadata(token: string, path: string): Promise<Metadata> {
  const page = await fetchSharePage(token);
  const origin = await publicOrigin();
  // §1b: token pages are never indexed — a capability URL is not a public
  // page of record, and revoking one must not leave a search-engine copy.
  const robots = { index: false, follow: false } as const;
  if (!page) {
    return { title: { absolute: 'Bored Chat' }, description: 'Chat for when the group chat is dead.', robots };
  }
  const d = describe(page);
  const image = d.image ? `${origin}${d.image}` : undefined;
  return {
    // absolute: the describe() strings already name Bored Chat — the root
    // layout's "%s · Bored Chat" template would double it.
    title: { absolute: d.title },
    description: d.description,
    robots,
    openGraph: {
      title: d.title,
      description: d.description,
      siteName: 'Bored Chat',
      type: 'website',
      url: `${origin}${path}`,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title: d.title,
      description: d.description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export async function ShareRoute({
  token,
  path,
  cursor,
}: {
  token: string;
  path: string;
  cursor?: string;
}) {
  const page = await fetchSharePage(token, cursor);
  if (!page) {
    // 404s are byte-identical server-side (unknown / revoked / gone /
    // no-longer-public) — ONE honest empty state, no oracle.
    return (
      <main className={cm.sharePage}>
        <header className={cm.shareHead}>
          <Link href="/" className={cm.shareBrand}>
            bored.
          </Link>
        </header>
        <div className={cm.shareCard} style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 34, margin: 0 }} aria-hidden>
            🫧
          </p>
          <p className={cm.shareBody}>
            Nothing here. The link may have been revoked, or the thing it pointed at is gone.
          </p>
          <Link href="/register" className="btn btn-primary">
            Join Bored Chat instead
          </Link>
        </div>
      </main>
    );
  }
  return <SharePageView page={page} token={token} path={path} />;
}
