// Inline SVG icons for the story viewer chrome (handoff 2a–2d: no emoji as
// UI icons). 1.7px strokes on a 24 box, currentColor.
import type { ReactNode } from 'react';

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IcLink = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.5 6.3" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3" />
  </I>
);
export const IcSend = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4.5 11.5 20 4.5l-5 15.5-3.3-6.2L4.5 11.5Z" />
    <path d="M11.7 13.8 20 4.5" />
  </I>
);
export const IcShare = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M12 15V4.5" />
    <path d="m8.5 8 3.5-3.5L15.5 8" />
    <path d="M6 12.5v6a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-6" />
  </I>
);
export const IcBrush = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="m14.5 5.5 4 4L9 19H5v-4l9.5-9.5Z" />
    <path d="m12.5 7.5 4 4" />
  </I>
);
export const IcSticker = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M5 7a2 2 0 0 1 2-2h7l5 5v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z" />
    <path d="M14 5v5h5" />
    <path d="M9 13.5c.8 1 1.8 1.5 3 1.5" />
  </I>
);
export const IcNote = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M6 5.5h12M6 10h12M6 14.5h7" />
    <path d="M6 19h4" />
  </I>
);
export const IcTrash = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M5 7h14M10 7V5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V7M7.5 7l.8 12a1.4 1.4 0 0 0 1.4 1.3h4.6a1.4 1.4 0 0 0 1.4-1.3L16.5 7M10.2 10.5v6M13.8 10.5v6" />
  </I>
);
export const IcEye = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </I>
);
export const IcEdit = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </I>
);
export const IcMore = ({ size }: { size?: number }) => (
  <I size={size}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </I>
);
export const IcClose = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </I>
);
export const IcMic = ({ size }: { size?: number }) => (
  <I size={size}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v2.5" />
  </I>
);
export const IcFlag = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M5 20V4.5h11l-1.5 4 1.5 4H5" />
  </I>
);
export const IcUndo = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M8.5 8H14a4.5 4.5 0 0 1 0 9H9" />
    <path d="m11 4.5-3.5 3.5L11 11.5" />
  </I>
);
export const IcGroup = ({ size }: { size?: number }) => (
  <I size={size}>
    <circle cx="9" cy="9" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="16.5" cy="10" r="2.4" />
    <path d="M15 15.2a4.6 4.6 0 0 1 5.5 3.8" />
  </I>
);
export const IcCheck = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="m5 12.5 4.2 4.2L19 7.5" />
  </I>
);
