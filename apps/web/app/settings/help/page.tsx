'use client';

// Settings → Help & feedback (v0.8b — API.md §1.69 #81b, FEATURES #81).
// 🐞 bug / ❓ question / 💡 idea / ⚠️ safety + optional screenshot → a ticket
// in the operator's inbox; answers arrive in your "Bored Chat Support" chat.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Attachment, SupportCategory, SupportTicket, UploadResponse } from '@socialchat/shared';
import { SUPPORT_BODY_MAX_CHARS, SUPPORT_CATEGORIES } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import { createSupportTicket, listMySupportTickets } from '@/lib/support';
import { toast } from '@/lib/toast';
import { useInstanceInfo } from '@/lib/instance';
import AppShell from '@/components/AppShell';
import cm from '@/components/community.module.css';
import sm from '@/components/settings.module.css';

const CHEV = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

function ChevronLeft() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 6 L8.5 12 L14.5 18" {...CHEV} />
    </svg>
  );
}

const CATEGORY_INFO: Record<SupportCategory, { emoji: string; label: string }> = {
  bug: { emoji: '🐞', label: 'Something broke' },
  question: { emoji: '❓', label: 'A question' },
  idea: { emoji: '💡', label: 'An idea' },
  safety: { emoji: '⚠️', label: 'Safety' },
};

function AboutBlock() {
  const info = useInstanceInfo();
  return (
    <>
      <h2>About</h2>
      <div className="card">
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>Bored Chat</strong> · a self-hosted chat. No ads, no contact sync, no feed that never
          ends.
        </p>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          {info?.operator_contact ? (
            <>
              Hosted by <strong>{info.operator_contact}</strong> — appeals and questions go there.{' '}
            </>
          ) : (
            'Hosted by whoever runs this server. '
          )}
        </p>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> ·{' '}
          <Link href="/guidelines">Community guidelines</Link>
        </p>
      </div>
    </>
  );
}

function HelpAndFeedback() {
  const [category, setCategory] = useState<SupportCategory>('question');
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listMySupportTickets()
      .then((list) => {
        if (!cancelled) setTickets(list);
      })
      .catch(() => {
        if (!cancelled) setTickets([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      const form = new FormData();
      form.append('file', up, up.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.kind !== 'image') setError('Screenshots are images only.');
      else setAttachment(res.attachment);
    } catch (err) {
      setError(err instanceof HeicUnreadableError ? err.message : 'Could not upload the screenshot.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(): Promise<void> {
    const text = body.trim();
    if (!text || busy || uploading) return;
    setBusy(true);
    setError(null);
    try {
      const ticket = await createSupportTicket({
        category,
        body: text,
        ...(attachment ? { attachment_id: attachment.id } : {}),
      });
      setBody('');
      setAttachment(null);
      setTickets((prev) => [ticket, ...(prev ?? [])]);
      toast('Sent — the answer lands in your Bored Chat Support chat');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('That’s a lot of tickets for one day — try again tomorrow.');
      } else if (err instanceof ApiError && err.code === 'bad_attachment') {
        setError('That screenshot didn’t work — remove it and try again.');
      } else {
        setError('Could not send it — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 IA: reached from the /settings category page. */}
        <Link href="/settings" className="btn btn-ghost btn-icon" aria-label="Back">
          <ChevronLeft />
        </Link>
        <h1 className={sm.title}>Help &amp; about</h1>
        <span />
      </header>
      <div className="settings-section">
        <div className="card">
          <div className={cm.catRow} role="radiogroup" aria-label="What is this about?">
            {SUPPORT_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                className={`${cm.catChip}${category === c ? ` ${cm.catOn}` : ''}`}
                onClick={() => setCategory(c)}
              >
                <span aria-hidden>{CATEGORY_INFO[c].emoji}</span> {CATEGORY_INFO[c].label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            rows={4}
            placeholder={
              category === 'bug'
                ? 'What broke, and what were you doing when it did?'
                : category === 'safety'
                  ? 'Tell us what happened — this goes straight to the operator.'
                  : 'Say the thing…'
            }
            aria-label="Your message to the operator"
            value={body}
            maxLength={SUPPORT_BODY_MAX_CHARS}
            onChange={(e) => setBody(e.target.value)}
          />
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
              e.target.value = '';
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            {attachment ? (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attachment.thumb_url ?? attachment.url}
                  alt="Screenshot to attach"
                  style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 10 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ position: 'absolute', top: -8, right: -8 }}
                  aria-label="Remove screenshot"
                  onClick={() => setAttachment(null)}
                >
                  ×
                </button>
              </span>
            ) : (
              <button type="button" className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? 'Uploading…' : '🖼 Add a screenshot (optional)'}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || uploading || !body.trim()}
              onClick={() => void submit()}
            >
              {busy ? 'Sending…' : 'Send to the operator'}
            </button>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            Replies arrive as a <strong>🛟 Bored Chat Support</strong> chat — push, unread and all.
            Answering there re-opens your ticket.
          </p>
        </div>

        {tickets && tickets.length > 0 ? (
          <>
            <h2>Your tickets</h2>
            <div className="card">
              {tickets.map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0' }}>
                  <span aria-hidden>{CATEGORY_INFO[t.category].emoji}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.body}
                  </span>
                  <span
                    className={`${cm.statusChip} ${
                      t.status === 'open' ? cm.statusOpen : t.status === 'answered' ? cm.statusAnswered : ''
                    }`}
                  >
                    {t.status}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Wave 1 §1.1: the About block — who runs this, where the rules live. */}
        <AboutBlock />
      </div>
    </div>
  );
}

export default function HelpPage() {
  return (
    <AppShell>
      <HelpAndFeedback />
    </AppShell>
  );
}
