'use client';

// Inline-SVG QR renderer over the hand-rolled encoder in lib/qr.ts (v0.9 —
// API.md §1.71/§1.73, ADR-021: no QR dependency). Returns null when the
// payload overflows the encoder's version tables — by contract every QR
// surface keeps its text fallback permanently visible, so a missing QR
// degrades to the fallback carrying the feature alone.
//
// Always dark-on-white regardless of theme: QR contrast is a scanner
// requirement, not a style choice. The quiet zone is part of the viewBox.
import { useMemo } from 'react';
import { qrSvg } from '@/lib/qr';
import styles from './authpack.module.css';

const QUIET = 4; // modules of quiet zone, per spec

export default function QrCode({
  text,
  label,
  size = 196,
}: {
  text: string;
  /** Accessible description ("Login code", "Authenticator setup code"). */
  label: string;
  size?: number;
}) {
  const spec = useMemo(() => qrSvg(text), [text]);
  if (!spec) return null;
  const box = spec.size + QUIET * 2;
  return (
    <svg
      className={styles.qr}
      width={size}
      height={size}
      viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={-QUIET} y={-QUIET} width={box} height={box} fill="#ffffff" />
      <path d={spec.path} fill="#101418" />
    </svg>
  );
}
