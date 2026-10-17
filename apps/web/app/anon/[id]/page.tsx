'use client';

// One anonymous reveal-game thread (v0.8b — API.md §1.62, FEATURES #77).
import { useParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import AnonThreadView from '@/components/AnonThreadView';

export default function AnonThreadPage() {
  const params = useParams<{ id: string }>();
  return (
    <AppShell>
      <AnonThreadView threadId={params.id} />
    </AppShell>
  );
}
