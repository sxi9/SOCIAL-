'use client';

import { useParams } from 'next/navigation';
import ChatView from '@/components/ChatView';
import TwoPane from '@/components/TwoPane';

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  return (
    <TwoPane activeId={params.id}>
      {/* Keyed so switching conversations in the sidebar remounts cleanly. */}
      <ChatView key={params.id} conversationId={params.id} />
    </TwoPane>
  );
}
