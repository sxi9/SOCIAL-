'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ChatView from '@/components/ChatView';
import TwoPane from '@/components/TwoPane';
import { useAppState } from '@/lib/useStore';
import { joinCall } from '@/lib/webrtc';

/**
 * v0.7.1 ring push (API.md §2.9, FEATURES #88): the notification's Answer
 * action (and a plain tap) deep-links to /c/<conversation_id>?call=<call_id>.
 * ChatView's call-log fetch (§1.42 reconnect truth) populates liveCalls on
 * open; the moment the named call shows up live, auto-accept runs the normal
 * §1.42 join. The ?call param is stripped immediately so a refresh (or a
 * stale deep link after the call ended) never re-joins — and a call that is
 * already terminal simply never matches, showing nothing (the ring was
 * handled elsewhere).
 */
function CallAutoAccept({ conversationId }: { conversationId: string }) {
  const state = useAppState();
  const search = useSearchParams();
  const router = useRouter();
  const attempted = useRef(false);
  const callId = search.get('call');
  const live = state.liveCalls.get(conversationId);

  useEffect(() => {
    if (!callId || attempted.current) return;
    // Already in a call (this one or another): no auto-join — the mesh is one
    // call per person; just clean the URL.
    if (state.callUi && state.callUi.phase !== 'ended') {
      attempted.current = true;
      router.replace(`/c/${conversationId}`);
      return;
    }
    // Wait for the socket: the §1.42 join must be able to send its offers.
    if (state.conn !== 'online') return;
    if (live && live.id === callId && (live.status === 'ringing' || live.status === 'ongoing')) {
      attempted.current = true;
      router.replace(`/c/${conversationId}`);
      void joinCall(callId, live.kind);
    }
  }, [callId, live, state.callUi, state.conn, conversationId, router]);

  return null;
}

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  return (
    <TwoPane activeId={params.id}>
      {/* Keyed so switching conversations in the sidebar remounts cleanly. */}
      <ChatView key={params.id} conversationId={params.id} />
      {/* useSearchParams needs a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <CallAutoAccept conversationId={params.id} />
      </Suspense>
    </TwoPane>
  );
}
