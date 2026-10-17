// Scheduled messages & time capsules (v0.4 — API.md §1.26). Mine only, private
// until delivery; scheduled.updated frames keep the list in sync cross-device.
import {
  SCHEDULED_TOAST_MS,
  type CreateScheduledRequest,
  type ListScheduledResponse,
  type ScheduledMessage,
  type ScheduledResponse,
} from '@socialchat/shared';
import { api } from './api';
import { formatDeliverAt } from './format';
import * as store from './store';
import { toast } from './toast';

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
  // v0.7 (§1.54) → v0.7.1 (§1.56): the success toast — "Scheduled for <human
  // time>" — rides the ONE shared toast with its per-call duration override.
  toast(`Scheduled for ${formatDeliverAt(res.scheduled.deliver_at)}`, SCHEDULED_TOAST_MS);
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
