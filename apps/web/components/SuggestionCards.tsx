'use client';

// People-you-may-know cards (v0.8b — API.md §1.64, FEATURES #78, ADR-019).
// Mutual FACES first (people I already know — no new exposure), mutual_count
// carrying the rest; same_area is a boolean, the area text stays private.
// Dismiss is permanent and silent; connect is the ordinary §1.28 request.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Suggestion } from '@socialchat/shared';
import { connectTo } from '@/lib/connections';
import { dismissSuggestion, fetchSuggestions } from '@/lib/suggestions';
import { toast } from '@/lib/toast';
import Avatar from './Avatar';
import cm from './community.module.css';

export default function SuggestionCards({ title = 'People you may know' }: { title?: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void fetchSuggestions()
      .then((list) => {
        if (!cancelled) setSuggestions(list);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (suggestions === null || suggestions.length === 0) return null;

  async function dismiss(userId: string): Promise<void> {
    setSuggestions((prev) => (prev ? prev.filter((s) => s.user.id !== userId) : prev));
    try {
      await dismissSuggestion(userId);
    } catch {
      /* idempotent — worst case it shows once more next visit */
    }
  }

  async function connect(userId: string): Promise<void> {
    setRequested((prev) => new Set(prev).add(userId));
    try {
      await connectTo(userId);
      toast('Request sent');
    } catch {
      setRequested((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      toast('Could not send the request');
    }
  }

  return (
    <section aria-label={title}>
      <p className="muted small" style={{ margin: '10px 2px 2px' }}>
        {title}
      </p>
      <div className={cm.suggStrip}>
        {suggestions.map((s) => {
          const why: string[] = [];
          if (s.mutual_count > 0) why.push(`${s.mutual_count} mutual ${s.mutual_count === 1 ? 'friend' : 'friends'}`);
          if (s.shared_groups > 0) why.push(`${s.shared_groups} shared ${s.shared_groups === 1 ? 'group' : 'groups'}`);
          if (s.same_area) why.push('your area');
          return (
            <article key={s.user.id} className={cm.suggCard}>
              <button
                type="button"
                className={cm.suggDismiss}
                aria-label={`Dismiss ${s.user.display_name} — they won't be suggested again`}
                onClick={() => void dismiss(s.user.id)}
              >
                ×
              </button>
              <Link href={`/u/${encodeURIComponent(s.user.username)}`} aria-label={`${s.user.display_name} — open profile`}>
                <Avatar avatar={s.user.avatar} name={s.user.display_name} size={56} />
              </Link>
              <Link href={`/u/${encodeURIComponent(s.user.username)}`} className={cm.suggName}>
                {s.user.display_name}
              </Link>
              <span className={cm.suggUser}>@{s.user.username}</span>
              <span className={cm.suggWhy}>
                {s.mutuals.length > 0 ? (
                  <span className={cm.suggMutualFaces} aria-hidden>
                    {s.mutuals.map((u) => (
                      <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={20} />
                    ))}
                  </span>
                ) : null}
                <span>{why.join(' · ') || 'new around here'}</span>
              </span>
              {requested.has(s.user.id) ? (
                <span className="muted small">Requested ✓</span>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => void connect(s.user.id)}>
                  Connect
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
