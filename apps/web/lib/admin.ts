// Admin client (v0.5b — API.md §1.41, ADR-013). Operator-only: every route
// here answers 404 to non-admins (the surface does not exist for them), and
// every payload is METADATA ONLY — no private message bodies exist in any
// admin response, by contract.
import type {
  AdminContentResponse,
  AdminContentType,
  AdminLogsResponse,
  AdminMetricsResponse,
  AdminReportResponse,
  AdminReportsResponse,
  AdminSupportTicketResponse,
  AdminSupportTicketsResponse,
  AdminUpdateResponse,
  AdminUserExport,
  AdminUserRow,
  AdminUsersResponse,
  InstanceSettingsResponse,
  LastSeenBucket,
  ReportContextResponse,
  SupportTicketStatus,
  UpdateInstanceSettingsRequest,
} from '@socialchat/shared';
import { api } from './api';

export async function adminProbe(): Promise<boolean> {
  // The cheapest admin read; 404 = "this surface does not exist for you".
  try {
    await api.get<InstanceSettingsResponse>('/api/admin/settings');
    return true;
  } catch {
    return false;
  }
}

export async function adminUsers(q: string, cursor: string | null): Promise<AdminUsersResponse> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return api.get<AdminUsersResponse>(`/api/admin/users${qs ? `?${qs}` : ''}`);
}

export type AdminUserAction =
  | 'suspend'
  | 'unsuspend'
  | 'ban'
  | 'unban'
  | 'grant-admin'
  | 'revoke-admin'
  | 'delete';

export async function adminUserAction(
  id: string,
  action: AdminUserAction,
  note: string
): Promise<AdminUserRow> {
  const res = await api.post<{ user: AdminUserRow }>(`/api/admin/users/${id}/${action}`, { note });
  return res.user;
}

// ADR-013 amendment: the operator sets a known password; the server revokes
// every session of the target. Admin targets → bad_admin_target.
export async function adminSetPassword(id: string, newPassword: string): Promise<AdminUserRow> {
  const res = await api.post<{ user: AdminUserRow }>(`/api/admin/users/${id}/password`, {
    new_password: newPassword,
  });
  return res.user;
}

export async function adminUserExport(id: string): Promise<AdminUserExport> {
  const res = await api.get<{ export: AdminUserExport }>(`/api/admin/users/${id}/export`);
  return res.export;
}

export async function adminReports(
  status: 'open' | 'closed' | null,
  cursor: string | null,
  category?: string | null
): Promise<AdminReportsResponse> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return api.get<AdminReportsResponse>(`/api/admin/reports${qs ? `?${qs}` : ''}`);
}

export async function adminCloseReport(id: string, note: string): Promise<AdminReportResponse> {
  return api.post<AdminReportResponse>(`/api/admin/reports/${id}/close`, { note });
}

// ---------------------------------------------------------------------------
// v0.8b (§1.69) — content tab, support inbox, report context, update banner.
// ---------------------------------------------------------------------------

/** PUBLIC surfaces only (public posts, public beacons, all board listings) —
 * private chats and friends-only content are structurally unrepresentable. */
export async function adminContent(
  type: AdminContentType | null,
  q: string,
  cursor: string | null
): Promise<AdminContentResponse> {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return api.get<AdminContentResponse>(`/api/admin/content${qs ? `?${qs}` : ''}`);
}

/** Takedown — reason REQUIRED: the author gets a neutral Support-conversation
 * notice carrying it, and the action is ring-logged. */
export async function adminTakedown(type: AdminContentType, id: string, reason: string): Promise<void> {
  await api.post(`/api/admin/content/${type}/${id}/takedown`, { reason });
}

export async function adminSupportTickets(
  status: SupportTicketStatus | null,
  cursor: string | null
): Promise<AdminSupportTicketsResponse> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return api.get<AdminSupportTicketsResponse>(`/api/admin/support${qs ? `?${qs}` : ''}`);
}

/** The ticket + the user's Support-conversation dialogue (consent is
 * structural — the conversation exists to talk to the operator; ADR-020). */
export async function adminSupportTicket(id: string): Promise<AdminSupportTicketResponse> {
  return api.get<AdminSupportTicketResponse>(`/api/admin/support/${id}`);
}

export async function adminSupportReply(id: string, body: string): Promise<void> {
  await api.post(`/api/admin/support/${id}/reply`, { body });
}

export async function adminSupportClose(id: string, note: string): Promise<void> {
  await api.post(`/api/admin/support/${id}/close`, { note });
}

/** The consented context slice — exists ONLY for kind:'message' reports whose
 * reporter checked include_context; every call is ring-logged server-side. */
export async function adminReportContext(id: string): Promise<ReportContextResponse> {
  return api.get<ReportContextResponse>(`/api/admin/reports/${id}/context`);
}

export async function adminUpdateStatus(): Promise<AdminUpdateResponse> {
  return api.get<AdminUpdateResponse>('/api/admin/update');
}

export async function adminMetrics(): Promise<AdminMetricsResponse> {
  return api.get<AdminMetricsResponse>('/api/admin/metrics');
}

export async function adminLogs(offset: number): Promise<AdminLogsResponse> {
  return api.get<AdminLogsResponse>(`/api/admin/logs?offset=${offset}&limit=100`);
}

export async function adminSettings(): Promise<InstanceSettingsResponse> {
  return api.get<InstanceSettingsResponse>('/api/admin/settings');
}

export async function adminUpdateSettings(
  change: UpdateInstanceSettingsRequest
): Promise<InstanceSettingsResponse> {
  return api.patch<InstanceSettingsResponse>('/api/admin/settings', change);
}

export const BUCKET_LABEL: Record<LastSeenBucket, string> = {
  today: 'today',
  this_week: 'this week',
  this_month: 'this month',
  older: 'older',
  never: 'never',
};

/** Trigger a browser download of a JSON blob (the §1.41 user export). */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
