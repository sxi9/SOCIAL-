'use client';

// Wave 1 (AUDIT-PLAN §1.6 + §1.8, 2026-10-28): the rows at the top of Chat
// settings — Mute (8 h · 1 week · Always · Off) for every chat, and for a DM
// the safety trio: Report person · Block · End chat. For a plain group a
// member who is not an admin gets "Report group". All server-backed:
// PATCH /api/conversations/:id/mute writes my own participant row
// (viewer-private); Block is the §1.14 PUT; End chat is the existing
// DELETE …/participants/:me (now silent for DMs).
import { useState } from 'react';
import {
  MUTE_FOREVER_ISO,
  type ConversationListItem,
  type ConversationResponse,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/confirm';
import * as store from '@/lib/store';
import { toast } from '@/lib/toast';
import ReportSheet from './ReportSheet';
import sheetStyles from './beacons.module.css';
import cm from './community.module.css';
import exp from './expression.module.css';

type MuteChoice = 'off' | '8h' | '1w' | 'always';

function choiceOf(mutedUntil: string | null): MuteChoice {
  if (!mutedUntil) return 'off';
  const t = new Date(mutedUntil).getTime();
  if (t <= Date.now()) return 'off';
  if (mutedUntil === MUTE_FOREVER_ISO || t - Date.now() > 400 * 24 * 3600 * 1000) return 'always';
  return t - Date.now() > 2 * 24 * 3600 * 1000 ? '1w' : '8h';
}

export function MuteRow({ conv, meId }: { conv: ConversationListItem; meId: string }) {
  const mine = conv.participants.find((p) => p.user.id === meId);
  const current = choiceOf(mine?.muted_until ?? null);
  const [busy, setBusy] = useState(false);

  async function choose(c: MuteChoice): Promise<void> {
    if (busy || (c === current && (c === 'off' || c === 'always'))) return;
    setBusy(true);
    const until =
      c === 'off'
        ? null
        : c === 'always'
          ? MUTE_FOREVER_ISO
          : new Date(Date.now() + (c === '8h' ? 8 : 24 * 7) * 3600 * 1000).toISOString();
    try {
      const res = await api.patch<ConversationResponse>(`/api/conversations/${conv.id}/mute`, { until });
      store.upsertConversation(res.conversation);
      toast(c === 'off' ? 'Unmuted' : 'Muted — mentions still get through');
    } catch {
      toast('Could not change the mute');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={sheetStyles.sheetLabel}>
        Mute <span className={exp.personalTag}>only for you</span>
      </div>
      <div className={sheetStyles.segRow} role="radiogroup" aria-label="Mute this chat">
        {(
          [
            { value: 'off', label: 'Off' },
            { value: '8h', label: '8 hours' },
            { value: '1w', label: '1 week' },
            { value: 'always', label: 'Always' },
          ] as { value: MuteChoice; label: string }[]
        ).map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            disabled={busy}
            className={`${sheetStyles.segBtn}${current === o.value ? ` ${sheetStyles.segOn}` : ''}`}
            onClick={() => void choose(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function DmSafetyRows({
  conv,
  meId,
  onEndChat,
}: {
  conv: ConversationListItem;
  meId: string;
  onEndChat: () => void;
}) {
  const peer = conv.participants.find((p) => p.user.id !== meId)?.user ?? null;
  const [report, setReport] = useState(false);
  const [blocked, setBlocked] = useState(false);
  if (!peer) return null;

  async function block(): Promise<void> {
    if (!peer) return;
    const ok = await confirmDialog(
      `Block ${peer.display_name}? You disappear from each other everywhere — chats, feed, plans. They are not told.`,
      { confirmLabel: 'Block', danger: true },
    );
    if (!ok) return;
    try {
      await api.put(`/api/users/${peer.id}/block`);
      setBlocked(true);
      toast(`Blocked ${peer.display_name}`);
    } catch {
      toast('Could not block');
    }
  }

  return (
    <>
      <div className={sheetStyles.sheetLabel}>Safety</div>
      <div className={cm.safetyRows}>
        <button type="button" className="btn" onClick={() => setReport(true)}>
          Report {peer.display_name}
        </button>
        <button type="button" className="btn" disabled={blocked} onClick={() => void block()}>
          {blocked ? 'Blocked' : 'Block'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onEndChat}>
          End chat
        </button>
      </div>
      {report ? <ReportSheet target={{ kind: 'user', user_id: peer.id }} onClose={() => setReport(false)} /> : null}
    </>
  );
}

export function GroupReportRow({ conv }: { conv: ConversationListItem }) {
  const [report, setReport] = useState(false);
  return (
    <>
      <div className={cm.safetyRows}>
        <button type="button" className="btn" onClick={() => setReport(true)}>
          Report this group
        </button>
      </div>
      {report ? <ReportSheet target={{ kind: 'group', object_id: conv.id }} onClose={() => setReport(false)} /> : null}
    </>
  );
}
