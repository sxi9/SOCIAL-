'use client';

// Forward sheet (v0.5a — API.md §1.31): multi-pick up to FORWARD_MAX_TARGETS
// conversations. All-or-nothing server-side; attachments are re-referenced,
// authorship is never spoofed (the forwarder is the sender, the original
// author rides metadata.forwarded_from).
import { useEffect, useMemo, useState } from 'react';
import type { ForwardMessageResponse, Message } from '@socialchat/shared';
import { FORWARD_MAX_TARGETS } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import * as db from '@/lib/db';
import { canPostIn, conversationTitle, dmPeer, messageSnippet } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import sheet from './beacons.module.css';
import cm from './community.module.css';
import st from './social.module.css';

interface ForwardSheetProps {
  message: Message;
  onClose: () => void;
}

export default function ForwardSheet({ message, onClose }: ForwardSheetProps) {
  const state = useAppState();
  const meId = state.me?.id;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Targets I can actually post into (channels need owner/admin, §1.35).
  const targets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...state.conversations.values()]
      .filter((c) => canPostIn(c, meId))
      .filter((c) => {
        if (!q) return true;
        return conversationTitle(c, meId).toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const ta = a.last_message_at ?? a.created_at;
        const tb = b.last_message_at ?? b.created_at;
        return new Date(tb).getTime() - new Date(ta).getTime();
      });
  }, [state.conversations, meId, filter]);

  function toggle(id: string): void {
    setError(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < FORWARD_MAX_TARGETS) next.add(id);
      else setError(`Up to ${FORWARD_MAX_TARGETS} chats at a time.`);
      return next;
    });
  }

  async function send(): Promise<void> {
    if (busy || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ForwardMessageResponse>(
        `/api/conversations/${message.conversation_id}/messages/${message.seq}/forward`,
        { client_msg_id: uuidv7(), target_conversation_ids: [...picked] }
      );
      for (const m of res.messages) {
        store.applyMessage(m);
        void db.storeMessages(m.conversation_id, [m]).catch(() => undefined);
      }
      setDone(true);
      setTimeout(onClose, 650);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_forwardable') {
        setError('This kind of message stays where it happened.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('One of those chats is not available right now.');
      } else {
        setError('Could not forward — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div
      className={sheet.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label="Forward message">
        <div className={sheet.sheetHead}>
          <h2>Forward to…</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {/* Royal v2 (proto 15): the quoted message rides a preview pill. */}
        <div className={cm.fwdQuote} title={messageSnippet(message)}>
          {messageSnippet(message)}
        </div>
        <input
          className="input"
          type="search"
          placeholder="Search chats"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 4 }}
        />
        {/* Recent chats as a horizontal avatar row with check badges. */}
        {targets.length === 0 ? (
          <p className={st.connEmpty}>No chats you can post into match.</p>
        ) : (
          <div className={cm.fwdTargets}>
            {targets.map((c) => {
              const peer = dmPeer(c, meId);
              const title = conversationTitle(c, meId);
              const on = picked.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`${cm.fwdTarget}${on ? ` ${cm.fwdTargetOn}` : ''}`}
                  aria-pressed={on}
                  title={c.type === 'channel' ? `${title} · channel` : title}
                  onClick={() => toggle(c.id)}
                >
                  <span className={cm.fwdFace}>
                    <Avatar avatar={peer ? peer.avatar : c.avatar} name={title} size={52} />
                    <span className={cm.fwdBadge} aria-hidden>
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.2 6.4 L4.8 9 L9.8 3.4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </span>
                  <span className={cm.fwdTargetName}>{title}</span>
                </button>
              );
            })}
          </div>
        )}
        {error ? <p className="error-text">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 10 }}
          disabled={busy || picked.size === 0}
          onClick={() => void send()}
        >
          {done
            ? 'Forwarded ✓'
            : busy
              ? 'Forwarding…'
              : picked.size > 1
                ? `Send to ${picked.size} chats`
                : picked.size === 1
                  ? `Send to ${(() => {
                      const c = state.conversations.get([...picked][0]);
                      return c ? conversationTitle(c, meId) : 'chat';
                    })()}`
                  : 'Send'}
        </button>
      </div>
    </div>
  );
}
