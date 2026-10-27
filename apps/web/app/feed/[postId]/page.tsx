'use client';

// /feed/<postId> (§1b deep-link back, 2026-10-27): the Feed tab with that
// one post open in its sheet — where a share page's "sign up / sign in"
// lands, instead of the bare tab. On close the URL is stripped with the
// native history API (Next keeps usePathname in sync), NOT router.replace:
// a route change would unmount this page and remount the whole tab (lanes,
// layout, board) just to close a sheet. The auth gate keeps the full path
// on its round-trip because it is a path, not a query string.
import { Suspense } from 'react';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import FeedView from '@/components/FeedView';
import TabPage from '@/components/TabPage';

function FeedPost() {
  const params = useParams<{ postId: string }>();
  // Phase 3: the share token the visitor arrived with (`?s=`).
  const shareToken = useSearchParams().get('s');
  // Next keeps THIS route's tree on the history entry after the native
  // replaceState, so a later Back can remount this page with the old param
  // while the URL says /feed. The deep link is live only while the pathname
  // still names the post — a restored entry does not re-open the sheet.
  const pathname = usePathname();
  const initial = pathname === `/feed/${params.postId}` ? params.postId : null;
  return (
    <FeedView
      initialPostId={initial}
      shareToken={shareToken}
      onDeepLinkDone={() => window.history.replaceState(null, '', '/feed')}
    />
  );
}

export default function FeedPostPage() {
  return (
    <TabPage active="feed">
      <Suspense fallback={null}>
        <FeedPost />
      </Suspense>
    </TabPage>
  );
}
