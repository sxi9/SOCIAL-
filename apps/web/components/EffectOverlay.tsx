'use client';

// Full-screen one-shot message effect (v0.4 — API.md §1.22). Mounted only after
// lib/effects.claimFirstView() granted the single play for this viewer, and
// NEVER under prefers-reduced-motion (the caller renders the static badge
// instead — a full replacement, not a toned-down animation). No sound, ever.
import { useEffect, useMemo } from 'react';
import type { MessageEffect } from '@socialchat/shared';
import exp from './expression.module.css';

const CONFETTI_COLORS = ['#ffd166', '#6f8cff', '#4cd4a0', '#ff6b6b', '#f48ebd', '#4fc3e8'];

interface EffectOverlayProps {
  effect: MessageEffect;
  onDone: () => void;
}

interface Piece {
  key: number;
  cls: string;
  style: React.CSSProperties & Record<string, string>;
  char?: string;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function buildPieces(effect: MessageEffect): { pieces: Piece[]; durationMs: number } {
  const pieces: Piece[] = [];
  if (effect === 'confetti') {
    for (let i = 0; i < 90; i++) {
      pieces.push({
        key: i,
        cls: `${exp.fxPiece} ${exp.fxConfetti}`,
        style: {
          '--x': `${rand(0, 100)}vw`,
          '--d': `${rand(1.8, 3)}s`,
          '--delay': `${rand(0, 0.7)}s`,
          '--r': `${rand(240, 900)}deg`,
          '--c': CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        } as Piece['style'],
      });
    }
    return { pieces, durationMs: 3800 };
  }
  if (effect === 'snow') {
    for (let i = 0; i < 60; i++) {
      pieces.push({
        key: i,
        cls: exp.fxPiece,
        char: '❄️',
        style: {
          '--x': `${rand(0, 100)}vw`,
          '--d': `${rand(2.6, 4.2)}s`,
          '--delay': `${rand(0, 1)}s`,
          '--r': `${rand(90, 360)}deg`,
          '--s': `${rand(10, 22)}px`,
        } as Piece['style'],
      });
    }
    return { pieces, durationMs: 5300 };
  }
  if (effect === 'hearts') {
    for (let i = 0; i < 26; i++) {
      pieces.push({
        key: i,
        cls: exp.fxRise,
        char: i % 3 === 0 ? '💗' : i % 3 === 1 ? '❤️' : '💞',
        style: {
          '--x': `${rand(4, 94)}vw`,
          '--d': `${rand(2.2, 3.4)}s`,
          '--delay': `${rand(0, 1)}s`,
          '--s': `${rand(16, 32)}px`,
          '--sway': `${rand(-50, 50)}px`,
        } as Piece['style'],
      });
    }
    return { pieces, durationMs: 4500 };
  }
  // fireworks
  for (let i = 0; i < 16; i++) {
    pieces.push({
      key: i,
      cls: exp.fxBurst,
      char: i % 2 === 0 ? '🎆' : '✨',
      style: {
        '--x': `${rand(8, 88)}vw`,
        '--y': `${rand(10, 60)}vh`,
        '--d': `${rand(1, 1.7)}s`,
        '--delay': `${rand(0, 1.4)}s`,
        '--s': `${rand(24, 44)}px`,
      } as Piece['style'],
    });
  }
  return { pieces, durationMs: 3400 };
}

export default function EffectOverlay({ effect, onDone }: EffectOverlayProps) {
  const { pieces, durationMs } = useMemo(() => buildPieces(effect), [effect]);

  useEffect(() => {
    const t = setTimeout(onDone, durationMs);
    return () => clearTimeout(t);
  }, [durationMs, onDone]);

  return (
    <div className={exp.fxOverlay} aria-hidden>
      {pieces.map((p) => (
        <span key={p.key} className={p.cls} style={p.style}>
          {p.char}
        </span>
      ))}
    </div>
  );
}
