// Share-target receiver (manifest `action: /share`, ARCHITECTURE §6).
// Logged in  → forward to POST /api/share-imports, 303 → /compose?import=<id>.
// Logged out → forward to POST /api/share-stash,  303 → /login?next=/share/claim/<id>.
import { NextResponse, type NextRequest } from 'next/server';
import type { ShareImportResponse, ShareStashResponse } from '@socialchat/shared';

export const dynamic = 'force-dynamic';

function redirect(req: NextRequest, path: string): NextResponse {
  // 303 See Other: POST-redirect-GET, refresh-safe.
  return NextResponse.redirect(new URL(path, req.url), 303);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001';

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return redirect(req, '/');
  }

  // Map manifest param names → API field names.
  const form = new FormData();
  const title = incoming.get('share_title');
  if (typeof title === 'string' && title) form.append('title', title);
  const text = incoming.get('share_text');
  if (typeof text === 'string' && text) form.append('text', text);
  const url = incoming.get('share_url');
  if (typeof url === 'string' && url) form.append('url', url);
  for (const media of incoming.getAll('media')) {
    if (media instanceof File && media.size > 0) form.append('media', media, media.name);
  }

  const cookie = req.headers.get('cookie');
  const authedHeaders: Record<string, string> = { 'X-Requested-With': 'fetch' };
  if (cookie) authedHeaders.cookie = cookie;

  let res: Response;
  try {
    res = await fetch(`${apiOrigin}/api/share-imports`, {
      method: 'POST',
      headers: authedHeaders,
      body: form,
    });
  } catch {
    return redirect(req, '/?share_error=1');
  }

  if (res.ok) {
    const data = (await res.json()) as ShareImportResponse;
    return redirect(req, `/compose?import=${data.import.id}`);
  }

  if (res.status === 401) {
    // No (valid) session: park the payload server-side, claim after login.
    try {
      const stashRes = await fetch(`${apiOrigin}/api/share-stash`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch' },
        body: form,
      });
      if (stashRes.ok) {
        const data = (await stashRes.json()) as ShareStashResponse;
        return redirect(req, `/login?next=${encodeURIComponent(`/share/claim/${data.stash_id}`)}`);
      }
    } catch {
      /* fall through */
    }
    return redirect(req, '/login');
  }

  return redirect(req, '/?share_error=1');
}
