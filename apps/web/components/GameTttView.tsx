'use client';

// Tic-tac-toe board bubble (v0.4 — API.md §1.27). The WHOLE game state lives in
// metadata.game; moves are SERVER-validated (POST /api/games/:messageId/move)
// and arrive back as msg.updated full-DTO replacements — the client never
// computes game state. No rematch counters, no win tallies (PSYCHOLOGY rule 3).
import { useState } from 'react';
import type { ConversationListItem, GameMessageResponse, Message } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import * as store from '@/lib/store';
import exp from './expression.module.css';

interface GameTttViewProps {
  message: Message;
  conv: ConversationListItem;
  meId: string;
  nameFor: (userId: string, fallback: string) => string;
}

export default function GameTttView({ message, conv, meId, nameFor }: GameTttViewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const game = message.metadata.game;
  if (!game) return null;

  const nameOf = (userId: string): string => {
    const p = conv.participants.find((x) => x.user.id === userId);
    const fallback = p?.user.display_name ?? 'Someone';
    return userId === meId ? 'You' : nameFor(userId, fallback);
  };

  const mySymbol = game.players.x === meId ? 'x' : game.players.o === meId ? 'o' : null;
  const myTurn = mySymbol !== null && game.winner === null && game.turn === mySymbol;

  const status =
    game.winner === 'draw'
      ? 'It’s a draw!'
      : game.winner
        ? game.players[game.winner] === meId
          ? 'You won! 🎉'
          : `${nameOf(game.players[game.winner])} won!`
        : myTurn
          ? 'Your turn'
          : `${nameOf(game.players[game.turn])}’s turn`;

  async function move(cell: number): Promise<void> {
    if (busy || !myTurn || game!.board[cell] !== null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<GameMessageResponse>(`/api/games/${message.id}/move`, { cell });
      store.replaceMessage(res.message);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'game_not_your_turn') setError('Not your turn.');
      else if (err instanceof ApiError && err.code === 'game_cell_taken') setError('That square is taken.');
      else if (err instanceof ApiError && err.code === 'game_over') setError('This game is over.');
      else setError('Move didn’t land — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={exp.ttt}>
      <span className={exp.tttHead} aria-hidden>
        🎮 {nameOf(game.players.x)} vs {nameOf(game.players.o)}
      </span>
      <div className={exp.tttBoard} role="grid" aria-label={`Tic-tac-toe board. ${status}`}>
        {game.board.map((cell, i) => (
          <button
            key={i}
            type="button"
            role="gridcell"
            className={exp.tttCell}
            aria-label={`Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}${cell ? `: ${cell.toUpperCase()}` : ', empty'}`}
            disabled={busy || !myTurn || cell !== null}
            onClick={() => void move(i)}
          >
            {cell ? (
              <span className={`${exp.tttMark} ${cell === 'x' ? exp.tttX : exp.tttO}`} aria-hidden>
                {cell === 'x' ? '✕' : '◯'}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <span className={`${exp.tttStatus}${myTurn ? ` ${exp.tttStatusMine}` : ''}`} role="status">
        {status}
        {mySymbol && game.winner === null ? ` · you are ${mySymbol === 'x' ? '✕' : '◯'}` : ''}
      </span>
      {error ? <span className="error-text">{error}</span> : null}
    </div>
  );
}
