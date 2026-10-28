'use client';

// Wave 1.7 (AUDIT-PLAN §1.7, migration 0015): a stranger's DM parked in my
// Requests. Four doors and nothing else — Accept (the chat opens, receipts
// and typing start), Delete (leave it; silent to them, like a declined
// connection), Block, Report. Until I choose, the composer stays closed and
// nothing I do here reaches the other side.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ConversationListItem, ConversationResponse } from '@socialchat/shared';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import { dmPeer } from '@/lib/format';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import ReportSheet from './ReportSheet';
import cm from './community.module.css';

export default function RequestBanner({ conv, meId }: { conv: ConversationListItem; meId: string }) {
  const router = useRouter();
  const peer = dmPeer(conv, meId);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(false);

  async function accept(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<ConversationResponse>(`/api/conversations/${conv.id}/accept`);
      store.upsertConversation(res.conversation);
    } catch {
      toast('Could not accept — try again');
    }
    setBusy(false);
  }

  async function remove(): Promise<void> {
    if (busy) return;
    if (!(await confirmDialog('Delete this request? They are not told. If they message you again it lands here again.'))) return;
    setBusy(true);
    try {
      await api.del(`/api/conversations/${conv.id}/participants/${meId}`);
      store.removeConversation(conv.id);
      router.push('/');
      return;
    } catch {
      toast('Could not delete — try again');
    }
    setBusy(false);
  }

  async function block(): Promise<void> {
    if (busy || !peer) return;
    if (!(await confirmDialog(`Block @${peer.username}? They can no longer message or call you.`))) return;
    setBusy(true);
    try {
      await api.put(`/api/users/${peer.id}/block`);
      store.removeConversation(conv.id);
      router.push('/');
      return;
    } catch {
      toast('Could not block — try again');
    }
    setBusy(false);
  }

  return (
    <div className={cm.publicBanner} role="status">
      <span aria-hidden>✉️</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>{peer ? peer.display_name : 'Someone'}</strong> wants to message you. Nothing you do here
        reaches them until you accept.
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void accept()}>
            Accept
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
          {peer ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void block()}>
                Block
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setReport(true)}>
                Report
              </button>
            </>
          ) : null}
        </span>
      </span>
      {report && peer ? <ReportSheet target={{ kind: 'user', user_id: peer.id }} onClose={() => setReport(false)} /> : null}
    </div>
  );
}
