// In-app confirmation (owner report, 2026-10-18): window.confirm() renders the
// browser's own "<host> says" box — un-themed, and on phones it reads like a
// system alert. One pending ask at a time; ConfirmSheet (mounted once in
// GlobalOverlays) renders it. Resolves false on Cancel, backdrop tap or
// Escape. A newer ask supersedes a pending one (resolved false).
import { useSyncExternalStore } from 'react';

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Defaults to a guess from the wording (delete/remove/ban/block…). */
  danger?: boolean;
  /** Stack above a caller that sits higher than the modal plane (40) — the
   * story viewer is 60, so a confirm asked from inside it passes 61 (the
   * sheet applies +2). Never reach the call planes (69–72, globals.css). */
  zIndex?: number;
}

export interface PendingConfirm {
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  zIndex?: number;
  resolve: (ok: boolean) => void;
}

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getPending(): PendingConfirm | null {
  return pending;
}

export function usePendingConfirm(): PendingConfirm | null {
  return useSyncExternalStore(subscribe, getPending, () => null);
}

const DANGER_RE = /\b(delete|remove|ban|block|take .* down|cannot be undone|can.t be undone|for good)\b/i;

export function confirmDialog(text: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (pending) pending.resolve(false);
  return new Promise<boolean>((resolve) => {
    const ask: PendingConfirm = {
      text,
      confirmLabel: opts.confirmLabel ?? 'Yes',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger ?? DANGER_RE.test(text),
      zIndex: opts.zIndex,
      resolve: (ok) => {
        if (pending === ask) pending = null;
        emit();
        resolve(ok);
      },
    };
    pending = ask;
    emit();
  });
}
