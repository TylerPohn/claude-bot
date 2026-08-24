import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Database, Info, SlidersHorizontal, Terminal, X } from 'lucide-react'

import { cn } from '@/lib/cn'
import { useAppStore } from '@/stores/appStore'
import { IconButton } from '@/components/ui/IconButton'
import { useFocusTrap } from '@/components/ui/Modal'
import { GeneralTab } from './GeneralTab'
import { ClaudeTab } from './ClaudeTab'
import { BotsTab } from './BotsTab'
import { DataTab } from './DataTab'
import { AboutTab } from './AboutTab'

/* ------------------------------------------------------------------ *
 * Font scale
 *
 * Nothing else in the renderer applies `settings.fontScale` — App.tsx stamps
 * the theme and stops there. This module is imported statically by App.tsx, so
 * a module-scope subscription applies the user's scale from the first frame
 * after bootstrap rather than only while this dialog happens to be open.
 *
 * Only the type tokens are scaled, never a root `zoom`: the macOS traffic
 * lights are drawn by the OS at a fixed size, and zooming the document would
 * slide the whole window chrome out from under them.
 * ------------------------------------------------------------------ */

const TYPE_TOKENS: Array<[size: string, sizePx: number, lineHeight: string, lineHeightPx: number]> =
  [
    ['--fs-nano', 10, '--lh-nano', 14],
    ['--fs-micro', 12, '--lh-micro', 16],
    ['--fs-meta', 13, '--lh-meta', 18],
    ['--fs-chrome', 14, '--lh-chrome', 20],
    ['--fs-ui', 15, '--lh-ui', 22],
    ['--fs-title', 16, '--lh-title', 22],
    ['--fs-h1', 20, '--lh-h1', 26],
    ['--fs-hero', 28, '--lh-hero', 34],
    ['--fs-code', 13, '--lh-code', 20]
  ]

export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.3

function applyFontScale(scale: number): void {
  const root = document.documentElement
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
  for (const [sizeVar, sizePx, lineVar, linePx] of TYPE_TOKENS) {
    if (clamped === 1) {
      // Remove rather than write 1× values, so tokens.css stays the single
      // source of truth whenever the user is at the default.
      root.style.removeProperty(sizeVar)
      root.style.removeProperty(lineVar)
      continue
    }
    root.style.setProperty(sizeVar, `${Math.round(sizePx * clamped * 10) / 10}px`)
    root.style.setProperty(lineVar, `${Math.round(linePx * clamped * 10) / 10}px`)
  }
}

let appliedScale = 1
useAppStore.subscribe((state) => {
  const next = state.settings?.fontScale ?? 1
  if (next === appliedScale) return
  appliedScale = next
  applyFontScale(next)
})

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const TABS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'claude', label: 'Claude Code', icon: Terminal },
  { id: 'bots', label: 'Bots', icon: Bot },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'about', label: 'About', icon: Info }
] as const

type TabId = (typeof TABS)[number]['id']

function normalizeTab(value: string | undefined): TabId {
  return TABS.some((t) => t.id === value) ? (value as TabId) : 'general'
}

