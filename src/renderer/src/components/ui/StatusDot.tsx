import type { CSSProperties, ReactElement } from 'react'

import { cn } from '@/lib/cn'

export type StatusState = 'idle' | 'unread' | 'attention' | 'working' | 'queued' | 'error'

/**
 * The attention indicator (DESIGN §3.4). The three product states are visually
 * DISTINCT and must never be collapsed into one dot:
 *
 *   needs-attention → solar `#FF640A` with a 2px ring in the row's own colour,
 *                     so it reads as a raised marker rather than a flat dot;
 *   unread          → a solid `--fg-primary` dot (the row title also promotes
 *                     to weight 590, which carries more signal than the dot);
 *   working         → a hollow accent ring — the row's avatar carries the
 *                     pulsing ring and the preview carries the shimmer phase, so
 *                     this dot stays quiet to keep one motion element per row.
 */
export interface StatusDotProps {
  state: StatusState
  size?: number
  /** Colour behind the dot, used for the separator ring. */
  ringColor?: string
  /**
   * Force the separator ring on the states that normally go without it. Needed
   * when the dot is a badge sitting ON an avatar (the pinned strip, the collapsed
   * rail) rather than on the row ground: a solid --fg-primary dot would otherwise
   * merge into a light blob in light theme and a dark one in dark theme, and the
   * hollow states would read as part of the artwork underneath. Off by default —
   * inline in a row the ring is either invisible or, on a hovered row whose
   * ground has shifted, a visible halo in the wrong colour.
   */
  ring?: boolean
  className?: string
  title?: string
}

export function StatusDot({
  state,
  size = 8,
  ringColor = 'var(--surface-1)',
  ring = false,
  className,
  title
}: StatusDotProps): ReactElement | null {
  if (state === 'idle') return null

  const base: CSSProperties = { width: size, height: size, borderRadius: '50%' }
  const separator = `0 0 0 2px ${ringColor}`
  const style: CSSProperties =
    state === 'attention'
      ? { ...base, background: 'var(--attention)', boxShadow: separator }
      : state === 'unread'
        ? { ...base, background: 'var(--fg-primary)', boxShadow: ring ? separator : undefined }
        : state === 'working'
          ? {
              ...base,
              background: 'transparent',
              border: '2px solid var(--accent)',
              boxShadow: ring ? separator : undefined
            }
          : state === 'queued'
            ? {
                ...base,
                background: 'transparent',
                border: '2px solid var(--fg-quaternary)',
                boxShadow: ring ? separator : undefined
              }
            : { ...base, background: 'var(--fg-danger)', boxShadow: ring ? separator : undefined }

  const label =
    title ??
    (state === 'attention'
      ? 'Needs attention'
      : state === 'unread'
        ? 'Unread activity'
        : state === 'working'
          ? 'Working'
          : state === 'queued'
            ? 'Queued'
            : 'Failed')

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('block shrink-0', className)}
      style={style}
    />
  )
}
