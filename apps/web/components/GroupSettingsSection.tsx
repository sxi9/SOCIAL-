'use client';

// Group visibility modes (v0.8b — API.md §1.68, FEATURES #79d, ADR-020) —
// the "Group" section of the chat-settings sheet. Admins pick the mode
// (public requires an explicit confirm that explains post-switch-only
// exposure; ghost is a one-way door), edit the description, work the
// invite-only join-request queue and mint/copy the share link. Ghost members
// manage their mask here.
import { useEffect, useState } from 'react';
import type {
  ConversationListItem,
  GroupJoinRequestRow,
  GroupVisibility,
} from '@socialchat/shared';
import {
  GHOST_MASK_EMOJI,
  GROUP_DESCRIPTION_MAX_CHARS,
  GROUP_VISIBILITIES,
  MASK_NAME_MAX_CHARS,
} from '@socialchat/shared';
import { ApiError } from '@/lib/api';
import {
  approveJoinRequest,
  denyJoinRequest,
  isGhost,
  listJoinRequests,
  setMask,
  updateGroupVisibility,
} from '@/lib/groups';
import { ShareButton } from './ShareSheet';
import { toast } from '@/lib/toast';
import Avatar from './Avatar';
import Portal from './Portal';
import bz from './beacons.module.css';
import cm from './community.module.css';

const VIS_INFO: Record<GroupVisibility, { icon: string; label: string; hint: string }> = {
  private: {
    icon: '🔒',
    label: 'Private',
    hint: 'Invite links only. Nothing about this group exists for outsiders.',
  },
  invite_only: {
    icon: '🎟️',
    label: 'Invite-only',
    hint: 'Gets a public CARD page (name, description, member count — never messages). People can ask to join; admins decide.',
  },
  public: {
    icon: '🌐',
    label: 'Public',
    hint: 'Anyone can join, and NEW messages are readable on a live public page. History from before the switch is never exposed.',
  },
  ghost: {
    icon: '👻',
    label: 'Ghost',
    hint: 'Unlisted everywhere; members wear masks (pseudonym + emoji) — anonymous to each other, never to the server. FOREVER: this can never be switched off.',
  },
};

