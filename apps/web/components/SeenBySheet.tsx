'use client';

// Seen-by sheet (v0.3 — API.md §1.18, FEATURES #27). Faces and names, ordered
// by username, NO timestamps anywhere — a receipt must never become a deadline
// (PSYCHOLOGY never-build list). Reciprocity: with your own read receipts off
// the server answers 403 read_receipts_off and the sheet explains why.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { MessageReceiptsResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import Avatar from './Avatar';
import styles from './beacons.module.css';

interface SeenBySheetProps {
  conversationId: string;
  seq: number;
  onClose: () => void;
}

type SheetState =
  | { phase: 'loading' }
  | { phase: 'ok'; data: MessageReceiptsResponse }
  | { phase: 'receipts_off' }
  | { phase: 'error' };

export default function SeenBySheet({ conversationId, seq, onClose }: SeenBySheetProps) {
  const [st, setSt] = useState<SheetState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void api
      .get<MessageReceiptsResponse>(`/api/conversations/${conversationId}/messages/${seq}/receipts`)
      .then((data) => {
        if (!cancelled) setSt({ phase: 'ok', data });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'read_receipts_off') {
          setSt({ phase: 'receipts_off' });
        } else {
          setSt({ phase: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, seq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={styles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Message info">
        <div className={styles.sheetHead}>
          <h2>Message info</h2>
          <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {st.phase === 'loading' ? (
          <p className={styles.receiptMuted}>
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            Checking…
          </p>
        ) : st.phase === 'receipts_off' ? (
          <>
            <p className={styles.receiptMuted}>
              Seen-by is hidden because your read receipts are off — it&rsquo;s reciprocal: while you
              don&rsquo;t share yours, you don&rsquo;t see anyone else&rsquo;s.
            </p>
            <p className={styles.sheetNote}>
              You can turn them back on in{' '}
              <Link href="/settings/privacy" onClick={onClose}>
                Privacy settings
              </Link>
              .
            </p>
          </>
        ) : st.phase === 'error' ? (
          <p className="error-text">Could not load message info.</p>
        ) : (
          <>
            <div className={styles.receiptGroup}>
              <h3>Seen</h3>
              {st.data.seen.length === 0 ? (
                <p className={styles.receiptMuted}>No one yet — give it a minute.</p>
              ) : (
                st.data.seen.map((u) => (
                  <div key={u.id} className={styles.receiptRow}>
                    <Avatar avatar={u.avatar} name={u.display_name} size={32} />
                    <span className={styles.receiptName}>{u.display_name}</span>
                  </div>
                ))
              )}
            </div>
            <div className={styles.receiptGroup}>
              <h3>Delivered</h3>
              {st.data.delivered.length === 0 ? (
                <p className={styles.receiptMuted}>Everyone who got it has seen it.</p>
              ) : (
                st.data.delivered.map((u) => (
                  <div key={u.id} className={styles.receiptRow}>
                    <Avatar avatar={u.avatar} name={u.display_name} size={32} />
                    <span className={styles.receiptName}>{u.display_name}</span>
                  </div>
                ))
              )}
            </div>
            {/* No timestamps, by design: a receipt is not a deadline. */}
          </>
        )}
      </div>
    </div>
  );
}
