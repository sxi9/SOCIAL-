'use client';

import { useEffect, useRef, useState } from 'react';
import type { UserPublic, UserSearchResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import Avatar from './Avatar';
import styles from './list.module.css';

const SEARCH_DEBOUNCE_MS = 300;

interface UserSearchProps {
  onSelect: (user: UserPublic) => void;
  excludeIds?: ReadonlySet<string>;
  placeholder?: string;
}

export default function UserSearch({ onSelect, excludeIds, placeholder }: UserSearchProps) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserPublic[]>([]);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const query = q.trim();
    if (!query) {
      setResults([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<UserSearchResponse>(`/api/users?q=${encodeURIComponent(query)}`);
          setResults(res.users);
        } catch {
          setResults([]);
        } finally {
          setBusy(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [q]);

  return (
    <div>
      <input
        className="input"
        type="search"
        value={q}
        placeholder={placeholder ?? 'Search people by name or username'}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      {busy ? <div className="muted small" style={{ padding: '8px 2px' }}>Searching…</div> : null}
      {results.length > 0 ? (
        <div className={styles.searchResults}>
          {results.map((user) => {
            const excluded = excludeIds?.has(user.id) ?? false;
            return (
              <button
                key={user.id}
                type="button"
                className={styles.searchRow}
                disabled={excluded}
                onClick={() => {
                  onSelect(user);
                  setQ('');
                  setResults([]);
                }}
              >
                <Avatar avatar={user.avatar} name={user.display_name} size={34} />
                <span style={{ minWidth: 0 }}>
                  <span className={styles.searchName} style={{ display: 'block' }}>
                    {user.display_name}
                  </span>
                  <span className={styles.searchUsername}>@{user.username}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!busy && q.trim() && results.length === 0 ? (
        <div className="muted small" style={{ padding: '8px 2px' }}>
          No one found.
        </div>
      ) : null}
    </div>
  );
}
