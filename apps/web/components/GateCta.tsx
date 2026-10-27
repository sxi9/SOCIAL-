'use client';

// The gated CTA on a share page (Slice E). Renders a real link to the
// `/register?next=` fallback — crawlers, no-JS and middle-clicks keep the
// redirect form — and, on a plain click, opens the inline sign-in sheet
// over the page instead (AUDIT-PLAN §1b "inline sign-in on share pages").
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import InlineSignInSheet from './InlineSignInSheet';

export default function GateCta({
  next,
  fallback,
  word,
  className,
  children,
}: {
  /** Where sign-in lands: the object route (or this page for groups). */
  next: string;
  /** The redirect-form href (`/register?next=…`). */
  fallback: string;
  /** What the gate protects, for the sheet title. */
  word: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  function close(): void {
    setOpen(false);
    anchorRef.current?.focus(); // the dialog returns focus to its trigger
  }
  function onClick(e: MouseEvent<HTMLAnchorElement>): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setOpen(true);
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
