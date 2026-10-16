'use client';

import { useState, type CSSProperties } from 'react';
import type { Attachment } from '@socialchat/shared';
import AudioBubble from './AudioBubble';
import BlurhashCanvas from './BlurhashCanvas';
import { formatBytes } from '@/lib/format';
import styles from './chat.module.css';
import exp from './expression.module.css';

function extOf(att: Attachment): string {
  const name = att.file_name ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).slice(0, 4);
  const slash = att.mime.indexOf('/');
  return slash === -1 ? 'file' : att.mime.slice(slash + 1).slice(0, 4);
}

function aspectStyle(att: Attachment): CSSProperties {
  if (att.width && att.height) {
    return { aspectRatio: `${att.width} / ${att.height}`, width: Math.min(att.width, 320) };
  }
  return { aspectRatio: '4 / 3', width: 280 };
}

export default function AttachmentView({
  attachment,
  doodle = false,
}: {
  attachment: Attachment;
  /** v0.4 §1.21: metadata.doodle → sketchy hand-drawn frame. */
  doodle?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);

  if (attachment.kind === 'audio') {
    // v0.4 §1.20: waveform playback bubble; never autoplays.
    return <AudioBubble attachment={attachment} />;
  }

  if (attachment.kind === 'image') {
    const img = (
      <span className={styles.mediaBox} style={aspectStyle(attachment)}>
        {attachment.blurhash ? <BlurhashCanvas hash={attachment.blurhash} /> : null}
        {attachment.thumb_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={attachment.thumb_url}
            alt={attachment.file_name ?? (doodle ? 'Doodle' : 'Photo')}
            className={loaded ? styles.loaded : undefined}
            onLoad={() => setLoaded(true)}
          />
        ) : null}
      </span>
    );
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer">
        {doodle ? <span className={exp.doodleFrame}>{img}</span> : img}
      </a>
    );
  }

  if (attachment.kind === 'video') {
    if (attachment.status === 'ready') {
      return (
        <span className={styles.mediaBox} style={aspectStyle(attachment)}>
          <video
            src={attachment.url}
            poster={attachment.thumb_url ?? undefined}
            controls
            playsInline
            preload="metadata"
          />
        </span>
      );
    }
    // pending: usable immediately, poster/thumb hydrate via msg.updated (§5)
    return (
      <span className={styles.mediaBox} style={aspectStyle(attachment)}>
        {attachment.blurhash ? <BlurhashCanvas hash={attachment.blurhash} /> : null}
        <span className={styles.mediaPending}>
          <span className="spinner" />
          {attachment.status === 'failed' ? 'Processing failed' : 'Processing video…'}
        </span>
      </span>
    );
  }

  return (
    <a className={styles.fileRow} href={attachment.url} download={attachment.file_name ?? true}>
      <span className={styles.fileIcon}>{extOf(attachment)}</span>
      <span style={{ minWidth: 0 }}>
        <span className={styles.fileName}>{attachment.file_name ?? 'File'}</span>
        <span className="muted small" style={{ display: 'block' }}>
          {formatBytes(attachment.size_bytes)}
        </span>
      </span>
    </a>
  );
}
