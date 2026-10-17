'use client';

// v0.6.1 overlay portal. Every modal sheet/backdrop renders through this into
// document.body, for two root-cause reasons found in the v0.6 owner test:
//
// 1. position:fixed is relative to the nearest ancestor with a transform,
//    filter or backdrop-filter — NOT the viewport. The blurred `.topbar`
//    (backdrop-filter) is such an ancestor, so sheets opened from topbar
//    buttons (Rescue/SOS, Invite) rendered pinned to the topbar box and
//    clipped off the top of the screen.
// 2. pointer-events is inherited: a sheet mounted inside the `.boredWrap`
//    FAB shell (pointer-events: none) silently ignored every tap, and the
//    FAB wrapper's z-index stacking context put the sheet UNDER the tab bar.
//
// Portaling to <body> opts overlays out of ancestor transforms, filters,
// pointer-events and stacking contexts for good, so the z-index scale in
// globals.css applies as written.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function Portal({ children }: { children: ReactNode }) {
  // Render nothing until mounted — document.body does not exist during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
