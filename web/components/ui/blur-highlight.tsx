'use client';

/**
 * BlurHighlight — a paragraph that blurs into focus when it scrolls into view, then sweeps a
 * highlighter across chosen phrases.
 *
 * Written from scratch for this project. It follows the props documented for React Bits Pro's
 * "Blur Highlight", so it works as a drop-in if you later install the licensed version. There are
 * no dependencies: IntersectionObserver plus CSS transitions, so highlights wrap cleanly across lines.
 */
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type HighlightBit = string | { text: string; /** 1-based: which match to highlight */ occurrence?: number };

export interface BlurHighlightProps {
  children: ReactNode;
  highlightedBits?: HighlightBit[];
  highlightColor?: string;
  highlightClassName?: string;
  blurAmount?: number;
  inactiveOpacity?: number;
  blurDelay?: number;
  blurDuration?: number;
  highlightDelay?: number;
  highlightDuration?: number;
  highlightDirection?: 'left' | 'right' | 'top' | 'bottom';
  viewportOptions?: { once?: boolean; amount?: number };
  /** Extra (not in the original API): seconds between successive highlights. */
  highlightStagger?: number;
  className?: string;
  as?: 'p' | 'div' | 'h1' | 'h2' | 'h3' | 'blockquote';
}

type Range = { start: number; end: number };

function textOf(node: ReactNode): string | null {
  let out = '';
  let ok = true;
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') out += String(child);
    else if (isValidElement<{ children?: ReactNode }>(child) && child.type === 'br') out += '\n';
    else if (child !== null && child !== undefined && typeof child !== 'boolean') ok = false;
  });
  return ok ? out : null;
}

export function findRanges(text: string, bits: HighlightBit[]): Range[] {
  const ranges: Range[] = [];
  for (const bit of bits) {
    const needle = typeof bit === 'string' ? bit : bit.text;
    if (!needle) continue;
    const wanted = typeof bit === 'string' ? null : Math.max(1, bit.occurrence ?? 1);
    let from = 0;
    let n = 0;
    while (true) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      n++;
      if (wanted === null || n === wanted) ranges.push({ start: idx, end: idx + needle.length });
      if (wanted !== null && n >= wanted) break;
      from = idx + needle.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const SIZE: Record<NonNullable<BlurHighlightProps['highlightDirection']>, { from: string; position: string }> = {
  left: { from: '0% 100%', position: 'left center' },
  right: { from: '0% 100%', position: 'right center' },
  top: { from: '100% 0%', position: 'center top' },
  bottom: { from: '100% 0%', position: 'center bottom' },
};

export function BlurHighlight({
  children,
  highlightedBits = [],
  highlightColor = 'hsl(80, 100%, 50%)',
  highlightClassName = '',
  blurAmount = 8,
  inactiveOpacity = 0.3,
  blurDelay = 0,
  blurDuration = 0.8,
  highlightDelay = 0.4,
  highlightDuration = 1,
  highlightDirection = 'left',
  viewportOptions = { once: false, amount: 0.5 },
  highlightStagger = 0,
  className = '',
  as: Tag = 'p',
}: BlurHighlightProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const once = viewportOptions.once ?? false;
  const amount = viewportOptions.amount ?? 0.5;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold: amount, rootMargin: '-20% 0px -20% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [once, amount]);

  const text = textOf(children);
  const segments = useMemo(() => {
    if (text === null) return null;
    const ranges = findRanges(text, highlightedBits);
    const out: { text: string; hl: boolean }[] = [];
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), hl: false });
      out.push({ text: text.slice(r.start, r.end), hl: true });
      cursor = r.end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), hl: false });
    return out;
  }, [text, highlightedBits]);

  const dir = SIZE[highlightDirection];
  const wrapperStyle: CSSProperties = {
    filter: inView ? 'blur(0px)' : `blur(${blurAmount}px)`,
    opacity: inView ? 1 : inactiveOpacity,
    transition: `filter ${blurDuration}s ease-out ${blurDelay}s, opacity ${blurDuration}s ease-out ${blurDelay}s`,
    whiteSpace: 'pre-line',
  };

  let hlIndex = 0;
  return (
    <Tag ref={ref as never} className={cn('blur-highlight', className)} style={wrapperStyle} data-in-view={inView || undefined}>
      {segments
        ? segments.map((seg, i) => {
            if (!seg.hl) return <span key={i}>{seg.text}</span>;
            const delay = blurDelay + highlightDelay + highlightStagger * hlIndex++;
            const style: CSSProperties = {
              backgroundImage: `linear-gradient(${highlightColor}, ${highlightColor})`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: dir.position,
              backgroundSize: inView ? '100% 100%' : dir.from,
              transition: `background-size ${highlightDuration}s cubic-bezier(0.65, 0, 0.35, 1) ${inView ? delay : 0}s`,
              boxDecorationBreak: 'clone',
              WebkitBoxDecorationBreak: 'clone',
            };
            return (
              <mark key={i} className={cn('blur-highlight__mark', highlightClassName)} style={style}>
                {seg.text}
              </mark>
            );
          })
        : children}
    </Tag>
  );
}

export default BlurHighlight;
