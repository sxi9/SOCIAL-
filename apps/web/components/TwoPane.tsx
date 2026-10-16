'use client';

// Shared shell for `/` and `/c/:id` (WhatsApp-Web style). Mobile behavior is
// unchanged — the list page shows the list, the chat page the chat — while
// from 900px up the list becomes a persistent 360px sidebar with the open
// conversation filling the rest (globals.css `.split*`).
import type { ReactNode } from 'react';
import AppShell from './AppShell';
import ConversationListView from './ConversationListView';
import { InviteButton } from './InviteSheet';

export default function TwoPane({
  activeId = null,
  children,
}: {
  activeId?: string | null;
  children?: ReactNode;
}) {
  return (
    <AppShell>
      <div className={`split${activeId ? ' split-has-active' : ''}`}>
        <aside className="split-side">
          <ConversationListView activeId={activeId} />
        </aside>
        <main className="split-main">{children ?? <IdlePane />}</main>
      </div>
    </AppShell>
  );
}

/** Desktop-only placeholder while no conversation is open. */
function IdlePane() {
  return (
    <div className="idle-pane">
      <svg width="88" height="88" viewBox="0 0 88 88" fill="none" aria-hidden>
        <path
          d="M44 12 c18 0 30 11 30 26 c0 15 -12 26 -30 26 c-3.2 0 -6.3 -0.4 -9.2 -1.1 L20 70 l3.6 -12.3 C17.2 53.4 14 46.7 14 38 C14 23 26 12 44 12 Z"
          stroke="var(--accent)"
          strokeWidth="2.6"
          strokeLinejoin="round"
          opacity="0.5"
        />
        <circle cx="34" cy="38" r="2.8" fill="var(--accent)" opacity="0.5" />
        <circle cx="44" cy="38" r="2.8" fill="var(--accent)" opacity="0.5" />
        <circle cx="54" cy="38" r="2.8" fill="var(--accent)" opacity="0.5" />
      </svg>
      <h2>It&rsquo;s quiet in here… too quiet.</h2>
      <p>Pick a conversation on the left — or drag someone new into the boredom.</p>
      <InviteButton className="btn btn-primary" label="Invite a friend" />
    </div>
  );
}
