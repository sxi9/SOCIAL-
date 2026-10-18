'use client';

// The anonymous reveal-game thread (v0.8b — API.md §1.62, FEATURES #77).
// Ghost-styled for BOTH sides, deliberately smaller than a chat: text only,
// no receipts, no typing, no reactions. The recipient watches the sender's
// avatar un-blur under a timer (SERVER-rendered blur — the real pixels never
// ship early); the riddle reveal is the sender's call ("that's right ✓").
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ANON_BODY_MAX_CHARS, ANON_RIDDLE_MAX_CHARS, ANON_TIMER_PRESETS_S } from '@socialchat/shared';
import type { AnonMessage, AnonThread } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  anonAvatarUrl,
  answerRiddle,
  blurFactor,
  deleteAnonThread,
  isRevealed,
  listAnonMessages,
  refreshAnonThreads,
  requestReveal,
  revealNow,
  sendAnonMessage,
  setReveal,
  timerLabel,
} from '@/lib/anon';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import { useAppState } from '@/lib/useStore';
import { useNow } from '@/lib/useNow';
import { useReducedMotion } from '@/lib/useReducedMotion';
import Avatar from './Avatar';
import Portal from './Portal';
import ReportSheet from './ReportSheet';
import cm from './community.module.css';
import { confirmDialog } from '@/lib/confirm';

