'use client';

// Coarse shared clock for countdowns (beacon cards, plan headers). Ticks at
// minute-ish granularity — countdowns here build anticipation (PSYCHOLOGY §5),
// they are never a seconds treadmill.
import { useEffect, useState } from 'react';

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
