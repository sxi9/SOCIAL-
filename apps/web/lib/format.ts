import type { ConversationListItem, Conversation, Message, UserPublic } from '@socialchat/shared';

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatLastSeen(iso: string | null): string {
  if (!iso) return 'offline';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${formatTime(iso)}`;
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
  const peer = otherParticipants(conv, meId)[0];
  return peer ? peer.display_name : 'Conversation';
}

export function dmPeer(conv: Conversation, meId: string | undefined): UserPublic | null {
  if (conv.type !== 'dm') return null;
  return otherParticipants(conv, meId)[0] ?? null;
}

export function messageSnippet(msg: Message | null): string {
  if (!msg) return 'No messages yet';
  if (msg.type === 'system') return msg.body ?? 'Update';
  if (msg.type === 'image') return msg.body ? msg.body : 'Photo';
  if (msg.type === 'video') return msg.body ? msg.body : 'Video';
  if (msg.type === 'file') return msg.body ? msg.body : 'File';
  return msg.body ?? '';
}

export function unreadOf(item: ConversationListItem): number {
  return item.unread_count;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function firstUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}
