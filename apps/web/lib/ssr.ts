// Server-side helpers for the unauthenticated SSR surfaces (/join, /p, /s —
// API.md §1.53/§1.67). Import from SERVER COMPONENTS ONLY — next/headers
// makes this module server-scoped (no `server-only` marker dep; rule 10).
import { headers } from 'next/headers';
import {
  SHARE_TOKEN_REGEX,
  SharePageResponseSchema,
  type SharePage,
} from '@socialchat/shared';

/** Public origin for absolute OG URLs. PUBLIC_ORIGIN env wins when set —
 * required behind tunnels (cloudflared/ngrok rewrite Host to the local
 * origin, so headers can't recover the public name). Otherwise derive from
 * the forwarded headers Caddy sends. (The §1.53 publicOrigin() rule.) */
export async function publicOrigin(): Promise<string> {
  const fixed = process.env.PUBLIC_ORIGIN;
  if (fixed) return fixed.replace(/\/+$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * GET /api/share/:token/public through API_ORIGIN, re-sending the visitor's
 * X-Forwarded-For chain (the house SSR-hop rule): the api rate-limits the
 * public read per client IP — without the chain, every SSR render worldwide
 * would share one bucket keyed on this container's address.
 * Returns null for any 404 (unknown/revoked/no-longer-public — byte-identical
 * by contract, so the page renders ONE honest "nothing here" state).
 */
export async function fetchSharePage(token: string, cursor?: string): Promise<SharePage | null> {
  if (!SHARE_TOKEN_REGEX.test(token)) return null;
  const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001';
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  try {
    const res = await fetch(`${apiOrigin}/api/share/${encodeURIComponent(token)}/public${qs}`, {
      cache: 'no-store',
      ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
    });
    if (!res.ok) return null;
    const parsed = SharePageResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.page : null;
  } catch {
    return null;
  }
}
