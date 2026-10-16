// Shared scenery for /login, /register and /join/:token — animated gradient,
// floating blob/avatar cluster (pure CSS/SVG, no assets), big brand block and
// a frosted-glass card holding whatever the page puts inside. Hook-free so it
// renders from both server and client components.
import type { ReactNode } from 'react';
import styles from './auth.module.css';

function FloatingFace({ className, hue }: { className: string; hue: string }) {
  return (
    <svg className={className} width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden>
      <circle cx="27" cy="27" r="25" fill={hue} opacity="0.28" />
      <circle cx="27" cy="27" r="25" stroke={hue} strokeWidth="1.6" opacity="0.55" />
      <circle cx="19.5" cy="23" r="2.6" fill={hue} />
      <circle cx="34.5" cy="23" r="2.6" fill={hue} />
      <path d="M18 33 a9.5 9.5 0 0 0 18 0" stroke={hue} strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export default function AuthScene({ children }: { children: ReactNode }) {
  return (
    <div className={styles.scene}>
      <div className={styles.blobs} aria-hidden>
        <span className={`${styles.blob} ${styles.b1}`} />
        <span className={`${styles.blob} ${styles.b2}`} />
        <span className={`${styles.blob} ${styles.b3}`} />
        <FloatingFace className={`${styles.face} ${styles.f1}`} hue="#6f8cff" />
        <FloatingFace className={`${styles.face} ${styles.f2}`} hue="#4cd4a0" />
        <FloatingFace className={`${styles.face} ${styles.f3}`} hue="#ff6b96" />
      </div>
      <div className={styles.content}>
        <header className={styles.brand}>
          <h1 className={styles.title}>Bored Chat</h1>
          <p className={styles.pitch}>for when the group chat is dead</p>
        </header>
        <div className={styles.card}>{children}</div>
      </div>
    </div>
  );
}
