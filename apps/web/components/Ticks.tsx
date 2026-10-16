import type { Conversation, Message } from '@socialchat/shared';

export type TickState = 'sent' | 'delivered' | 'read';

/**
 * Sender-side ticks derived locally from watermarks (API.md §2.5): delivered /
 * read when min(watermark over other active participants) >= message.seq.
 */
export function tickStateFor(message: Message, conv: Conversation, meId: string): TickState {
  const others = conv.participants.filter((p) => p.left_at === null && p.user.id !== meId);
  if (others.length === 0) return 'sent';
  let minDelivered = Number.POSITIVE_INFINITY;
  let minRead = Number.POSITIVE_INFINITY;
  for (const p of others) {
    if (p.last_delivered_seq < minDelivered) minDelivered = p.last_delivered_seq;
    if (p.last_read_seq < minRead) minRead = p.last_read_seq;
  }
  if (minRead >= message.seq) return 'read';
  if (minDelivered >= message.seq) return 'delivered';
  return 'sent';
}

export default function Ticks({ state }: { state: TickState }) {
  const double = state !== 'sent';
  return (
    <span className={`ticks${state === 'read' ? ' read' : ''}`} aria-label={state} title={state}>
      <svg width="18" height="12" viewBox="0 0 18 12" fill="none">
        <path
          d="M1.5 6.5 L4.5 9.5 L10 3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {double ? (
          <path
            d="M8 8.8 L8.8 9.5 L14.5 3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
    </span>
  );
}
