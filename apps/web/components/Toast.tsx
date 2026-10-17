'use client';

// v0.7.1 (API.md §1.56, FEATURES #90a): THE shared toast component — the one
// place confirmation toasts render. Portaled to <body> (TROUBLESHOOTING: never
// a fixed element inside app chrome), bottom-anchored above the tab bar at the
// toast layer of the globals.css z-scale (80), auto-dismissing (store.pushToast
// owns the timer + the TOAST_MAX_VISIBLE cap), dismissible by tap, surfaced to
// screen readers via role="status" / aria-live="polite". Reduced motion: the
// CSS drops the slide and keeps a plain appearance (§1.22 replacement rule).
// Mounted once by GlobalOverlays; new confirmations call lib/toast.ts toast().
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Portal from './Portal';
import soc from './social.module.css';

export default function Toast() {
  const state = useAppState();
  if (state.toasts.length === 0) return null;
  return (
    <Portal>
      <div className={soc.toastHost}>
        {state.toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            className={soc.toast}
            role="status"
            aria-live="polite"
            onClick={() => store.dismissToast(t.id)}
          >
            {t.text}
          </button>
        ))}
      </div>
    </Portal>
  );
}
