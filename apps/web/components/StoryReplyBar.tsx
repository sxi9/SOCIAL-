'use client';

// A friend's story: reply first (handoff 2d, 2026-10-28). A reaction row,
// a "Reply to <name>…" pill and a hold-to-record Voice circle; everything
// lands in the author's DM through POST /api/stories/:id/reply (§1.79). My
// own sends drift up the left edge as a pill — ephemeral and local; nobody
// else's activity is ever shown on a story that is not mine.
import { useEffect, useRef, useState } from 'react';
import type { Story, UploadResponse } from '@socialchat/shared';
import { MAX_AUDIO_DURATION_S } from '@socialchat/shared';
import { api, ApiError, retryIn } from '@/lib/api';
import { replyToStory } from '@/lib/stories';
import { toast } from '@/lib/toast';
import { IcBrush, IcMic, IcSend } from './StoryIcons';
import s from './story.module.css';

const REACTIONS = ['😂', '😮', '❤️', '🔥', '👏'];

interface Props {
  story: Story;
  /** True while the composer/recorder has the user — the viewer pauses. */
  onBusy: (busy: boolean) => void;
  /** Canvas is open on this story — show the Draw door. */
  canDraw: boolean;
  onDraw: () => void;
}

type Drift = { id: number; text: string };

export default function StoryReplyBar({ story, onBusy, canDraw, onDraw }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [drifts, setDrifts] = useState<Drift[]>([]);
  const [rec, setRec] = useState<{ startedAt: number } | null>(null);
  const [recMs, setRecMs] = useState(0);
  const [focused, setFocused] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const idRef = useRef(0);
  const name = story.author.display_name;

  const busy = focused || sending || rec !== null;
  useEffect(() => {
    onBusy(busy);
    // Unmounting mid-send / mid-take (a step to another story) must never
    // leave the viewer held.
    return () => onBusy(false);
  }, [busy, onBusy]);
  const pressedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new story under the bar: drop any half-typed reply (it was to someone else).
  useEffect(() => {
    setDraft('');
    setDrifts([]);
  }, [story.id]);

  function drift(text: string): void {
    const id = ++idRef.current;
    setDrifts((d) => [...d.slice(-3), { id, text }]);
    setTimeout(() => setDrifts((d) => d.filter((x) => x.id !== id)), 2700);
  }

  function explain(err: unknown): string {
    if (err instanceof ApiError && err.code === 'dm_request_pending') return `Waiting for ${name} to accept your chat first`;
    if (err instanceof ApiError && err.status === 404) return 'That story is not available';
    if (err instanceof ApiError && err.status === 429) return `Easy there — try again ${retryIn(err)}`;
    return 'Could not send that — try again';
  }

  async function react(emoji: string): Promise<void> {
    if (sending) return;
    setSending(true);
    try {
      await replyToStory(story.id, { emoji });
      drift(`${emoji}  sent to ${name}`);
    } catch (err) {
      toast(explain(err));
    } finally {
      setSending(false);
    }
  }

  async function sendText(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await replyToStory(story.id, { body });
      setDraft('');
      drift(body);
      toast(`Sent to ${name}`);
    } catch (err) {
      toast(explain(err));
    } finally {
      setSending(false);
    }
  }

  // ---- voice (the §1.20 recorder, trimmed: hold to record, release to send) ----
  async function startRecording(): Promise<void> {
    if (rec || sending) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Microphone unavailable — check permissions');
      return;
    }
    // The finger lifted (or the bar went away) while the mic was being
    // granted: never start a take nobody is holding.
    if (!pressedRef.current || !mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
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
      toast('Recording is not supported in this browser');
      return;
    }
    chunksRef.current = [];
    cancelledRef.current = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const cancelled = cancelledRef.current;
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      setRec(null);
      setRecMs(0);
      if (!cancelled && blob.size > 0) void sendVoice(blob, type);
    };
    recorderRef.current = recorder;
    recorder.start(250);
    setRec({ startedAt: Date.now() });
  }

  function stopRecording(cancel: boolean): void {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    cancelledRef.current = cancel;
    recorder.stop();
    recorderRef.current = null;
  }

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        cancelledRef.current = true;
        recorder.stop();
        recorderRef.current = null;
      }
    };
  }, []);

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

  async function sendVoice(blob: Blob, mime: string): Promise<void> {
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    setSending(true);
    try {
      const form = new FormData();
      form.append('file', new File([blob], `story-reply.${ext}`, { type: mime }));
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      await replyToStory(story.id, { attachment_id: res.attachment.id });
      drift(`Voice note sent to ${name}`);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 413 ? 'Voice note is too large' : explain(err));
    } finally {
      setSending(false);
    }
  }

  const recSeconds = Math.floor(recMs / 1000);

  return (
    <>
      <div className={s.driftLayer} aria-live="polite">
        {drifts.map((d) => (
          <span key={d.id} className={s.driftPill}>
            {d.text}
          </span>
        ))}
      </div>
      {rec ? (
        <p className={s.recHint}>
          Recording {String(Math.floor(recSeconds / 60)).padStart(1, '0')}:{String(recSeconds % 60).padStart(2, '0')} — release to send
        </p>
      ) : null}
      <div className={s.replyBar}>
        <div className={s.reactRow} role="group" aria-label={`React to ${name}’s story`}>
          {REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              className={s.circle}
              aria-label={`React ${e}`}
              disabled={sending}
              onClick={() => void react(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className={s.composerRow}>
          <label className={s.composerPill}>
            <input
              value={draft}
              placeholder={`Reply to ${name}…`}
              aria-label={`Reply to ${name}`}
              maxLength={500}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void sendText();
                }
              }}
            />
            {draft.trim() ? (
              <button type="button" className={s.sendBtn} aria-label="Send" disabled={sending} onClick={() => void sendText()}>
                <IcSend size={17} />
              </button>
            ) : null}
          </label>
          {canDraw ? (
            <button type="button" className={s.circle} aria-label="Draw on this story" onClick={onDraw}>
              <IcBrush />
            </button>
          ) : null}
          <button
            type="button"
            className={`${s.circle} ${s.circleMic}${rec ? ` ${s.circleRec}` : ''}`}
            aria-label={rec ? 'Release to send the voice note' : 'Hold to record a voice note'}
            disabled={sending && !rec}
            onPointerDown={(e) => {
              e.preventDefault();
              // Capture so a finger drifting off the circle does not end the
              // take early; release (anywhere) sends, a sub-500 ms tap cancels.
              e.currentTarget.setPointerCapture(e.pointerId);
              pressedRef.current = true;
              void startRecording();
            }}
            onPointerUp={() => {
              pressedRef.current = false;
              stopRecording(rec !== null && Date.now() - rec.startedAt < 500);
            }}
            onPointerCancel={() => {
              pressedRef.current = false;
              stopRecording(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation(); // the viewer's Space-pauses listener
                if (rec) {
                  pressedRef.current = false;
                  stopRecording(false);
                } else {
                  pressedRef.current = true;
                  void startRecording();
                }
              } else if (e.key === 'Escape' && rec) {
                e.stopPropagation();
                pressedRef.current = false;
                stopRecording(true);
              }
            }}
          >
            <IcMic />
          </button>
        </div>
      </div>
    </>
  );
}
