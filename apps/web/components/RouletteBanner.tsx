'use client';

// v0.6 roulette provisional DM (API.md §1.45, ADR-015): the countdown banner
// + KEEP button at the top of the chat. The window is 5 minutes; BOTH parties
// must keep or the sweep hard-deletes the chat. The other party's keep state
// is never serialized — "Kept ✓ (waiting)" carries no pressure about them.
// Both-kept → confetti (once, reduced-motion skips it entirely) + the
// one-time private feedback prompt.
import { useEffect, useState } from 'react';
import type { ConversationListItem } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { keepRoulette, markKept, queueFeedback, shouldCelebrateKeep } from '@/lib/discovery';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import EffectOverlay from './EffectOverlay';
import styles from './discovery.module.css';

export default function RouletteBanner({ conv }: { conv: ConversationListItem }) {
  // Seconds matter here (a 5-minute fuse, not a beacon countdown).
  const now = useNow(1000);
  useAppState(); // re-render when conv.updated lands
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);

  const rider = conv.roulette;
  const permanent = conv.origin === 'roulette' && rider === null;

  // Both kept — whether my keep's 200 or the other's conv.updated resolved it.
  useEffect(() => {
    if (!permanent) return;
    if (shouldCelebrateKeep(conv.id)) {
      markKept(conv.id);
      // Read the media query directly: the hook's value can lag one commit,
      // and a reduce-motion user must never get the confetti at all.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!still) setCelebrate(true);
      queueFeedback('roulette', conv.id);
    }
  }, [permanent, conv.id]);

  if (permanent) {
    return celebrate ? <EffectOverlay effect="confetti" onDone={() => setCelebrate(false)} /> : null;
  }
  if (!rider) return null;

  const leftS = Math.max(0, Math.ceil((new Date(rider.expires_at).getTime() - now) / 1000));
  const clock = `${Math.floor(leftS / 60)}:${(leftS % 60).toString().padStart(2, '0')}`;

  async function keep(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await keepRoulette(conv.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError('Too late — the window closed.');
      } else {
        setError('Could not keep the chat.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.rouletteBanner} role="status">
      <span aria-hidden>🎲</span>
      <span>
        Stranger chat · <span className={styles.rouletteClock}>{clock}</span> left
        {error ? <span className="error-text" style={{ marginLeft: 8 }}>{error}</span> : null}
      </span>
      {rider.kept ? (
        <span className={styles.keptChip} title="It stays if they keep it too">
          Kept ✓
        </span>
      ) : (
        <button
          type="button"
          className={styles.keepBtn}
          disabled={busy}
          onClick={() => void keep()}
          title="If you both keep it, the chat stays"
        >
          {busy ? 'Keeping…' : '💜 Keep this chat'}
        </button>
      )}
    </div>
  );
}
