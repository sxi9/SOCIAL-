// Public share page (v0.8b — API.md §1.67, FEATURES #79c). UNAUTHENTICATED
// SSR, like /join/<token>: one live read through API_ORIGIN (XFF re-sent),
// full OG/twitter tags with PUBLIC_ORIGIN-absolute URLs.
import type { Metadata } from 'next';
import { ShareRoute, sharePageMetadata } from '@/components/SharePageRoute';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ cursor?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return sharePageMetadata(token, `/p/${token}`);
}

export default async function PublicSharePage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { cursor } = await searchParams;
  return <ShareRoute token={token} path={`/p/${token}`} cursor={cursor} />;
}
