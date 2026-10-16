'use client';

// Vibe check message body (v0.4 — API.md §1.23): prompt card + the growing
// collage strip of reply refs (inlined on the DTO — zero extra fetches), plus
// the reply CTA. One reply per user; replies are ordinary messages carrying
// metadata.vibe_reply_seq, re-aggregated live via msg.updated.
import { useRef, useState } from 'react';
import type { Message, SendMessageRequest, UploadResponse, VibeReplyRef } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { sendMessage } from '@/lib/connection';
import { uuidv7 } from '@/lib/ids';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import DoodleSheet from './DoodleSheet';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

interface VibeCheckViewProps {
  message: Message;
  /** My nickname map applied by the parent (personal view, §1.24). */
  nameFor: (userId: string, fallback: string) => string;
}

export default function VibeCheckView({ message, nameFor }: VibeCheckViewProps) {
  const state = useAppState();
  const vibe = message.vibe;
  const [replyOpen, setReplyOpen] = useState(false);
  const [doodleOpen, setDoodleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!vibe) return null;
  const me = state.me;
  const answered = vibe.my_reply_seq !== null;
  const extra = Math.max(0, vibe.reply_count - vibe.replies.length);

  async function sendReply(payload: {
    type: 'text' | 'image';
    body?: string;
    attachment_ids?: string[];
    stamp?: true;
    doodle?: true;
  }): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const metadata: NonNullable<SendMessageRequest['metadata']> = { vibe_reply_seq: message.seq };
      if (payload.stamp) metadata.stamp = true;
      if (payload.doodle) metadata.doodle = true;
      const req: SendMessageRequest = {
        client_msg_id: uuidv7(),
        type: payload.type,
        body: payload.body,
        attachment_ids: payload.attachment_ids,
        metadata,
      };
      await sendMessage(message.conversation_id, req);
      setReplyOpen(false);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'vibe_already_replied') {
        setError('You already answered this one.');
        setReplyOpen(false);
      } else {
        setError('Could not send your answer — try again.');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      await sendReply({ type: 'image', attachment_ids: [res.attachment.id] });
    } catch {
      setError('Upload failed — try again.');
      setBusy(false);
    }
  }

  const stampReady = me?.avatar.status === 'ready';

  function tile(r: VibeReplyRef) {
    const name = nameFor(r.user.id, r.user.display_name);
    return (
      <span key={`${r.user.id}-${r.seq}`} className={exp.vibeTile} title={name}>
        {r.kind === 'stamp' || !r.thumb_url ? (
          <span className={exp.vibeTileMedia}>
            <Avatar avatar={r.user.avatar} name={name} size={58} />
          </span>
        ) : (
          <span className={`${exp.vibeTileMedia}${r.kind === 'doodle' ? ` ${exp.vibeTileDoodle}` : ''}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.thumb_url} alt={`${name}'s answer`} />
          </span>
        )}
        <span className={exp.vibeTileName}>{name}</span>
      </span>
    );
  }

  return (
    <div className={exp.vibeCard}>
      <span className={exp.vibePromptTag}>🎭 Vibe check</span>
      <span className={exp.vibePrompt}>{vibe.prompt}</span>

      {vibe.replies.length > 0 ? (
        <div className={exp.vibeStripScroll} role="list" aria-label="Vibe check answers">
          {vibe.replies.map(tile)}
          {extra > 0 ? <span className={exp.vibeMore}>+{extra}</span> : null}
        </div>
      ) : (
        <span className="muted small">No answers yet — be the first.</span>
      )}

      {answered ? (
        <span className={exp.vibeAnswered}>✓ You answered</span>
      ) : (
        <button type="button" className={exp.vibeCta} disabled={busy} onClick={() => setReplyOpen(true)}>
          Answer the vibe
        </button>
      )}
      {error ? <span className="error-text">{error}</span> : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void uploadPhoto(e.target.files);
          e.target.value = '';
        }}
      />

      {replyOpen ? (
        <div
          className={sheetStyles.sheetBackdrop}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setReplyOpen(false);
          }}
        >
          <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Answer the vibe check">
            <div className={sheetStyles.sheetHead}>
              <h2>{vibe.prompt}</h2>
              <button
                type="button"
                className={sheetStyles.sheetClose}
                aria-label="Close"
                onClick={() => setReplyOpen(false)}
              >
                ×
              </button>
            </div>
            <div className={exp.replyOptRow}>
              <button type="button" className={exp.replyOpt} disabled={busy} onClick={() => fileRef.current?.click()}>
                <span aria-hidden>📷</span>
                Photo
              </button>
              <button
                type="button"
                className={exp.replyOpt}
                disabled={busy}
                onClick={() => {
                  setReplyOpen(false);
                  setDoodleOpen(true);
                }}
              >
                <span aria-hidden>✏️</span>
                Doodle
              </button>
              <button
                type="button"
                className={exp.replyOpt}
                disabled={busy || !stampReady}
                title={stampReady ? undefined : 'Add an avatar first — the stamp is your face'}
                onClick={() => void sendReply({ type: 'text', stamp: true })}
              >
                <span aria-hidden>🙂</span>
                {stampReady ? 'My face' : 'My face (needs avatar)'}
              </button>
            </div>
            <p className={sheetStyles.sheetNote}>One answer per person — make it count.</p>
          </div>
        </div>
      ) : null}

      {doodleOpen ? (
        <DoodleSheet
          title={`Doodle: ${vibe.prompt}`}
          sendLabel="Send answer"
          onClose={() => setDoodleOpen(false)}
          onSend={async (attachmentId) => {
            await sendReply({ type: 'image', attachment_ids: [attachmentId], doodle: true });
          }}
        />
      ) : null}
    </div>
  );
}
