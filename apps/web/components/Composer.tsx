'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  CreatePreviewResponse,
  GetPreviewResponse,
  LinkPreview,
  MessageEffect,
  UploadResponse,
} from '@socialchat/shared';
import { MAX_AUDIO_DURATION_S } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { EFFECT_EMOJI, EFFECT_LABEL, suggestEffect } from '@/lib/effects';
import { EMOJI_GRID } from '@/lib/emoji';
import { firstUrl, formatDuration } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import PreviewCard from './PreviewCard';
import ScheduleSheet, { type ScheduleDraft } from './ScheduleSheet';
import styles from './chat.module.css';
import exp from './expression.module.css';

const URL_PREVIEW_DEBOUNCE_MS = 800;
const SEND_LONG_PRESS_MS = 450;
const SLIDE_CANCEL_PX = 72;

export interface ComposerPayload {
  type: 'text' | 'image' | 'video' | 'file' | 'audio';
  body?: string;
  attachment_ids?: string[];
  metadata?: { link_preview?: LinkPreview; effect?: MessageEffect };
}

/** Actions the chat page handles from the "+" menu (v0.4). */
export type PlusAction = 'doodle' | 'vibe' | 'ttt' | 'puzzle';

interface ComposerProps {
  onSubmit: (payload: ComposerPayload) => Promise<boolean>;
  onTyping?: () => void;
  initialBody?: string;
  initialAttachments?: Attachment[];
  initialPreview?: LinkPreview | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Set in a live chat: enables voice notes, effects and scheduled sends. */
  conversationId?: string;
  /** Set in a live chat: shows the "+" menu (doodle / vibe check / games). */
  onPlusAction?: (action: PlusAction) => void;
}

type RecState = { phase: 'recording'; startedAt: number; cancelArmed: boolean } | null;

