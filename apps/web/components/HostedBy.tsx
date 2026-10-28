'use client';

// Wave 1 (§1.1): the three honest lines under the auth card — what this is,
// who runs it, and where the terms live. Reads GET /api/instance once.
import Link from 'next/link';
import { useInstanceInfo } from '@/lib/instance';
import authStyles from './auth.module.css';

export default function HostedBy() {
  const info = useInstanceInfo();
  return (
    <p className={authStyles.footLineSmall}>
      A small self-hosted chat — no ads, no contact sync, no feed that never ends.
      {info?.operator_contact ? (
        <>
          {' '}
          Hosted by <strong>{info.operator_contact}</strong>.
        </>
      ) : null}{' '}
      <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> ·{' '}
      <Link href="/guidelines">Guidelines</Link>
    </p>
  );
}
