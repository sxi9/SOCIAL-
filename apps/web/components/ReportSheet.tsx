'use client';

// Report sheet (v0.3 — API.md §1.14; widened v0.8b — §1.62/§1.66/§1.69;
// Wave 1 §1.5, 2026-10-28). A REQUIRED category, an optional note, then
// POST /api/reports. No one is notified; nothing else changes (FEATURES
// #29). Binding UX contracts carried here:
//   * message reports render REPORT_CONTEXT_CONSENT_COPY beside an UNCHECKED
//     include-context checkbox — the report sends fine without it;
//   * anonymous-message and canvas-overlay reports SAY that the author's real
//     identity is attached (anonymity never survives a report);
//   * "Also block" is offered where the target has a person behind it and
//     is a separate, explicit tick (never implied by reporting).
// Wave 1 adds the object kinds (post · comment · story · listing · group)
// and portals to <body> (the CLAUDE.md overlay rule — two callers are sheets).
import { useState } from 'react';
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  REPORT_CONTEXT_CONSENT_COPY,
  REPORT_REASON_MAX_CHARS,
  type CreateReportRequest,
  type ReportCategory,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { useOverlayEscape } from '@/lib/overlays';
import { toast } from '@/lib/toast';
import Portal from './Portal';
import styles from './beacons.module.css';

/** The target identity — category + reason are collected here. `user_id`
 * on an object kind is optional: when the caller knows the author, the
 * "Also block" tick appears. */
export type ReportTarget =
  | { kind: 'user'; user_id: string }
  | { kind: 'message'; conversation_id: string; seq: number; user_id?: string }
  | { kind: 'beacon'; beacon_id: string; user_id?: string }
  | { kind: 'anon_message'; thread_id: string; message_id: string }
  | { kind: 'story_overlay'; story_id: string; overlay_id: string }
  | { kind: 'post' | 'comment' | 'story' | 'listing' | 'group'; object_id: string; user_id?: string };

const TITLES: Record<ReportTarget['kind'], string> = {
  user: 'Report this person',
  message: 'Report this message',
  beacon: 'Report this plan',
  anon_message: 'Report this anonymous message',
  story_overlay: 'Report this canvas addition',
  post: 'Report this post',
  comment: 'Report this comment',
  story: 'Report this story',
  listing: 'Report this listing',
  group: 'Report this group',
};

export default function ReportSheet({
  target,
  onClose,
  zIndex,
}: {
  target: ReportTarget;
  onClose: () => void;
  /** Above-the-caller stacking (the story viewer sits at 60). */
  zIndex?: number;
}) {
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [reason, setReason] = useState('');
  const [includeContext, setIncludeContext] = useState(false); // unchecked by default (binding)
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useOverlayEscape(onClose);

  const blockable = target.kind !== 'anon_message' && target.kind !== 'story_overlay' && 'user_id' in target && !!target.user_id;

  async function submit(): Promise<void> {
    if (busy || done || !category) return;
    setBusy(true);
    setError(null);
    const note = reason.trim();
    let body: CreateReportRequest;
    switch (target.kind) {
      case 'user':
        body = { kind: 'user', user_id: target.user_id, category, reason: note };
        break;
      case 'message':
        body = {
          kind: 'message',
          conversation_id: target.conversation_id,
          seq: target.seq,
          category,
          reason: note,
          include_context: includeContext,
        };
        break;
      case 'beacon':
        body = { kind: 'beacon', beacon_id: target.beacon_id, category, reason: note };
        break;
      case 'anon_message':
        body = { kind: 'anon_message', thread_id: target.thread_id, message_id: target.message_id, category, reason: note };
        break;
      case 'story_overlay':
        body = { kind: 'story_overlay', story_id: target.story_id, overlay_id: target.overlay_id, category, reason: note };
        break;
      default:
        body = { kind: target.kind, object_id: target.object_id, category, reason: note };
    }
    try {
      await api.post('/api/reports', body);
      if (alsoBlock && blockable && 'user_id' in target && target.user_id) {
        // Blocking is idempotent and its own act — a failure here never
        // un-sends the report.
        await api.put(`/api/users/${target.user_id}/block`).catch(() => undefined);
      }
      setDone(true);
      // v0.7.1 §1.56: the shared confirmation toast (the sheet's done view
      // keeps the "no one is told" reassurance for whoever lingers).
      toast('Report sent — a human will take a look');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('You have sent a lot of reports this hour — try again later.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('That is no longer available to report.');
      } else {
        setError('Could not send the report. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className={styles.sheetBackdrop}
        style={zIndex !== undefined ? { zIndex } : undefined}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={TITLES[target.kind]}>
          <div className={styles.sheetHead}>
            <h2>{TITLES[target.kind]}</h2>
            <button type="button" className={styles.sheetClose} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          {done ? (
            <>
              <p className="ok-text">Thanks — a human will take a look.</p>
              <p className={styles.sheetNote}>
                No one is told you reported this. You can see where it stands under Settings → Privacy
                &amp; safety → Your reports.
              </p>
              <button type="button" className="btn" onClick={onClose} style={{ marginTop: 8 }}>
                Done
              </button>
            </>
          ) : (
            <>
              <p className={styles.sheetNote} style={{ marginTop: 0 }}>
                What&rsquo;s wrong with it? Reports go to moderators only — no one is notified.
              </p>
              <div role="radiogroup" aria-label="Reason" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {REPORT_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={category === c}
                    className={`btn${category === c ? ' btn-primary' : ''}`}
                    style={{ padding: '6px 10px', fontSize: 13 }}
                    onClick={() => setCategory(c)}
                  >
                    {REPORT_CATEGORY_LABELS[c]}
                  </button>
                ))}
              </div>
              {target.kind === 'anon_message' ? (
                // §1.62 binding: anonymity never survives a report — say so.
                <p className={styles.sheetNote}>
                  🎭 The sender was only ever anonymous to <em>you</em> — this report attaches their
                  real identity for the moderators.
                </p>
              ) : null}
              {target.kind === 'story_overlay' ? (
                // §1.66: the overlay author is attached server-side.
                <p className={styles.sheetNote}>
                  🎨 The moderators see who drew this — attribution is attached automatically.
                </p>
              ) : null}
              <textarea
                className="input"
                rows={3}
                placeholder="Anything else the moderators should know? (optional)"
                value={reason}
                maxLength={REPORT_REASON_MAX_CHARS}
                onChange={(e) => setReason(e.target.value)}
                style={{ marginTop: 10 }}
              />
              {target.kind === 'message' ? (
                // v0.8b §1.69 (binding UX contract): the EXACT consent copy,
                // unchecked by default. Without it the admin context viewer
                // answers 404 for this report.
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={includeContext}
                    onChange={(e) => setIncludeContext(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>{REPORT_CONTEXT_CONSENT_COPY}</span>
                </label>
              ) : null}
              {blockable ? (
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 13 }}>
                  <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>Also block this person — you disappear from each other everywhere.</span>
                </label>
              ) : null}
              {error ? <p className="error-text">{error}</p> : null}
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !category}
                onClick={() => void submit()}
                style={{ marginTop: 10, width: '100%' }}
              >
                {busy ? 'Sending…' : category ? 'Send report' : 'Pick a reason'}
              </button>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
