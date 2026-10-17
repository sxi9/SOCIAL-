'use client';

// Anonymous reveal game — thread list (v0.8b — API.md §1.62, FEATURES #77).
// Both roles land here: games I started (I'm the mystery) and games aimed at
// me (the sender is a blurred mystery until the reveal).
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AnonThread } from '@socialchat/shared';
import { anonAvatarUrl, isRevealed, refreshAnonThreads } from '@/lib/anon';
import { formatTime } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import cm from '@/components/community.module.css';

function AnonList() {
  const state = useAppState();
  const router = useRouter();
  const now = useNow(30_000);

  useEffect(() => {
    void refreshAnonThreads();
  }, []);

  const threads = state.anonThreads;

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>🎭 Anonymous</h1>
        <span />
      </header>
      {threads === null ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : threads.length === 0 ? (
        <div className="settings-section">
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 28 }} aria-hidden>
              👻
            </p>
            <p style={{ margin: '8px 0 0' }}>No mystery threads yet.</p>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Open someone&rsquo;s profile and tap &ldquo;Send anonymously&rdquo; — they see the
              words, not the face. If they ask who you are, you pick the reveal game: a timer, a
              riddle, or just telling them.
            </p>
          </div>
        </div>
      ) : (
        <div>
          {threads.map((t) => (
            <ThreadRow key={t.id} thread={t} now={now} onOpen={() => router.push(`/anon/${t.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ thread, now, onOpen }: { thread: AnonThread; now: number; onOpen: () => void }) {
  const revealed = isRevealed(thread, now);
  const counterpart = thread.counterpart;
  const title =
    thread.role === 'sender'
      ? `To ${counterpart?.display_name ?? 'someone'} (you're the mystery)`
      : counterpart
        ? counterpart.display_name
        : 'Mystery sender';
  const snippet = thread.last_message
    ? thread.last_message.body
    : thread.role === 'sender'
      ? 'Your anonymous thread'
      : 'Someone sent you an anonymous message';
  return (
    <button type="button" className={cm.anonRow} onClick={onOpen}>
      {thread.role === 'recipient' && !revealed ? (
        <span className={cm.maskedAvatar} aria-hidden>
          {/* Server-blurred pixels — the real avatar never ships early. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={anonAvatarUrl(thread.id, now)} alt="" />
        </span>
      ) : counterpart ? (
        <Avatar avatar={counterpart.avatar} name={counterpart.display_name} size={44} />
      ) : (
        <span className={cm.maskedAvatar} aria-hidden>
          <span className={cm.anonGhostGlyph}>👻</span>
        </span>
      )}
      <span className={cm.anonRowText}>
        <strong>{title}</strong>
        <span>{snippet}</span>
      </span>
      <span className={cm.anonRowTime}>
        {formatTime(thread.last_message?.created_at ?? thread.created_at)}
      </span>
    </button>
  );
}

export default function AnonPage() {
  return (
    <AppShell>
      <AnonList />
    </AppShell>
  );
}
