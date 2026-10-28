// Wave 1 (§1.8): the one-line stranger-safety strip — the LISTING_SAFETY_NOTE
// posture (verbatim, never dismissible) for the surfaces that put two
// strangers together. Server-safe (no hooks).
import { STRANGER_SAFETY_NOTE } from '@socialchat/shared';
import st from './board.module.css';

export default function SafetyStrip({ style }: { style?: React.CSSProperties }) {
  return (
    <div className={st.safetyNote} role="note" style={style}>
      <span aria-hidden>🛡️</span>
      <span>{STRANGER_SAFETY_NOTE}</span>
    </div>
  );
}