export default function Composer({
  onSubmit,
  onTyping,
  initialBody,
  initialAttachments,
  initialPreview,
  disabled,
  autoFocus,
  conversationId,
  onPlusAction,
}: ComposerProps) {
  const state = useAppState();
  const [body, setBody] = useState(initialBody ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [preview, setPreviewState] = useState<LinkPreview | null>(initialPreview ?? null);
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const lastUrlRef = useRef<string | null>(initialPreview?.url ?? null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  // ---- v0.4 §1.22 effects: suggest-only; the sender must confirm (arm). ----
  const [armedEffect, setArmedEffect] = useState<MessageEffect | null>(null);
  const [dismissedEffect, setDismissedEffect] = useState<MessageEffect | null>(null);
  const suggestion = conversationId ? suggestEffect(body) : null;
  const showSuggestion = suggestion !== null && armedEffect === null && suggestion !== dismissedEffect;

  // ---- v0.4 §1.26 scheduled sends (long-press Send, or "+" menu item). ----
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const sendPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  // ---- v0.4 §1.20 voice notes (hold-to-record, slide-to-cancel). ----
  const [rec, setRec] = useState<RecState>(null);
  const [recMs, setRecMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recCancelledRef = useRef(false);
  const recStartXRef = useRef(0);
  const [recSupported, setRecSupported] = useState(false);
  useEffect(() => {
    setRecSupported(
      typeof window !== 'undefined' &&
        typeof MediaRecorder !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia
    );
  }, []);

  // Insert at the caret (falls back to appending), keep focus in the textarea.
  function insertEmoji(emoji: string): void {
    const el = textRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody((prev) => prev.slice(0, start) + emoji + prev.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  // attachment.ready hydrates pending (video/audio) attachments still here.
  const hydrated = attachments.map((a) => state.readyAttachments.get(a.id) ?? a);

  // preview.ready resolves a pending unfurl requested below
  useEffect(() => {
    if (!pendingHash) return;
    const entry = state.previews.get(pendingHash);
    if (!entry) return;
    if (entry.status === 'ok' && entry.preview && !previewDismissed) {
      setPreviewState(entry.preview);
      setPendingHash(null);
    } else if (entry.status === 'failed') {
      setPendingHash(null);
    }
  }, [state.previews, previewDismissed, pendingHash]);

  // GET /api/previews/:url_hash poll fallback (API.md §1.7) — covers a
  // preview.ready that never reaches this client (reconnect, lost event).
  useEffect(() => {
    if (!pendingHash) return;
    const hash = pendingHash;
    let attempts = 0;
    const timer = setInterval(() => {
      void (async () => {
        attempts += 1;
        try {
          const res = await api.get<GetPreviewResponse>(`/api/previews/${hash}`);
          if (res.status === 'ok' && res.preview) {
            if (!previewDismissed) setPreviewState(res.preview);
            setPendingHash((h) => (h === hash ? null : h));
          } else if (res.status === 'failed' || attempts >= 15) {
            setPendingHash((h) => (h === hash ? null : h));
          }
        } catch {
          if (attempts >= 15) setPendingHash((h) => (h === hash ? null : h));
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingHash, previewDismissed]);

  // Typed URLs: debounce 800 ms, then POST /api/previews (ARCHITECTURE §6).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const url = firstUrl(body);
      if (!url) {
        lastUrlRef.current = null;
        if (!previewDismissed) setPreviewState(initialPreview ?? null);
        return;
      }
      if (url === lastUrlRef.current) return;
      lastUrlRef.current = url;
      setPreviewDismissed(false);
      void (async () => {
        try {
          const res = await api.post<CreatePreviewResponse>('/api/previews', { url });
          if (lastUrlRef.current !== url) return;
          if (res.status === 'ok') {
            setPreviewState(res.preview);
            setPendingHash(null);
          } else if (res.status === 'pending') {
            setPendingHash(res.url_hash);
          } else {
            setPreviewState(null);
            setPendingHash(null);
          }
        } catch {
          /* rate limited or offline — no card */
        }
      })();
    }, URL_PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files || !files.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await api.postForm<UploadResponse>('/api/uploads', form);
        setAttachments((prev) => [...prev, res.attachment]);
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) setError(`${file.name} is too large.`);
        else if (err instanceof ApiError && err.status === 415) setError(`${file.name}: unsupported file type.`);
        else setError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function resetAfterSend(): void {
    setBody('');
    setAttachments([]);
    setPreviewState(null);
    setPreviewDismissed(false);
    lastUrlRef.current = null;
    setPendingHash(null);
    setArmedEffect(null);
    setDismissedEffect(null);
    textRef.current?.focus();
  }

  const canSend = !sending && uploading === 0 && (body.trim().length > 0 || hydrated.length > 0);

  function buildPayload(): ComposerPayload | null {
    const trimmed = body.trim();
    if (!trimmed && hydrated.length === 0) return null;
    const type = hydrated.length > 0 ? hydrated[0].kind : 'text';
    const payload: ComposerPayload = { type };
    if (trimmed) payload.body = trimmed;
    if (hydrated.length > 0) payload.attachment_ids = hydrated.map((a) => a.id);
    const metadata: ComposerPayload['metadata'] = {};
    if (preview && !previewDismissed) metadata.link_preview = preview;
    if (armedEffect) metadata.effect = armedEffect;
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;
    return payload;
  }

  async function handleSend(): Promise<void> {
    if (sending || uploading > 0) return;
    const payload = buildPayload();
    if (!payload) return;
    setSending(true);
    setError(null);
    try {
      const ok = await onSubmit(payload);
      if (ok) resetAfterSend();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || 'Send failed.') : 'Send failed.');
    } finally {
      setSending(false);
    }
  }

  // ---- long-press Send → schedule sheet (§1.26); click still sends now. ----
  function sendPressStart(): void {
    if (!conversationId || !canSend) return;
    longPressFiredRef.current = false;
    sendPressRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setScheduleOpen(true);
    }, SEND_LONG_PRESS_MS);
  }

  function sendPressEnd(): void {
    if (sendPressRef.current !== null) {
      clearTimeout(sendPressRef.current);
      sendPressRef.current = null;
    }
  }

  function handleSendClick(): void {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return; // the long-press already opened the schedule sheet
    }
    void handleSend();
  }

  // ---------------------------------------------------------------------------
  // Voice notes (§1.20): hold to record, slide left to cancel. Keyboard: Enter/
  // Space toggles start → stop-and-send; Escape cancels. Server caps at 5 min.
  // ---------------------------------------------------------------------------

  async function startRecording(): Promise<void> {
    if (rec || disabled) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone unavailable — check permissions.');
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setError('Recording is not supported in this browser.');
      return;
    }
    recChunksRef.current = [];
    recCancelledRef.current = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const cancelled = recCancelledRef.current;
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(recChunksRef.current, { type });
      recChunksRef.current = [];
      setRec(null);
      setRecMs(0);
      if (!cancelled && blob.size > 0) void sendVoiceNote(blob, type);
    };
    recorderRef.current = recorder;
    recorder.start(250);
    setRec({ phase: 'recording', startedAt: Date.now(), cancelArmed: false });
  }

  function stopRecording(cancel: boolean): void {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recCancelledRef.current = cancel;
    recorder.stop();
    recorderRef.current = null;
  }

  // Leaving the composer mid-recording cancels cleanly (mic released).
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recCancelledRef.current = true;
        recorder.stop();
        recorderRef.current = null;
      }
    };
  }, []);

  // Recording timer + hard stop at the server's 5-minute truth.
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => {
      const ms = Date.now() - rec.startedAt;
      setRecMs(ms);
      if (ms >= (MAX_AUDIO_DURATION_S - 2) * 1000) stopRecording(false);
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.startedAt]);

  async function sendVoiceNote(blob: Blob, mime: string): Promise<void> {
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    setUploading((n) => n + 1);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', new File([blob], `voice-note.${ext}`, { type: mime }));
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      const payload: ComposerPayload = { type: 'audio', attachment_ids: [res.attachment.id] };
      if (armedEffect) payload.metadata = { effect: armedEffect };
      const ok = await onSubmit(payload);
      if (ok) setArmedEffect(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) setError('Voice note is too large (10 MB cap).');
      else if (err instanceof ApiError && err.status === 415) setError('This browser produced an unsupported audio format.');
      else setError('Could not send the voice note.');
    } finally {
      setUploading((n) => n - 1);
    }
  }

  const micPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    recStartXRef.current = e.clientX;
    void startRecording();
  };

  const micPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (!rec) return;
    const dx = e.clientX - recStartXRef.current;
    const armed = dx < -SLIDE_CANCEL_PX;
    if (armed !== rec.cancelArmed) setRec({ ...rec, cancelArmed: armed });
  };

  const micPointerUp = (): void => {
    if (!rec) return;
    stopRecording(rec.cancelArmed || Date.now() - rec.startedAt < 500);
  };

  const micKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (rec) stopRecording(false);
      else void startRecording();
    } else if (e.key === 'Escape' && rec) {
      stopRecording(true);
    }
  };

  const showMic =
    recSupported && conversationId !== undefined && body.trim().length === 0 && hydrated.length === 0;

  const plusItems: { action: PlusAction; icon: string; label: string }[] = [
    { action: 'doodle', icon: '✏️', label: 'Doodle' },
    { action: 'vibe', icon: '🎭', label: 'Vibe check' },
    { action: 'ttt', icon: '🎮', label: 'Tic-tac-toe' },
    { action: 'puzzle', icon: '🧩', label: 'Daily puzzle' },
  ];

  const scheduleDraft: ScheduleDraft | null = (() => {
    const payload = buildPayload();
    if (!payload) return null;
    return {
      type: payload.type,
      body: payload.body,
      attachment_ids: payload.attachment_ids,
      effect: armedEffect ?? undefined,
    };
  })();

  return (
    <div className={styles.composer}>
      {error ? <div className="error-text">{error}</div> : null}
      {preview && !previewDismissed ? (
        <PreviewCard
          preview={preview}
          onDismiss={() => {
            setPreviewDismissed(true);
            setPreviewState(null);
          }}
        />
      ) : null}
      {/* §1.22 consent chip: suggest on trigger phrase; sender taps to arm. */}
      {showSuggestion && suggestion ? (
        <div className={exp.effectChipRow}>
          <button
            type="button"
            className={exp.effectChip}
            onClick={() => setArmedEffect(suggestion)}
            aria-label={`Send with ${EFFECT_LABEL[suggestion].toLowerCase()} effect`}
          >
            <span aria-hidden>{EFFECT_EMOJI[suggestion]}</span>
            Send with {EFFECT_LABEL[suggestion].toLowerCase()}?
          </button>
          <button
            type="button"
            className={exp.effectChipX}
            aria-label="Dismiss effect suggestion"
            onClick={() => setDismissedEffect(suggestion)}
          >
            ×
          </button>
        </div>
      ) : null}
      {armedEffect ? (
        <div className={exp.effectChipRow}>
          <button
            type="button"
            className={`${exp.effectChip} ${exp.effectChipArmed}`}
            onClick={() => setArmedEffect(null)}
            aria-label={`${EFFECT_LABEL[armedEffect]} effect armed — tap to remove`}
          >
            <span aria-hidden>{EFFECT_EMOJI[armedEffect]}</span>
            {EFFECT_LABEL[armedEffect]} will play
            <span className={exp.effectChipX} aria-hidden>
              ×
            </span>
          </button>
        </div>
      ) : null}
      {hydrated.length > 0 || uploading > 0 ? (
        <div className={styles.attachments}>
          {hydrated.map((att) => (
            <span key={att.id} className={styles.attachmentChip}>
              {att.kind === 'image' && att.thumb_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={att.thumb_url} alt="" />
              ) : (
                <span>
                  {att.kind === 'video'
                    ? att.status === 'ready'
                      ? 'Video'
                      : 'Video (processing…)'
                    : att.kind === 'audio'
                      ? 'Voice note'
                      : att.file_name ?? 'File'}
                </span>
              )}
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label="Remove attachment"
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
              >
                ×
              </button>
            </span>
          ))}
          {uploading > 0 ? (
            <span className={styles.attachmentChip}>
              <span className="spinner" />
            </span>
          ) : null}
        </div>
      ) : null}
      {rec ? (
        <div className={exp.recordBar} role="status">
          <span className={exp.recordDot} aria-hidden />
          <span>{formatDuration(recMs)}</span>
          <span className={`${exp.recordHint}${rec.cancelArmed ? ` ${exp.recordHintCancel}` : ''}`}>
            {rec.cancelArmed ? 'Release to cancel' : 'Slide left to cancel · release to send'}
          </span>
        </div>
      ) : null}
      <div className={styles.composerRow}>
        {onPlusAction ? (
          <span className={styles.composerEmoji}>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="More message types"
              aria-expanded={plusOpen}
              aria-haspopup="menu"
              disabled={disabled}
              onClick={() => setPlusOpen((v) => !v)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M10 4 V16 M4 10 H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            {plusOpen ? (
              <>
                <button
                  type="button"
                  className={styles.pickerBackdrop}
                  aria-label="Close menu"
                  onClick={() => setPlusOpen(false)}
                />
                <div className={exp.plusPop} role="menu" aria-label="More message types">
                  {plusItems.map((item) => (
                    <button
                      key={item.action}
                      type="button"
                      role="menuitem"
                      className={exp.plusItem}
                      onClick={() => {
                        setPlusOpen(false);
                        onPlusAction(item.action);
                      }}
                    >
                      <span aria-hidden>{item.icon}</span>
                      {item.label}
                    </button>
                  ))}
                  {conversationId ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={exp.plusItem}
                      onClick={() => {
                        setPlusOpen(false);
                        if (canSend) setScheduleOpen(true);
                        else setError('Write the message first, then schedule it.');
                      }}
                    >
                      <span aria-hidden>🕑</span>
                      Schedule send
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </span>
        ) : null}
        <span className={styles.composerEmoji}>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Add an emoji"
            aria-expanded={emojiOpen}
            disabled={disabled}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="7.4" cy="8.4" r="1" fill="currentColor" />
              <circle cx="12.6" cy="8.4" r="1" fill="currentColor" />
              <path d="M6.8 12 a3.6 3.6 0 0 0 6.4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {emojiOpen ? (
            <>
              <button
                type="button"
                className={styles.pickerBackdrop}
                aria-label="Close emoji picker"
                onClick={() => setEmojiOpen(false)}
              />
              <div className={styles.composerEmojiPop} role="menu" aria-label="Pick an emoji">
                <div className={styles.emojiGrid}>
                  {EMOJI_GRID.map((emoji) => (
                    <button key={emoji} type="button" role="menuitem" onClick={() => insertEmoji(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className={`btn btn-icon ${styles.attachBtn}`}
          aria-label="Attach a file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M13.5 5.5 L7.6 11.4 a2.3 2.3 0 0 0 3.25 3.25 L16.4 9.1 a4 4 0 0 0 -5.65 -5.65 L5 9.2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <textarea
          ref={textRef}
          className={styles.composerInput}
          placeholder="Message"
          rows={1}
          value={body}
          autoFocus={autoFocus}
          disabled={disabled || rec !== null}
          onChange={(e) => {
            setBody(e.target.value);
            if (e.target.value.trim()) onTyping?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        {showMic ? (
          <button
            type="button"
            className={`btn btn-icon ${exp.micBtn}${rec ? ` ${exp.micRecording}` : ''}`}
            aria-label={rec ? 'Recording — release to send, Escape to cancel' : 'Hold to record a voice note'}
            aria-pressed={rec !== null}
            disabled={disabled || uploading > 0}
            onPointerDown={micPointerDown}
            onPointerMove={micPointerMove}
            onPointerUp={micPointerUp}
            onPointerCancel={() => stopRecording(true)}
            onKeyDown={micKeyDown}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <rect x="7.2" y="2.5" width="5.6" height="9.5" rx="2.8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M4.5 9.5 a5.5 5.5 0 0 0 11 0 M10 15 V17.5 M7.5 17.5 h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-icon"
            aria-label={conversationId ? 'Send (hold to schedule)' : 'Send'}
            disabled={disabled || !canSend}
            onPointerDown={sendPressStart}
            onPointerUp={sendPressEnd}
            onPointerLeave={sendPressEnd}
            onPointerCancel={sendPressEnd}
            onClick={handleSendClick}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M3 10 L17 3 L13.5 10 L17 17 Z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      {scheduleOpen && conversationId && scheduleDraft ? (
        <ScheduleSheet
          conversationId={conversationId}
          draft={scheduleDraft}
          onClose={() => setScheduleOpen(false)}
          onScheduled={() => {
            setScheduleOpen(false);
            resetAfterSend();
          }}
        />
      ) : null}
    </div>
  );
}
