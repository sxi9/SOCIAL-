'use client';

// v0.6 app-wide overlays, mounted once inside AppShell so they work on every
// page: the incoming-call overlay + in-call screen (§1.42), the mutual-wave
// match moment (§1.44), roulette navigation + the goodbye screen (§1.45), and
// the pending private expectation-feedback sheet (§1.45 prompt rule).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { feedbackSeen } from '@/lib/discovery';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import { useReducedMotion } from '@/lib/useReducedMotion';
import Avatar from './Avatar';
import CallOverlay from './CallOverlay';
import EffectOverlay from './EffectOverlay';
import ExpectationFeedback from './ExpectationFeedback';
import Mascot from './Mascot';
import PushExplainer from './PushExplainer';
import Toast from './Toast';
import styles from './discovery.module.css';

export default function GlobalOverlays() {
  const state = useAppState();
  const router = useRouter();

  // A fresh roulette match pulls the user straight into the provisional DM.
  const nav = state.rouletteMatchNav;
  useEffect(() => {
    if (!nav) return;
    store.setRouletteMatchNav(null);
    router.push(`/c/${nav}`);
  }, [nav, router]);

  return (
    <>
      <CallOverlay />
      {/* v0.7.1 (§1.56): THE shared toast host + the one-time push explainer. */}
      <Toast />
      <PushExplainer />
      {state.discoveryMatch ? <MatchOverlay /> : null}
      {state.rouletteGoodbye ? <RouletteGoodbye conversationId={state.rouletteGoodbye} /> : null}
      {!state.rouletteGoodbye && state.feedbackAsk ? (
        <ExpectationFeedback
          context={state.feedbackAsk.context}
          conversationId={state.feedbackAsk.conversation_id}
          onClose={() => store.setFeedbackAsk(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mutual wave → the match moment (celebratory, then straight into the DM)
// ---------------------------------------------------------------------------

function MatchOverlay() {
  const state = useAppState();
  const router = useRouter();
  const reduced = useReducedMotion();
  // Initialized from the media query directly so a reduce-motion user never
  // sees even one confetti frame before the hook's effect lands.
  const [confetti, setConfetti] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const match = state.discoveryMatch;
  if (!match) return null;

  const close = () => store.setDiscoveryMatch(null);

  return (
    <>
      {confetti && !reduced ? (
        <EffectOverlay effect="confetti" onDone={() => setConfetti(false)} />
      ) : null}
      <div
        className={styles.matchBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className={styles.matchCard} role="dialog" aria-modal="true" aria-label="You matched">
          <Mascot state="celebrate" size={96} />
          <Avatar avatar={match.user.avatar} name={match.user.display_name} size={64} animated />
          <h2>You both waved! 👋</h2>
          <p>
            {match.user.display_name} waved back. The hard part is over — there&rsquo;s an
            icebreaker waiting in your new chat.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            autoFocus
            onClick={() => {
              close();
              router.push(`/c/${match.conversation_id}`);
            }}
          >
            Say hi →
          </button>
          <button type="button" className="btn btn-ghost" style={{ width: '100%' }} onClick={close}>
            Later
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Roulette expiry → friendly goodbye (the chat is hard-deleted server-side;
// deliberately no "who didn't keep" — there is no rejection surface).
// ---------------------------------------------------------------------------

function RouletteGoodbye({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [askFeedback, setAskFeedback] = useState(false);
  const wantFeedback = !feedbackSeen(conversationId);

  const done = () => {
    store.setRouletteGoodbye(null);
    store.setFeedbackAsk(null);
    // If the deleted chat was open, land somewhere that still exists.
    if (window.location.pathname === `/c/${conversationId}`) router.replace('/');
  };

  if (askFeedback) {
    return (
      <ExpectationFeedback context="roulette" conversationId={conversationId} onClose={done} />
    );
  }

  return (
    <div className={styles.matchBackdrop} role="presentation">
      <div className={styles.goodbyeCard} role="dialog" aria-modal="true" aria-label="Chat ended">
        <Mascot state="yawn" size={88} />
        <h2>And… it&rsquo;s gone ✨</h2>
        <p>
          The five minutes are up, so that chat dissolved completely — no archive, no awkward
          leftovers, for either of you. That&rsquo;s the deal with roulette.
        </p>
        {wantFeedback ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => setAskFeedback(true)}
          >
            One quick question
          </button>
        ) : null}
        <button type="button" className="btn" style={{ width: '100%' }} onClick={done}>
          Back to being bored
        </button>
      </div>
    </div>
  );
}
