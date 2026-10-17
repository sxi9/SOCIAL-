'use client';

// Pinned bar (v0.5a — API.md §1.32): a stable board (created_at ASC) at the
// top of the chat. Tap cycles through pins and jumps to each message; the
// board itself rides the Conversation DTO and conv.updated keeps it fresh.
import { useState } from 'react';
import type { ConversationListItem } from '@socialchat/shared';
import { api } from '@/lib/api';
import { kindLabel, messageSnippet } from '@/lib/format';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import st from './social.module.css';

interface PinnedBarProps {
  conv: ConversationListItem;
  canPin: boolean;
  onJump: (seq: number) => void;
}

export default function PinnedBar({ conv, canPin, onJump }: PinnedBarProps) {
  const state = useAppState();
  const [idx, setIdx] = useState(0);
  const pins = conv.pins;
  if (pins.length === 0) return null;

  const cur = Math.min(idx, pins.length - 1);
  const pin = pins[cur];
  const msg = state.messages.get(conv.id)?.find((m) => m.seq === pin.seq) ?? null;
  const text = msg
    ? msg.deleted_at
      ? 'Deleted message'
      : msg.body?.trim()
        ? msg.body
        : `${kindLabel(msg.type)}${msg.body ? ` · ${messageSnippet(msg)}` : ''}`
    : 'Pinned message';

  const cycle = () => {
    onJump(pin.seq);
    if (pins.length > 1) setIdx((cur + 1) % pins.length);
  };

  async function unpin(): Promise<void> {
    try {
      await api.del(`/api/conversations/${conv.id}/pins/${pin.seq}`);
      // Optimistic: conv.updated confirms. Drop the pin locally now.
      store.upsertConversation({ ...conv, pins: pins.filter((p) => p.seq !== pin.seq) });
      setIdx(0);
    } catch {
      /* already unpinned or no permission — the DTO stays the truth */
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <button
        type="button"
        className={st.pinnedBar}
        onClick={cycle}
        aria-label={`Pinned message ${cur + 1} of ${pins.length} — tap to jump${pins.length > 1 ? ' and cycle' : ''}`}
      >
        <span aria-hidden>📌</span>
        {pins.length > 1 ? <span className={st.pinnedCount}>{cur + 1}/{pins.length}</span> : null}
        <span className={st.pinnedText}>{text}</span>
        {canPin ? (
          <span
            role="button"
            tabIndex={0}
            className={st.pinnedUnpin}
            aria-label="Unpin this message"
            onClick={(e) => {
              e.stopPropagation();
              void unpin();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                void unpin();
              }
            }}
          >
            ×
          </span>
        ) : null}
      </button>
    </div>
  );
}
