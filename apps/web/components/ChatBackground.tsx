'use client';

// GIF/video chat background (v0.8a — API.md §1.60, FEATURES #79). PERSONAL:
// prefs.background is my own upload, resolved for me alone — nobody else ever
// learns it exists. Render contract (binding): painted behind the chat scroll
// under a theme-aware scrim (CHAT_BG_OVERLAY_OPACITY) so bubbles stay
// legible; video/GIF muted, looped, playsInline, never audible; PAUSED when
// off-screen (IntersectionObserver + document hidden) and when the battery
// runs low (the Battery Status API has no explicit saver flag — low-and-
// discharging is the closest honest signal); prefers-reduced-motion renders
// the static poster (thumb_url) instead — no playback, no first loop, ever.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CHAT_BG_OVERLAY_OPACITY, type Attachment } from '@socialchat/shared';
import { useReducedMotion } from '@/lib/useReducedMotion';
import idm from './identity.module.css';

interface BatteryLike {
  level: number;
  charging: boolean;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
}

export default function ChatBackground({ attachment }: { attachment: Attachment }) {
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [inView, setInView] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [lowBattery, setLowBattery] = useState(false);

  // Off-screen → paused (the chat behind another pane, a backgrounded tab…).
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setInView(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState !== 'visible');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Battery guard, where the API exists (Chromium): low and discharging.
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (!nav.getBattery) return;
    let battery: BatteryLike | null = null;
    let cancelled = false;
    const update = () => {
      if (battery) setLowBattery(!battery.charging && battery.level <= 0.2);
    };
    void nav
      .getBattery()
      .then((b) => {
        if (cancelled) return;
        battery = b;
        update();
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (battery) {
        battery.removeEventListener('levelchange', update);
        battery.removeEventListener('chargingchange', update);
      }
    };
  }, []);

  const playing = inView && !hidden && !reduced && !lowBattery;

  // Drive the <video> element — pause() keeps the current frame on screen.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, attachment.id]);

  const poster = attachment.thumb_url;
  const isVideo = attachment.kind === 'video';

  let media: ReactNode;
  if (reduced) {
    // Reduced motion: the static poster, full stop (§1.60).
    media = poster ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={poster} alt="" />
    ) : null;
  } else if (isVideo) {
    media = (
      <video
        ref={videoRef}
        src={attachment.url}
        poster={poster ?? undefined}
        muted
        loop
        playsInline
        autoPlay
        preload="metadata"
      />
    );
  } else {
    // image/GIF: the file animates natively; off-screen/low battery swaps to
    // the still poster so the decoder rests.
    const src = playing ? attachment.url : poster ?? attachment.url;
    // eslint-disable-next-line @next/next/no-img-element
    media = <img src={src} alt="" />;
  }

  return (
    <div ref={wrapRef} className={idm.chatBg} aria-hidden>
      {media}
      {/* Theme-aware scrim: bubbles keep their own opaque surfaces on top. */}
      <div className={idm.chatBgScrim} style={{ opacity: CHAT_BG_OVERLAY_OPACITY }} />
    </div>
  );
}
