'use client';

// /local/<listingId> (§1b deep-link back, 2026-10-27): the Local tab with
// that listing's sheet open — where a listing share page lands a sign-up.
import { Suspense } from 'react';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import LocalTab from '@/components/LocalTab';
import TabPage from '@/components/TabPage';

function LocalListing() {
  const params = useParams<{ listingId: string }>();
  const shareToken = useSearchParams().get('s'); // phase 3
  // Live only while the pathname still names the listing (a history entry
  // restored after the close's replaceState carries this route's tree but
  // the /local URL — it must not re-open the sheet).
  const pathname = usePathname();
  const initial = pathname === `/local/${params.listingId}` ? params.listingId : null;
  return <LocalTab initialListingId={initial} shareToken={shareToken} />;
}

export default function LocalListingPage() {
  return (
    <TabPage active="local">
      <Suspense fallback={null}>
        <LocalListing />
      </Suspense>
    </TabPage>
  );
}
