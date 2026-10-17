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
import DiscoverySection from '@/components/DiscoverySection';
import { RescueButton } from '@/components/RescueSheet';
import TabPage from '@/components/TabPage';

function LocalContent() {
  const router = useRouter();
  const params = useSearchParams();
  const deepLink = params.get('l');

  return (
    <div className="page">
      <header className="topbar">
        <h1>Local</h1>
        {/* v0.6 §1.46 (fixer r1): one-tap SOS on the boredom tab itself. */}
        <RescueButton />
      </header>
      <KudosBanner />
      <BeaconStrip />
      {/* v0.6 Bored Together (§1.44/§1.45): opt-in discovery + roulette — a
          moment, not a setting; strangers only, never your friends. */}
      <DiscoverySection />
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
