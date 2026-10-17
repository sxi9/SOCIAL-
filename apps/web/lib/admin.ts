// Admin client (v0.5b — API.md §1.41, ADR-013). Operator-only: every route
// here answers 404 to non-admins (the surface does not exist for them), and
// every payload is METADATA ONLY — no private message bodies exist in any
// admin response, by contract.
import type {
  AdminLogsResponse,
  AdminMetricsResponse,
  AdminReportResponse,
  AdminReportsResponse,
  AdminUserExport,
  AdminUserRow,
  AdminUsersResponse,
  InstanceSettingsResponse,
  LastSeenBucket,
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

export type AdminUserAction = 'suspend' | 'unsuspend' | 'ban' | 'unban';

export async function adminUserAction(
  id: string,
  action: AdminUserAction,
  note: string
): Promise<AdminUserRow> {
  const res = await api.post<{ user: AdminUserRow }>(`/api/admin/users/${id}/${action}`, { note });
  return res.user;
}

export async function adminUserExport(id: string): Promise<AdminUserExport> {
  const res = await api.get<{ export: AdminUserExport }>(`/api/admin/users/${id}/export`);
  return res.export;
}

export async function adminReports(
  status: 'open' | 'closed' | null,
  cursor: string | null
): Promise<AdminReportsResponse> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return api.get<AdminReportsResponse>(`/api/admin/reports${qs ? `?${qs}` : ''}`);
}

export async function adminCloseReport(id: string, note: string): Promise<AdminReportResponse> {
  return api.post<AdminReportResponse>(`/api/admin/reports/${id}/close`, { note });
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
