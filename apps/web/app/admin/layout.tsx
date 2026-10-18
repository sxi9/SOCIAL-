'use client';

// Operator surface shell (v0.5b — API.md §1.41, ADR-013). HIDDEN ENTIRELY for
// non-admins: nothing in the app links here, and the probe below mirrors the
// server's 404 shape — a non-admin (or a guesser) sees a dead end, not a
// login wall. Adminhood is granted on the Users tab or via the CLI (ADR-013).
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ad from '@/components/admin.module.css';
import { adminProbe } from '@/lib/admin';

const NAV: { href: string; label: string }[] = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/reports', label: 'Reports' },
  // v0.8b §1.69: public-content moderation + the support inbox.
  { href: '/admin/content', label: 'Content' },
  { href: '/admin/support', label: 'Support' },
  { href: '/admin/logs', label: 'Logs' },
  { href: '/admin/settings', label: 'Settings' },
  // v0.9 §1.74: OTP-ready authentication settings (SMTP + inert toggles).
  { href: '/admin/auth', label: 'Authentication' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminProbe().then((ok) => {
      if (!cancelled) setAllowed(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell>
      {allowed === null ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : allowed === false ? (
        // The §1.14 shape, client-side too: this page does not exist for you.
        <div className="center-screen muted" role="alert">
          This page does not exist.
        </div>
      ) : (
        <div className={ad.wrap}>
          <header className={ad.head}>
            <h1>
              Bored Chat <span className={ad.badge}>operator</span>
            </h1>
            <nav className={ad.nav} aria-label="Admin sections">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={pathname === item.href ? ad.navOn : undefined}
                  aria-current={pathname === item.href ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <span style={{ flex: 1 }} />
            <Link href="/" className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }}>
              ← app
            </Link>
          </header>
          <main className={ad.main}>{children}</main>
        </div>
      )}
    </AppShell>
  );
}
