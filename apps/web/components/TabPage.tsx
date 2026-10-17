'use client';

// Shell for the non-chat tabs (Plans / Feed / Profile / Connections): the same
// Tabs bar TwoPane renders, around a single scrolling pane.
import type { ReactNode } from 'react';
import AppShell from './AppShell';
import Tabs, { type TabKey } from './Tabs';

export default function TabPage({ active, children }: { active: TabKey; children: ReactNode }) {
  return (
    <AppShell>
      <div className="shell">
        <main className="shell-main">{children}</main>
        <Tabs active={active} />
      </div>
    </AppShell>
  );
}
