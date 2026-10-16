// Daily word puzzle (v0.4 — API.md §1.27, ADR-010). One deterministic 5-letter
// word per UTC day: PUZZLE_WORDLIST[sha256(`${yyyy-mm-dd}:${PUZZLE_SECRET}`)
// mod length]. The wordlist is public shared code; the secret is server-side
// env, so clients can never precompute the word — and the DB never stores it
// (puzzle_attempts holds only guesses + scores). Guesses are scored
// SERVER-side only. NO leaderboard, NO rankings, NO streaks, ever
// (PSYCHOLOGY never-build list).
import { createHash } from 'node:crypto';
import {
  PUZZLE_WORD_LENGTH,
  PUZZLE_WORDLIST,
  type PuzzleAttempt,
} from '@socialchat/shared';
import { config } from '../../config.js';

/** The current puzzle day — UTC by contract ('YYYY-MM-DD'). */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Deterministic word for one UTC day. Exported with an explicit secret
 * parameter so tests can pin it. */
export function wordForDate(date: string, secret = config.puzzleSecret): string {
  const hex = createHash('sha256').update(`${date}:${secret}`).digest('hex');
  const idx = Number(BigInt(`0x${hex}`) % BigInt(PUZZLE_WORDLIST.length));
  return PUZZLE_WORDLIST[idx]!;
}

/**
 * Wordle-style scoring: 5 chars of g/y/x. Greens are claimed first; the
 * remaining letters supply yellows left-to-right while supply lasts, so
 * duplicate letters never over-score (API.md §1.27).
 */
export function scoreGuess(guess: string, word: string): string {
  const res: ('g' | 'y' | 'x')[] = new Array(PUZZLE_WORD_LENGTH).fill('x');
  const supply = new Map<string, number>();
  for (let i = 0; i < PUZZLE_WORD_LENGTH; i++) {
    if (guess[i] === word[i]) {
      res[i] = 'g';
    } else {
      supply.set(word[i]!, (supply.get(word[i]!) ?? 0) + 1);
    }
  }
  for (let i = 0; i < PUZZLE_WORD_LENGTH; i++) {
    if (res[i] === 'g') continue;
    const c = guess[i]!;
    const n = supply.get(c) ?? 0;
    if (n > 0) {
      res[i] = 'y';
      supply.set(c, n - 1);
    }
  }
  return res.join('');
}

export function parseGuesses(raw: unknown): PuzzleAttempt[] {
  return Array.isArray(raw) ? (raw as PuzzleAttempt[]) : [];
}
