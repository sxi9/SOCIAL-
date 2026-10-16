'use client';

// Scheduled sends & time capsules (v0.4 — API.md §1.26). Preset chips plus a
// custom picker; capsule mode seals the delivery in an envelope bubble with a
// first-view reveal. A pending schedule is private until it delivers.
import { useEffect, useMemo, useState } from 'react';
import type { MessageEffect } from '@socialchat/shared';
import { SCHEDULED_MAX_HORIZON_S, SCHEDULED_MIN_LEAD_S } from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import { formatDeliverAt } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { createScheduled } from '@/lib/scheduled';
import sheetStyles from './beacons.module.css';
import exp from './expression.module.css';

export interface ScheduleDraft {
  type: 'text' | 'image' | 'video' | 'file' | 'audio';
  body?: string;
  attachment_ids?: string[];
  effect?: MessageEffect;
}

interface ScheduleSheetProps {
  conversationId: string;
  draft: ScheduleDraft;
  onClose: () => void;
  onScheduled: () => void;
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleSheet({ conversationId, draft, onClose, onScheduled }: ScheduleSheetProps) {
  const [capsule, setCapsule] = useState(false);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const presets = useMemo(() => {
    const now = new Date();
    const list: { label: string; at: Date }[] = [];
    list.push({ label: 'In 1 hour', at: new Date(now.getTime() + 3600_000) });
    const tonight = new Date(now);
    tonight.setHours(20, 0, 0, 0);
    if (tonight.getTime() > now.getTime() + 10 * 60_000) list.push({ label: 'Tonight 8pm', at: tonight });
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    list.push({ label: 'Tomorrow 9am', at: tomorrow });
    const nextWeek = new Date(now.getTime() + 7 * 24 * 3600_000);
    list.push({ label: 'In a week', at: nextWeek });
    const nextYear = new Date(now);
    nextYear.setFullYear(now.getFullYear() + 1);
    list.push({ label: 'A year from now', at: nextYear });
    return list;
  }, []);

  async function schedule(at: Date): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const metadata: { effect?: MessageEffect; capsule?: true } = {};
      if (draft.effect) metadata.effect = draft.effect;
      if (capsule) metadata.capsule = true;
      await createScheduled(conversationId, {
        client_msg_id: uuidv7(),
        type: draft.type,
        body: draft.body,
        attachment_ids: draft.attachment_ids,
        metadata: Object.keys(metadata).length ? metadata : undefined,
        deliver_at: at.toISOString(),
      });
      onScheduled();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'deliver_at_out_of_range') {
        setError('Pick a time at least a minute out (and within a year).');
      } else if (err instanceof ApiError && err.code === 'scheduled_limit') {
        setError('You already have 50 pending scheduled messages — cancel one first.');
      } else {
        setError('Could not schedule that — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const minLocal = toLocalInputValue(new Date(Date.now() + (SCHEDULED_MIN_LEAD_S + 60) * 1000));
  const maxLocal = toLocalInputValue(new Date(Date.now() + SCHEDULED_MAX_HORIZON_S * 1000));

  return (
    <div
      className={sheetStyles.sheetBackdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={sheetStyles.sheet} role="dialog" aria-modal="true" aria-label="Schedule this message">
        <div className={sheetStyles.sheetHead}>
          <h2>Send later</h2>
          <button type="button" className={sheetStyles.sheetClose} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="muted small" style={{ margin: '0 0 12px' }}>
          {draft.body ? `“${draft.body.length > 80 ? `${draft.body.slice(0, 80)}…` : draft.body}”` : 'Your attachment'}{' '}
          will be delivered as a normal message when the time comes.
        </p>

        <div className={sheetStyles.sheetLabel}>When</div>
        <div className={exp.schedPresets}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className={sheetStyles.whenChip}
              disabled={busy}
              onClick={() => void schedule(p.at)}
            >
              {p.label}
              <small>{formatDeliverAt(p.at.toISOString())}</small>
            </button>
          ))}
        </div>

        <div className={sheetStyles.sheetLabel}>Or pick a time</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="datetime-local"
            className="input"
            aria-label="Custom delivery time"
            value={custom}
            min={minLocal}
            max={maxLocal}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !custom}
            onClick={() => {
              const at = new Date(custom);
              if (Number.isNaN(at.getTime())) {
                setError('That time didn’t parse.');
                return;
              }
              void schedule(at);
            }}
          >
            Set
          </button>
        </div>

        <button
          type="button"
          className={`${exp.capsuleToggle}${capsule ? ` ${exp.capsuleToggleOn}` : ''}`}
          role="switch"
          aria-checked={capsule}
          onClick={() => setCapsule((v) => !v)}
        >
          <span aria-hidden style={{ fontSize: 22, lineHeight: 1 }}>
            💌
          </span>
          <span style={{ flex: 1 }}>
            <strong>Time capsule</strong>
            <span className="muted small" style={{ display: 'block', marginTop: 2 }}>
              Delivered sealed — they tap the envelope to open it.
            </span>
          </span>
        </button>

        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </div>
  );
}
