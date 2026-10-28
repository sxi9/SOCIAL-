// Phase 5 (AUDIT-PLAN §1b): the call room link — /call/<token>. The same
// UNAUTHENTICATED SSR as /p/<token> (one live read through API_ORIGIN, XFF
// re-sent, noindex OG tags); the SharePage 'call' variant renders the card.
import type { Metadata } from 'next';
import { ShareRoute, sharePageMetadata } from '@/components/SharePageRoute';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return sharePageMetadata(token, `/call/${token}`);
}

export default async function CallLinkPage({ params }: PageProps) {
  const { token } = await params;
  return <ShareRoute token={token} path={`/call/${token}`} />;
}
