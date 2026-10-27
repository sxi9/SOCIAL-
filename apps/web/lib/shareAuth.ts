// Who is looking at a public SSR surface (/p, /s, /join)? Those pages run
// outside AppShell — no store, no socket — so the islands on them ask once,
// client-side, the way JoinClient always has (GET /api/users/me rides the
// sid cookie; 401 = nobody). One probe per page load, shared by every island
// on it. Share-everything phase 2.
import type { MeResponse, UserPrivate } from '@socialchat/shared';
import { api } from './api';

let memo: { key: string; p: Promise<UserPrivate | null> } | null = null;

/** One probe per page — keyed on the URL, so a client-side navigation back
 * here (the /login?next=… round-trip) asks again instead of trusting a
 * memo taken before the sign-in. */
export function probeMe(): Promise<UserPrivate | null> {
  const key = `${window.location.pathname}${window.location.search}`;
  if (!memo || memo.key !== key) {
    memo = {
      key,
      p: api
        .get<MeResponse>('/api/users/me')
        .then((res) => res.user)
        .catch(() => null),
    };
  }
  return memo.p;
}

/** Forget the memo — call after anything that changes who is signed in. */
export function resetMeProbe(): void {
  memo = null;
}