export function SettingsModal({
  tab,
  onClose
}: {
  tab?: string
  onClose: () => void
}): ReactElement {
  const [active, setActive] = useState<TabId>(() => normalizeTab(tab))
  const panelRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)

  // Reopening from a different entry point (a toast's "Open settings", the app
  // menu) must land on the tab that entry point asked for.
  useEffect(() => {
    setActive(normalizeTab(tab))
  }, [tab])

  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, true, close)

  /** ↑/↓/Home/End move between tabs, which is what a real tablist does. */
  const onNavKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const index = TABS.findIndex((t) => t.id === active)
      let next = -1
      if (event.key === 'ArrowDown') next = (index + 1) % TABS.length
      else if (event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = TABS.length - 1
      if (next === -1) return
      event.preventDefault()
      const target = TABS[next]
      if (!target) return
      setActive(target.id)
      navRef.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus()
    },
    [active]
  )

  const activeLabel = useMemo(
    () => TABS.find((t) => t.id === active)?.label ?? 'General',
    [active]
  )

  return createPortal(
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ zIndex: 'var(--z-dialog)' }}
      role="presentation"
    >
      <div
        aria-hidden
        onMouseDown={close}
        className="absolute inset-0"
        style={{
          background: 'var(--overlay)',
          zIndex: 'var(--z-dialog-scrim)',
          animation: 'scrim-in var(--dur-base) var(--ease-out-quad)'
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Claude Code Bots settings"
        tabIndex={-1}
        className="relative flex overflow-hidden outline-none"
        style={{
          // DESIGN §3.8: 880 × 620, radius 12, five-layer dialog shadow.
          width: 'min(880px, calc(100vw - 48px))',
          height: 'min(620px, calc(100vh - 64px))',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--r-popover)',
          boxShadow: 'var(--shadow-dialog)',
          zIndex: 'var(--z-dialog)',
          animation: 'dialog-in var(--dur-base) var(--ease-out-quad)'
        }}
      >
        {/* ---- nav rail ------------------------------------------------ */}
        <div
          className="flex shrink-0 flex-col"
          style={{
            width: 200,
            background: 'var(--surface-1)',
            borderRight: '1px solid var(--border-1)'
          }}
        >
          <div
            className="flex shrink-0 flex-col justify-center"
            style={{ height: 56, padding: '0 12px' }}
          >
            <span
              className="text-[var(--fg-tertiary)]"
              style={{
                fontSize: 'var(--fs-nano)',
                lineHeight: 'var(--lh-nano)',
                letterSpacing: 'var(--ls-nano)',
                fontWeight: 510,
                textTransform: 'uppercase'
              }}
            >
              Claude Code Bots
            </span>
            <span
              className="text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-title)',
                lineHeight: 'var(--lh-title)',
                letterSpacing: 'var(--ls-title)',
                fontWeight: 550
              }}
            >
              Settings
            </span>
          </div>

          <div
            ref={navRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onNavKeyDown}
            className="flex flex-col"
            style={{ padding: '4px 8px', gap: 1 }}
          >
            {TABS.map(({ id, label, icon: Icon }) => {
              const selected = id === active
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  data-tab={id}
                  data-selected={selected}
                  {...(selected ? { 'data-autofocus': true } : {})}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${id}`}
                  // Roving tabindex: one stop for the whole rail, then arrows.
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(id)}
                  className={cn(
                    'row-pill flex w-full items-center gap-[8px] text-left',
                    selected ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-secondary)]',
                    'transition-[color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:text-[var(--fg-primary)]'
                  )}
                  style={{
                    height: 32,
                    padding: '0 8px',
                    borderRadius: 'var(--r-3)',
                    fontSize: 'var(--fs-chrome)',
                    letterSpacing: 'var(--ls-chrome)',
                    fontWeight: selected ? 550 : 510
                  }}
                >
                  <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              )
            })}
          </div>

          <div className="flex-1" />

          {/* Grounding line: the whole product is a client for a local install,
              and this is the screen where that fact matters most. */}
          <p
            className="text-[var(--fg-quaternary)]"
            style={{
              padding: '0 12px 14px',
              fontSize: 'var(--fs-micro)',
              lineHeight: 'var(--lh-micro)',
              letterSpacing: 'var(--ls-micro)'
            }}
          >
            Runs on your own Claude Code. No separate API key.
          </p>
        </div>

        {/* ---- content ------------------------------------------------- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="flex shrink-0 items-center gap-[12px]"
            style={{ height: 56, padding: '0 12px 0 24px' }}
          >
            <h2
              className="min-w-0 flex-1 truncate text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-title)',
                lineHeight: 'var(--lh-title)',
                letterSpacing: 'var(--ls-title)',
                fontWeight: 550
              }}
            >
              {activeLabel}
            </h2>
            <IconButton label="Close settings" onClick={close}>
              <X size={18} strokeWidth={1.75} />
            </IconButton>
          </header>

          <div
            role="tabpanel"
            id={`settings-panel-${active}`}
            aria-labelledby={`settings-tab-${active}`}
            className={cn(
              'min-h-0 flex-1',
              // The Bots tab embeds a full list view that owns its own scroller.
              active === 'bots' ? 'flex flex-col overflow-hidden' : 'scroller overflow-y-auto'
            )}
            style={active === 'bots' ? undefined : { padding: '4px 24px 24px' }}
          >
            {settings === null ? null : active === 'general' ? (
              <GeneralTab settings={settings} />
            ) : active === 'claude' ? (
              <ClaudeTab settings={settings} />
            ) : active === 'bots' ? (
              <BotsTab />
            ) : active === 'data' ? (
              <DataTab />
            ) : (
              <AboutTab />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
