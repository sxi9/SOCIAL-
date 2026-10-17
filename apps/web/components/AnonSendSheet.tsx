'use client';

// "👻 Send anonymously" (v0.8b — API.md §1.62, FEATURES #77). Opens MY open
// anon thread to this person with a first message. Refusals are INVISIBLE by
// contract (one 404 shape for opt-out / unmet connections / blocks / unknown)
// — the copy here never disambiguates them.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ANON_BODY_MAX_CHARS } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { openAnonThread } from '@/lib/anon';
import styles from './beacons.module.css';
import Portal from './Portal';

export default function AnonSendSheet({
  userId,
  displayName,
  onClose,
}: {
  userId: string;
  displayName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(): Promise<void> {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await openAnonThread(userId, text);
      onClose();
      router.push(`/anon/${thread.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // The invisible refusal — never says WHY (§1.62 binding).
        setError('Anonymous messages aren’t available for this person right now.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — anonymous-message limit reached for now.');
      } else {
        setError('Could not send — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={styles.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Send anonymously">
          <div className={styles.sheetHead}>
            <h2>👻 Send anonymously</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className={styles.sheetNote} style={{ marginTop: 0 }}>
            {displayName} won&rsquo;t see who you are — unless you reveal yourself later, or they
            win the reveal game. Text only. Be kind: <strong>reports always unmask you</strong> to
            the moderators.
          </p>
          <textarea
            className="input"
            rows={3}
            autoFocus
            placeholder="Say the thing…"
            value={body}
            maxLength={ANON_BODY_MAX_CHARS}
            onChange={(e) => setBody(e.target.value)}
            style={{ marginTop: 10 }}
          />
          {error ? <p className="error-text">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 10, width: '100%' }}
            disabled={busy || !body.trim()}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Send as a mystery 👻'}
          </button>
        </div>
      </div>
    </Portal>
  );
}
