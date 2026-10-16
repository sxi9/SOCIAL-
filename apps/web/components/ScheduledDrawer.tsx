'use client';

// The "scheduled" drawer (v0.4 — API.md §1.26): my pending scheduled messages
// for this conversation, with one-tap cancel. Private: no other participant
// can see a pending schedule exists. scheduled.updated keeps this in sync.
import { useEffect, useState } from 'react';
import type { ScheduledMessage } from '@socialchat/shared';
import { formatDeliverAt } from '@/lib/format';
import { cancelScheduled, pendingFor, refreshScheduled } from '@/lib/scheduled';
import { useAppState } from '@/lib/useStore';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

interface ScheduledDrawerProps {
  conversationId: string;
  onClose: () => void;
}

function snippetOf(s: ScheduledMessage): string {
  if (s.body) return s.body;
  if (s.type === 'audio') return 'Voice note';
  if (s.type === 'image') return 'Photo';
  if (s.type === 'video') return 'Video';
  if (s.type === 'file') return 'File';
  return 'Message';
}

export default function ScheduledDrawer({ conversationId, onClose }: ScheduledDrawerProps) {
  useAppState(); // re-render on scheduled.updated
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void refreshScheduled().catch(() => setError('Could not load your scheduled messages.'));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pending = pendingFor(conversationId);

  async function cancel(s: ScheduledMessage): Promise<void> {
    setBusyId(s.id);
    setError(null);
    try {
      await cancelScheduled(s);
    } catch {
      setError('Could not cancel that one — it may have just sent.');
      void refreshScheduled().catch(() => undefined);
    } finally {
      setBusyId(null);
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
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Scheduled messages">
        <div className={sheetStyles.sheetHead}>
          <h2>Scheduled</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: '0 0 6px' }}>
          Only you can see these until they send.
        </p>
        {pending.length === 0 ? (
          <p className={sheetStyles.receiptMuted}>
            Nothing queued here. Long-press Send (or use the + menu) to schedule one.
          </p>
        ) : (
          pending.map((s) => (
            <div key={s.id} className={exp.schedRow}>
              {s.metadata.capsule ? (
                <span aria-hidden style={{ fontSize: 20 }}>
                  💌
                </span>
              ) : (
                <span aria-hidden style={{ fontSize: 20 }}>
                  🕑
                </span>
              )}
              <div className={exp.schedBody}>
                <div className={exp.schedSnippet}>{snippetOf(s)}</div>
                <div className={exp.schedWhen}>
                  {s.metadata.capsule ? 'Capsule opens ' : 'Sends '}
                  {formatDeliverAt(s.deliver_at)}
                </div>
              </div>
              <button
                type="button"
                className={`btn btn-danger ${exp.schedCancel}`}
                disabled={busyId === s.id}
                onClick={() => void cancel(s)}
              >
                Cancel
              </button>
            </div>
          ))
        )}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </div>
  );
}