export default function AnonThreadView({ threadId }: { threadId: string }) {
  const state = useAppState();
  const router = useRouter();
  const now = useNow(1000);
  const reducedMotion = useReducedMotion();
  const thread = state.anonThreads?.find((t) => t.id === threadId) ?? null;
  const messages = state.anonMessages.get(threadId) ?? [];

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reporting, setReporting] = useState<AnonMessage | null>(null);
  const [revealMoment, setRevealMoment] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevRevealedRef = useRef<boolean | null>(null);

  // Reconnect truth: the thread list GET (frames patch live).
  useEffect(() => {
    if (state.anonThreads === null) void refreshAnonThreads();
  }, [state.anonThreads]);

  // Load the message window (created_at ASC; cursor pages older).
  useEffect(() => {
    let cancelled = false;
    void listAnonMessages(threadId, null)
      .then((res) => {
        if (cancelled) return;
        store.setAnonMessages(threadId, res.messages);
        setCursor(res.next_cursor);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Pin to bottom on new messages.
  const lastId = messages.length ? messages[messages.length - 1].id : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const revealed = thread ? isRevealed(thread, now) : false;

  // The reveal moment: fire once when the mask comes off while watching.
  useEffect(() => {
    if (!thread) return;
    if (prevRevealedRef.current === null) {
      prevRevealedRef.current = revealed;
      return;
    }
    if (!prevRevealedRef.current && revealed) {
      prevRevealedRef.current = true;
      setRevealMoment(true);
    }
  }, [thread, revealed]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendAnonMessage(threadId, text);
      setDraft('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('This thread isn’t taking messages any more.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — message limit for this hour.');
      } else {
        setError('Could not send — try again.');
      }
    } finally {
      setBusy(false);
    }
  }, [draft, busy, threadId]);

  async function olderPage(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await listAnonMessages(threadId, cursor);
      store.setAnonMessages(threadId, [...res.messages, ...messages]);
      setCursor(res.next_cursor);
    } catch {
      /* keep the button */
    }
  }

  async function removeThread(): Promise<void> {
    if (!(await confirmDialog('Delete this whole game, for both of you? There is no archive.'))) return;
    try {
      await deleteAnonThread(threadId);
      toast('Gone — for both of you');
      router.replace('/anon');
    } catch {
      toast('Could not delete it');
    }
  }

  if (!thread) {
    return (
      <div className="page">
        <header className="topbar">
          <Link href="/anon" className="btn btn-ghost btn-icon" aria-label="Back">
            ←
          </Link>
          <h1>🎭 Anonymous</h1>
          <span />
        </header>
        <div className="center-screen muted" role="status">
          {state.anonThreads === null || !loaded ? 'Loading…' : 'This thread is gone.'}
        </div>
      </div>
    );
  }

  const isSender = thread.role === 'sender';
  const counterpart = thread.counterpart;
  const factor = blurFactor(thread, now);
  const mineIs = isSender; // from_sender === true is mine iff I'm the sender

  return (
    <div className={`page ${cm.anonPage}`}>
      <header className="topbar">
        <Link href="/anon" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        {isSender || revealed ? (
          counterpart ? (
            <Link href={`/u/${encodeURIComponent(counterpart.username)}`} aria-label="Open profile">
              <Avatar avatar={counterpart.avatar} name={counterpart.display_name} size={36} />
            </Link>
          ) : (
            <span className={cm.maskedAvatar} style={{ width: 36, height: 36 }} aria-hidden>
              <span className={cm.anonGhostGlyph}>👻</span>
            </span>
          )
        ) : (
          <span className={cm.maskedAvatar} style={{ width: 36, height: 36 }} aria-label="Mystery sender">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={anonAvatarUrl(thread.id, now)} alt="" />
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 15, margin: 0 }}>
            {isSender
              ? counterpart?.display_name ?? 'Them'
              : revealed && counterpart
                ? counterpart.display_name
                : 'Mystery sender'}
          </h1>
          <p className="muted small" style={{ margin: 0 }}>
            {isSender
              ? revealed
                ? 'revealed — they know it’s you'
                : '👻 you’re anonymous to them'
              : revealed
                ? 'the mystery is over'
                : thread.reveal_mode === 'timer'
                  ? `un-blurring… ${Math.round((1 - factor) * 100)}%`
                  : '🎭 anonymous game'}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Delete this game" onClick={() => void removeThread()}>
          🗑
        </button>
      </header>

      <div ref={scrollRef} className={cm.anonThreadScroll}>
        {cursor ? (
          <button type="button" className="btn" style={{ alignSelf: 'center' }} onClick={() => void olderPage()}>
            Load earlier
          </button>
        ) : null}

        <GameCard thread={thread} now={now} revealed={revealed} messages={messages} />

        {messages.map((m) => {
          const mine = m.from_sender === mineIs;
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
              <div
                className={`${cm.anonBubble}${mine ? ` ${cm.anonBubbleMine}` : ''}${m.is_riddle_answer ? ` ${cm.anonRiddleAnswer}` : ''}`}
              >
                {m.is_riddle_answer ? <span aria-hidden>🧩 </span> : null}
                {m.body}
              </div>
              <span className={cm.anonBubbleMeta}>
                {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {!mine ? (
                  <button
                    type="button"
                    className={cm.anonFlagBtn}
                    aria-label="Report this message (the sender's identity is attached for moderators)"
                    onClick={() => setReporting(m)}
                  >
                    ⚑ report
                  </button>
                ) : null}
                {m.is_riddle_answer && isSender && !revealed ? (
                  <RiddleConfirm threadId={thread.id} />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {error ? (
        <p className="error-text" style={{ margin: '4px 14px' }}>
          {error}
        </p>
      ) : null}
      <div className={cm.anonComposer}>
        <input
          className="input"
          placeholder={isSender ? 'Reply (still anonymous)…' : 'Reply to the mystery…'}
          value={draft}
          maxLength={ANON_BODY_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>

      {reporting ? (
        <ReportSheet
          target={{ kind: 'anon_message', thread_id: thread.id, message_id: reporting.id }}
          onClose={() => setReporting(null)}
        />
      ) : null}

      {revealMoment ? (
        <Portal>
          <div className={cm.revealOverlay} role="dialog" aria-modal="true" aria-label="Revealed">
            <div className={cm.revealCard}>
              {counterpart ? (
                <span className={reducedMotion ? undefined : cm.revealFace} style={{ display: 'inline-flex' }}>
                  <Avatar avatar={counterpart.avatar} name={counterpart.display_name} size={96} animated />
                </span>
              ) : (
                <span style={{ fontSize: 52 }} aria-hidden>
                  🎭
                </span>
              )}
              <h2 style={{ margin: 0 }}>
                {isSender
                  ? 'The mask is off 🎭'
                  : `It was ${counterpart?.display_name ?? 'them'} all along!`}
              </h2>
              {!isSender && counterpart ? (
                <Link href={`/u/${encodeURIComponent(counterpart.username)}`} className="btn btn-primary" style={{ width: '100%' }}>
                  See their profile →
                </Link>
              ) : null}
              <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setRevealMoment(false)}>
                Back to the chat
              </button>
            </div>
          </div>
        </Portal>
      ) : null}
    </div>
  );
}

/** The sender's "that's right ✓" on a riddle answer = the §1.62 reveal. */
function RiddleConfirm({ threadId }: { threadId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={cm.anonFlagBtn}
      style={{ color: 'var(--ok)' }}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void revealNow(threadId)
          .catch(() => toast('Could not reveal — try again'))
          .finally(() => setBusy(false));
      }}
    >
      that&rsquo;s right ✓ (reveals you)
    </button>
  );
}

/** The game state card: reveal request, timer un-blur, riddle, controls. */
function GameCard({
  thread,
  now,
  revealed,
  messages,
}: {
  thread: AnonThread;
  now: number;
  revealed: boolean;
  messages: AnonMessage[];
}) {
  const isSender = thread.role === 'sender';
  const factor = blurFactor(thread, now);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'idle' | 'riddle'>('idle');
  const [riddleQ, setRiddleQ] = useState('');
  const [answer, setAnswer] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, fail: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setMode('idle');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_revealed') setErr('Already revealed.');
      else setErr(fail);
    } finally {
      setBusy(false);
    }
  }

  if (revealed) {
    return (
      <div className={cm.anonGameCard} role="status">
        <h3>🎉 Revealed</h3>
        <p style={{ margin: 0 }}>
          {isSender ? 'They know it’s you now. The game is over — the words stay.' : 'Mystery solved. The words stay.'}
        </p>
      </div>
    );
  }

  // ---- Recipient side ----
  if (!isSender) {
    return (
      <div className={cm.anonGameCard}>
        <h3>👻 Someone&rsquo;s being mysterious</h3>
        {thread.reveal_mode === 'timer' && thread.reveal_at ? (
          <>
            <p style={{ margin: 0 }}>
              They picked a <strong>{thread.reveal_timer_s ? timerLabel(thread.reveal_timer_s) : ''} timer</strong> — their
              face un-blurs as it runs out ({fmtRemaining(new Date(thread.reveal_at).getTime() - now)} left).
            </p>
            <div className={cm.anonTimerBar} aria-hidden>
              <span className={cm.anonTimerFill} style={{ width: `${Math.round((1 - factor) * 100)}%` }} />
            </div>
            <span className={`${cm.maskedAvatar} ${cm.maskedAvatarBig}`} style={{ alignSelf: 'center' }} aria-label="Their avatar, still blurred">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={anonAvatarUrl(thread.id, now)} alt="" />
            </span>
          </>
        ) : thread.reveal_mode === 'riddle' && thread.riddle_q ? (
          <>
            <p style={{ margin: 0 }}>
              They set a riddle — a satisfying answer reveals them (they judge it):
            </p>
            <p style={{ margin: 0, fontStyle: 'italic' }}>&ldquo;{thread.riddle_q}&rdquo;</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 16 }}
                placeholder="Your answer…"
                value={answer}
                maxLength={ANON_RIDDLE_MAX_CHARS}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !answer.trim()}
                onClick={() =>
                  void run(async () => {
                    await answerRiddle(thread.id, answer.trim());
                    setAnswer('');
                  }, 'Could not send the answer.')
                }
              >
                Guess
              </button>
            </div>
            {messages.some((m) => m.is_riddle_answer) ? (
              <p className="muted small" style={{ margin: 0 }}>
                Guesses land in the thread — they tap &ldquo;that&rsquo;s right&rdquo; when one earns the reveal.
              </p>
            ) : null}
          </>
        ) : thread.reveal_requested ? (
          <p style={{ margin: 0 }}>
            You asked who they are. Now they pick: a timer, a riddle, or just telling you. No nagging — it&rsquo;s their move.
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>Curious? Ask who they are — they pick how (or whether) to reveal.</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void run(() => requestReveal(thread.id), 'Could not ask — try again.')}
            >
              🔍 Request reveal
            </button>
          </>
        )}
        {err ? <p className="error-text" style={{ margin: 0 }}>{err}</p> : null}
      </div>
    );
  }

  // ---- Sender side ----
  return (
    <div className={cm.anonGameCard}>
      <h3>🎭 You&rsquo;re the mystery</h3>
      {thread.reveal_requested ? (
        <p style={{ margin: 0 }}>
          <strong>They asked who you are.</strong> Pick a game — or ignore it, that&rsquo;s allowed too.
        </p>
      ) : (
        <p style={{ margin: 0 }}>They haven&rsquo;t asked who you are (yet). You can reveal any time.</p>
      )}
      {thread.reveal_mode === 'timer' && thread.reveal_at ? (
        <>
          <p style={{ margin: 0 }}>
            ⏳ Timer set ({thread.reveal_timer_s ? timerLabel(thread.reveal_timer_s) : ''}): your avatar un-blurs for them —{' '}
            {fmtRemaining(new Date(thread.reveal_at).getTime() - now)} to go.
          </p>
          <div className={cm.anonTimerBar} aria-hidden>
            <span className={cm.anonTimerFill} style={{ width: `${Math.round((1 - factor) * 100)}%` }} />
          </div>
        </>
      ) : null}
      {thread.reveal_mode === 'riddle' && thread.riddle_q ? (
        <p style={{ margin: 0 }}>
          🧩 Riddle set: &ldquo;{thread.riddle_q}&rdquo; — tap &ldquo;that&rsquo;s right ✓&rdquo; on a worthy guess.
        </p>
      ) : null}

      {mode === 'riddle' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, fontSize: 16 }}
            placeholder="Your riddle — “what did I spill on you in 9th grade?”"
            value={riddleQ}
            maxLength={ANON_RIDDLE_MAX_CHARS}
            onChange={(e) => setRiddleQ(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !riddleQ.trim()}
            onClick={() =>
              void run(async () => {
                await setReveal(thread.id, { mode: 'riddle', riddle_q: riddleQ.trim() });
                setRiddleQ('');
              }, 'Could not set the riddle.')
            }
          >
            Set
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ANON_TIMER_PRESETS_S.map((s) => (
            <button
              key={s}
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => setReveal(thread.id, { mode: 'timer', timer_s: s as 3600 | 21600 | 86400 }),
                  'Could not set the timer.'
                )
              }
            >
              ⏳ {timerLabel(s)}
            </button>
          ))}
          <button type="button" className="btn" disabled={busy} onClick={() => setMode('riddle')}>
            🧩 Riddle
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              void confirmDialog('Reveal yourself now? This can’t be undone.', {
                confirmLabel: 'Reveal',
                danger: false,
              }).then((ok) => {
                if (ok) void run(() => revealNow(thread.id), 'Could not reveal.');
              });
            }}
          >
            🎉 Reveal now
          </button>
        </div>
      )}
      {err ? <p className="error-text" style={{ margin: 0 }}>{err}</p> : null}
    </div>
  );
}

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}
