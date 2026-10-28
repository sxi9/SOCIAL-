// Wave 1 (§1.1): the public instance info on the CLIENT — "Hosted by" on
// the auth scenes, the About block, the age line. One fetch per page load,
// shared; failures degrade to null (nothing user-facing depends on it).
import { useEffect, useState } from 'react';
import type { PublicInstanceInfo } from '@socialchat/shared';
import { api } from './api';

let memo: Promise<PublicInstanceInfo | null> | null = null;

export function getInstanceInfo(): Promise<PublicInstanceInfo | null> {
  if (!memo) {
    memo = api.get<PublicInstanceInfo>('/api/instance').catch(() => {
      memo = null;
      return null;
    });
  }
  return memo;
}

export function useInstanceInfo(): PublicInstanceInfo | null {
  const [info, setInfo] = useState<PublicInstanceInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getInstanceInfo().then((i) => {
      if (!cancelled) setInfo(i);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
