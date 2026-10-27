// Overlay stack (2026-10-27, Slice C review): sheets stack — a ShareSheet
// over a detail sheet, a ChatPickerSheet over that, the ConfirmSheet over
// everything — and each used to register its own window Escape listener, so
// one press tore the whole stack down. Every stacking overlay registers here
// on mount and only the TOP entry acts on Escape. Deliberately tiny: no
// focus management, no z-index (callers keep their own z contract).
import { useEffect, useRef } from 'react';

const stack: symbol[] = [];

function isTop(id: symbol): boolean {
  return stack[stack.length - 1] === id;
}

/**
 * Register as a stacked overlay for the component's lifetime and run
 * `onEscape` only while it is the topmost one. Pass `active=false` to stay
 * out of the stack (e.g. a sheet that is mounted but hidden).
 */
export function useOverlayEscape(onEscape: () => void, active = true): void {
  const idRef = useRef<symbol | null>(null);
  const cbRef = useRef(onEscape);
  cbRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const id = Symbol('overlay');
    idRef.current = id;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTop(id)) return;
      e.stopImmediatePropagation();
      cbRef.current();
    };
    // Capture phase: runs before any bubble-phase listener a caller (e.g.
    // the story viewer) registered on window, so a handled Escape never
    // reaches it.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      idRef.current = null;
    };
  }, [active]);
}

/** True while any stacked overlay is open — for callers that run their own
 * keyboard shortcuts (the story viewer's arrows/space) and must yield. */
export function anyOverlayOpen(): boolean {
  return stack.length > 0;
}
