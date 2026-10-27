'use client';

// The one share sheet (§1b "share everything", 2026-10-27; API.md §1.67).
// Mounted on every shareable object — post, beacon, listing, story, group —
// in place of the five clipboard-only buttons. Opening it mints-or-returns
// the object's ONE open token; the row of actions is the whole contract:
//   Copy link · Share… (OS sheet) · QR · Send to a chat · Stop sharing
// and, for a NON-public object (not mintable yet — the §1b token path), the
// Teaser / Full preview switch chosen at mint time. Stop sharing goes
// through confirmDialog (the standing no-undo-pill decision) and kills the
// page and every gated media URL instantly. Portaled to <body>: two of the
// callers are themselves sheets, and a fixed backdrop inside a transformed
// ancestor pins itself to that ancestor (the CLAUDE.md overlay gotcha).
// Stacking: `zIndex` lifts the sheet, its picker and its confirm above a
// caller that sits higher than the modal plane (the story viewer, z 60);
// Escape is topmost-only via lib/overlays.
import { useEffect, useRef, useState } from 'react';
import type { SendMessageResponse, ShareLink, ShareObjectType } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import * as db from '@/lib/db';
import { conversationTitle } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { useOverlayEscape } from '@/lib/overlays';
import {
  absoluteShareUrl,
  copyText,
  mintShareLink,
  revokeShareLink,
  SHARE_OBJECT_WORD,
} from '@/lib/share';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import ChatPickerSheet, { type PickerResult } from './ChatPickerSheet';
import Portal from './Portal';
import QrCode from './QrCode';
import styles from './invite.module.css';

interface ShareSheetProps {
  type: ShareObjectType;
  id: string;
  onClose: () => void;
  /** Set when the object is NOT public: shows the Teaser / Full switch. The
   * server refuses non-public mints until the §1b token path lands, so this
   * is wired but unreachable today. */
  nonPublic?: boolean;
  /** Above-the-caller stacking (modal plane is 40; the story viewer is 60). */
  zIndex?: number;
}

