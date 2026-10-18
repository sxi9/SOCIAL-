'use client';

// /settings — the Royal v2 category page (proto ref 46): user card + the
// Telegram-style section rows + Sign out. It replaces the old redirect to
// /settings/profile; that route is now the own-profile tab, and every
// FEATURE_DIRECTORY '/settings' deep link lands here (Account is one tap in).
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SessionsResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { logout } from '@/lib/connection';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import sm from '@/components/settings.module.css';

/* Stroke icons — 24 viewBox, 1.7px, round caps (the Tabs.tsx family). */
const S = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...S} />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M9.5 6 L15.5 12 L9.5 18" {...S} />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="8.4" r="3.6" {...S} />
      <path d="M5 19.5 c1.4 -3.4 4 -5 7 -5 s5.6 1.6 7 5" {...S} />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.5" {...S} />
      <path d="M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0 v2.5" {...S} />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <path d="M18 16 H6 c1.3 -1.4 1.8 -3 1.8 -5.2 V10 a4.2 4.2 0 0 1 8.4 0 v0.8 c0 2.2 0.5 3.8 1.8 5.2 Z" {...S} />
      <path d="M10.3 19 a1.8 1.8 0 0 0 3.4 0" {...S} />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 4 c5.4 0 9 3.1 9 7.2 c0 4.1 -3.6 7.2 -9 7.2 c-1 0 -2 -0.1 -2.9 -0.4 L5 20.5 l1.1 -3.6 C4.2 15.5 3 13.5 3 11.2 C3 7.1 6.6 4 12 4 Z"
        {...S}
      />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M7.2 4.5 l2.3 0.4 0.9 3.1 -1.8 1.6 a11.5 11.5 0 0 0 5.8 5.8 l1.6 -1.8 3.1 0.9 0.4 2.3 c0 1.1 -0.9 2.1 -2.1 2.1 A15.8 15.8 0 0 1 5.1 6.6 c0 -1.2 1 -2.1 2.1 -2.1 Z"
        {...S}
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3.5 L18.5 5.9 v5 c0 4.4 -2.8 7.5 -6.5 9.6 C8.3 18.4 5.5 15.3 5.5 10.9 v-5 Z" {...S} />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...S} />
      <path d="M9.7 9.5 a2.4 2.4 0 1 1 3.3 2.2 c-0.8 0.3 -1 0.9 -1 1.7" {...S} />
      <path d="M12 16.4 h0.01" {...S} />
    </svg>
  );
}

function SettingsHome() {
  const state = useAppState();
  const router = useRouter();
  const me = state.me;
  // "N devices" on the Devices & security row — cheap (one GET); omitted
  // quietly when the fetch fails. A count of my OWN devices is a private
  // fact, not a social score.
  const [deviceCount, setDeviceCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<SessionsResponse>('/api/auth/sessions')
      .then((res) => {
        if (!cancelled) setDeviceCount(res.sessions.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me) return null;

  const rows: { href: string; title: string; icon: ReactNode; value?: string }[] = [
    { href: '/settings/account', title: 'Account', icon: <PersonIcon /> },
    { href: '/settings/privacy', title: 'Privacy & safety', icon: <LockIcon /> },
    { href: '/settings/notifications', title: 'Notifications & sounds', icon: <BellIcon /> },
    { href: '/settings/chats', title: 'Chats', icon: <ChatIcon /> },
    { href: '/settings/calls', title: 'Calls', icon: <PhoneIcon /> },
    {
      href: '/settings/security',
      title: 'Devices & security',
      icon: <ShieldIcon />,
      ...(deviceCount !== null
        ? { value: `${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'}` }
        : {}),
    },
    { href: '/settings/help', title: 'Help & about', icon: <HelpIcon /> },
  ];

  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <Link href="/settings/profile" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Settings</h1>
      </header>

      <Link href="/settings/account" className={sm.userCard}>
        <Avatar avatar={me.avatar} name={me.display_name} size={52} />
        <span className={sm.userMain}>
          <span className={sm.userName}>{me.display_name}</span>
          <span className={sm.userHandle}>
            @{me.username}
            {me.mood ? (
              <>
                {' · '}
                <span className={sm.userMood}>
                  {me.mood.label} <span aria-hidden>{me.mood.emoji}</span>
                </span>
              </>
            ) : null}
          </span>
        </span>
        <span className={sm.rowChevron} aria-hidden>
          <ChevronRight />
        </span>
      </Link>

      <nav className={sm.rows} aria-label="Settings sections">
        {rows.map((row) => (
          <Link key={row.href} href={row.href} className={sm.row}>
            <span className={sm.rowIcon} aria-hidden>
              {row.icon}
            </span>
            <span className={sm.rowTitle}>{row.title}</span>
            {row.value ? <span className={sm.rowValue}>{row.value}</span> : null}
            <span className={sm.rowChevron} aria-hidden>
              <ChevronRight />
            </span>
          </Link>
        ))}
      </nav>

      <button
        type="button"
        className={sm.signOut}
        onClick={() => {
          void logout().then(() => router.replace('/login'));
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export default function SettingsIndexPage() {
  return (
    <AppShell>
      <SettingsHome />
    </AppShell>
  );
}
