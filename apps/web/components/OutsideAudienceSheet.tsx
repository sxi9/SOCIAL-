'use client';

// Share-everything phase 3 (AUDIT-PLAN §1b rows Plan / Listing / Post): the
// landing a signed-in visitor gets when the object a share link pointed at
// is OUTSIDE their audience. The object route's own read stays the §1.14
// 404 (unknown ≡ outside ≡ blocked); only the LIVE share token the visitor
// arrived with (`?s=`) unlocks this much — who shared it and the one door
// that turns "outside" into a request:
//   plan    → "Ask <host> to add you": a DM with the host (Wave 7.1's host
//             approval replaces this later; a DM already makes you friends-of)
//   listing → "Message the poster": the §1.39 contact row, which the token
//             lets through the area gate; the contact itself grants the read
//   post    → "Connect with <author>": the §1.28 request; the post opens
//             once they accept (friends-only posts are friends-of scoped)
// Never a "couldn't find" for something the sharer meant you to reach.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ConversationResponse, ShareLanding } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { adoptConversationById } from '@/lib/connection';
import { connectionStateFor, connectTo } from '@/lib/connections';
import { contactListing } from '@/lib/listings';
import { useOverlayEscape } from '@/lib/overlays';
import { upsertConversation } from '@/lib/store';
import Avatar from './Avatar';
import Portal from './Portal';
import sheet from './beacons.module.css';

export default function OutsideAudienceSheet({
  landing,
  token,
  onClose,
  onVisible,
}: {
  landing: ShareLanding;
  /** The live share token the visitor arrived with. */
  token: string;
  onClose: () => void;
  /** The door opened at once (a counter-request got accepted): re-read. */
  onVisible?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const author = landing.author;
  const name = author?.display_name ?? 'them';

  useOverlayEscape(() => {
    if (!busy) onClose();
  });

  // A connection request already on its way reads as Requested from the start.
  useEffect(() => {
    if (landing.object_type === 'post' && author) {
      const s = connectionStateFor(author.id);
      if (s.kind === 'outgoing') setRequested(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing.object_type, author?.id]);

  function fail(err: unknown, fallback: string): void {
    if (err instanceof ApiError && err.status === 429) setError('Too many tries — give it a while.');
    else if (err instanceof ApiError && err.status === 404) setError('That is not available any more.');
    else if (err instanceof ApiError && err.code === 'listing_closed') setError('This listing has closed.');
    else setError(fallback);
  }

  async function askHost(): Promise<void> {
    if (!author || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'dm',
        user_id: author.id,
      });
      upsertConversation(res.conversation);
      onClose();
      router.push(`/c/${res.conversation.id}`);
      return;
    } catch (err) {
      fail(err, 'Could not open a chat. Check your connection and try again.');
    }
    setBusy(false);
  }

  async function messagePoster(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const convId = await contactListing(landing.object_id, token);
      await adoptConversationById(convId); // before the chat route asks for it
      onClose();
      router.push(`/c/${convId}`);
      return;
    } catch (err) {
      fail(err, 'Could not open a chat. Check your connection and try again.');
    }
    setBusy(false);
  }

  async function connect(): Promise<void> {
    if (!author || busy) return;
    setBusy(true);
    setError(null);
    try {
      const conn = await connectTo(author.id);
      if (conn.status === 'accepted') {
        // They had already asked me — that tap accepted it; friends-of now.
        onClose();
        onVisible?.();
        return;
      }
      setRequested(true);
    } catch (err) {
      fail(err, 'Could not send the request right now.');
    }
    setBusy(false);
  }

  const word = landing.object_type === 'beacon' ? 'plan' : landing.object_type;
  const title =
    landing.object_type === 'beacon'
      ? `${name}’s plan`
      : landing.object_type === 'listing'
        ? `${name}’s listing`
        : `${name}’s post`;

  return (
    <Portal>
      <div
        className={sheet.sheetBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div className={sheet.sheet} role="dialog" aria-modal="true" aria-label={title}>
          <div className={sheet.sheetHead}>
            <h2>{title}</h2>
            <button type="button" className={sheet.sheetClose} aria-label="Close" disabled={busy} onClick={onClose}>
              ×
            </button>
          </div>
          {author ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 12px' }}>
              <Avatar avatar={author.avatar} name={author.display_name} size={40} />
              <span style={{ minWidth: 0 }}>
                <strong>{author.display_name}</strong>{' '}
                <span className="muted small">@{author.username}</span>
              </span>
            </div>
          ) : null}
          <p className={sheet.sheetNote} style={{ marginTop: 0 }}>
            {landing.object_type === 'beacon'
              ? `This plan is for ${name}’s people. Say hi — once you two are connected, it opens for you.`
              : landing.object_type === 'listing'
                ? `This listing is for ${name}’s area. Message them about it and it opens for you.`
                : `This post is for ${name}’s people. Ask to connect — it opens once they accept.`}
          </p>
          {error ? <p className="error-text">{error}</p> : null}
          {landing.object_type === 'beacon' ? (
            <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => void askHost()}>
              {busy ? 'Opening…' : `Ask ${name} to add you`}
            </button>
          ) : landing.object_type === 'listing' ? (
            <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => void messagePoster()}>
              {busy ? 'Opening…' : 'Message the poster'}
            </button>
          ) : requested ? (
            <>
              <p className="ok-text" style={{ margin: '0 0 8px' }}>
                Requested — the {word} opens once {name} accepts.
              </p>
              <button type="button" className="btn" style={{ width: '100%' }} onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => void connect()}>
              {busy ? 'Sending…' : `Connect with ${name}`}
            </button>
          )}
        </div>
      </div>
    </Portal>
  );
}
