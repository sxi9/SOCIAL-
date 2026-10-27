'use client';

// The gated CTA on a share page (Slice E). Renders a real link to the
// `/register?next=` fallback — crawlers, no-JS and middle-clicks keep the
// redirect form — and, on a plain click, opens the inline sign-in sheet
// over the page instead (AUDIT-PLAN §1b "inline sign-in on share pages").
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { probeMe } from '@/lib/shareAuth';
import InlineSignInSheet from './InlineSignInSheet';

export default function GateCta({
  next,
  fallback,
  word,
  className,
  children,
  autoOpen = false,
}: {
  /** Where sign-in lands: the object route (or this page for groups). */
  next: string;
  /** The redirect-form href (`/register?next=…`). */
  fallback: string;
  /** What the gate protects, for the sheet title. */
  word: string;
  className?: string;
  children: ReactNode;
  /** Open the sheet on mount — a click that landed while the host island
   * was still finding out whether anyone is signed in. */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  function close(): void {
    setOpen(false);
    anchorRef.current?.focus(); // the dialog returns focus to its trigger
  }
  const probing = useRef(false);
  function onClick(e: MouseEvent<HTMLAnchorElement>): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (probing.current) return;
    probing.current = true;
    // Phase 2: someone already signed in (a share link opened in the app's
    // own browser) needs no sheet — straight to the object.
    void probeMe().then((me) => {
      probing.current = false;
      if (me) window.location.assign(next);
      else setOpen(true);
    });
  }
  return (
    <>
      <a ref={anchorRef} href={fallback} className={className} onClick={onClick}>
        {children}
      </a>
      {open ? <InlineSignInSheet next={next} word={word} onClose={close} /> : null}
    </>
  );
}
