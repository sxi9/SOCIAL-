'use client';

// The once-only recovery-codes reveal (v0.9 — API.md §1.72, FEATURES #84).
// Used at the first-run moment after signup AND after a settings
// regeneration. The codes exist in the DOM exactly while this is mounted —
// the server keeps only sha256 rows, so this is the ONE chance to save them:
// copy + download + an explicit "I saved them" confirm.
import { useState } from 'react';
import { downloadTextFile, recoveryCodesText } from '@/lib/auth';
import { toast } from '@/lib/toast';
import styles from './authpack.module.css';

export default function RecoveryCodes({
  codes,
  username,
  confirmLabel,
  onConfirm,
}: {
  codes: string[];
  username: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      toast('Recovery codes copied'); // §1.56: quiet action, confirmed
    } catch {
      toast('Could not copy — select the codes by hand');
    }
  }

  function download(): void {
    downloadTextFile('bored-chat-recovery-codes.txt', recoveryCodesText(codes, username));
    toast('Recovery codes downloaded');
  }

  return (
    <div>
      <div className={styles.codeGrid} aria-label="Your recovery codes">
        {codes.map((code) => (
          <span key={code} className={styles.codeItem}>
            {code}
          </span>
        ))}
      </div>
      <div className={styles.codeActions}>
        <button type="button" className="btn" onClick={() => void copyAll()}>
          {copied ? 'Copied ✓' : 'Copy all'}
        </button>
        <button type="button" className="btn" onClick={download}>
          Download .txt
        </button>
      </div>
      <p className="muted small" style={{ margin: '0 0 10px' }}>
        Each code works once. Using one signs you out everywhere and asks for a new password —
        they are your way back in if you lose your password, passkeys and authenticator. They are
        never shown again.
      </p>
      <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  );
}
