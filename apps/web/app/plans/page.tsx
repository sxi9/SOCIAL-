'use client';

// The Plans tab: the live beacon surface (v0.3) in its own home — kudos
// banner, beacon cards, boredom radar and the one big "I'm bored" button.
import { BoredButton } from '@/components/BeaconCreateSheet';
import BeaconStrip, { KudosBanner } from '@/components/BeaconStrip';
import TabPage from '@/components/TabPage';

export default function PlansPage() {
  return (
    <TabPage active="plans">
      <div className="page">
        <header className="topbar">
          <h1>Plans</h1>
        </header>
        <KudosBanner />
        <BeaconStrip />
        <p className="muted small" style={{ padding: '6px 16px', margin: 0 }}>
          Light a beacon when you&rsquo;re bored — friends tap in, and when enough do, it&rsquo;s a
          plan with its own group chat.
        </p>
        {/* The bored user never waits: one tap from here to vibe chips. */}
        <BoredButton />
      </div>
    </TabPage>
  );
}
