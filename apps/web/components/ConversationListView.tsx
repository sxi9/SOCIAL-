'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PRESENCE_SUB_MAX, type ConversationListItem } from '@socialchat/shared';
import { retryConnection, subscribePresence, unsubscribePresence } from '@/lib/connection';
import { refreshConnections } from '@/lib/connections';
import { conversationTitle, dmPeer, formatTime, messageSnippet } from '@/lib/format';
import { isGhost, isSupportConversation } from '@/lib/groups';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import ConnectionRequestsSheet from './ConnectionRequestsSheet';
import InviteSheet, { InviteButton } from './InviteSheet';
import Portal from './Portal';
import RescueSheet from './RescueSheet';
import StoriesStrip from './StoriesStrip';
import WhatsNewCard from './WhatsNewCard';
import styles from './list.module.css';
import tb from './topbar.module.css';

function sortKey(item: ConversationListItem): number {
  return item.last_message_at ? new Date(item.last_message_at).getTime() : new Date(item.created_at).getTime();
}

export default function ConversationListView({ activeId = null }: { activeId?: string | null }) {
  const state = useAppState();
  const meId = state.me?.id;
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [rescueOpen, setRescueOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Royal v2 header: the "···" overflow popover holds everything beyond the
  // three stroke actions (search / new chat / more).
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const incomingCount = state.connections?.incoming.length ?? 0;

  // Connections power the requests badge here and the connect states on
  // profiles — one cheap GET, then connection.updated keeps it live.
  useEffect(() => {
    void refreshConnections();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const openMenu = () => {
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setMenuOpen(true);
  };

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
        <h1 className={styles.pageTitle}>Chats</h1>
        {/* Royal v2: exactly three stroke actions. Search routes to /people
            until the global search page exists (Wave B). */}
        <Link href="/people" className="btn btn-ghost btn-icon" aria-label="Search">
          <SearchIcon />
        </Link>
        <Link href="/new" className="btn btn-ghost btn-icon" aria-label="New conversation">
          <PlusIcon />
        </Link>
        <button
          ref={menuBtnRef}
          type="button"
          className={`btn btn-ghost btn-icon ${tb.menuTrigger}`}
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        >
          <DotsIcon />
          {/* Requests waiting behind the popover still announce on the bar. */}
          {incomingCount > 0 ? <span className={tb.btnDot} aria-hidden /> : null}
        </button>
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

      {/* v0.5a story tray — unviewed rings first, by username (§1.34). */}
      <StoriesStrip />

      {/* v0.8a (§1.61): releases newer than my marker — one dismissible card,
          no badges anywhere else, gone for good once dismissed. */}
      <WhatsNewCard />

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
            // Royal v2: own-last-message rows carry a small tick before the
            // snippet — read state rides the existing receipt watermarks.
            const lastMsg = item.last_message;
            let tick: 'read' | 'delivered' | 'sent' | null = null;
            if (lastMsg && meId && lastMsg.sender_id === meId) {
              const others = item.participants.filter((p) => p.left_at === null && p.user.id !== meId);
              if (others.some((p) => p.last_read_seq >= lastMsg.seq)) tick = 'read';
              else if (others.some((p) => p.last_delivered_seq >= lastMsg.seq)) tick = 'delivered';
              else tick = 'sent';
            }
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
                      <span className={styles.title}>
                        {item.type === 'channel' ? <span aria-label="channel">📣 </span> : null}
                        {/* v0.8b: ghost groups wear the badge; the Support
                            conversation wears the brand (§1.68/§1.69). */}
                        {isGhost(item) ? <span aria-label="ghost group">👻 </span> : null}
                        {isSupportConversation(item) ? <span aria-hidden>🛟 </span> : null}
                        {title}
                      </span>
                      {/* Royal v2: conversations holding pinned messages wear
                          a small pin glyph next to the title. */}
                      {item.pins.length > 0 ? (
                        <span className={styles.pinGlyph} aria-label="has pinned messages">
                          <PinIcon />
                        </span>
                      ) : null}
                      {item.last_message_at ? (
                        <span
                          className={`${styles.time}${item.unread_count > 0 ? ` ${styles.timeUnread}` : ''}`}
                        >
                          {formatTime(item.last_message_at)}
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.snippetLine}>
                      {tick ? (
                        <span
                          className={`${styles.tick}${tick === 'read' ? ` ${styles.tickRead}` : ''}${tick === 'delivered' ? ` ${styles.tickDelivered}` : ''}`}
                          aria-hidden
                        >
                          <TickIcon />
                        </span>
                      ) : null}
                      <span className={`${styles.snippet}${item.unread_count > 0 ? ` ${styles.unread}` : ''}`}>
                        {messageSnippet(item.last_message)}
                      </span>
                      {item.unread_count > 0 ? (
                        <span className={`badge ${styles.unreadBadge}`}>{item.unread_count}</span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {menuOpen ? (
        <Portal>
          <div className={tb.menuBackdrop} role="presentation" onClick={() => setMenuOpen(false)} />
          <div
            className={tb.menu}
            role="menu"
            aria-label="More options"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            {/* v0.6 §1.46 (fixer r1): the one-tap SOS lives on the home tab
                too, not only buried in Profile settings. */}
            <button
              type="button"
              role="menuitem"
              className={tb.menuItem}
              aria-label="Rescue me — ping friends to call you"
              onClick={() => {
                setMenuOpen(false);
                setRescueOpen(true);
              }}
            >
              <span className={tb.menuIcon}>
                <SosIcon />
              </span>
              Rescue me
            </button>
            {/* v0.8b §1.62: the anonymous reveal-game inbox. */}
            <Link
              href="/anon"
              role="menuitem"
              className={tb.menuItem}
              aria-label="Anonymous messages"
              onClick={() => setMenuOpen(false)}
            >
              <span className={tb.menuIcon}>
                <MaskIcon />
              </span>
              Anonymous inbox
            </Link>
            <button
              type="button"
              role="menuitem"
              className={tb.menuItem}
              aria-label="Invite a friend"
              onClick={() => {
                setMenuOpen(false);
                setInviteOpen(true);
              }}
            >
              <span className={tb.menuIcon}>
                <InviteIcon />
              </span>
              Invite a friend
            </button>
            <button
              type="button"
              role="menuitem"
              className={tb.menuItem}
              aria-label={incomingCount > 0 ? `Friend requests (${incomingCount} waiting)` : 'Friend requests'}
              onClick={() => {
                setMenuOpen(false);
                setRequestsOpen(true);
              }}
            >
              <span className={tb.menuIcon}>
                <PeopleIcon />
                {incomingCount > 0 ? <span className={tb.menuDot} aria-hidden /> : null}
              </span>
              Friend requests
            </button>
            <Link
              href="/settings"
              role="menuitem"
              className={tb.menuItem}
              aria-label="Settings"
              onClick={() => setMenuOpen(false)}
            >
              <span className={tb.menuIcon}>
                <GearIcon />
              </span>
              Settings
            </Link>
          </div>
        </Portal>
      ) : null}

      {rescueOpen ? <RescueSheet onClose={() => setRescueOpen(false)} /> : null}
      {inviteOpen ? <InviteSheet onClose={() => setInviteOpen(false)} /> : null}
      {requestsOpen ? <ConnectionRequestsSheet onClose={() => setRequestsOpen(false)} /> : null}
    </div>
  );
}

/* Royal v2 header icons: 24 viewBox, 1.7px stroke, round caps (Tabs.tsx family). */

function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.6 15.6 L20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5 V19 M5 12 H19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function SosIcon() {
  // Lifebuoy: ring + four spokes.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 3.8 V8.6 M12 15.4 V20.2 M3.8 12 H8.6 M15.4 12 H20.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MaskIcon() {
  // Speech bubble with a wink — the anonymous inbox.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4 c5.4 0 9 3.1 9 7.2 c0 4.1 -3.6 7.2 -9 7.2 c-1 0 -2 -0.1 -2.9 -0.4 L5 20.5 l1.1 -3.6 C4.2 15.5 3 13.5 3 11.2 C3 7.1 6.6 4 12 4 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="9.4" cy="11" r="1.1" fill="currentColor" />
      <path d="M13.4 11 h2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function InviteIcon() {
  // Chain link (the invite-link glyph the invite sheet already uses).
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 14 L14 10 M8.4 15.6 a3.4 3.4 0 0 1 -4.8 -4.8 l2.6 -2.6 a3.4 3.4 0 0 1 4.8 0 M15.6 8.4 a3.4 3.4 0 0 1 4.8 4.8 l-2.6 2.6 a3.4 3.4 0 0 1 -4.8 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8.6" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.4 19 c1.2 -2.9 3.3 -4.3 5.6 -4.3 s4.4 1.4 5.6 4.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M15.5 9.4 a2.6 2.6 0 1 0 1.4 -4.9 M16.6 13.9 c2 0.3 3.4 1.6 4.2 3.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
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

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14.5 3.5 L20.5 9.5 L18.6 11.4 L17.8 11.1 L13.4 15.5 L13.2 19 L11.4 20.8 L7.3 16.7 L3.5 20.5 M7.3 16.7 L3.2 12.6 L5 10.8 L8.5 10.6 L12.9 6.2 L12.6 5.4 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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
