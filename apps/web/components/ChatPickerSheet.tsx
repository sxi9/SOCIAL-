'use client';

// Chat picker sheet — the multi-pick target list that ForwardSheet (§1.31)
// grew, extracted so "Send to a chat" on a share link (§1b ShareSheet) uses
// the SAME picker instead of a second one. Targets are the conversations I
// can actually post into (channels need owner/admin, §1.35); the caller owns
// what happens with the picked ids and reports back per target: the ids
// that went through are dropped from the selection so a retry after a
// partial failure only re-sends what failed.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FORWARD_MAX_TARGETS } from '@socialchat/shared';
import { canPostIn, conversationTitle, dmPeer } from '@/lib/format';
import { useOverlayEscape } from '@/lib/overlays';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import sheet from './beacons.module.css';
import cm from './community.module.css';
import st from './social.module.css';

export interface PickerResult {
  /** null = everything went through. */
  error: string | null;
  /** Conversations that DID receive it (cleared from the selection). */
  sent: string[];
}

interface ChatPickerSheetProps {
  title: string;
  /** What is being sent — rendered as the quote pill under the title. */
  preview: ReactNode;
  verb: string; // 'Forward' | 'Send'
  doneLabel: string; // 'Forwarded ✓' | 'Sent ✓'
  onClose: () => void;
  onConfirm: (conversationIds: string[]) => Promise<PickerResult>;
  /** Above-the-caller stacking (the story viewer sits at z 60). */
  zIndex?: number;
}

export default function ChatPickerSheet({
  title,
  preview,
  verb,
  doneLabel,
  onClose,
  onConfirm,
  zIndex,
}: ChatPickerSheetProps) {
  const state = useAppState();
  const meId = state.me?.id;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Not dismissable mid-send: the POST loop would keep running against an
  // unmounted sheet, the user would never see the per-target result, and a
  // re-send after reopening would duplicate what already went through.
  const close = () => {
    if (!busy) onClose();
  };
  // Topmost-only Escape (lib/overlays); focus lands in the search box and
  // goes back to the opener on close (the aria-modal contract).
  useOverlayEscape(close);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

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

  async function confirm(): Promise<void> {
    if (busy || picked.size === 0) return;
    setBusy(true);
    setError(null);
    const res = await onConfirm([...picked]);
    if (res.sent.length > 0) {
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of res.sent) next.delete(id);
        return next;
      });
    }
    if (res.error) {
      setError(res.error);
      setBusy(false);
      return;
    }
    setDone(true);
    setTimeout(onClose, 650);
  }

  const onlyPicked = picked.size === 1 ? state.conversations.get([...picked][0]!) : null;
  // 'Send' → 'Sending…', 'Forward' → 'Forwarding…' (a trailing e drops).
  const busyLabel = `${verb.replace(/e$/, '')}ing…`;

  return (
    <div
      className={sheet.sheetBackdrop}
      style={zIndex !== undefined ? { zIndex } : undefined}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={sheet.sheetHead}>
          <h2>{title}</h2>
          <button type="button" className={sheet.sheetClose} aria-label="Close" disabled={busy} onClick={close}>
            ×
          </button>
        </div>
        {/* Royal v2 (proto 15): what is being sent rides a preview pill. */}
        <div className={cm.fwdQuote}>{preview}</div>
        <input
          ref={searchRef}
          className="input"
          type="search"
          placeholder="Search chats"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 4 }}
        />
        {targets.length === 0 ? (
          <p className={st.connEmpty}>No chats you can post into match.</p>
        ) : (
          <div className={cm.fwdTargets}>
            {targets.map((c) => {
              const peer = dmPeer(c, meId);
              const t = conversationTitle(c, meId);
              const on = picked.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`${cm.fwdTarget}${on ? ` ${cm.fwdTargetOn}` : ''}`}
                  aria-pressed={on}
                  title={c.type === 'channel' ? `${t} · channel` : t}
                  onClick={() => toggle(c.id)}
                >
                  <span className={cm.fwdFace}>
                    <Avatar avatar={peer ? peer.avatar : c.avatar} name={t} size={52} />
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
                  <span className={cm.fwdTargetName}>{t}</span>
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
          onClick={() => void confirm()}
        >
          {done
            ? doneLabel
            : busy
              ? busyLabel
              : picked.size > 1
                ? `${verb} to ${picked.size} chats`
                : picked.size === 1
                  ? `${verb} to ${onlyPicked ? conversationTitle(onlyPicked, meId) : 'chat'}`
                  : verb}
        </button>
      </div>
    </div>
  );
}
