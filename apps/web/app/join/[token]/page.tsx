// Public invite landing page (v0.2 — API.md §1.11, ARCHITECTURE §9).
// Server component: looks the token up through the UNAUTHENTICATED public
// endpoint via API_ORIGIN (same server-side hop app/share/route.ts uses) and
// exports OG metadata so a pasted link unfurls with the inviter's face —
// og:image is the token-gated avatar proxy's STATIC variant (what unfurlers
// reliably render); the page itself shows the animated one.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { INVITE_TOKEN_REGEX, InvitePublicResponseSchema, type InvitePublic } from '@socialchat/shared';
import JoinClient from './JoinClient';

export const dynamic = 'force-dynamic';

async function fetchInvite(token: string): Promise<InvitePublic | null> {
  if (!INVITE_TOKEN_REGEX.test(token)) return null;
  const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001';
  // The public endpoint rate-limits by req.ip (60/h, invites/routes.ts). This
  // hop runs inside the web container, so WITHOUT forwarding the visitor's IP
  // every SSR render worldwide would share one bucket keyed on the container's
  // address — 60 join-page views/hour would 429 ALL invite links. Fastify runs
  // trustProxy:true, so re-sending the X-Forwarded-For chain Caddy gave us
  // attributes the request to the real client. No XFF (bare dev hit) → omit.
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  try {
    const res = await fetch(`${apiOrigin}/api/invites/${encodeURIComponent(token)}/public`, {
      cache: 'no-store',
      ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
    });
    if (!res.ok) return null;
    const parsed = InvitePublicResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.invite : null;
  } catch {
    return null;
  }
}

/** Public origin for absolute OG URLs. PUBLIC_ORIGIN env wins when set —
 * required behind tunnels (cloudflared/ngrok rewrite Host to the local
 * origin, so headers can't recover the public name). Otherwise derive from
 * the forwarded headers Caddy sends. */
async function publicOrigin(): Promise<string> {
  const fixed = process.env.PUBLIC_ORIGIN;
  if (fixed) return fixed.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

interface JoinPageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: JoinPageProps): Promise<Metadata> {
  const { token } = await params;
  const invite = await fetchInvite(token);
  if (!invite || invite.status !== 'valid') {
    return {
      title: 'Join Bored Chat',
      description: 'Chat for when the group chat is dead.',
    };
  }
  const name = invite.inviter.display_name;
  const title = `${name} invited you to Bored Chat`;
  const description =
    invite.kind === 'group' && invite.group_title
      ? `Jump into “${invite.group_title}” on Bored Chat — it takes a minute and it's free.`
      : `Jump into a chat with ${name} on Bored Chat — it takes a minute and it's free.`;
  // InvitePublic avatar URLs already point at /api/invites/<token>/avatar
  // (?v=static&ver=…) and are null unless the invite is valid AND the avatar
  // is ready — so prefixing the public origin is all the unfurler needs.
  const origin = await publicOrigin();
  const image = invite.inviter.avatar.static_url
    ? `${origin}${invite.inviter.avatar.static_url}`
    : undefined;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: 'Bored Chat',
      type: 'website',
      url: `${origin}/join/${token}`,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

// v2 Royal (proto 31): the share-link page is its own deep-bg stranger view —
// header, centered card, locked grid — no longer the AuthScene mood stage.
export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params;
  const invite = await fetchInvite(token);
  return <JoinClient token={token} invite={invite} />;
}
