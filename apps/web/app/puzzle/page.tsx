'use client';

// Daily word puzzle (v0.4 — API.md §1.27, FEATURES #38). One word per UTC day,
// guesses scored SERVER-side only (the page never knows the word until it's
// over — and even then only implicitly). Sharing the no-spoiler emoji grid
// into a chat is the ONLY social surface: friends-who-shared are listed by
// username, never ranked; no streaks, no leaderboards, ever (PSYCHOLOGY).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  PUZZLE_MAX_GUESSES,
  PUZZLE_SCORE_EMOJI,
  PUZZLE_WORD_LENGTH,
  type PuzzleFriendsResponse,
  type PuzzleGuessResponse,
  type PuzzleTodayResponse,
  type SendMessageResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { uuidv7 } from '@/lib/ids';
import { conversationTitle } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import sheetStyles from '@/components/beacons.module.css';
import styles from './puzzle.module.css';

const KB_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const;

type ScoreChar = 'g' | 'y' | 'x';

function gridEmoji(rows: string[]): string[] {
  return rows.map((row) => [...row].map((c) => PUZZLE_SCORE_EMOJI[c as ScoreChar] ?? '⬜').join(''));
}

function PuzzlePage() {
  const appState = useAppState();
  const router = useRouter();
  const [today, setToday] = useState<PuzzleTodayResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [friends, setFriends] = useState<PuzzleFriendsResponse['friends']>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<PuzzleTodayResponse>('/api/puzzle/today')
      .then((res) => {
        if (!cancelled) setToday(res);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    void api
      .get<PuzzleFriendsResponse>('/api/puzzle/today/friends')
      .then((res) => {
        if (!cancelled) setFriends(res.friends);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const finished = today !== null && (today.solved || today.remaining === 0);

  const submitGuess = useCallback(async () => {
    if (!today || finished || busy) return;
    if (guess.length !== PUZZLE_WORD_LENGTH) {
      setNote('Five letters needed.');
      setShake((s) => s + 1);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await api.post<PuzzleGuessResponse>('/api/puzzle/guess', { guess });
      setToday(res);
      setGuess('');
      if (res.correct) setNote('You got it! 🎉');
      else if (res.remaining === 0) setNote('Out of guesses — tomorrow is a fresh word.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'puzzle_done') {
        setNote('Today’s puzzle is already finished.');
        void api
          .get<PuzzleTodayResponse>('/api/puzzle/today')
          .then(setToday)
          .catch(() => undefined);
      } else if (err instanceof ApiError && err.code === 'bad_guess') {
        setNote('Letters a–z only.');
        setShake((s) => s + 1);
      } else {
        setNote('That didn’t land — try again.');
      }
    } finally {
      setBusy(false);
    }
  }, [today, finished, busy, guess]);

  const onKey = useCallback(
    (key: string) => {
      if (!today || finished || busy) return;
      if (key === 'enter') {
        void submitGuess();
      } else if (key === 'back') {
        setGuess((g) => g.slice(0, -1));
        setNote(null);
      } else if (/^[a-z]$/.test(key)) {
        setGuess((g) => (g.length < PUZZLE_WORD_LENGTH ? g + key : g));
        setNote(null);
      }
    },
    [today, finished, busy, submitGuess]
  );

  // Physical keyboard plays too (desktop-first accessibility).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Enter') onKey('enter');
      else if (e.key === 'Backspace') onKey('back');
      else if (/^[a-zA-Z]$/.test(e.key)) onKey(e.key.toLowerCase());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onKey]);

  // Best-known state per letter for keyboard coloring (g beats y beats x).
  const keyStates = useMemo(() => {
    const map = new Map<string, ScoreChar>();
    if (!today) return map;
    for (const a of today.attempts) {
      [...a.guess].forEach((ch, i) => {
        const s = a.score[i] as ScoreChar;
        const prev = map.get(ch);
        if (!prev || (prev !== 'g' && (s === 'g' || (s === 'y' && prev === 'x')))) map.set(ch, s);
      });
    }
    return map;
  }, [today]);

  async function shareTo(conversationId: string): Promise<void> {
    if (shareBusy) return;
    setShareBusy(true);
    setShareError(null);
    try {
      await api.post<SendMessageResponse>(`/api/conversations/${conversationId}/messages`, {
        client_msg_id: uuidv7(),
        type: 'puzzle_result',
      });
      setShareOpen(false);
      router.push(`/c/${conversationId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'puzzle_unfinished') {
        setShareError('Finish the puzzle first.');
      } else {
        setShareError('Could not share — try again.');
      }
      setShareBusy(false);
    }
  }

  const conversations = [...appState.conversations.values()].sort((a, b) => {
    const ka = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const kb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return kb - ka;
  });

  const rows: { letters: string; score: string | null; typed: boolean }[] = [];
  if (today) {
    for (const a of today.attempts) rows.push({ letters: a.guess, score: a.score, typed: false });
    if (!finished) rows.push({ letters: guess, score: null, typed: true });
    while (rows.length < PUZZLE_MAX_GUESSES) rows.push({ letters: '', score: null, typed: false });
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>🧩 Daily puzzle</h1>
        <span />
      </header>

      {loadError ? (
        <div className="center-screen muted" role="status">
          Could not load today’s puzzle — pull back in later.
        </div>
      ) : !today ? (
        <div className="center-screen muted" role="status">
          Loading…
        </div>
      ) : (
        <div className={styles.wrap}>
          <span className={styles.dateLine}>
            {today.date} · one word a day, six tries · guesses stay private unless you share
          </span>

          <div className={styles.grid} role="group" aria-label="Your guesses">
            {rows.slice(0, PUZZLE_MAX_GUESSES).map((row, ri) => (
              <div
                key={ri}
                className={`${styles.gridRow}${row.typed && shake > 0 && note !== null ? ` ${styles.shakeRow}` : ''}`}
              >
                {Array.from({ length: PUZZLE_WORD_LENGTH }, (_, ci) => {
                  const ch = row.letters[ci] ?? '';
                  const sc = row.score?.[ci] as ScoreChar | undefined;
                  const cls = sc
                    ? `${styles.tile} ${styles.tileScored} ${sc === 'g' ? styles.tileG : sc === 'y' ? styles.tileY : styles.tileX}`
                    : `${styles.tile}${ch ? ` ${styles.tileTyped}` : ''}`;
                  return (
                    <span
                      key={ci}
                      className={cls}
                      style={sc ? { animationDelay: `${ci * 70}ms` } : undefined}
                      aria-label={ch ? `${ch}${sc ? `, ${sc === 'g' ? 'correct' : sc === 'y' ? 'wrong spot' : 'not in the word'}` : ''}` : 'empty'}
                    >
                      {ch}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>

          {note ? (
            <span role="status" className={today.solved ? 'ok-text' : 'muted small'}>
              {note}
            </span>
          ) : null}

          {finished ? (
            <div className={styles.doneCard}>
              <h2>{today.solved ? `Solved in ${today.attempts.length}/${PUZZLE_MAX_GUESSES}` : 'Not today!'}</h2>
              <span className={styles.doneGrid} aria-hidden>
                {gridEmoji(today.attempts.map((a) => a.score)).map((r, i) => (
                  <span key={i} style={{ display: 'block' }}>
                    {r}
                  </span>
                ))}
              </span>
              <p className="muted small" style={{ margin: 0 }}>
                Share the grid — colors only, no spoilers.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setShareOpen(true)}>
                Share to a chat
              </button>
            </div>
          ) : (
            <div className={styles.kb} role="group" aria-label="Keyboard">
              {KB_ROWS.map((rowKeys, ri) => (
                <div key={ri} className={styles.kbRow}>
                  {ri === 2 ? (
                    <button
                      type="button"
                      className={`${styles.key} ${styles.keyWide}`}
                      disabled={busy}
                      onClick={() => onKey('enter')}
                    >
                      Enter
                    </button>
                  ) : null}
                  {[...rowKeys].map((k) => {
                    const st = keyStates.get(k);
                    const cls = `${styles.key}${st === 'g' ? ` ${styles.keyG}` : st === 'y' ? ` ${styles.keyY}` : st === 'x' ? ` ${styles.keyX}` : ''}`;
                    return (
                      <button key={k} type="button" className={cls} disabled={busy} onClick={() => onKey(k)}>
                        {k}
                      </button>
                    );
                  })}
                  {ri === 2 ? (
                    <button
                      type="button"
                      className={`${styles.key} ${styles.keyWide}`}
                      aria-label="Backspace"
                      disabled={busy}
                      onClick={() => onKey('back')}
                    >
                      ⌫
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {friends.length > 0 ? (
            <div className={styles.friends}>
              <h2>Friends who shared today</h2>
              <div className={styles.friendStrip}>
                {friends.map((f) => (
                  <div key={f.user.id} className={styles.friendCard}>
                    <Avatar avatar={f.user.avatar} name={f.user.display_name} size={36} />
                    <span className={styles.friendName}>{f.user.display_name}</span>
                    <span className={styles.friendGrid} aria-hidden>
                      {gridEmoji(f.result.grid).map((r, i) => (
                        <span key={i} style={{ display: 'block' }}>
                          {r}
                        </span>
                      ))}
                    </span>
                    <span className={styles.friendScore}>
                      {f.result.solved ? `${f.result.attempts_used}/${PUZZLE_MAX_GUESSES}` : `X/${PUZZLE_MAX_GUESSES}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {shareOpen ? (
        <div
          className={sheetStyles.sheetBackdrop}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShareOpen(false);
          }}
        >
          <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Share your result">
            <div className={sheetStyles.sheetHead}>
              <h2>Share to…</h2>
              <button
                type="button"
                className={sheetStyles.sheetClose}
                aria-label="Close"
                onClick={() => setShareOpen(false)}
              >
                ×
              </button>
            </div>
            {conversations.length === 0 ? (
              <p className={sheetStyles.receiptMuted}>No conversations yet — start one first.</p>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={styles.convPickRow}
                  disabled={shareBusy}
                  onClick={() => void shareTo(c.id)}
                >
                  <Avatar avatar={c.avatar} name={conversationTitle(c, appState.me?.id)} size={34} />
                  <span className={sheetStyles.receiptName}>{conversationTitle(c, appState.me?.id)}</span>
                </button>
              ))
            )}
            {shareError ? <p className="error-text">{shareError}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <AppShell>
      <PuzzlePage />
    </AppShell>
  );
}