export default function ShareSheet({ type, id, onClose, nonPublic = false, zIndex }: ShareSheetProps) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<'teaser' | 'full'>('teaser');
  const mintedRef = useRef(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  // One client_msg_id per target conversation for ONE picker session, so a
  // retry after a partial failure REPLAYS (server 200) instead of sending the
  // link twice (§1.5 idempotency). Reset each time the picker opens: a new
  // "Send to a chat" is a new intent and must produce a new message, never a
  // silent replay reported as "Sent ✓".
  const sendIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    void (async () => {
      try {
        setLink(await mintShareLink(type, id));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_public') {
          setError('Only public things get a share link.');
        } else if (err instanceof ApiError && err.status === 403) {
          setError('Only the group’s admins can share it.');
        } else if (err instanceof ApiError && err.status === 404) {
          setError('This is not available to share.');
        } else {
          setError('Could not make a share link. Check your connection and try again.');
        }
      }
    })();
  }, [type, id]);

  // Topmost-only Escape; the picker (and the confirm) take over while open.
  useOverlayEscape(onClose);
  // Focus the first action once the link exists; give focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    if (link) copyRef.current?.focus();
  }, [link]);

  const url = link ? absoluteShareUrl(link) : null;
  const word = SHARE_OBJECT_WORD[type];

  async function copy(): Promise<void> {
    if (!url) return;
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast('Public link copied — anyone can open it');
    } else {
      // Clipboard blocked: the link box above is select-all; say so.
      toast('Clipboard blocked — select the link above to copy it');
    }
  }

  function share(): void {
    if (!url) return;
    void navigator.share({ title: 'Bored Chat', url }).catch(() => undefined);
  }

  async function revoke(): Promise<void> {
    if (!link || busy) return;
    const ok = await confirmDialog(
      `Stop sharing this ${word}? The link stops working for everyone who has it.`,
      { confirmLabel: 'Stop sharing', danger: true, zIndex },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await revokeShareLink(link.token);
      toast('Share link revoked — the page is gone');
      onClose();
    } catch {
      toast('Could not revoke the link');
      setBusy(false);
    }
  }

  /** "Send to a chat": the link rides as an ordinary text message into each
   * picked chat (§1.5 send). Per-target: what went through is reported back
   * so the picker clears it; what failed is named. */
  async function sendTo(targets: string[]): Promise<PickerResult> {
    if (!url) return { error: 'No link yet.', sent: [] };
    const sent: string[] = [];
    const failed: string[] = [];
    for (const convId of targets) {
      let cid = sendIdsRef.current.get(convId);
      if (!cid) {
        cid = uuidv7();
        sendIdsRef.current.set(convId, cid);
      }
      try {
        const res = await api.post<SendMessageResponse>(`/api/conversations/${convId}/messages`, {
          client_msg_id: cid,
          type: 'text',
          body: url,
        });
        store.applyMessage(res.message);
        void db.storeMessages(convId, [res.message]).catch(() => undefined);
        sent.push(convId);
      } catch {
        failed.push(convId);
      }
    }
    if (failed.length === 0) return { error: null, sent };
    const meId = store.state.me?.id;
    const titles = failed.map((cid) => {
      const c = store.state.conversations.get(cid);
      return c ? conversationTitle(c, meId) : 'a chat';
    });
    const names =
      titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}` : titles[0]!;
    const head = sent.length > 0 ? `Sent to ${sent.length} of ${targets.length} — ` : '';
    return { error: `${head}${names} ${failed.length === 1 ? 'is' : 'are'} not available right now.`, sent };
  }

  return (
    <Portal>
      <div
        className={styles.backdrop}
        style={zIndex !== undefined ? { zIndex } : undefined}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={`Share this ${word}`}>
          <div className={styles.head}>
            <h2>Share this {word}</h2>
            <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className={styles.blurb}>
            Anyone with the link can see it — no account needed to look. Joining takes a minute.
          </p>

          {error ? (
            <p className="error-text">{error}</p>
          ) : !link || !url ? (
            <div className={styles.spinnerRow}>
              <span className="spinner" /> Making your link…
            </div>
          ) : (
            <>
              {nonPublic ? (
                <div className={styles.actions} role="radiogroup" aria-label="What the link shows">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preview === 'teaser'}
                    className={`btn${preview === 'teaser' ? ' btn-primary' : ''}`}
                    onClick={() => setPreview('teaser')}
                  >
                    Teaser
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preview === 'full'}
                    className={`btn${preview === 'full' ? ' btn-primary' : ''}`}
                    onClick={() => setPreview('full')}
                  >
                    Full
                  </button>
                </div>
              ) : null}
              <div className={styles.linkBox}>
                <span className={styles.linkText}>{url}</span>
              </div>
              <div className={styles.actions}>
                <button ref={copyRef} type="button" className="btn btn-primary" onClick={() => void copy()}>
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
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    sendIdsRef.current = new Map();
                    setPickerOpen(true);
                  }}
                >
                  Send to a chat
                </button>
              </div>
              {qrOpen ? (
                <div className={styles.linkBox} style={{ justifyContent: 'center' }}>
                  <QrCode text={url} label={`QR code for this ${word}'s link`} size={176} />
                </div>
              ) : null}
              <div className={styles.actions}>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void revoke()}>
                  Stop sharing
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {pickerOpen && url ? (
        <ChatPickerSheet
          title="Send link to…"
          preview={<span title={url}>{url}</span>}
          verb="Send"
          doneLabel="Sent ✓"
          onClose={() => setPickerOpen(false)}
          onConfirm={sendTo}
          zIndex={zIndex !== undefined ? zIndex + 1 : undefined}
        />
      ) : null}
    </Portal>
  );
}

/** A button that opens the sheet — the drop-in for the old copy buttons. */
export function ShareButton({
  type,
  id,
  className = 'btn',
  style,
  label = 'Share',
  ariaLabel,
  children,
  nonPublic,
  zIndex,
}: {
  type: ShareObjectType;
  id: string;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
  nonPublic?: boolean;
  zIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        style={style}
        aria-label={ariaLabel ?? `Share this ${SHARE_OBJECT_WORD[type]}`}
        onClick={() => setOpen(true)}
      >
        {children ?? label}
      </button>
      {open ? (
        <ShareSheet type={type} id={id} onClose={() => setOpen(false)} nonPublic={nonPublic} zIndex={zIndex} />
      ) : null}
    </>
  );
}
