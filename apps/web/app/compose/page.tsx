'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ConversationListItem, ShareImport, ShareImportResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { sendMessage } from '@/lib/connection';
import { conversationTitle, dmPeer, messageSnippet } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { useAppState } from '@/lib/useStore';
import AppShell from '@/components/AppShell';
import Avatar from '@/components/Avatar';
import Composer, { type ComposerPayload } from '@/components/Composer';
import listStyles from '@/components/list.module.css';

function initialBodyOf(imp: ShareImport): string {
  const parts: string[] = [];
  if (imp.text_body) parts.push(imp.text_body);
  if (imp.url && !(imp.text_body ?? '').includes(imp.url)) parts.push(imp.url);
  return parts.join('\n');
}

function sortKey(item: ConversationListItem): number {
  return item.last_message_at ? new Date(item.last_message_at).getTime() : new Date(item.created_at).getTime();
}

function ComposeInner() {
  const search = useSearchParams();
  const router = useRouter();
  const state = useAppState();
  const importId = search.get('import');

  const [imp, setImp] = useState<ShareImport | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'gone' | 'none'>(
    importId ? 'loading' : 'none'
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedNote, setQueuedNote] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!importId || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      try {
        const res = await api.get<ShareImportResponse>(`/api/share-imports/${importId}`);
        if (res.import.status !== 'open') {
          setLoadState('gone');
          return;
        }
        setImp(res.import);
        setLoadState('ready');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setLoadState('gone');
        else setLoadState('gone');
      }
    })();
  }, [importId]);

  const conversations = [...state.conversations.values()].sort((a, b) => sortKey(b) - sortKey(a));

  async function submit(payload: ComposerPayload): Promise<boolean> {
    if (!selected) {
      setError('Pick a conversation first.');
      return false;
    }
    setError(null);
    const msg = await sendMessage(selected, { client_msg_id: uuidv7(), ...payload });
    if (msg) {
      if (imp) {
        // Consume the import after a successful send (§6 step 5).
        await api.del(`/api/share-imports/${imp.id}`).catch(() => undefined);
      }
      router.replace(`/c/${selected}`);
    } else {
      // Parked in the outbox; the import stays open until it actually sends.
      setQueuedNote(true);
      router.replace(`/c/${selected}`);
    }
    return true;
  }

  async function discard(): Promise<void> {
    if (imp) await api.del(`/api/share-imports/${imp.id}`).catch(() => undefined);
    router.replace('/');
  }

  if (loadState === 'loading') {
    return (
      <div className="center-screen muted" role="status">
        Loading share…
      </div>
    );
  }

  if (loadState === 'gone' || loadState === 'none') {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          <h1>{loadState === 'gone' ? 'Share expired' : 'Nothing to share'}</h1>
          <p className="muted">
            {loadState === 'gone'
              ? 'This shared content is no longer available.'
              : 'Open the share sheet in another app and pick SocialChat.'}
          </p>
          <Link className="btn btn-primary" href="/">
            Go to chats
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>Share to…</h1>
        <button type="button" className="btn btn-ghost" onClick={() => void discard()}>
          Discard
        </button>
      </header>

      <div className="settings-section" style={{ flex: 1, overflowY: 'auto' }}>
        {imp?.title ? <p className="muted small">Shared: {imp.title}</p> : null}
        {queuedNote ? <p className="ok-text">Offline — the message is queued and will send when you reconnect.</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        {conversations.length === 0 ? (
          <p className="muted">
            No conversations yet — <Link href="/new">start one</Link> first, then share again.
          </p>
        ) : (
          conversations.map((item) => {
            const title = conversationTitle(item, state.me?.id);
            const peer = dmPeer(item, state.me?.id);
            const avatar = peer ? peer.avatar : item.avatar;
            return (
              <button
                key={item.id}
                type="button"
                className={`${listStyles.pickerRow}${selected === item.id ? ` ${listStyles.selected}` : ''}`}
                onClick={() => {
                  setSelected(item.id);
                  setError(null);
                }}
              >
                <Avatar avatar={avatar} name={title} size={38} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{title}</span>
                  <span className="muted small" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {messageSnippet(item.last_message)}
                  </span>
                </span>
                {selected === item.id ? <span className="badge">✓</span> : null}
              </button>
            );
          })
        )}
      </div>

      {imp ? (
        <Composer
          onSubmit={submit}
          initialBody={initialBodyOf(imp)}
          initialAttachments={imp.attachments}
          initialPreview={imp.preview?.status === 'ok' ? imp.preview.preview ?? null : null}
          disabled={!selected}
        />
      ) : null}
    </div>
  );
}

export default function ComposePage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <ComposeInner />
      </Suspense>
    </AppShell>
  );
}
