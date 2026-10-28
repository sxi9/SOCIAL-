'use client';

// /link/<code> — the PHONE side of QR cross-device login (v0.9 — API.md
// §1.71, FEATURES #83). Opened by scanning the laptop's QR (the full code in
// the URL) or by typing the 6-char display code under Settings → Security.
// AppShell gates auth: a logged-OUT phone lands on /login?next=/link/<code>
// and returns here after signing in — login-first, then the sheet (§1.71).
//
// The sheet is the informed consent: it shows WHAT is asking (the laptop's
// browser/OS + a coarse network hint) before Approve. Approval never moves a
// token through this device — the laptop's own next poll mints its session.
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { LoginLinkInfo } from '@socialchat/shared';
import { ApiError, retryIn } from '@/lib/api';
import { approveLoginLink, denyLoginLink, countdown, describeUserAgent, isExpired, lookupLoginLink } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { useNow } from '@/lib/useNow';
import { formatTime } from '@/lib/format';
import AppShell from '@/components/AppShell';
import Portal from '@/components/Portal';
import sheet from '@/components/beacons.module.css';
import ap from '@/components/authpack.module.css';

function ApproveSheet() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = typeof params.code === 'string' ? decodeURIComponent(params.code) : '';
  const [link, setLink] = useState<LoginLinkInfo | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  useEffect(() => {
    if (!code) {
      setGone(true);
      return;
    }
    let cancelled = false;
    void lookupLoginLink(code)
      .then((res) => {
        if (!cancelled) setLink(res.link);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 410) setGone(true);
        else if (err instanceof ApiError && err.status === 429)
          setError(`Too many tries — give it ${retryIn(err, 'a minute')}.`);
        else setError('Could not look that code up. Check your connection and try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const expired = gone || (link !== null && isExpired(link.expires_at, now));

  const deny = useCallback((): void => {
    // Wave 1 §1.3: a real Deny — the code dies now, the laptop sees 410.
    void denyLoginLink(code).catch(() => undefined);
    toast('Denied — that code no longer works');
    router.replace('/');
  }, [router, code]);

  async function approve(): Promise<void> {
    if (busy || !link) return;
    setBusy(true);
    setError(null);
    try {
      await approveLoginLink(code);
      // §1.71: the laptop's next poll mints its session; it shows up under
      // Devices like any other and is revocable from here (remote logout).
      toast('Laptop signed in — it now shows under Devices');
      router.replace('/settings/sessions');
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setGone(true);
      } else {
        setError('Could not approve — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div className={sheet.sheetBackdrop} role="presentation">
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Approve a sign-in">
          <div className={sheet.sheetHead}>
            <h2>Sign that device in?</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={deny}>
              ×
            </button>
          </div>

          {expired ? (
            <div>
              <p className="muted" style={{ marginTop: 0 }}>
                That code is gone — expired, already used, or mistyped. Codes only live for two
                minutes; ask the other device for a fresh one and try again.
              </p>
              <button type="button" className="btn" style={{ width: '100%' }} onClick={() => router.replace('/')}>
                Close
              </button>
            </div>
          ) : link === null ? (
            <p className="muted" role="status">
              {error ?? 'Checking the code…'}
            </p>
          ) : (
            <div>
              <p className="muted small" style={{ marginTop: 0 }}>
                A device showing the login QR wants into <strong>your</strong> account. Only
                approve it if the screen in front of you is yours.
              </p>
              <div className="card" style={{ margin: '8px 0 12px' }}>
                <div className={ap.factRow}>
                  <span className={ap.factKey}>Device</span>
                  <span>{describeUserAgent(link.user_agent)}</span>
                </div>
                <div className={ap.factRow}>
                  <span className={ap.factKey}>Network</span>
                  <span>{link.ip_hint ?? 'unknown'}</span>
                </div>
                <div className={ap.factRow}>
                  <span className={ap.factKey}>Asked</span>
                  <span>{formatTime(link.created_at)}</span>
                </div>
                <div className={ap.factRow}>
                  <span className={ap.factKey}>Expires</span>
                  <span>in {countdown(link.expires_at, now)}</span>
                </div>
              </div>
              {error ? <p className="error-text">{error}</p> : null}
              <div style={{ display: 'grid', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void approve()}
                >
                  {busy ? 'Approving…' : 'Approve sign-in'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={deny}>
                  Deny
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

export default function LinkApprovePage() {
  return (
    <AppShell>
      {/* A quiet page behind the sheet — the sheet IS the surface. */}
      <div className="center-screen muted" aria-hidden>
        &nbsp;
      </div>
      <ApproveSheet />
    </AppShell>
  );
}
