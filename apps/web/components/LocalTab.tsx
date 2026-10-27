'use client';

// The Local tab's body (v0.5b — FEATURES #43): live beacons up top (they
// expire and push — the one interruption-shaped thing here); below them the
// pull-based board (§1.38). Extracted from app/local/page.tsx so the
// object routes /local/<listingId> and /local/b/<beaconId> (§1b deep-link
// back) render the SAME tab with the object open, and /local itself keeps
// its ?l= query form for the in-chat context pills.
import { BoredButton } from '@/components/BeaconCreateSheet';
import BeaconStrip, { KudosBanner } from '@/components/BeaconStrip';
import BoardView from '@/components/BoardView';
import DiscoverySection from '@/components/DiscoverySection';
import { RescueButton } from '@/components/RescueSheet';
import { useAppState } from '@/lib/useStore';
import dsc from '@/components/discovery.module.css';

export default function LocalTab({
  initialListingId = null,
  initialBeaconId = null,
  shareToken = null,
}: {
  initialListingId?: string | null;
  initialBeaconId?: string | null;
  /** Phase 3: the share token a deep link arrived with (`?s=`). */
  shareToken?: string | null;
}) {
  const state = useAppState();
  const area = state.me?.area ?? null;
  // Strip the deep link with the native history API, not router.replace: a
  // route change from /local/<id> to /local would unmount this page and
  // remount the whole tab just to close a sheet. Each sheet keeps its own
  // open state, so the other one (if ?l= and ?b= were both set) survives.
  const done = () => {
    if (initialListingId || initialBeaconId) window.history.replaceState(null, '', '/local');
  };

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
      <BeaconStrip initialBeaconId={initialBeaconId} shareToken={shareToken} onDeepLinkDone={done} />
      {/* Royal v2 (ref 10): the dashed "+ I'm bored" pill sits right under
          the live beacon card — still one tap from bored to beacon. */}
      <BoredButton />
      {/* v0.6 Bored Together (§1.44/§1.45): opt-in discovery + roulette — a
          moment, not a setting; strangers only, never your friends. */}
      <DiscoverySection />
      <BoardView initialListingId={initialListingId} shareToken={shareToken} onDeepLinkDone={done} />
    </div>
  );
}
