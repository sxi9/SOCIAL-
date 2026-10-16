'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  MAX_GROUP_PARTICIPANTS,
  type ConversationResponse,
  type UserPublic,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { upsertConversation } from '@/lib/store';
import AppShell from '@/components/AppShell';
import UserSearch from '@/components/UserSearch';
import styles from '@/components/list.module.css';

const MAX_INVITEES = MAX_GROUP_PARTICIPANTS - 1; // + creator = cap

function NewConversation() {
  const router = useRouter();
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<UserPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function startDm(user: UserPublic): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // DM replays dedupe via dm_key server-side (§1.4) — 200 returns the existing one.
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'dm',
        user_id: user.id,
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch {
      setError('Could not start the conversation.');
      setBusy(false);
    }
  }

  function addMember(user: UserPublic): void {
    setError(null);
    setMembers((prev) => {
      if (prev.some((u) => u.id === user.id)) return prev;
      if (prev.length >= MAX_INVITEES) {
        setError(`Groups are capped at ${MAX_GROUP_PARTICIPANTS} members.`);
        return prev;
      }
      return [...prev, user];
    });
  }

  async function createGroup(): Promise<void> {
    if (busy) return;
    const name = title.trim();
    if (!name) {
      setError('Give the group a name.');
      return;
    }
    if (members.length === 0) {
      setError('Add at least one member.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ConversationResponse>('/api/conversations', {
        type: 'group',
        title: name,
        user_ids: members.map((u) => u.id),
      });
      upsertConversation(res.conversation);
      router.push(`/c/${res.conversation.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'group_too_large') {
        setError(`Groups are capped at ${MAX_GROUP_PARTICIPANTS} members.`);
      } else {
        setError('Could not create the group.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link href="/" className="btn btn-ghost btn-icon" aria-label="Back">
          ←
        </Link>
        <h1>New conversation</h1>
      </header>
      <div className="settings-section">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            type="button"
            className={`btn${mode === 'dm' ? ' btn-primary' : ''}`}
            onClick={() => setMode('dm')}
          >
            Direct message
          </button>
          <button
            type="button"
            className={`btn${mode === 'group' ? ' btn-primary' : ''}`}
            onClick={() => setMode('group')}
          >
            Group
          </button>
        </div>

        {mode === 'group' ? (
          <>
            <div className="field">
              <label htmlFor="group-title">Group name</label>
              <input
                id="group-title"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
              />
            </div>
            {members.length > 0 ? (
              <div className={styles.chips}>
                {members.map((u) => (
                  <span key={u.id} className="chip">
                    {u.display_name}
                    <button
                      type="button"
                      aria-label={`Remove ${u.display_name}`}
                      onClick={() => setMembers((prev) => prev.filter((m) => m.id !== u.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <p className="muted small">
              {members.length}/{MAX_INVITEES} members added
            </p>
          </>
        ) : null}

        <UserSearch
          onSelect={(user) => {
            if (mode === 'dm') void startDm(user);
            else addMember(user);
          }}
          excludeIds={new Set(members.map((m) => m.id))}
          placeholder={mode === 'dm' ? 'Who do you want to message?' : 'Add members'}
        />

        {error ? <p className="error-text">{error}</p> : null}
        {mode === 'group' ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 12 }}
            disabled={busy || members.length === 0 || !title.trim()}
            onClick={() => void createGroup()}
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function NewConversationPage() {
  return (
    <AppShell>
      <NewConversation />
    </AppShell>
  );
}
