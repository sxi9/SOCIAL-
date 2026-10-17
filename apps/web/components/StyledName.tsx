'use client';

// Animated display names (v0.8a — API.md §1.58, FEATURES #75). Render sites
// are pinned by the contract: profile pages, chat headers and group/channel
// sender names — never message bodies, never buttons. Pure CSS text effects;
// 'surprise' resolves deterministically per user per UTC day (lib/names.ts);
// reduced-motion viewers get the static tint via the module's media query.
// Legibility always wins: no size/spacing change, color fallbacks per theme.
import type { NameStyle } from '@socialchat/shared';
import { resolveNameStyle } from '@/lib/names';
import idm from './identity.module.css';

const STYLE_CLASS: Record<string, string> = {
  glow: idm.nameGlow,
  shimmer: idm.nameShimmer,
  rainbow: idm.nameRainbow,
};

export default function StyledName({
  userId,
  style,
  name,
  className,
}: {
  userId: string;
  style: NameStyle;
  name: string;
  className?: string;
}) {
  const resolved = resolveNameStyle(style, userId);
  const fx = resolved === 'none' ? '' : STYLE_CLASS[resolved] ?? '';
  const cls = [className ?? '', fx].filter(Boolean).join(' ');
  return cls ? <span className={cls}>{name}</span> : <>{name}</>;
}
