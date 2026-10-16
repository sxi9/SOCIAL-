'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { PRESENCE_SUB_MAX, type ConversationListItem } from '@socialchat/shared';
import { retryConnection, subscribePresence, unsubscribePresence } from '@/lib/connection';
import { conversationTitle, dmPeer, formatTime, messageSnippet } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import { BoredButton } from './BeaconCreateSheet';
import BeaconStrip, { KudosBanner } from './BeaconStrip';
import { InviteButton } from './InviteSheet';
import styles from './list.module.css';

function sortKey(item: ConversationListItem): number {
  return item.last_message_at ? new Date(item.last_message_at).getTime() : new Date(item.created_at).getTime();
}

export default function ConversationListView({ activeId = null }: { activeId?: string | null }) {
  const state = useAppState();
  const meId = state.me?.id;

  // The store mutates in place and bumps a version, so derive per render.
  const items = [...state.conversations.values()].sort((a, b) => sortKey(b) - sortKey(a));

  // Presence dots for visible DM peers (subscribe to on-screen users only).
  const peerIds: string[] = [];
  for (const item of items) {
    const peer = dmPeer(item, meId);
    if (peer && peerIds.length < PRESENCE_SUB_MAX) peerIds.push(peer.id);
  }
  const peerKey = peerIds.join(',');

  useEffect(() => {
    if (!peerIds.length || state.conn !== 'online') return;
    subscribePresence(peerIds);
    return () => unsubscribePresence(peerIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey, state.conn]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Bored Chat</h1>
        <InviteButton className={`btn btn-ghost btn-icon ${styles.headerInvite}`} label="" />
        <Link
          href="/new"
          className={`btn btn-ghost btn-icon ${styles.desktopOnly}`}
          aria-label="New conversation"
        >
          <PencilIcon />
        </Link>
        <Link href="/settings/profile" className="btn btn-ghost btn-icon" aria-label="Settings">
          <GearIcon />
        </Link>
      </header>
      {state.conn === 'error' ? (
        <div className="offline-banner error-banner">
          Connection error — the server rejected this session.{' '}
          <button type="button" className="banner-retry" onClick={() => retryConnection()}>
            Retry
          </button>
        </div>
      ) : state.conn !== 'online' ? (
        <div className="offline-banner">Offline — reconnecting…</div>
      ) : null}

      {/* Private kudos (recipient-only) + the live beacon strip (v0.3). */}
      <KudosBanner />
      <BeaconStrip />

      {!state.booted ? (
        <div className={styles.empty}>Loading conversations…</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <EmptyDoodle />
          <p className={styles.emptyTitle}>It&rsquo;s quiet in here… too quiet.</p>
          <p className="muted small">
            Chats are better with someone on the other end. Send a link, start the chaos.
          </p>
          <div className={styles.emptyActions}>
            <InviteButton className="btn btn-primary" label="Invite a friend" />
            <Link className="btn" href="/new">
              Start a chat
            </Link>
          </div>
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => {
            const peer = dmPeer(item, meId);
            const presence = peer ? state.presence.get(peer.id) : undefined;
            const title = conversationTitle(item, meId);
            // Lists render the static avatar frame only (§5.4).
            const avatar = peer ? peer.avatar : item.avatar;
            return (
              <li key={item.id}>
                <Link
                  href={`/c/${item.id}`}
                  className={`${styles.row}${item.id === activeId ? ` ${styles.rowActive}` : ''}`}
                  aria-current={item.id === activeId ? 'page' : undefined}
                >
                  <span className={styles.avatarWrap}>
                    <Avatar avatar={avatar} name={title} size={48} />
                    {peer ? (
                      <span className={`presence-dot ${styles.dot}${presence?.online ? ' online' : ''}`} />
                    ) : null}
                  </span>
                  <span className={styles.main}>
                    <span className={styles.titleLine}>
                      <span className={styles.title}>{title}</span>
                      {item.last_message_at ? (
                        <span className={styles.time}>{formatTime(item.last_message_at)}</span>
                      ) : null}
                    </span>
                    <span className={styles.snippetLine}>
                      <span className={`${styles.snippet}${item.unread_count > 0 ? ` ${styles.unread}` : ''}`}>
                        {messageSnippet(item.last_message)}
                      </span>
                      {item.unread_count > 0 ? <span className="badge">{item.unread_count}</span> : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* The bored user never waits: one tap from here to vibe chips. */}
      <BoredButton />

      <Link href="/new" className={styles.fab} aria-label="New conversation">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 5 V19 M5 12 H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </Link>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 20 L4.8 16.2 L16.4 4.6 a1.9 1.9 0 0 1 2.7 0 l0.3 0.3 a1.9 1.9 0 0 1 0 2.7 L7.8 19.2 Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmptyDoodle() {
  return (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" aria-hidden>
      <path
        d="M30 16 c-11 0 -19 7.4 -19 17 c0 5 2.2 9.3 6.3 12.3 L15 53 l9 -6.4 c1.9 0.5 3.9 0.7 6 0.7 c11 0 19 -7.4 19 -17 S41 16 30 16 Z"
        stroke="var(--accent)"
        strokeWidth="2.4"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M58 36 c10 0 17 6.6 17 15 c0 4.4 -1.9 8.2 -5.5 10.9 L72 70 l-8 -5.6 c-1.8 0.4 -3.6 0.6 -6 0.6 c-10 0 -17 -6.6 -17 -15 s7 -14 17 -14 Z"
        stroke="var(--ok)"
        strokeWidth="2.4"
        strokeLinejoin="round"
        opacity="0.45"
      />
      <circle cx="24" cy="33" r="2.2" fill="var(--accent)" opacity="0.55" />
      <circle cx="31" cy="33" r="2.2" fill="var(--accent)" opacity="0.55" />
      <circle cx="38" cy="33" r="2.2" fill="var(--accent)" opacity="0.55" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.8 L13.4 5.4 L16.3 4.9 L17 7.8 L19.9 8.5 L19.3 11.4 L21.2 13.6 L19.2 15.8 L19.8 18.7 L16.9 19.3 L16.1 22.1 L13.2 21.5 L11 23.2 L8.9 21.4 L6 21.9 L5.4 19 L2.6 18.2 L3.3 15.3 L1.5 13 L3.5 10.9 L3 8 L5.9 7.4 L6.8 4.6 L9.7 5.3 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity="0.75"
      />
    </svg>
  );
}
