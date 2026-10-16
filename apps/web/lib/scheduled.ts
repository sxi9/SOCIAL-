// Scheduled messages & time capsules (v0.4 — API.md §1.26). Mine only, private
// until delivery; scheduled.updated frames keep the list in sync cross-device.
import type {
  CreateScheduledRequest,
  ListScheduledResponse,
  ScheduledMessage,
  ScheduledResponse,
} from '@socialchat/shared';
import { api } from './api';
import * as store from './store';

export async function refreshScheduled(): Promise<void> {
  const res = await api.get<ListScheduledResponse>('/api/scheduled-messages');
  store.setScheduledList(res.scheduled);
}

export async function createScheduled(
  conversationId: string,
  payload: CreateScheduledRequest
): Promise<ScheduledMessage> {
  const res = await api.post<ScheduledResponse>(
    `/api/conversations/${conversationId}/scheduled-messages`,
    payload
  );
  store.upsertScheduled(res.scheduled);
  return res.scheduled;
}

export async function cancelScheduled(s: ScheduledMessage): Promise<void> {
  await api.del(`/api/scheduled-messages/${s.id}`);
  store.upsertScheduled({ ...s, status: 'cancelled' });
}

/** Pending schedules for one conversation, soonest first. */
export function pendingFor(conversationId: string): ScheduledMessage[] {
  return [...store.state.scheduled.values()]
    .filter((s) => s.status === 'pending' && s.conversation_id === conversationId)
    .sort((a, b) => new Date(a.deliver_at).getTime() - new Date(b.deliver_at).getTime());
}
