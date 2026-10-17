'use client';

// v0.5b tab shell: Chats / Local / Feed / Profile (the Plans tab absorbed the
// board and became Local — FEATURES #43). Bottom bar on mobile, slim left rail
// from 900px up (the two-pane chat shell stays intact). The bar hides on
// mobile while a chat is open (hideOnMobile).
import Link from 'next/link';
import { useAppState } from '@/lib/useStore';
import st from './social.module.css';

export type TabKey = 'chats' | 'local' | 'feed' | 'profile';

// `tour` = the v0.8a §1.61 spotlight-tour anchor (TOUR_STEPS[].anchor). The
// contract's 'tab-plans' step has no tab of its own since Plans became Local
// (FEATURES #43) — the tour shows that step as a plain card instead.
const TABS: { key: TabKey; href: string; label: string; tour: string }[] = [
  { key: 'chats', href: '/', label: 'Chats', tour: 'tab-chats' },
  { key: 'local', href: '/local', label: 'Local', tour: 'tab-local' },
  { key: 'feed', href: '/feed', label: 'Feed', tour: 'tab-feed' },
  { key: 'profile', href: '/settings/profile', label: 'Profile', tour: 'tab-profile' },
];

export default function Tabs({ active, hideOnMobile = false }: { active: TabKey; hideOnMobile?: boolean }) {
  const state = useAppState();
  const unread = [...state.conversations.values()].some((c) => c.unread_count > 0);
  const requests = (state.connections?.incoming.length ?? 0) > 0;

  return (
    <nav
      className={`${st.tabbar}${hideOnMobile ? ` ${st.tabbarChatOpen}` : ''}`}
      aria-label="Main navigation"
    >
      {TABS.map((tab) => {
        const dot = (tab.key === 'chats' && unread) || (tab.key === 'profile' && requests);
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={`${st.tab}${tab.key === active ? ` ${st.tabOn}` : ''}`}
            aria-current={tab.key === active ? 'page' : undefined}
            data-tour={tab.tour}
          >
            <span className={st.tabIcon}>
              <TabIcon tab={tab.key} />
              {dot ? <span className={st.tabDot} aria-label="new activity" /> : null}
            </span>
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function TabIcon({ tab }: { tab: TabKey }) {
  switch (tab) {
    case 'chats':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 4 c5.4 0 9 3.1 9 7.2 c0 4.1 -3.6 7.2 -9 7.2 c-1 0 -2 -0.1 -2.9 -0.4 L5 20.5 l1.1 -3.6 C4.2 15.5 3 13.5 3 11.2 C3 7.1 6.6 4 12 4 Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'local':
      // Map-pin: the board is about where you are (beacons + listings).
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 21 C8 16.6 5.5 13.4 5.5 10.2 a6.5 6.5 0 0 1 13 0 C18.5 13.4 16 16.6 12 21 Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      );
    case 'feed':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="4" y="4" width="16" height="7" rx="2.4" stroke="currentColor" strokeWidth="1.7" />
          <rect x="4" y="14" width="16" height="6" rx="2.4" stroke="currentColor" strokeWidth="1.7" opacity="0.65" />
        </svg>
      );
    case 'profile':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="8.4" r="3.6" stroke="currentColor" strokeWidth="1.7" />
          <path d="M5 19.5 c1.4 -3.4 4 -5 7 -5 s5.6 1.6 7 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
  }
}
