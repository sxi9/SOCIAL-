'use client';

// v0.5a tab shell: Chats / Plans / Feed / Profile. Bottom bar on mobile, slim
// left rail from 900px up (the two-pane chat shell stays intact). The bar hides
// on mobile while a chat is open (hideOnMobile).
import Link from 'next/link';
import { useAppState } from '@/lib/useStore';
import st from './social.module.css';

export type TabKey = 'chats' | 'plans' | 'feed' | 'profile';

const TABS: { key: TabKey; href: string; label: string }[] = [
  { key: 'chats', href: '/', label: 'Chats' },
  { key: 'plans', href: '/plans', label: 'Plans' },
  { key: 'feed', href: '/feed', label: 'Feed' },
  { key: 'profile', href: '/settings/profile', label: 'Profile' },
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
    case 'plans':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3 c1 3 3.4 4.2 3.4 7 a3.4 3.4 0 0 1 -6.8 0 C8.6 7.2 11 6 12 3 Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M6 16.5 c1.6 2.4 4 3.5 6 3.5 s4.4 -1.1 6 -3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
