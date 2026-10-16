'use client';

import { useEffect, useRef } from 'react';
import { decodeBlurhash } from '@/lib/blurhash';

const SIZE = 32;

export default function BlurhashCanvas({ hash, className }: { hash: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pixels = decodeBlurhash(hash, SIZE, SIZE);
    if (!pixels) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(pixels, SIZE, SIZE), 0, 0);
  }, [hash]);

  return <canvas ref={ref} width={SIZE} height={SIZE} className={className} aria-hidden />;
}
