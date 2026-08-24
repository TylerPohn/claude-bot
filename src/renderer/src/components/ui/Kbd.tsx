import type { ReactElement } from 'react'

import { cn } from '@/lib/cn'
import { isMac } from '@/lib/platform'

const GLYPH: Record<string, string> = {
  mod: '⌘',
  cmd: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  control: '⌃',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  enter: '↵',
  return: '↵',
  escape: 'Esc',
  esc: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space'
}

const WINDOWS_GLYPH: Record<string, string> = {
  mod: 'Ctrl',
  cmd: 'Ctrl',
  meta: 'Ctrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  tab: 'Tab'
}

function render(key: string): string {
  const lower = key.toLowerCase()
  if (isMac()) return GLYPH[lower] ?? (key.length === 1 ? key.toUpperCase() : key)
  return WINDOWS_GLYPH[lower] ?? GLYPH[lower] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/**
 * Shortcut chips (DESIGN §3.11). The root is transparent and borderless; each
 * KEY is the chip. `mod` renders as ⌘ on macOS and Ctrl elsewhere.
 */
export function Kbd({
  keys,
  size = 'sm',
  className
}: {
  /** `'mod+k'` or `['mod', 'k']`. */
  keys: string | string[]
  size?: 'sm' | 'md'
  className?: string
}): ReactElement {
  const parts = (typeof keys === 'string' ? keys.split('+') : keys).map((k) => k.trim())
  const dimension = size === 'sm' ? 16 : 20

  return (
    <kbd className={cn('inline-flex items-center', className)} style={{ fontFamily: 'inherit' }}>
      {parts.map((part, index) => (
        <span
          key={`${part}-${index}`}
          className="inline-flex items-center justify-center"
          style={{
            minWidth: dimension,
            minHeight: dimension,
            marginLeft: index === 0 ? 0 : 4,
            padding: '0 4px',
            borderRadius: 'var(--r-2)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-1)',
            color: 'var(--fg-secondary)',
            fontSize: size === 'sm' ? 'var(--fs-nano)' : 'var(--fs-meta)',
            fontWeight: 550,
            lineHeight: 1
          }}
        >
          {render(part)}
        </span>
      ))}
    </kbd>
  )
}
