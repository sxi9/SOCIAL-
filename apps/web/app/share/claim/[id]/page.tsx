'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { ShareImportResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';

/** Promotes a logged-out share stash to a real import after login (§1.8). */
export default function ShareClaimPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const stashId = params.id;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.post<ShareImportResponse>('/api/share-imports/claim', {
          stash_id: stashId,
        });
        if (!cancelled) router.replace(`/compose?import=${res.import.id}`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(`/share/claim/${stashId}`)}`);
        } else if (err instanceof ApiError && err.status === 404) {
          setError('This share expired (stashes last 30 minutes). Share it again from the other app.');
        } else {
          setError('Could not claim this share.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stashId, router]);

  return (
    <div className="center-screen">
      <div className="card auth-card">
        {error ? (
          <>
            <h1>Share expired</h1>
            <p className="muted">{error}</p>
            <Link className="btn btn-primary" href="/">
              Go to chats
            </Link>
          </>
        ) : (
          <p className="muted" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="spinner" /> Claiming your share…
          </p>
        )}
      </div>
    </div>
  );
}
