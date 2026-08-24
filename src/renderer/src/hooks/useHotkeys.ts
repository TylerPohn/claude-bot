import { useEffect, useRef } from 'react'

import { isMac } from '@/lib/platform'

/**
 * Global keyboard shortcuts (DESIGN §4.8).
 *
 * Combos are written as `'mod+k'`, `'mod+shift+n'`, `'escape'`, `'mod+.'`,
 * `'ctrl+tab'`, `'mod+1'`. `mod` is ⌘ on macOS and Ctrl elsewhere; `ctrl` always
 * means the physical Control key (so `Ctrl+Tab` still works on a Mac).
 *
 * A shortcut WITHOUT a modifier never fires while the user is typing — otherwise
 * `j` and `k` would eat every j and k in the composer. A shortcut WITH a modifier
 * always fires, because ⌘K has no meaning inside a text field.
 */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>

interface Combo {
  key: string
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  bare: boolean
}

const ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  plus: '+',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  backspace: 'backspace'
}

function parse(spec: string): Combo {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)

  // `mod+.` and `mod++` split into an empty tail; recover the literal key.
  const raw = spec.trim().toLowerCase()
  if (raw.endsWith('++')) parts.push('+')

  const combo: Combo = { key: '', mod: false, ctrl: false, shift: false, alt: false, bare: false }
  for (const part of parts) {
    if (part === 'mod' || part === 'cmdorctrl') combo.mod = true
    else if (part === 'ctrl' || part === 'control') combo.ctrl = true
    else if (part === 'shift') combo.shift = true
    else if (part === 'alt' || part === 'option') combo.alt = true
    else if (part === 'cmd' || part === 'meta' || part === 'command') combo.mod = true
    else combo.key = ALIASES[part] ?? part
  }
  combo.bare = !combo.mod && !combo.ctrl && !combo.alt
  return combo
}

function matches(combo: Combo, e: KeyboardEvent): boolean {
  // `mod` maps to ⌘ on macOS and to Ctrl elsewhere; `ctrl` always means the
  // physical Control key. Resolving both into the two real modifier booleans
  // first is what keeps `ctrl+tab` working on a Mac and `mod+k` working on
  // Windows without a special case per combo.
  const wantMeta = isMac() ? combo.mod : false
  const wantCtrl = combo.ctrl || (!isMac() && combo.mod)

  if (e.metaKey !== wantMeta) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (combo.shift !== e.shiftKey) return false
  if (combo.alt !== e.altKey) return false

  const key = e.key.toLowerCase()
  if (key === combo.key) return true
  // ⌥ and some layouts rewrite `e.key`; compare physical codes for letters and
  // digits so the keyboard layout never changes which shortcut fires.
  if (combo.key.length === 1) {
    if (/[a-z]/.test(combo.key) && e.code === `Key${combo.key.toUpperCase()}`) return true
    if (/[0-9]/.test(combo.key) && e.code === `Digit${combo.key}`) return true
  }
  return false
}

/** Parsing is pure and the same dozen specs recur on every keystroke. */
const comboCache = new Map<string, Combo>()

function parseCached(spec: string): Combo {
  let combo = comboCache.get(spec)
  if (!combo) {
    combo = parse(spec)
    comboCache.set(spec, combo)
  }
  return combo
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.getAttribute('role') === 'textbox'
  )
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      // A composition (IME) in flight must never be interrupted by a shortcut.
      if (e.isComposing || e.keyCode === 229) return

      const typing = isTypingTarget(e.target)
      const entries = Object.entries(mapRef.current)
      for (const [spec, handler] of entries) {
        const combo = parseCached(spec)
        if (!matches(combo, e)) continue
        // Escape is the one bare key that must work from inside a field.
        if (typing && combo.bare && combo.key !== 'escape') continue
        handler(e)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
