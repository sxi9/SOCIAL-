'use client';

// /local/<listingId> (§1b deep-link back, 2026-10-27): the Local tab with
// that listing's sheet open — where a listing share page lands a sign-up.
import { useParams, usePathname } from 'next/navigation';
import LocalTab from '@/components/LocalTab';
import TabPage from '@/components/TabPage';

export default function LocalListingPage() {
  const params = useParams<{ listingId: string }>();
  // Live only while the pathname still names the listing (a history entry
  // restored after the close's replaceState carries this route's tree but
  // the /local URL — it must not re-open the sheet).
  const pathname = usePathname();
  const initial = pathname === `/local/${params.listingId}` ? params.listingId : null;
  return (
    <TabPage active="local">
      <LocalTab initialListingId={initial} />
    </TabPage>
  );
}
