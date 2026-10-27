'use client';

// /local/b/<beaconId> (§1b deep-link back, 2026-10-27): the Local tab with
// that plan's sheet open — where a plan share page lands a sign-up. A plan
// the viewer cannot see resolves from the strip's store as "not available"
// (the §1.14 shape: nothing to confirm).
import { Suspense } from 'react';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import LocalTab from '@/components/LocalTab';
import TabPage from '@/components/TabPage';

function LocalBeacon() {
  const params = useParams<{ beaconId: string }>();
  const shareToken = useSearchParams().get('s'); // phase 3
  // Live only while the pathname still names the plan (see the listing
  // route for why a restored history entry must not re-open the sheet).
  const pathname = usePathname();
  const initial = pathname === `/local/b/${params.beaconId}` ? params.beaconId : null;
  return <LocalTab initialBeaconId={initial} shareToken={shareToken} />;
}

export default function LocalBeaconPage() {
  return (
    <TabPage active="local">
      <Suspense fallback={null}>
        <LocalBeacon />
      </Suspense>
    </TabPage>
  );
}
