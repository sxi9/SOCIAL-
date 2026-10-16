'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  CreatePreviewResponse,
  GetPreviewResponse,
  LinkPreview,
  UploadResponse,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { firstUrl } from '@/lib/format';
import { useAppState } from '@/lib/useStore';
import PreviewCard from './PreviewCard';
import styles from './chat.module.css';

const URL_PREVIEW_DEBOUNCE_MS = 800;

export interface ComposerPayload {
  type: 'text' | 'image' | 'video' | 'file';
  body?: string;
  attachment_ids?: string[];
  metadata?: { link_preview?: LinkPreview };
}

interface ComposerProps {
  onSubmit: (payload: ComposerPayload) => Promise<boolean>;
  onTyping?: () => void;
  initialBody?: string;
  initialAttachments?: Attachment[];
  initialPreview?: LinkPreview | null;
  disabled?: boolean;
  autoFocus?: boolean;
}

export default function Composer({
  onSubmit,
  onTyping,
  initialBody,
  initialAttachments,
  initialPreview,
  disabled,
  autoFocus,
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

  // attachment.ready hydrates pending (video) attachments still in the composer.
  // The store mutates in place and bumps a version, so derive per render.
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

  async function handleSend(): Promise<void> {
    const trimmed = body.trim();
    if (sending || uploading > 0) return;
    if (!trimmed && hydrated.length === 0) return;
    const type = hydrated.length > 0 ? hydrated[0].kind : 'text';
    const payload: ComposerPayload = { type };
    if (trimmed) payload.body = trimmed;
    if (hydrated.length > 0) payload.attachment_ids = hydrated.map((a) => a.id);
    if (preview && !previewDismissed) payload.metadata = { link_preview: preview };
    setSending(true);
    setError(null);
    try {
      const ok = await onSubmit(payload);
      if (ok) {
        setBody('');
        setAttachments([]);
        setPreviewState(null);
        setPreviewDismissed(false);
        lastUrlRef.current = null;
        setPendingHash(null);
        textRef.current?.focus();
      }
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || 'Send failed.') : 'Send failed.');
    } finally {
      setSending(false);
    }
  }

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
      <div className={styles.composerRow}>
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
          disabled={disabled}
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
        <button
          type="button"
          className="btn btn-primary btn-icon"
          aria-label="Send"
          disabled={disabled || sending || uploading > 0 || (!body.trim() && hydrated.length === 0)}
          onClick={() => void handleSend()}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 10 L17 3 L13.5 10 L17 17 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}
