// Who is looking at a public SSR surface (/p, /s, /join)? Those pages run
// outside AppShell — no store, no socket — so the islands on them ask once,
// client-side, the way JoinClient always has (GET /api/users/me rides the
// sid cookie; 401 = nobody). One probe per page load, shared by every island
// on it. Share-everything phase 2.
import type { MeResponse, UserPrivate } from '@socialchat/shared';
import { api } from './api';

let memo: Promise<UserPrivate | null> | null = null;

export function probeMe(): Promise<UserPrivate | null> {
  if (!memo) {
    memo = api
      .get<MeResponse>('/api/users/me')
      .then((res) => res.user)
      .catch(() => null);
  }
  return memo;
}
