'use client';

import { useEffect, useState } from 'react';
import type { Conversation } from '@socialchat/shared';
import { sweepTyping } from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import styles from './chat.module.css';

export default function TypingIndicator({ conversation }: { conversation: Conversation }) {
  const state = useAppState();
  const [, setTick] = useState(0);
  const entries = state.typing.get(conversation.id);
  const now = Date.now();
  const typistIds = entries ? [...entries.entries()].filter(([, exp]) => exp > now).map(([id]) => id) : [];

  // Clients clear the indicator at expires_at (~6 s); no stop event (§2.6).
  useEffect(() => {
    if (!typistIds.length) return;
    const timer = setInterval(() => {
      sweepTyping();
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [typistIds.length]);

  let label = '';
  if (typistIds.length) {
    // v0.4 §1.24: my personal nicknames apply everywhere in my view.
    const prefs = state.prefs.get(conversation.id);
    const names = typistIds
      .map(
        (id) =>
          prefs?.nicknames[id] ??
          conversation.participants.find((p) => p.user.id === id)?.user.display_name ??
          'Someone'
      )
      .slice(0, 2);
    label =
      typistIds.length === 1
        ? `${names[0]} is typing…`
        : typistIds.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : 'Several people are typing…';
  }

  return <div className={styles.typing}>{label}</div>;
}
