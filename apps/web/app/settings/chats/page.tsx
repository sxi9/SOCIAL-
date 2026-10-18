'use client';

// Settings → Chats (Royal v2 IA, proto ref 50). Chat backgrounds are
// per-conversation and private to your own view (v0.8a §1.60) — this page
// points at where that lives rather than duplicating it. No archived row:
// archiving does not exist yet, so nothing pretends it does.
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';

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

function ChatSettings() {
  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Chats</h1>
        <span />
      </header>

      <div className={sm.setList}>
        <Link href="/" className={sm.setRow}>
          <span className={sm.setMain}>
            <span className={sm.setTitle}>Themes &amp; backgrounds</span>
            <span className={sm.setHint} style={{ display: 'block' }}>
              Set per chat: open a chat, tap its name, pick a background. Only you see yours.
            </span>
          </span>
          <span className={sm.rowChevron} aria-hidden>
            <ChevronRight />
          </span>
        </Link>
        <Link href="/settings/privacy" className={sm.setRow}>
          <span className={sm.setMain}>
            <span className={sm.setTitle}>Typing, receipts &amp; mood effects</span>
            <span className={sm.setHint} style={{ display: 'block' }}>
              Those live in Privacy &amp; safety — one place for everything others can see.
            </span>
          </span>
          <span className={sm.rowChevron} aria-hidden>
            <ChevronRight />
          </span>
        </Link>
      </div>
    </div>
  );
}

export default function ChatSettingsPage() {
  return (
    <AppShell>
      <ChatSettings />
    </AppShell>
  );
}
