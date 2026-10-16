'use client';

import { useEffect, useRef, useState } from 'react';
import type { Avatar as AvatarDto, AvatarMotion } from '@socialchat/shared';
import { useAppState } from '@/lib/useStore';

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

interface AvatarProps {
  avatar: AvatarDto;
  name: string;
  size?: number;
  /**
   * Rendering contract (ARCHITECTURE §5.4): only profile pages and the open
   * chat header pass animated; lists, bubbles and search stay static.
   */
  animated?: boolean;
}

export default function Avatar({ avatar, name, size = 40, animated = false }: AvatarProps) {
  const state = useAppState();
  const ref = useRef<HTMLSpanElement | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [inView, setInView] = useState(true);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!animated) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [animated]);

  // Off-screen animated avatars pause (swap to the static frame).
  useEffect(() => {
    if (!animated || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) setInView(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [animated]);

  const motion: AvatarMotion = state.me?.avatar_motion ?? 'auto';
  // Gated by prefers-reduced-motion AND avatar_motion; 'reduced' = hover only.
  const motionAllowed = !reducedMotion && motion !== 'off' && (motion === 'auto' || hovered);
  // Render whatever URLs the DTO carries, regardless of status: a failed (or
  // in-flight) transcode KEEPS the previous avatar server-side
  // (ARCHITECTURE §5), so 'failed'/'processing' still carry the last good
  // keys. Only 'none' (no avatar) has null URLs → initial-letter fallback.
  const showAnimated = animated && motionAllowed && inView && avatar.animated_url !== null;
  const src = showAnimated ? avatar.animated_url : avatar.static_url;

  return (
    <span
      ref={ref}
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} draggable={false} />
      ) : (
        <span aria-hidden>{initialOf(name)}</span>
      )}
    </span>
  );
}
