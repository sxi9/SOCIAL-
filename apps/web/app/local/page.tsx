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
import { useAppState } from '@/lib/useStore';
import dsc from '@/components/discovery.module.css';

function LocalContent() {
  const router = useRouter();
  const params = useSearchParams();
  const state = useAppState();
  const deepLink = params.get('l');
  const area = state.me?.area ?? null;

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 (ref 10): serif title + the muted area line; SOS is the
            one text action (the header search icon is Wave B — omitted). */}
        <h1>
          Local
          {area ? <span className={dsc.localSub}>{area}</span> : null}
        </h1>
        {/* v0.6 §1.46 (fixer r1): one-tap SOS on the boredom tab itself.
            Royal: the wrapper re-tones the trigger (13px/600, danger). */}
        <span className={dsc.sosTrigger}>
          <RescueButton />
        </span>
      </header>
      <KudosBanner />
      <BeaconStrip />
      {/* Royal v2 (ref 10): the dashed "+ I'm bored" pill sits right under
          the live beacon card — still one tap from bored to beacon. */}
      <BoredButton />
      {/* v0.6 Bored Together (§1.44/§1.45): opt-in discovery + roulette — a
          moment, not a setting; strangers only, never your friends. */}
      <DiscoverySection />
      <BoardView
        initialListingId={deepLink}
        onDeepLinkDone={() => {
          if (deepLink) router.replace('/local');
        }}
      />
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
