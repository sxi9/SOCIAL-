'use client';

// The Local tab (v0.5b — FEATURES #43). The tab body lives in
// components/LocalTab; this page keeps the ?l=<listingId> query form the
// in-chat context pills use (and ?b=<beaconId> alongside it). The object
// routes /local/<id> and /local/b/<id> are the §1b deep-link-back form.
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import LocalTab from '@/components/LocalTab';
import TabPage from '@/components/TabPage';

function LocalFromQuery() {
  const params = useSearchParams();
  return <LocalTab initialListingId={params.get('l')} initialBeaconId={params.get('b')} />;
}

export default function LocalPage() {
  return (
    <TabPage active="local">
      <Suspense fallback={null}>
        <LocalFromQuery />
      </Suspense>
    </TabPage>
  );
}
