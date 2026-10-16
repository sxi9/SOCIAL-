'use client';

import type { LinkPreview } from '@socialchat/shared';
import styles from './chat.module.css';

interface PreviewCardProps {
  preview: LinkPreview;
  /** Rendered inside the composer: dismissible, not clickable. */
  onDismiss?: () => void;
}

export default function PreviewCard({ preview, onDismiss }: PreviewCardProps) {
  const body = (
    <>
      {preview.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.image_url} alt="" loading="lazy" />
      ) : null}
      <span className={styles.previewBody} style={{ display: 'block' }}>
        {onDismiss ? (
          <button
            type="button"
            className={styles.previewDismiss}
            onClick={(e) => {
              e.preventDefault();
              onDismiss();
            }}
            aria-label="Remove preview"
          >
            ×
          </button>
        ) : null}
        {preview.site_name ? <span className={styles.previewSite} style={{ display: 'block' }}>{preview.site_name}</span> : null}
        {preview.title ? <span className={styles.previewTitle} style={{ display: 'block' }}>{preview.title}</span> : null}
        {preview.description ? <span className={styles.previewDesc}>{preview.description}</span> : null}
      </span>
    </>
  );

  if (onDismiss) {
    return <span className={styles.previewCard} style={{ display: 'block' }}>{body}</span>;
  }
  return (
    <a className={styles.previewCard} href={preview.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  );
}
