// Story share page (v0.8b — API.md §1.67): /s/<token> — stories get their
// own prefix because their links are author-minted, revocable and die with
// the story. Same machinery as /p/<token>; the server decides what the token
// points at and every dead cause 404s identically.
import type { Metadata } from 'next';
import { ShareRoute, sharePageMetadata } from '@/components/SharePageRoute';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ cursor?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return sharePageMetadata(token, `/s/${token}`);
}

export default async function StorySharePage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { cursor } = await searchParams;
  return <ShareRoute token={token} path={`/s/${token}`} cursor={cursor} />;
}
