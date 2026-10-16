'use client';

// Shared `prefers-reduced-motion` hook for the animated auth experience.
// SSR renders `false` (static markup carries no motion anyway); the real value
// lands right after mount and tracks live changes to the media query.
import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
