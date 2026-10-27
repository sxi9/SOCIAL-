'use client';

// Invite-link sheet (v0.2 — API.md §1.11). Opening it REUSES the newest still-
// open invite for this scope (GET /api/invites) and only mints a fresh token
// via POST /api/invites when none exists — the server caps simultaneously open
// invites at 20 (409 invite_limit), so minting on every open would dead-end
// the button after 20 opens. InvitePrivate.url is the app-origin PATH
// /join/<token>, so the full link is window.location.origin + url. Copy always
// works; navigator.share rides along where the platform has a share sheet.
// Phase 2 (2026-10-28, AUDIT-PLAN §2.5): a QR for the link, and "Your open
// links" — every link I hold for this scope, with Revoke (DELETE
// /api/invites/:id); dead links stay listed so the list explains them.
import { useEffect, useRef, useState } from 'react';
import type { CreateInviteResponse, InvitePrivate, ListInvitesResponse } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import { useOverlayEscape } from '@/lib/overlays';
import { toast } from '@/lib/toast';
import Portal from './Portal';
import QrCode from './QrCode';
import styles from './invite.module.css';

const SHARE_TEXT = 'Join me on Bored Chat 👋';

interface InviteSheetProps {
  onClose: () => void;
  /** Omitted = DM-with-me invite; set = group invite (admin-only, §1.11). */
  conversationId?: string;
}

function whenShort(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function rowNote(inv: InvitePrivate): string {
  switch (inv.status) {
    case 'valid':
      return `${inv.use_count}/${inv.max_uses} joined · lasts until ${whenShort(inv.expires_at)}`;
    case 'expired':
      return `expired ${whenShort(inv.expires_at)} · ${inv.use_count} joined`;
    case 'exhausted':
      return `all ${inv.max_uses} joins used`;
    default:
      return `revoked${inv.revoked_at ? ` ${whenShort(inv.revoked_at)}` : ''} · ${inv.use_count} joined`;
  }
}

export default function InviteSheet({ onClose, conversationId }: InviteSheetProps) {
  const [invite, setInvite] = useState<InvitePrivate | null>(null);
  const [mine, setMine] = useState<InvitePrivate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const mintedRef = useRef(false);
  const mintingRef = useRef(false);
  const scope = conversationId ?? null;

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  async function mint(): Promise<void> {
    if (mintingRef.current) return; // one mint at a time (the 20-open cap is real)
    mintingRef.current = true;
    setMinting(true);
    setError(null);
    try {
      const res = await api.post<CreateInviteResponse>(
        '/api/invites',
        conversationId ? { conversation_id: conversationId } : {},
      );
      setInvite(res.invite);
      setMine((prev) => [res.invite, ...prev.filter((i) => i.id !== res.invite.id)]);
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
    } finally {
      mintingRef.current = false;
      setMinting(false);
    }
  }

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    void (async () => {
      // Reuse first: newest open ('valid') invite for this exact scope.
      // GET /api/invites is created_at DESC, so the first match is newest.
      try {
        const list = await api.get<ListInvitesResponse>('/api/invites');
        const here = list.invites.filter((inv) => inv.conversation_id === scope);
        setMine(here);
        const open = here.find((inv) => inv.status === 'valid');
        if (open) {
          setInvite(open);
          return;
        }
      } catch {
        /* list unavailable — fall through and try minting */
      }
      await mint();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useOverlayEscape(onClose);

  const url = invite ? `${window.location.origin}${invite.url}` : null;

  async function copy(): Promise<void> {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast('Invite link copied'); // v0.7.1 §1.56: the shared confirmation toast
    } catch {
      /* clipboard blocked — the link text is select-all, manual copy works */
    }
  }

  function share(): void {
    if (!url) return;
    void navigator.share({ title: 'Bored Chat', text: SHARE_TEXT, url }).catch(() => undefined);
  }

  async function revoke(inv: InvitePrivate): Promise<void> {
    if (busyId) return;
    const ok = await confirmDialog(
      'Revoke this invite link? Anyone who has it can no longer join with it. People who already joined stay.',
      { confirmLabel: 'Revoke link' },
    );
    if (!ok) return;
    setBusyId(inv.id);
    try {
      await api.del(`/api/invites/${inv.id}`);
      const now = new Date().toISOString();
      const dead: InvitePrivate = { ...inv, status: 'revoked', revoked_at: inv.revoked_at ?? now };
      const rest = mine.map((i) => (i.id === inv.id ? dead : i));
      setMine(rest);
      if (invite?.id === inv.id) {
        // The next open link (newest first) takes over; none → "Make a new link".
        setInvite(rest.find((i) => i.status === 'valid') ?? null);
        setQrOpen(false);
      }
      toast('Invite link revoked');
    } catch {
      toast('Could not revoke that link');
    }
    setBusyId(null);
  }

  return (
    // Portaled to <body>: InviteButton lives in the blurred `.topbar`, whose
    // backdrop-filter would otherwise contain this fixed backdrop (BUG: sheet
    // pinned to the topbar box, clipped off-screen).
    <Portal>
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
          <>
            <p className="error-text">{error}</p>
            <button type="button" className="btn" onClick={() => void mint()}>
              Try again
            </button>
          </>
        ) : !invite || !url ? (
          !minting && mine.length > 0 && !mine.some((i) => i.status === 'valid') ? (
            <button type="button" className="btn btn-primary" onClick={() => void mint()}>
              Make a new link
            </button>
          ) : (
            <div className={styles.spinnerRow}>
              <span className="spinner" /> Minting your link…
            </div>
          )
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
              <button type="button" className="btn" aria-pressed={qrOpen} onClick={() => setQrOpen((v) => !v)}>
                QR
              </button>
            </div>
            {qrOpen ? (
              <div className={styles.linkBox} style={{ justifyContent: 'center', marginTop: 10 }}>
                <QrCode text={url} label="QR code for this invite link" size={176} />
              </div>
            ) : null}
          </>
        )}

        {mine.length > 0 ? (
          <>
            <div className={styles.listLabel}>Your links {conversationId ? 'for this group' : ''}</div>
            {mine.map((inv) => (
              <div key={inv.id} className={`${styles.row} ${inv.status === 'valid' ? '' : styles.rowDead}`}>
                <span className={styles.rowText}>
                  <strong>{inv.status === 'valid' ? (inv.id === invite?.id ? 'This link' : 'Open link') : inv.status}</strong>
                  <span>{rowNote(inv)}</span>
                </span>
                {inv.status === 'valid' ? (
                  <button type="button" className="btn" disabled={busyId !== null} onClick={() => void revoke(inv)}>
                    {busyId === inv.id ? 'Revoking…' : 'Revoke'}
                  </button>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
    </Portal>
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
