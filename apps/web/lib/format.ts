import { extractFirstUrl, type ConversationListItem, type Conversation, type Message, type UserPublic } from '@socialchat/shared';

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  // Royal v2 (ref 08): list times stay compact — "9:41", no AM/PM, no
  // leading zero (locale hour12 noise reads as clutter at 12px).
  if (sameDay) return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Wave 1 §1.9: COARSE by design (PSYCHOLOGY: no seen-at timestamps) —
 * "active today / this week", never "43m ago". */
export function formatLastSeen(iso: string | null): string {
  if (!iso) return 'offline';
  const hours = Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600000);
  if (hours < 1) return 'active recently';
  if (hours < 24) return 'active today';
  if (hours < 24 * 7) return 'active this week';
  return 'offline';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function otherParticipants(conv: Conversation, meId: string | undefined): UserPublic[] {
  return conv.participants.filter((p) => p.left_at === null && p.user.id !== meId).map((p) => p.user);
}

export function conversationTitle(conv: Conversation, meId: string | undefined): string {
  if (conv.type === 'group') return conv.title ?? 'Group';
  if (conv.type === 'channel') return conv.title ?? 'Channel';
  const peer = otherParticipants(conv, meId)[0];
  return peer ? peer.display_name : 'Conversation';
}

/** My role in a conversation (v0.5a §1.35: 'owner' exists in channels only). */
export function myRole(conv: Conversation, meId: string | undefined): 'member' | 'admin' | 'owner' | null {
  const p = conv.participants.find((x) => x.user.id === meId && x.left_at === null);
  return p ? p.role : null;
}

/** Channels are read-only for plain members (§1.35 channel_read_only). */
export function canPostIn(conv: Conversation, meId: string | undefined): boolean {
  if (conv.type !== 'channel') return true;
  const role = myRole(conv, meId);
  return role === 'owner' || role === 'admin';
}

/** Client copy for body-less kinds (reply context cards, §1.29). */
export function kindLabel(type: Message['type']): string {
  switch (type) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'file':
      return 'File';
    case 'audio':
      return 'Voice note';
    case 'poll':
      return 'Poll';
    case 'vibe_check':
      return 'Vibe check';
    case 'game_ttt':
      return 'Tic-tac-toe';
    case 'puzzle_result':
      return 'Puzzle result';
    case 'location':
      return 'Location';
    default:
      return 'Message';
  }
}

export function dmPeer(conv: Conversation, meId: string | undefined): UserPublic | null {
  if (conv.type !== 'dm') return null;
  return otherParticipants(conv, meId)[0] ?? null;
}

export function messageSnippet(msg: Message | null): string {
  if (!msg) return 'No messages yet';
  if (msg.type === 'system') return msg.body ?? 'Update';
  // v0.8a §1.57: a drunk-mode undone message renders NOTHING anywhere — not
  // even a stub in the list snippet (no trace, by contract).
  if (msg.metadata.undone) return '';
  // v0.4 §1.25: tombstoned by the disappearing-messages sweep.
  if (msg.deleted_at) return 'Message expired';
  if (msg.metadata.capsule) return '💌 Time capsule';
  if (msg.type === 'image') return msg.body ? msg.body : msg.metadata.doodle ? '✏️ Doodle' : 'Photo';
  if (msg.type === 'video') return msg.body ? msg.body : 'Video';
  if (msg.type === 'file') return msg.body ? msg.body : 'File';
  if (msg.type === 'audio') return '🎤 Voice note';
  if (msg.type === 'poll') return msg.poll ? `📊 ${msg.poll.question}` : '📊 Poll';
  if (msg.type === 'vibe_check') return `🎭 ${msg.body ?? 'Vibe check'}`;
  if (msg.type === 'game_ttt') return '🎮 Tic-tac-toe';
  if (msg.type === 'puzzle_result') return '🧩 Puzzle result';
  // v0.7 §1.52: the push snippet is "📍 Location"; join_me names the variant.
  if (msg.type === 'location') {
    return msg.metadata.join_me ? '📍 Join me here' : '📍 Location';
  }
  return msg.body ?? '';
}

/** mm:ss label for voice-note durations (v0.4 §1.20). */
export function formatDuration(ms: number | null): string {
  const totalS = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Friendly deliver-at label for the scheduled drawer (v0.4 §1.26). */
export function formatDeliverAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  return `${day} at ${time}`;
}

export function unreadOf(item: ConversationListItem): number {
  return item.unread_count;
}

/** The ONE canonical URL extractor — same implementation the server uses
 * (@socialchat/shared), so composer previews match server-side extraction. */
export function firstUrl(text: string): string | null {
  return extractFirstUrl(text);
}
