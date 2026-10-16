'use client';

// Group tic-tac-toe challenge (v0.4 — API.md §1.27): pick an opponent among the
// active members. In a DM the opponent is implied and this sheet never shows.
import { useEffect, useState } from 'react';
import type { ConversationListItem } from '@socialchat/shared';
import Avatar from './Avatar';
import sheetStyles from './beacons.module.css';

interface TttChallengeSheetProps {
  conv: ConversationListItem;
  meId: string;
  nameFor: (userId: string, fallback: string) => string;
  onClose: () => void;
  onPick: (opponentId: string) => Promise<void>;
}

export default function TttChallengeSheet({ conv, meId, nameFor, onClose, onPick }: TttChallengeSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const candidates = conv.participants.filter((p) => p.left_at === null && p.user.id !== meId);

  async function pick(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(id);
      onClose();
    } catch {
      setError('Could not start the game — try again.');
      setBusy(false);
    }
  }

  return (
    <div
      className={sheetStyles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Challenge someone to tic-tac-toe">
        <div className={sheetStyles.sheetHead}>
          <h2>🎮 Challenge someone</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: '0 0 8px' }}>
          You play ✕ and move first. Everyone else gets to spectate.
        </p>
        {candidates.map((p) => {
          const name = nameFor(p.user.id, p.user.display_name);
          return (
            <button
              key={p.user.id}
              type="button"
              className={sheetStyles.receiptRow}
              style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' }}
              disabled={busy}
              onClick={() => void pick(p.user.id)}
            >
              <Avatar avatar={p.user.avatar} name={name} size={32} />
              <span className={sheetStyles.receiptName}>{name}</span>
            </button>
          );
        })}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </div>
  );
}
