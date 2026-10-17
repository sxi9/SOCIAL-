'use client';

// The Local tab (v0.5b — FEATURES #43): the Plans tab, grown up. Live beacons
// keep the strip up top (they expire and push — the one interruption-shaped
// thing here); below them sits the pull-based board (§1.38) — gigs, rides,
// rooms and place reviews that wait quietly until you look.
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BoredButton } from '@/components/BeaconCreateSheet';
import BeaconStrip, { KudosBanner } from '@/components/BeaconStrip';
import BoardView from '@/components/BoardView';
import TabPage from '@/components/TabPage';

function LocalContent() {
  const router = useRouter();
  const params = useSearchParams();
  const deepLink = params.get('l');

  return (
    <div className="page">
      <header className="topbar">
        <h1>Local</h1>
      </header>
      <KudosBanner />
      <BeaconStrip />
      <BoardView
        initialListingId={deepLink}
        onDeepLinkDone={() => {
          if (deepLink) router.replace('/local');
        }}
      />
      {/* One tap from bored to beacon, same as ever (PSYCHOLOGY §1). */}
      <BoredButton />
    </div>
  );
}

export default function LocalPage() {
  return (
    <TabPage active="local">
      <Suspense fallback={null}>
        <LocalContent />
      </Suspense>
    </TabPage>
  );
}
