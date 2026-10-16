'use client';

// Vibe check composer (v0.4 — API.md §1.23): pick a prompt from the rotating
// deck or write your own; the prompt IS the body of a type='vibe_check' message.
import { useEffect, useMemo, useState } from 'react';
import { VIBE_CHECK_PROMPT_MAX_CHARS, VIBE_CHECK_PROMPTS } from '@socialchat/shared';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

interface VibeCheckSheetProps {
  onClose: () => void;
  /** Resolves when the vibe message is sent; the sheet closes itself. */
  onSend: (prompt: string) => Promise<void>;
}

const DECK_PAGE = 4;

export default function VibeCheckSheet({ onClose, onSend }: VibeCheckSheetProps) {
  const [offset, setOffset] = useState(() => Math.floor(Math.random() * VIBE_CHECK_PROMPTS.length));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hand = useMemo(
    () =>
      Array.from(
        { length: DECK_PAGE },
        (_, i) => VIBE_CHECK_PROMPTS[(offset + i) % VIBE_CHECK_PROMPTS.length]
      ),
    [offset]
  );

  async function send(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(trimmed.slice(0, VIBE_CHECK_PROMPT_MAX_CHARS));
      onClose();
    } catch {
      setError('Could not start the vibe check — try again.');
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
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Start a vibe check">
        <div className={sheetStyles.sheetHead}>
          <h2>🎭 Vibe check</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          Everyone answers with a photo, a doodle, or their face. One answer each.
        </p>

        <div className={sheetStyles.sheetLabel}>From the deck</div>
        <div className={exp.deckList}>
          {hand.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className={exp.deckCard}
              disabled={busy}
              onClick={() => void send(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn ${exp.deckShuffle}`}
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={() => setOffset((o) => (o + DECK_PAGE) % VIBE_CHECK_PROMPTS.length)}
        >
          Shuffle the deck
        </button>

        <div className={sheetStyles.sheetLabel}>Or ask your own</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            placeholder="your prompt…"
            value={custom}
            maxLength={VIBE_CHECK_PROMPT_MAX_CHARS}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send(custom);
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !custom.trim()}
            onClick={() => void send(custom)}
          >
            Ask
          </button>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </div>
  );
}
