// Connections (v0.5a — API.md §1.28). FRIENDS-OF = accepted connections ∪
// DM partners, resolved server-side; this module only mirrors state. Declines
// and removals are SILENT to the other party by contract — the UI must never
// imply otherwise.
import type { Connection, ConnectionResponse, ListConnectionsResponse } from '@socialchat/shared';
import { api, ApiError } from './api';
import * as store from './store';

let inflight: Promise<void> | null = null;

/** GET /api/connections — the reconnect/reconcile read (frames patch live). */
export async function refreshConnections(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.get<ListConnectionsResponse>('/api/connections');
      store.setConnections(res);
    } catch {
      /* offline — the last mirror stands */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * POST /api/users/:id/connect — request (or auto-accept a pending request TO
 * me, §1.28). Returns the row; 404 is the blocked/unknown shape and reads as
 * "not available", never "blocked".
 */
export async function connectTo(userId: string): Promise<Connection> {
  const res = await api.post<ConnectionResponse>(`/api/users/${userId}/connect`);
  store.applyConnectionUpdated(res.connection, false);
  return res.connection;
}

export async function acceptConnection(id: string): Promise<void> {
  const res = await api.post<ConnectionResponse>(`/api/connections/${id}/accept`);
  store.applyConnectionUpdated(res.connection, false);
}

/** Decline deletes the row — silent to the requester (no rejection ping). */
export async function declineConnection(conn: Connection): Promise<void> {
  try {
    await api.post(`/api/connections/${conn.id}/decline`);
  } catch (err) {
    // 404 = already gone (raced a cancel) — treat as done.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  store.applyConnectionUpdated(conn, true);
}

/** Remove an accepted connection, or cancel my own pending request. */
export async function removeConnection(conn: Connection): Promise<void> {
  await api.del(`/api/connections/${conn.id}`);
  store.applyConnectionUpdated(conn, true);
}

export type ConnectionStateFor =
  | { kind: 'none' }
  | { kind: 'outgoing'; connection: Connection }
  | { kind: 'incoming'; connection: Connection }
  | { kind: 'accepted'; connection: Connection };

/** Viewer-side connection state for a user, from the store mirror. */
export function connectionStateFor(userId: string): ConnectionStateFor {
  const c = store.state.connections;
  if (!c) return { kind: 'none' };
  const accepted = c.connections.find((x) => x.user.id === userId);
  if (accepted) return { kind: 'accepted', connection: accepted };
  const incoming = c.incoming.find((x) => x.user.id === userId);
  if (incoming) return { kind: 'incoming', connection: incoming };
  const outgoing = c.outgoing.find((x) => x.user.id === userId);
  if (outgoing) return { kind: 'outgoing', connection: outgoing };
  return { kind: 'none' };
}
