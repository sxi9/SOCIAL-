'use client';

// Afterglow recap (v0.3 — API.md §1.15, PSYCHOLOGY §8/§9): rides the system
// message the worker posts in the plan conversation. Peak-first, people-first:
// the crew's faces, the photos, one-tap "Run it back", and a ONE-TIME gentle
// kudos prompt ("glad you came?") delivered privately — never a public count.
import { useEffect, useRef, useState } from 'react';
import type {
  AfterglowMetadata,
  Attachment,
  AttachmentResponse,
  Conversation,
  UserPublic,
} from '@socialchat/shared';
import { api } from '@/lib/api';
import { runItBack, sendKudos, VIBE_EMOJI, VIBE_LABEL } from '@/lib/beacons';
import Avatar from './Avatar';
import styles from './beacons.module.css';

const KUDOS_DONE_KEY = (beaconId: string) => `bc-kudos-done:${beaconId}`;

function kudosDone(beaconId: string): boolean {
  try {
    return localStorage.getItem(KUDOS_DONE_KEY(beaconId)) !== null;
  } catch {
    return false;
  }
}

function markKudosDone(beaconId: string): void {
  try {
    localStorage.setItem(KUDOS_DONE_KEY(beaconId), '1');
  } catch {
    /* private mode — the prompt may show again, harmless */
  }
}

interface AfterglowCardProps {
  afterglow: AfterglowMetadata;
  body: string | null;
  conv: Conversation;
  meId: string;
}

export default function AfterglowCard({ afterglow, body, conv, meId }: AfterglowCardProps) {
  const [photos, setPhotos] = useState<Attachment[]>([]);
  const [ranBack, setRanBack] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [promptGone, setPromptGone] = useState(true);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const fetchedRef = useRef(false);

  // The crew, resolved from the plan conversation's participants.
  const crew: UserPublic[] = afterglow.participant_ids
    .map((id) => conv.participants.find((p) => p.user.id === id)?.user)
    .filter((u): u is UserPublic => u !== undefined);
  const others = crew.filter((u) => u.id !== meId);
  const iWasThere = afterglow.participant_ids.includes(meId);

  useEffect(() => {
    setPromptGone(!iWasThere || others.length === 0 || kudosDone(afterglow.beacon_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterglow.beacon_id]);

  // Hydrate the photo strip (≤6 ids) — failures just mean fewer photos.
  useEffect(() => {
    if (fetchedRef.current || afterglow.photo_attachment_ids.length === 0) return;
    fetchedRef.current = true;
    let cancelled = false;
    void (async () => {
      const loaded: Attachment[] = [];
      for (const id of afterglow.photo_attachment_ids) {
        try {
          const res = await api.get<AttachmentResponse>(`/api/uploads/${id}`);
          if (res.attachment.status === 'ready') loaded.push(res.attachment);
        } catch {
          /* skip */
        }
      }
      if (!cancelled) setPhotos(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [afterglow.photo_attachment_ids]);

  async function runBack(): Promise<void> {
    if (runBusy || ranBack) return;
    setRunBusy(true);
    setRunErr(null);
    try {
      await runItBack(afterglow.run_it_back);
      setRanBack(true); // the new beacon (yours) is already live on the list
    } catch {
      setRunErr('Could not re-light it — try again.');
    } finally {
      setRunBusy(false);
    }
  }

  async function tapKudos(user: UserPublic): Promise<void> {
    if (sentTo.has(user.id)) return;
    const kind = user.id === conv.created_by ? 'glad_you_posted' : 'glad_you_came';
    try {
      await sendKudos(afterglow.beacon_id, user.id, kind);
      setSentTo((prev) => new Set(prev).add(user.id));
      markKudosDone(afterglow.beacon_id); // one gentle prompt, never again
    } catch {
      /* window closed or blocked pair — stay quiet */
    }
  }

  function dismissPrompt(): void {
    markKudosDone(afterglow.beacon_id);
    setPromptGone(true);
  }

  return (
    <div className={`${styles.afterglow} ${styles.beaconVars}`}>
      <div className={styles.afterglowHead}>
        <span aria-hidden>{VIBE_EMOJI[afterglow.vibe]}</span>
        <span>That {VIBE_LABEL[afterglow.vibe].toLowerCase()} happened ✨</span>
      </div>
      {body ? <p className={styles.afterglowBody}>{body}</p> : null}

      {crew.length > 0 ? (
        <span className={styles.pile}>
          {crew.map((u) => (
            <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={30} />
          ))}
        </span>
      ) : null}

      {photos.length > 0 ? (
        <div className={styles.afterglowPhotos}>
          {photos.map((att) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={att.id} src={att.thumb_url ?? att.url} alt="" loading="lazy" />
          ))}
        </div>
      ) : null}

      <button type="button" className={styles.runBackBtn} disabled={runBusy || ranBack} onClick={() => void runBack()}>
        {ranBack ? 'It’s live again 🔥' : runBusy ? 'Lighting…' : 'Run it back 🔁'}
      </button>
      {runErr ? <p className="error-text" style={{ margin: 0 }}>{runErr}</p> : null}

      {!promptGone ? (
        <div className={styles.kudosPrompt}>
          <p>Glad you came? Tap to let them know — privately, just between you two.</p>
          <div className={styles.kudosRow}>
            {others.map((u) => (
              <button
                key={u.id}
                type="button"
                className={styles.kudosPerson}
                disabled={sentTo.has(u.id)}
                onClick={() => void tapKudos(u)}
              >
                <Avatar avatar={u.avatar} name={u.display_name} size={24} />
                {sentTo.has(u.id) ? '💛 sent' : u.display_name}
              </button>
            ))}
          </div>
          <button type="button" className={styles.kudosSkip} onClick={dismissPrompt}>
            maybe later
          </button>
        </div>
      ) : null}
    </div>
  );
}
