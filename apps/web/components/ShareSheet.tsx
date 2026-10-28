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
  listMyShareLinks,
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
  /** Set when the object is NOT public (friends-only post, friends/area
   * plan, area-only listing): the OWNER mints a token with a Teaser / Full
   * choice stored on it (§1b, decision 11). The server answers 400
   * not_public to anyone else. */
  nonPublic?: boolean;
  /** Above-the-caller stacking (modal plane is 40; the story viewer is 60). */
  zIndex?: number;
  /** Phase 6: a profile's @username — adds the "Copy @username" action. */
  handle?: string;
  /** Phase 6: share a fixed app path instead of minting a token (someone
   * ELSE's profile: its /u/ address is public; only the owner mints a
   * revocable token). No Stop sharing — there is nothing to revoke. */
  fixedUrl?: string;
}

export default function ShareSheet({ type, id, onClose, nonPublic = false, zIndex, handle, fixedUrl }: ShareSheetProps) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<'teaser' | 'full'>('teaser');
  // nonPublic: is there already an open token for this object? Checked on
  // open so the chooser is shown only when a choice can actually take effect
  // (mint-or-return hands back an existing token whatever is picked).
  const [checkedExisting, setCheckedExisting] = useState(!nonPublic);
  // The choice the owner just made vs. the token that came back (mint-or-
  // return keeps an existing token's choice) — shown, never silent.
  const [mismatch, setMismatch] = useState<'teaser' | 'full' | null>(null);
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

  // Mint: a PUBLIC object mints on open (no choice to make). A NON-public one
  // waits for the Teaser / Full pick — the choice is stored on the token at
  // mint time and an open token keeps it, so asking first is what makes "a
  // link already sent never silently widens" true.
  async function mint(choice?: 'teaser' | 'full'): Promise<void> {
    try {
      const got = await mintShareLink(type, id, choice);
      setLink(got);
      setMismatch(choice && got.preview !== choice ? choice : null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_public') {
        setError('Only the person who posted this can share it.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Only the group’s admins can share it.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('This is not available to share.');
      } else {
        setError('Could not make a share link. Check your connection and try again.');
      }
    }
  }
  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    if (fixedUrl) return; // nothing to mint — the address IS the link
    if (!nonPublic) {
      void mint();
      return;
    }
    // Non-public: reuse an open token if one exists (its stored choice
    // stands — a link already sent never silently widens); otherwise ask.
    // Fail CLOSED: if the check itself fails, do not show the chooser (a
    // pick could then be silently overridden by an existing token).
    void listMyShareLinks()
      .then((mine) => {
        const open = mine.find((l) => l.object.type === type && l.object.id === id);
        if (open) setLink(open);
        setCheckedExisting(true);
      })
      .catch(() => setError('Could not check for an existing link. Check your connection and try again.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id, nonPublic]);

  /** Replace the open token with one of the other kind: revoke, then mint. */
  async function replaceWith(choice: 'teaser' | 'full'): Promise<void> {
    if (!link || busy) return;
    const ok = await confirmDialog(
      `Make a new ${choice === 'full' ? 'Full' : 'Teaser'} link? The current link stops working for everyone who has it.`,
      { confirmLabel: 'Replace link', zIndex },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await revokeShareLink(link.token);
      setLink(null);
      await mint(choice);
    } catch {
      toast('Could not replace the link');
    } finally {
      setBusy(false);
    }
  }

  const url = fixedUrl ? absoluteShareUrl({ url: fixedUrl }) : link ? absoluteShareUrl(link) : null;
  // Topmost-only Escape; the picker (and the confirm) take over while open.
  useOverlayEscape(onClose);
  // Focus the first action once the link exists; give focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    if (url) copyRef.current?.focus();
  }, [url]);

  const word = SHARE_OBJECT_WORD[type];
  const [handleCopied, setHandleCopied] = useState(false);
  async function copyHandle(): Promise<void> {
    if (!handle) return;
    if (await copyText(`@${handle}`)) {
      setHandleCopied(true);
      setTimeout(() => setHandleCopied(false), 2000);
      toast(`@${handle} copied`);
    } else {
      toast('Clipboard blocked');
    }
  }

  async function copy(): Promise<void> {
    if (!url) return;
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast(
        type === 'profile'
          ? 'Profile link copied — anyone can open it'
          : !nonPublic
          ? 'Public link copied — anyone can open it'
          : link?.preview === 'teaser'
            ? 'Preview link copied — anyone with it sees the teaser'
            : `Link copied — anyone with it sees the whole ${word}`,
      );
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
            {type === 'profile'
              ? fixedUrl
                ? 'Anyone with the link sees their name and picture — and what their profile setting allows. Messaging needs an account.'
                : 'Anyone with the link sees what your profile visibility allows (Settings → Privacy). Message and Call ask them to sign in first.'
              : nonPublic
                ? 'This isn’t public. A link shows people a preview and asks them to sign in for the rest — or the whole thing, your call.'
                : 'Anyone with the link can see it — no account needed to look. Joining takes a minute.'}
          </p>

          {error ? (
            <p className="error-text">{error}</p>
          ) : nonPublic && !checkedExisting ? (
            <div className={styles.spinnerRow}>
              <span className="spinner" /> Checking for a link…
            </div>
          ) : nonPublic && !link ? (
            <>
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
              <p className="muted small" style={{ margin: '0 0 8px' }}>
                {preview === 'teaser'
                  ? 'Teaser: who posted it, the first lines and one photo. The rest needs an account.'
                  : 'Full: everything, viewable without an account. Interacting still needs one.'}
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void mint(preview).finally(() => setBusy(false));
                  }}
                >
                  Make the link
                </button>
              </div>
            </>
          ) : !url || (!fixedUrl && !link) ? (
            <div className={styles.spinnerRow}>
              <span className="spinner" /> Making your link…
            </div>
          ) : (
            <>
              {nonPublic && link ? (
                <p className="muted small" style={{ margin: '0 0 8px' }}>
                  {mismatch
                    ? `You already had a ${link.preview === 'teaser' ? 'Teaser' : 'Full'} link for this, so it was kept — nobody who has it sees more than before. `
                    : null}
                  This link shows {link.preview === 'teaser' ? 'a preview' : 'everything'}.{' '}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '2px 8px', fontSize: 'inherit' }}
                    disabled={busy}
                    onClick={() => void replaceWith(link.preview === 'teaser' ? 'full' : 'teaser')}
                  >
                    Replace with a {link.preview === 'teaser' ? 'Full' : 'Teaser'} link
                  </button>
                </p>
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
                {handle ? (
                  <button type="button" className="btn" onClick={() => void copyHandle()}>
                    {handleCopied ? <span className={styles.copied}>Copied!</span> : `Copy @${handle}`}
                  </button>
                ) : null}
              </div>
              {qrOpen ? (
                <div className={styles.linkBox} style={{ justifyContent: 'center' }}>
                  <QrCode text={url} label={`QR code for this ${word}'s link`} size={176} />
                </div>
              ) : null}
              {fixedUrl ? null : (
                <div className={styles.actions}>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void revoke()}>
                    Stop sharing
                  </button>
                </div>
              )}
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
  handle,
  fixedUrl,
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
  handle?: string;
  fixedUrl?: string;
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
        <ShareSheet
          type={type}
          id={id}
          onClose={() => setOpen(false)}
          nonPublic={nonPublic}
          zIndex={zIndex}
          handle={handle}
          fixedUrl={fixedUrl}
        />
      ) : null}
    </>
  );
}
