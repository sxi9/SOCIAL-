'use client';

import { useParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ChatView from '@/components/ChatView';

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  return (
    <AppShell>
      <ChatView conversationId={params.id} />
    </AppShell>
  );
}
