'use client';

// Invite-link sheet (v0.2 — API.md §1.11). Opening it REUSES the newest still-
// open invite for this scope (GET /api/invites) and only mints a fresh token
// via POST /api/invites when none exists — the server caps simultaneously open
// invites at 20 (409 invite_limit), so minting on every open would dead-end
// the button after 20 opens. InvitePrivate.url is the app-origin PATH
// /join/<token>, so the full link is window.location.origin + url. Copy always
// works; navigator.share rides along where the platform has a share sheet.
import { useEffect, useRef, useState } from 'react';
import type { CreateInviteResponse, InvitePrivate, ListInvitesResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import styles from './invite.module.css';

const SHARE_TEXT = 'Join me on Bored Chat 👋';

interface InviteSheetProps {
  onClose: () => void;
  /** Omitted = DM-with-me invite; set = group invite (admin-only, §1.11). */
  conversationId?: string;
}

export default function InviteSheet({ onClose, conversationId }: InviteSheetProps) {
  const [invite, setInvite] = useState<InvitePrivate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const mintedRef = useRef(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    void (async () => {
      // Reuse first: newest open ('valid') invite for this exact scope.
      // GET /api/invites is created_at DESC, so the first match is newest.
      try {
        const list = await api.get<ListInvitesResponse>('/api/invites');
        const open = list.invites.find(
          (inv) => inv.status === 'valid' && inv.conversation_id === (conversationId ?? null),
        );
        if (open) {
          setInvite(open);
          return;
        }
      } catch {
        /* list unavailable — fall through and try minting */
      }
      try {
        const res = await api.post<CreateInviteResponse>(
          '/api/invites',
          conversationId ? { conversation_id: conversationId } : {},
        );
        setInvite(res.invite);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          setError('Easy there — you minted a lot of links this hour. Try again in a bit.');
        } else if (err instanceof ApiError && err.status === 403) {
          setError('Only group admins can mint invite links for a group.');
        } else if (err instanceof ApiError && err.status === 409 && err.code === 'invite_limit') {
          setError(
            'You already have 20 open invite links — the most one account can hold. Revoke one or let an old link lapse, then try again.',
          );
        } else {
          setError('Could not create an invite link. Check your connection and try again.');
        }
      }
    })();
  }, [conversationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const url = invite ? `${window.location.origin}${invite.url}` : null;

  async function copy(): Promise<void> {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the link text is select-all, manual copy works */
    }
  }

  function share(): void {
    if (!url) return;
    void navigator.share({ title: 'Bored Chat', text: SHARE_TEXT, url }).catch(() => undefined);
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Invite a friend">
        <div className={styles.head}>
          <h2>Invite a friend</h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className={styles.blurb}>
          {conversationId
            ? 'Anyone with this link joins the group — no account needed up front.'
            : 'Anyone with this link lands straight in a chat with you — no account needed up front.'}{' '}
          It lasts 7 days (or 50 joins, whichever comes first).
        </p>

        {error ? (
          <p className="error-text">{error}</p>
        ) : !invite || !url ? (
          <div className={styles.spinnerRow}>
            <span className="spinner" /> Minting your link…
          </div>
        ) : (
          <>
            <div className={styles.linkBox}>
              <span className={styles.linkText}>{url}</span>
            </div>
            <div className={styles.actions}>
              <button type="button" className="btn btn-primary" onClick={() => void copy()}>
                {copied ? <span className={styles.copied}>Copied!</span> : 'Copy link'}
              </button>
              {canShare ? (
                <button type="button" className="btn" onClick={share}>
                  Share…
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A button that opens the sheet — drop it in headers and empty states. */
export function InviteButton({
  className = 'btn',
  label = 'Invite',
  conversationId,
}: {
  className?: string;
  label?: string;
  conversationId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} aria-label="Invite a friend" onClick={() => setOpen(true)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path
            d="M8.5 11.5 L11.5 8.5 M7 13 a3 3 0 0 1 -4.2 -4.2 l2.4 -2.4 a3 3 0 0 1 4.2 0 M13 7 a3 3 0 0 1 4.2 4.2 l-2.4 2.4 a3 3 0 0 1 -4.2 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        {label}
      </button>
      {open ? <InviteSheet onClose={() => setOpen(false)} conversationId={conversationId} /> : null}
    </>
  );
}