export default function GroupSettingsSection({
  conv,
  meId,
}: {
  conv: ConversationListItem;
  meId: string;
}) {
  const myRole = conv.participants.find((p) => p.user.id === meId)?.role ?? 'member';
  const admin = myRole === 'admin' || myRole === 'owner';
  const ghost = isGhost(conv);

  const [confirming, setConfirming] = useState<GroupVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(conv.description);
  const [requests, setRequests] = useState<GroupJoinRequestRow[] | null>(null);

  // The admin's queue — invite-only groups only (oldest first; a queue).
  useEffect(() => {
    if (!admin || conv.visibility !== 'invite_only') {
      setRequests(null);
      return;
    }
    let cancelled = false;
    void listJoinRequests(conv.id)
      .then((res) => {
        if (!cancelled) setRequests(res.requests);
      })
      .catch(() => {
        if (!cancelled) setRequests([]);
      });
    return () => {
      cancelled = true;
    };
    // Phase 2: `pending_requests` moves with the group.join_request frame, so
    // the queue re-reads itself whenever it changes.
  }, [admin, conv.visibility, conv.id, conv.pending_requests]);

  async function applyVisibility(v: GroupVisibility, confirm = false): Promise<void> {
    if (busy) return;
    // Public and ghost demand the explicit confirm sheet first.
    if (!confirm && (v === 'public' || v === 'ghost')) {
      setConfirming(v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateGroupVisibility(conv.id, { visibility: v, confirm });
      setConfirming(null);
      toast(
        v === 'public'
          ? 'Group is public — new messages are readable on its page'
          : v === 'ghost'
            ? 'Ghost mode on — masks assigned 👻'
            : v === 'invite_only'
              ? 'Invite-only — people can now ask to join'
              : 'Group is private again — the public page is gone'
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ghost_is_forever') {
        setError('Ghost is forever — members spoke under masks, so there is no way back.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Only group admins can change this.');
      } else {
        setError('Could not change the visibility — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription(): Promise<void> {
    if (busy || description === conv.description) return;
    setBusy(true);
    setError(null);
    try {
      await updateGroupVisibility(conv.id, { description, confirm: false });
      toast('Description saved');
    } catch {
      setError('Could not save the description.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(userId: string, approve: boolean): Promise<void> {
    try {
      if (approve) await approveJoinRequest(conv.id, userId);
      else await denyJoinRequest(conv.id, userId);
      setRequests((prev) => (prev ? prev.filter((r) => r.user.id !== userId) : prev));
      if (approve) toast('They’re in');
    } catch {
      toast('Could not handle that request');
    }
  }

  return (
    <>
      <div className={bz.sheetLabel}>Group</div>

      {ghost ? (
        <p className="muted small" style={{ margin: '0 0 8px' }}>
          <span className={cm.ghostTag}>👻 ghost group</span> Unlisted everywhere, masks on,
          forever. Admins can see real identities for safety; reports always attach them.
        </p>
      ) : null}

      {admin && !ghost ? (
        <>
          <div className={cm.visGrid} role="radiogroup" aria-label="Who can find and read this group">
            {GROUP_VISIBILITIES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={conv.visibility === v}
                className={`${cm.visOpt}${conv.visibility === v ? ` ${cm.visOptOn}` : ''}`}
                disabled={busy || conv.visibility === v}
                onClick={() => void applyVisibility(v)}
              >
                <span aria-hidden>{VIS_INFO[v].icon}</span>
                <span className={cm.visOptText}>
                  <strong>{VIS_INFO[v].label}</strong>
                  <span>{VIS_INFO[v].hint}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="grp-desc">Description (shows on the group card &amp; share page)</label>
            <textarea
              id="grp-desc"
              className="input"
              rows={2}
              value={description}
              maxLength={GROUP_DESCRIPTION_MAX_CHARS}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => void saveDescription()}
            />
          </div>
        </>
      ) : null}

      {admin && (conv.visibility === 'public' || conv.visibility === 'invite_only') ? (
        <ShareButton
          type="group"
          id={conv.id}
          className="btn"
          style={{ width: '100%', marginBottom: 10 }}
          label="🔗 Share the group"
        />
      ) : null}

      {admin && conv.visibility === 'invite_only' ? (
        <>
          <div className={bz.sheetLabel}>
            Join requests{conv.pending_requests ? ` · ${conv.pending_requests} waiting` : ''}
          </div>
          {requests === null ? (
            <p className="muted small">Looking…</p>
          ) : requests.length === 0 ? (
            <p className="muted small" style={{ margin: '0 0 10px' }}>
              Nobody waiting. Requests land here, oldest first.
            </p>
          ) : (
            requests.map((r) => (
              <div key={r.user.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <Avatar avatar={r.user.avatar} name={r.user.display_name} size={32} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
                  <strong>{r.user.display_name}</strong>{' '}
                  <span className="muted small">@{r.user.username}</span>
                </span>
                <button type="button" className="btn btn-primary" onClick={() => void decide(r.user.id, true)}>
                  Approve
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Deny ${r.user.display_name} — they are not told`}
                  onClick={() => void decide(r.user.id, false)}
                >
                  Deny
                </button>
              </div>
            ))
          )}
          {requests && requests.length > 0 ? (
            <p className="muted small" style={{ margin: '4px 0 10px' }}>
              Denying is silent — they&rsquo;re never told, and can ask again.
            </p>
          ) : null}
        </>
      ) : null}

      {ghost ? <MaskEditor conv={conv} meId={meId} /> : null}

      {error ? <p className="error-text">{error}</p> : null}

      {confirming ? (
        <Portal>
          <div
            className={bz.sheetBackdrop}
            role="presentation"
            style={{ zIndex: 60 }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirming(null);
            }}
          >
            <div className={bz.sheet} role="alertdialog" aria-modal="true" aria-label="Confirm the switch">
              <div className={bz.sheetHead}>
                <h2>{confirming === 'public' ? '🌐 Make this group public?' : '👻 Go ghost?'}</h2>
                <button type="button" className={bz.sheetClose} aria-label="Close" onClick={() => setConfirming(null)}>
                  ×
                </button>
              </div>
              {confirming === 'public' ? (
                <p className={bz.sheetNote} style={{ marginTop: 0 }}>
                  From the moment you confirm, <strong>every NEW message</strong> in this group is
                  readable by anyone on a public page — and anyone can join.{' '}
                  <strong>Everything sent before this switch stays private, always.</strong> A
                  system message tells every member, and a banner stays up as a reminder.
                </p>
              ) : (
                <p className={bz.sheetNote} style={{ marginTop: 0 }}>
                  Everyone gets a mask (a pseudonym + emoji) and the group vanishes from search,
                  activity and suggestions — invites become the only way in.{' '}
                  <strong>This can never be undone</strong>: people will speak under masks, so no
                  later switch may unmask them. Admins still see real identities for safety, and
                  reports always attach them.
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button type="button" className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirming(null)}>
                  Not now
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => void applyVisibility(confirming, true)}
                >
                  {busy ? 'Switching…' : confirming === 'public' ? 'Make it public' : 'Go ghost — forever'}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  );
}

/** My mask in a ghost group — name + emoji, unique per group (§1.68). */
function MaskEditor({ conv }: { conv: ConversationListItem; meId: string }) {
  // §1.68: my own participant row serializes with my REAL identity (a client
  // must find itself), so the current mask comes from the explicit own-mask
  // field conv.my_mask — the one place a member learns the pseudonym+emoji
  // the others see them as (incl. the auto-mask left by a 409 mask_taken).
  const [name, setName] = useState(conv.my_mask?.name ?? '');
  const [emoji, setEmoji] = useState<string>(conv.my_mask?.emoji ?? GHOST_MASK_EMOJI[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setMask(conv.id, value, emoji);
      toast('Mask updated 👻');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mask_taken') {
        setError('Someone in here already wears that name — pick another.');
      } else {
        setError('Could not update your mask.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={bz.sheetLabel}>Your mask</div>
      <p className="muted small" style={{ margin: '0 0 8px' }}>
        This is who the others see. Changing it fans a quiet update — nothing links the old name to
        the new one for regular members.
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} role="radiogroup" aria-label="Mask emoji">
        {GHOST_MASK_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={emoji === e}
            className={`btn btn-icon${emoji === e ? ' btn-primary' : ''}`}
            onClick={() => setEmoji(e)}
          >
            {e}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input
          className="input"
          style={{ flex: 1, fontSize: 16 }}
          aria-label="Mask name"
          placeholder="mask name…"
          value={name}
          maxLength={MASK_NAME_MAX_CHARS}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Wear it'}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}
