'use client';

// The profile activity strip (v0.8a — API.md §1.59, FEATURES #76). The server
// resolved every item PER-VIEWER at read time: the per-kind setting ∩ the
// underlying object's own audience, blocks and bans included — invisible
// items were silently DROPPED (no placeholders, no "N hidden" counts, no
// counters of any kind). This component just renders what it was given and
// links to the thing itself where a surface exists for it.
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Activity, ActivityResponse, ActivitySummary } from '@socialchat/shared';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { KIND_EMOJI, KIND_LABEL } from '@/lib/listings';
import idm from './identity.module.css';

function summaryBits(a: Activity): { icon: string; text: ReactNode; href: string | null } {
  const s: ActivitySummary = a.summary;
  switch (s.type) {
    case 'beacon': {
      const vibe =
        s.vibe === 'custom' && s.custom_vibe_label
          ? `${s.custom_vibe_emoji ?? ''} ${s.custom_vibe_label}`.trim()
          : s.vibe;
      const verb = a.kind === 'beacon_sparked' ? 'sparked a plan' : 'lit a beacon';
      return {
        icon: a.kind === 'beacon_sparked' ? '✨' : '🔥',
        text: (
          <>
            {verb} — {vibe}
            {s.note ? <em> · {s.note}</em> : null}
            {s.status === 'expired' || s.status === 'cancelled' ? <em> · over</em> : null}
          </>
        ),
        // Beacons live on the Local tab; expired ones have no page of their own.
        href: s.status === 'open' || s.status === 'sparked' ? '/local' : null,
      };
    }
    case 'post':
      return {
        icon: '📝',
        text: <>posted{s.excerpt ? <em> · {s.excerpt}</em> : null}</>,
        href: '/feed',
      };
    case 'listing':
      return {
        icon: KIND_EMOJI[s.kind],
        text: (
          <>
            listed {KIND_LABEL[s.kind].toLowerCase()} — {s.title}
            {s.status !== 'active' ? <em> · {s.status}</em> : null}
          </>
        ),
        href: `/local?l=${s.listing_id}`,
      };
    case 'puzzle':
      return {
        icon: '🧩',
        text: s.solved ? (
          <>solved the daily puzzle in {s.attempts_used}</>
        ) : (
          <>took on the daily puzzle</>
        ),
        href: '/puzzle',
      };
    case 'game':
      return {
        icon: '🏆',
        text: (
          <>won tic-tac-toe{s.opponent ? <> vs {s.opponent.display_name}</> : null}</>
        ),
        // Visible only where the game happened — the viewer was in that chat.
        href: `/c/${s.conversation_id}`,
      };
  }
}

export default function ActivityStrip({ username, isMe }: { username: string; isMe: boolean }) {
  const [items, setItems] = useState<Activity[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    void api
      .get<ActivityResponse>(`/api/users/${encodeURIComponent(username)}/activity`)
      .then((res) => {
        if (!cancelled) setItems(res.activities);
      })
      .catch(() => {
        if (!cancelled) setItems([]); // 404/network → render nothing, quietly
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (!items || items.length === 0) return null;

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Recently</h3>
      <ul className={idm.actList}>
        {items.map((a) => {
          const { icon, text, href } = summaryBits(a);
          const inner = (
            <>
              <span className={idm.actIcon} aria-hidden>
                {icon}
              </span>
              <span className={idm.actText}>{text}</span>
              <span className={idm.actTime}>{formatTime(a.created_at)}</span>
            </>
          );
          return (
            <li key={a.id}>
              {href ? (
                <Link href={href} className={idm.actRow}>
                  {inner}
                </Link>
              ) : (
                <span className={idm.actRow}>{inner}</span>
              )}
            </li>
          );
        })}
      </ul>
      {isMe ? (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          You choose who sees each kind in{' '}
          <Link href="/settings/privacy">Privacy → Activity</Link>. Nothing here ever shows wider
          than the thing itself.
        </p>
      ) : null}
    </div>
  );
}
