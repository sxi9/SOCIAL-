'use client';

// Poll message body (v0.3 — API.md §1.17). Live bars show COUNTS ONLY — never
// a voter list, never names on options (the seen-by discipline applies to
// votes too). Tap to vote, tap your choice again to unvote; revote replaces.
import { useState } from 'react';
import type { Poll } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { votePoll } from '@/lib/beacons';
import styles from './beacons.module.css';

export default function PollView({ poll }: { poll: Poll }) {
  const [err, setErr] = useState<string | null>(null);
  const closed = poll.closes_at !== null && new Date(poll.closes_at).getTime() <= Date.now();
  const max = Math.max(1, ...poll.counts);

  async function tap(idx: number): Promise<void> {
    if (closed) return;
    setErr(null);
    try {
      await votePoll(poll, poll.my_vote === idx ? null : idx);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'poll_closed') setErr('This poll just closed.');
      else setErr('Vote didn’t land — try again.');
    }
  }

  return (
    <div className={styles.poll}>
      <div className={styles.pollQ}>📊 {poll.question}</div>
      {poll.options.map((opt, idx) => {
        const count = poll.counts[idx] ?? 0;
        const width = poll.total_votes > 0 ? Math.round((count / max) * 100) : 0;
        const mine = poll.my_vote === idx;
        return (
          <button
            key={idx}
            type="button"
            className={`${styles.pollOpt}${mine ? ` ${styles.pollOptMine}` : ''}`}
            aria-pressed={mine}
            disabled={closed}
            onClick={() => void tap(idx)}
          >
            <span className={styles.pollBar} style={{ '--w': `${width}%` } as React.CSSProperties} />
            <span className={styles.pollOptLabel}>
              {mine ? '✓ ' : ''}
              {opt}
            </span>
            <span className={styles.pollCount}>{count}</span>
          </button>
        );
      })}
      <span className={styles.pollMeta}>
        {poll.total_votes} {poll.total_votes === 1 ? 'vote' : 'votes'}
        {closed ? ' · closed' : poll.my_vote !== null ? ' · tap yours to unvote' : ''}
      </span>
      {err ? <span className="error-text">{err}</span> : null}
    </div>
  );
}
