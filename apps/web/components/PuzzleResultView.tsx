'use client';

// Daily puzzle share bubble (v0.4 — API.md §1.27). SERVER-built from the
// sender's stored attempt: score rows only ('g'/'y'/'x'), no letters, no word —
// spoiler-free and unforgeable. A shared grid is the ONLY leaderboard-like
// surface; no rankings, no streaks, anywhere (PSYCHOLOGY never-build list).
import Link from 'next/link';
import { PUZZLE_MAX_GUESSES, PUZZLE_SCORE_EMOJI, type PuzzleResultMetadata } from '@socialchat/shared';
import exp from './expression.module.css';

export default function PuzzleResultView({ puzzle, own }: { puzzle: PuzzleResultMetadata; own: boolean }) {
  const score = puzzle.solved ? `${puzzle.attempts_used}/${PUZZLE_MAX_GUESSES}` : `X/${PUZZLE_MAX_GUESSES}`;
  return (
    <div className={exp.puzzleShare}>
      <span className={exp.puzzleShareHead}>🧩 Daily puzzle · {puzzle.date} · {score}</span>
      <span className={exp.puzzleShareGrid} aria-label={`Puzzle grid, ${puzzle.grid.length} guesses, ${puzzle.solved ? 'solved' : 'not solved'}`}>
        {puzzle.grid.map((row, i) => (
          <span key={i} style={{ display: 'block' }} aria-hidden>
            {[...row].map((c) => PUZZLE_SCORE_EMOJI[c as 'g' | 'y' | 'x'] ?? '⬜').join('')}
          </span>
        ))}
      </span>
      {!own ? (
        <Link href="/puzzle" className={exp.puzzleShareLink}>
          Play today’s puzzle →
        </Link>
      ) : null}
    </div>
  );
}
