'use client';

// Admin support inbox (v0.8b — API.md §1.69 #81b). Tickets from Settings →
// Help & feedback; replies land in the user's "Bored Chat Support"
// conversation as ordinary messages with sender_id NULL (the brand, never a
// named admin). Reading the dialogue is NOT private-chat reading: the
// conversation exists to talk to the operator — consent is structural.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminSupportTicket,
  Message,
  SupportCategory,
  SupportTicketStatus,
} from '@socialchat/shared';
import { ADMIN_NOTE_MAX_CHARS, SUPPORT_BODY_MAX_CHARS } from '@socialchat/shared';
import {
  adminSupportClose,
  adminSupportReply,
  adminSupportTicket,
  adminSupportTickets,
} from '@/lib/admin';
import { formatTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import ad from '@/components/admin.module.css';
import cm from '@/components/community.module.css';

const CATEGORY_EMOJI: Record<SupportCategory, string> = {
  bug: '🐞',
  question: '❓',
  idea: '💡',
  safety: '⚠️',
  legal: '⚖️',
};

type StatusFilter = SupportTicketStatus | null;

export default function AdminSupportPage() {
  const [status, setStatus] = useState<StatusFilter>(null);
  const [tickets, setTickets] = useState<AdminSupportTicket[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = (fetchSeq.current += 1);
    setError(null);
    try {
      const res = await adminSupportTickets(status, null);
      if (fetchSeq.current !== seq) return;
      setTickets(res.tickets);
      setCursor(res.next_cursor);
    } catch {
      if (fetchSeq.current === seq) setError('Could not load the inbox.');
    }
  }, [status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function more(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await adminSupportTickets(status, cursor);
      setTickets((prev) => [...(prev ?? []), ...res.tickets]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more.');
    }
  }

  return (
    <div>
      <h2>Support inbox</h2>
      <p className={ad.note}>
        Tickets from Settings → Help &amp; feedback. Replies arrive to the user as the
        &ldquo;Bored Chat Support&rdquo; brand — never a named admin. A user reply in that
        conversation re-opens their ticket.
      </p>
      <div className={ad.levelChips} role="radiogroup" aria-label="Status filter">
        {(
          [
            { v: null, label: 'All' },
            { v: 'open', label: 'Open' },
            { v: 'answered', label: 'Answered' },
            { v: 'closed', label: 'Closed' },
          ] as const
        ).map((f) => (
          <button
            key={f.label}
            type="button"
            role="radio"
            aria-checked={status === f.v}
            className={`btn${status === f.v ? ' btn-primary' : ''}`}
            onClick={() => setStatus(f.v)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      {tickets === null ? (
        <p className="muted small" role="status">
          Loading…
        </p>
      ) : tickets.length === 0 ? (
        <p className="muted small">Inbox zero. Enjoy it.</p>
      ) : (
        <>
          {tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              onChanged={(next) => setTickets((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev)}
              onRefresh={() => void refresh()}
            />
          ))}
          {cursor !== null ? (
            <button type="button" className="btn" onClick={() => void more()}>
              Load more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function statusClass(s: SupportTicketStatus): string {
  return `${cm.statusChip} ${s === 'open' ? cm.statusOpen : s === 'answered' ? cm.statusAnswered : ''}`;
}

function TicketCard({
  ticket,
  onChanged,
  onRefresh,
}: {
  ticket: AdminSupportTicket;
  onChanged: (t: AdminSupportTicket) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const res = await adminSupportTicket(ticket.id);
      setMessages(res.messages);
      onChanged(res.ticket);
    } catch {
      setError('Could not load the dialogue.');
    }
  }

  async function sendReply(): Promise<void> {
    const body = reply.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminSupportReply(ticket.id, body);
      setReply('');
      toast('Reply sent as Bored Chat Support');
      await load();
      onRefresh();
    } catch {
      setError('Could not send the reply.');
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminSupportClose(ticket.id, note.trim());
      toast('Ticket closed');
      await load();
      onRefresh();
    } catch {
      setError('Could not close it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={ad.reportCard}>
      <div className={ad.reportHead}>
        <span className={ad.flag}>
          {CATEGORY_EMOJI[ticket.category]} {ticket.category}
        </span>
        <span className={statusClass(ticket.status)}>{ticket.status}</span>
        <span>
          from{' '}
          {ticket.user ? (
            <strong>@{ticket.user.username}</strong>
          ) : (
            <span className={ad.dim}>account deleted</span>
          )}
        </span>
        <span className={ad.dim}>{formatTime(ticket.created_at)}</span>
      </div>
      <p className={ad.reportReason}>{ticket.body}</p>
      {ticket.attachment && ticket.attachment.thumb_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ticket.attachment.thumb_url}
          alt="Attached screenshot"
          style={{ maxWidth: 220, borderRadius: 10, marginBottom: 8 }}
        />
      ) : null}

      {!open ? (
        <div className={ad.closeRow}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOpen(true);
              void load();
            }}
          >
            Open dialogue
          </button>
        </div>
      ) : (
        <>
          <div className={cm.contextSlice} aria-label="Support dialogue">
            {messages === null ? (
              <p className="muted small" style={{ margin: 0 }}>
                Loading…
              </p>
            ) : messages.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No dialogue yet — the first reply creates their Support conversation.
              </p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={cm.contextMsg}>
                  <strong>{m.sender_id === null ? '🛟 Support' : `@${ticket.user?.username ?? 'user'}`}</strong>{' '}
                  <span className={ad.dim}>{formatTime(m.created_at)}</span>
                  <div>{m.deleted_at ? <em className={ad.dim}>deleted</em> : m.body ?? <em className={ad.dim}>attachment</em>}</div>
                </div>
              ))
            )}
          </div>
          <div className={ad.closeRow} style={{ marginTop: 8 }}>
            <input
              className="input"
              placeholder="Reply as Bored Chat Support…"
              value={reply}
              maxLength={SUPPORT_BODY_MAX_CHARS}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void sendReply();
                }
              }}
            />
            <button type="button" className="btn btn-primary" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>
              Reply
            </button>
          </div>
          {ticket.status !== 'closed' ? (
            <div className={ad.closeRow} style={{ marginTop: 6 }}>
              <input
                className="input"
                placeholder="Close note (optional, logged)"
                value={note}
                maxLength={ADMIN_NOTE_MAX_CHARS}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="button" className="btn" disabled={busy} onClick={() => void close()}>
                Close ticket
              </button>
            </div>
          ) : null}
        </>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </article>
  );
}
