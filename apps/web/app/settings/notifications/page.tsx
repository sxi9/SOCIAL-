'use client';

// Settings → Notifications & sounds (Royal v2 IA, proto ref 49). The push
// row + the re-askable explainer moved here from the old profile-settings
// page, behavior intact (v0.7.1 §1.56, FEATURES #90b; v1.0 re-ask).
// Ringtones/text tones ship with the Calls pack — a muted note, not a fake
// row. Design rule carried over: we never notify about something you
// can't act on (PSYCHOLOGY §2).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { disablePush, getPushSubscription, pushSupported } from '@/lib/push';
import { PushExplainerSheet } from '@/components/PushExplainer';
import { toast } from '@/lib/toast';
import AppShell from '@/components/AppShell';
import sm from '@/components/settings.module.css';

const S = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...S} />
    </svg>
  );
}

/** v0.7.1 (§1.56): per-browser unblock steps for the 'denied' state — the
 * page cannot re-ask, so the row says exactly where the switch lives. */
function unblockSteps(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iPhone/iPad: add Bored Chat to your home screen (Share → Add to Home Screen), then iOS Settings → Notifications → Bored Chat → Allow Notifications.';
  }
  if (/Firefox/.test(ua)) {
    return 'Firefox: tap the permissions icon left of the address bar → Notifications → remove the "Blocked" entry, then reload and enable here.';
  }
  if (/Edg\//.test(ua)) {
    return 'Edge: tap the lock icon in the address bar → Permissions for this site → Notifications → Allow, then reload and enable here.';
  }
  if (/Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua)) {
    return 'Safari: menu Safari → Settings → Websites → Notifications → set this site to Allow, then reload and enable here.';
  }
  return 'Chrome: tap the lock/tune icon in the address bar → Site settings → Notifications → Allow, then reload and enable here.';
}

function NotificationSettings() {
  // The row always tells the truth — ON (permission granted + live
  // subscription), OFF ('default', or granted with no subscription), or
  // Blocked by browser ('denied' — per-browser unblock steps shown instead).
  const [pushStatus, setPushStatus] = useState<'on' | 'off' | 'blocked' | 'unsupported' | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [askPush, setAskPush] = useState(false); // v1.0: re-askable enable

  useEffect(() => {
    refreshPushStatus();
    // v1.0: heal the row when the user returns from the browser's site
    // settings (the unblock steps say "then come back here").
    const onFocus = () => refreshPushStatus();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  function refreshPushStatus(): void {
    if (!pushSupported()) {
      setPushStatus('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushStatus('blocked');
      return;
    }
    void getPushSubscription()
      .then((sub) => setPushStatus(sub !== null && Notification.permission === 'granted' ? 'on' : 'off'))
      .catch(() => setPushStatus('off'));
  }

  async function togglePush(): Promise<void> {
    if (pushBusy || pushStatus === null || pushStatus === 'unsupported' || pushStatus === 'blocked') return;
    if (pushStatus !== 'on') {
      // v1.0 (owner ask): Enable re-opens the friendly explainer sheet — the
      // ask is re-triggerable from Settings forever, not a one-time prompt.
      setAskPush(true);
      return;
    }
    setPushBusy(true);
    try {
      await disablePush();
      toast('Notifications are off');
    } catch {
      /* endpoint failure; the refresh below tells the truth */
    } finally {
      refreshPushStatus();
      setPushBusy(false);
    }
  }

  return (
    <div className="page pageFadeUp">
      <header className="topbar">
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Notifications &amp; sounds</h1>
        <span />
      </header>

      <div className={sm.setList}>
        <div className={sm.setRow}>
          <div className={sm.setMain}>
            <div className={sm.setTitle}>
              Push notifications
              {pushStatus === 'on' ? (
                <span className="ok-text" style={{ marginLeft: 8 }}>ON</span>
              ) : pushStatus === 'off' ? (
                <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>OFF</span>
              ) : pushStatus === 'blocked' ? (
                <span className="error-text" style={{ marginLeft: 8 }}>Blocked by browser</span>
              ) : null}
            </div>
            <p className={sm.setHint}>
              {pushStatus === 'unsupported'
                ? 'Not supported in this browser.'
                : 'Messages, incoming calls, sparked plans and wave nudges when the app is closed — rings depend on this.'}
            </p>
          </div>
          {pushStatus !== 'blocked' ? (
            <button
              type="button"
              className={`btn${pushStatus === 'on' ? '' : ' btn-primary'}`}
              disabled={pushStatus === 'unsupported' || pushBusy || pushStatus === null}
              onClick={() => void togglePush()}
            >
              {pushStatus === null ? '…' : pushStatus === 'on' ? 'Disable' : 'Enable'}
            </button>
          ) : null}
        </div>
      </div>

      {pushStatus === 'blocked' ? (
        <p className={sm.noteLine}>
          {/* §1.56: 'denied' cannot be re-asked from the page — per-browser
              unblock steps, keyed on the UA. */}
          {unblockSteps()}
        </p>
      ) : null}

      <p className={sm.noteLine}>Ringtones &amp; text tones arrive with the Calls pack.</p>
      <p className={sm.noteLine}>We never notify you about something you can&rsquo;t act on.</p>

      {askPush ? (
        <PushExplainerSheet
          onClose={() => {
            setAskPush(false);
            refreshPushStatus();
          }}
          onResult={() => refreshPushStatus()}
        />
      ) : null}
    </div>
  );
}

export default function NotificationSettingsPage() {
  return (
    <AppShell>
      <NotificationSettings />
    </AppShell>
  );
}
