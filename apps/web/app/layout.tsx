import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Bored Chat', template: '%s · Bored Chat' },
  description: 'Chat for when the group chat is dead.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Bored Chat' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
    { media: '(prefers-color-scheme: light)', color: '#f4f6fb' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Appearance (lib/theme.ts): set data-theme/data-accent from
            localStorage BEFORE paint so there is no flash of the wrong
            scheme. Same key + fallbacks as getThemePrefs(). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var p=JSON.parse(localStorage.getItem('bc.theme.v1')||'{}');var e=document.documentElement;" +
              "if(p.mode==='light'||p.mode==='dark')e.setAttribute('data-theme',p.mode);" +
              "if(['gold','rose','mint','sky'].indexOf(p.accent)>=0)e.setAttribute('data-accent',p.accent);}catch(_){}",
          }}
        />
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
