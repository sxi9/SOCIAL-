'use client';

// Rich profile editor (v0.5a — API.md §1.37): interests tags, work/skills
// entries, and the 3-GIF strip (upload + reorder). PATCH is full-replace per
// present field; profile edits fan nothing — profiles are pulled.
import { useEffect, useRef, useState } from 'react';
import type { Attachment, Profile, ProfileResponse, UploadResponse } from '@socialchat/shared';
import {
  INTEREST_TAG_MAX_CHARS,
  INTERESTS_MAX,
  PROFILE_ENTRIES_MAX,
  PROFILE_ENTRY_DETAIL_MAX_CHARS,
  PROFILE_ENTRY_TITLE_MAX_CHARS,
  PROFILE_MEDIA_MAX,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import st from './social.module.css';

interface EntryDraft {
  kind: 'work' | 'skill';
  title: string;
  detail: string;
}

export default function ProfileEditor() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Drafts
  const [interests, setInterests] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [entries, setEntries] = useState<EntryDraft[]>([]);
  const [media, setMedia] = useState<Attachment[]>([]);
  const [entryKind, setEntryKind] = useState<'work' | 'skill'>('work');
  const [entryTitle, setEntryTitle] = useState('');
  const [entryDetail, setEntryDetail] = useState('');

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<ProfileResponse>('/api/users/me/profile')
      .then((res) => {
        if (cancelled) return;
        setProfile(res.profile);
        setInterests(res.profile.interests);
        setEntries(res.profile.entries.map((e) => ({ kind: e.kind, title: e.title, detail: e.detail })));
        setMedia(res.profile.media);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(change: {
    interests?: string[];
    entries?: EntryDraft[];
    media_attachment_ids?: string[];
  }): Promise<boolean> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.patch<ProfileResponse>('/api/users/me/profile', change);
      setProfile(res.profile);
      setMedia(res.profile.media);
      setSaved(true);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || 'Could not save.') : 'Could not save.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function addTag(): void {
    const tag = tagDraft.trim().slice(0, INTEREST_TAG_MAX_CHARS);
    if (!tag) return;
    if (interests.length >= INTERESTS_MAX) {
      setError(`Up to ${INTERESTS_MAX} interests.`);
      return;
    }
    if (interests.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setTagDraft('');
      return;
    }
    setError(null);
    setInterests([...interests, tag]);
    setTagDraft('');
  }

  function addEntry(): void {
    const title = entryTitle.trim();
    if (!title) return;
    if (entries.length >= PROFILE_ENTRIES_MAX) {
      setError(`Up to ${PROFILE_ENTRIES_MAX} entries.`);
      return;
    }
    setError(null);
    setEntries([...entries, { kind: entryKind, title, detail: entryDetail.trim() }]);
    setEntryTitle('');
    setEntryDetail('');
  }

  function moveEntry(idx: number, dir: -1 | 1): void {
    const to = idx + dir;
    if (to < 0 || to >= entries.length) return;
    const next = [...entries];
    [next[idx], next[to]] = [next[to], next[idx]];
    setEntries(next);
  }

  async function uploadGif(file: File): Promise<void> {
    if (media.length >= PROFILE_MEDIA_MAX) return;
    setUploading(true);
    setError(null);
    try {
      const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      const form = new FormData();
      form.append('file', up, up.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.kind !== 'image') {
        setError('The strip takes images (GIFs welcome).');
        return;
      }
      const ids = [...media.map((m) => m.id), res.attachment.id];
      await save({ media_attachment_ids: ids });
    } catch (err) {
      if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setError('That file is too large.');
      else if (err instanceof ApiError && err.status === 415) setError('Unsupported file type.');
      else setError('Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function moveGif(idx: number, dir: -1 | 1): Promise<void> {
    const to = idx + dir;
    if (to < 0 || to >= media.length) return;
    const next = [...media];
    [next[idx], next[to]] = [next[to], next[idx]];
    setMedia(next); // optimistic order
    await save({ media_attachment_ids: next.map((m) => m.id) });
  }

  async function removeGif(idx: number): Promise<void> {
    const next = media.filter((_, i) => i !== idx);
    setMedia(next);
    await save({ media_attachment_ids: next.map((m) => m.id) });
  }

  if (loadError) {
    return (
      <div className="card">
        <p className="error-text" style={{ margin: 0 }}>
          Could not load your profile extras — refresh to retry.
        </p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="card">
        <p className="muted small" style={{ margin: 0 }}>
          <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
          Loading profile extras…
        </p>
      </div>
    );
  }

  return (
    <>
      <h2>GIF strip</h2>
      <div className="card">
        <p className="muted small" style={{ margin: '0 0 6px' }}>
          Three slots at the top of your profile — GIFs encouraged. Drag-free reordering with the
          arrows.
        </p>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/gif,image/webp,image/png,image/jpeg"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadGif(f);
            e.target.value = '';
          }}
        />
        <div className={st.gifStrip}>
          {media.map((m, i) => (
            <span key={m.id} className={st.gifTile}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.thumb_url ?? m.url} alt={`Profile GIF ${i + 1}`} />
              <span className={st.gifTileTools}>
                <button
                  type="button"
                  className={st.gifToolBtn}
                  aria-label="Move left"
                  disabled={i === 0 || busy}
                  onClick={() => void moveGif(i, -1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  className={st.gifToolBtn}
                  aria-label="Remove"
                  disabled={busy}
                  onClick={() => void removeGif(i)}
                >
                  ×
                </button>
                <button
                  type="button"
                  className={st.gifToolBtn}
                  aria-label="Move right"
                  disabled={i === media.length - 1 || busy}
                  onClick={() => void moveGif(i, 1)}
                >
                  →
                </button>
              </span>
            </span>
          ))}
          {media.length < PROFILE_MEDIA_MAX ? (
            <button
              type="button"
              className={`${st.gifTile} ${st.gifTileEmpty}`}
              aria-label="Add a GIF to your profile strip"
              disabled={uploading || busy}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <span className="spinner" /> : '+'}
            </button>
          ) : null}
        </div>
      </div>

      <h2>Interests</h2>
      <div className="card">
        <div className={st.interestChips}>
          {interests.length === 0 ? (
            <p className={st.connEmpty} style={{ padding: 0 }}>
              Tags help people find common ground — chai, climbing, synths…
            </p>
          ) : (
            interests.map((tag) => (
              <span key={tag} className="chip">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove interest ${tag}`}
                  onClick={() => setInterests(interests.filter((t) => t !== tag))}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <div className={st.tagInputRow}>
          <input
            className="input"
            value={tagDraft}
            maxLength={INTEREST_TAG_MAX_CHARS}
            placeholder="add an interest…"
            aria-label="Add an interest"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" className="btn" disabled={!tagDraft.trim()} onClick={addTag}>
            Add
          </button>
        </div>
      </div>

      <h2>Work &amp; skills</h2>
      <div className="card">
        {entries.length > 0 ? (
          entries.map((entry, i) => (
            <div key={`${entry.kind}-${entry.title}-${i}`} className={st.entryRow}>
              <span className={st.entryKind} aria-hidden>
                {entry.kind === 'work' ? '💼' : '✨'}
              </span>
              <span className={st.entryText}>
                <strong>{entry.title}</strong>
                {entry.detail ? <span>{entry.detail}</span> : null}
              </span>
              <span className={st.entryTools}>
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveEntry(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === entries.length - 1}
                  onClick={() => moveEntry(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${entry.title}`}
                  onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            </div>
          ))
        ) : (
          <p className={st.connEmpty} style={{ padding: 0 }}>
            What you do and what you&rsquo;re good at — shown as two tidy lists on your profile.
          </p>
        )}
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="pe-kind">New entry</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              id="pe-kind"
              className="input"
              style={{ width: 110, flex: 'none' }}
              value={entryKind}
              onChange={(e) => setEntryKind(e.target.value as 'work' | 'skill')}
            >
              <option value="work">Work</option>
              <option value="skill">Skill</option>
            </select>
            <input
              className="input"
              value={entryTitle}
              maxLength={PROFILE_ENTRY_TITLE_MAX_CHARS}
              placeholder={entryKind === 'work' ? 'e.g. Barista @ Third Wave' : 'e.g. Poster design'}
              aria-label="Entry title"
              onChange={(e) => setEntryTitle(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <input
            className="input"
            value={entryDetail}
            maxLength={PROFILE_ENTRY_DETAIL_MAX_CHARS}
            placeholder="detail (optional)"
            aria-label="Entry detail"
            onChange={(e) => setEntryDetail(e.target.value)}
          />
        </div>
        <button type="button" className="btn" disabled={!entryTitle.trim()} onClick={addEntry}>
          Add entry
        </button>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {saved ? <p className="ok-text">Profile saved.</p> : null}
      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={() => void save({ interests, entries })}
      >
        {busy ? 'Saving…' : 'Save interests & entries'}
      </button>
    </>
  );
}
