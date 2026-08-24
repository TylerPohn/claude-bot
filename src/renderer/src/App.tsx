import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Copy, FolderSearch, RefreshCw, Terminal } from 'lucide-react'

import type { Appearance } from '@shared/types'
import { applyPlatform, titleBarInsetLeft } from '@/lib/platform'
import { bridge, withToast } from '@/lib/ipc'
import { resetBootstrap, useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Kbd } from '@/components/ui/Kbd'
import { useFocusTrap } from '@/components/ui/Modal'
import { ShortcutsDialog } from '@/components/ui/ShortcutsDialog'
import { Skeleton } from '@/components/ui/Skeleton'
import { Toaster } from '@/components/ui/Toaster'
import { Sidebar } from '@/components/sidebar/Sidebar'

import { ChatView } from '@/components/chat/ChatView'
import { DetailsDrawer } from '@/components/details/DetailsDrawer'
import { BotSheet } from '@/components/bots/BotSheet'
import { GroupSheet } from '@/components/groups/GroupSheet'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Onboarding } from '@/components/onboarding/Onboarding'
import { CommandPalette } from '@/components/search/CommandPalette'
import { SearchPalette } from '@/components/search/SearchPalette'
import { EveryoneConfirm } from '@/components/composer/EveryoneConfirm'

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

/**
 * Above this the 320px details panel takes a column of its own beside the
 * transcript; below it, it overlays the transcript instead (see DetailsOverlay).
 *
 * It is a PRESENTATION threshold, never a capability one. It used to gate the
 * only mount of the panel, which made the ⓘ button, ⌘I and View ▸ Toggle Details
 * dead controls at every width below 1180 — including the window's own 900px
 * minimum — while `aria-pressed` still flipped to true, telling a screen-reader
 * user the panel was open when nothing had appeared.
 */
const DETAILS_INLINE_MIN = 1180

export function App(): ReactElement {
  const bootstrap = useAppStore((s) => s.bootstrap)
  const ready = useAppStore((s) => s.ready)
  const bootError = useAppStore((s) => s.bootError)
  const settings = useAppStore((s) => s.settings)
  const runtime = useAppStore((s) => s.runtime)

  const modal = useUiStore((s) => s.modal)
  const palette = useUiStore((s) => s.palette)
  const closeModal = useUiStore((s) => s.closeModal)
  const setPalette = useUiStore((s) => s.setPalette)
  const detailsOpen = useUiStore((s) => s.detailsOpen)
  const viewportWidth = useUiStore((s) => s.viewportWidth)

  /* The sidebar's filter field hands its term to the full-text palette (its
     "Search all messages for …" row), so the palette needs a seed. It lives
     here, not in uiStore, because it is only meaningful while this one mount is
     open: the effect below clears it whenever the palette is not the search
     palette, so ⌘F and the command palette's own entry always open empty. */
  const [searchSeed, setSearchSeed] = useState('')
  useEffect(() => {
    if (palette !== 'search') setSearchSeed('')
  }, [palette])

  const openMessageSearch = useCallback(
    (seed: string) => {
      setSearchSeed(seed)
      setPalette('search')
    },
    [setPalette]
  )

  /* ---- boot -------------------------------------------------------- */

  useEffect(() => {
    // Idempotent: React 19 StrictMode mounts effects twice in development, and
    // the store caches the promise so the second call is a no-op.
    void bootstrap()
  }, [bootstrap])

  // The traffic-light inset is seeded from the Electron user-agent so the first
  // paint is already correct; this confirms it from main and re-renders the tree
  // if the guess was ever wrong.
  const [, setAppVersion] = useState('')
  useEffect(() => {
    void bridge()
      .system.appInfo()
      .then((info) => {
        applyPlatform(info)
        setAppVersion(info.version)
      })
      .catch(() => {
        // The user-agent guess already covers this.
      })
  }, [])

  /* ---- theme ------------------------------------------------------- */

  useEffect(() => {
    const appearance: Appearance = settings?.appearance ?? 'system'
    const query = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const theme = appearance === 'system' ? (query.matches ? 'dark' : 'light') : appearance
      document.documentElement.dataset.theme = theme
    }

    apply()
    // Only follow the OS while the preference actually says "system".
    if (appearance !== 'system') return
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [settings?.appearance])

  /* ---- viewport ---------------------------------------------------- */

  useEffect(() => {
    const setViewportWidth = useUiStore.getState().setViewportWidth
    const onResize = (): void => setViewportWidth(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* ---- global shortcuts (DESIGN §4.8) ------------------------------ *
   * `app:command` and `app:navigate` from the native menu and from
   * notification clicks are reduced in `appStore.bootstrap()`, which owns the
   * single subscription to every main-process event. These are the shortcuts
   * the renderer handles directly.
   * ------------------------------------------------------------------ */

  const nextConversation = useCallback((direction: 1 | -1) => {
    const app = useAppStore.getState()
    const ui = useUiStore.getState()
    const visible = app.conversationOrder.filter((id) => !app.conversations[id]?.hidden)
    if (visible.length === 0) return
    const current = ui.activeConversationId
    const index = current ? visible.indexOf(current) : -1
    const next = visible[(index + direction + visible.length) % visible.length]
    if (!next) return
    ui.setActive(next)
    void app.loadMessages(next)
    void app.markRead(next)
  }, [])

  const jumpToIndex = useCallback((position: number) => {
    const app = useAppStore.getState()
    const ui = useUiStore.getState()
    const visible = app.conversationOrder.filter((id) => !app.conversations[id]?.hidden)
    const id = visible[position]
    if (!id) return
    ui.setActive(id)
    void app.loadMessages(id)
    void app.markRead(id)
  }, [])

  useHotkeys({
    'mod+n': () => useUiStore.getState().openModal({ kind: 'bot' }),
    'mod+shift+n': () => useUiStore.getState().openModal({ kind: 'group' }),
    'mod+k': () => setPalette('command'),
    'mod+f': () => setPalette('search'),
    'mod+,': () => useUiStore.getState().openModal({ kind: 'settings', tab: 'general' }),
    // Duplicated by Help ▸ Keyboard Shortcuts, exactly as ⌘K and ⌘, are: the
    // native accelerator wins when the menu is installed, and this is the
    // fallback for any window that has no menu.
    'mod+/': () => useUiStore.getState().openModal({ kind: 'shortcuts' }),
    'mod+b': () => useUiStore.getState().toggleSidebar(),
    'mod+i': () => useUiStore.getState().toggleDetails(),
    'mod+shift+u': () => {
      const id = useUiStore.getState().activeConversationId
      if (id) void useAppStore.getState().markRead(id)
    },
    'ctrl+tab': (e) => {
      e.preventDefault()
      nextConversation(1)
    },
    'ctrl+shift+tab': (e) => {
      e.preventDefault()
      nextConversation(-1)
    },
    'mod+1': () => jumpToIndex(0),
    'mod+2': () => jumpToIndex(1),
    'mod+3': () => jumpToIndex(2),
    'mod+4': () => jumpToIndex(3),
    'mod+5': () => jumpToIndex(4),
    'mod+6': () => jumpToIndex(5),
    'mod+7': () => jumpToIndex(6),
    'mod+8': () => jumpToIndex(7),
    'mod+9': () => jumpToIndex(8),
    escape: () => {
      // Overlay first, then the dialog layer. Modal owns its own Esc via the
      // focus trap (captured on document), so this only ever sees the palette.
      const ui = useUiStore.getState()
      if (ui.palette) ui.setPalette(null)
    }
  })

  /* ---- gates -------------------------------------------------------- */

  if (!ready) return <BootScreen />
  if (bootError) return <BootErrorScreen message={bootError} />

  const onboarding = settings ? !settings.onboardingCompleted : false
  if (onboarding || modal?.kind === 'onboarding') {
    return (
      <Onboarding
        onDone={() => {
          void useAppStore.getState().updateSettings({ onboardingCompleted: true })
          if (modal?.kind === 'onboarding') closeModal()
        }}
      />
    )
  }

  const runtimeBlocked =
    runtime !== null && runtime.availability !== 'ok' && runtime.availability !== 'checking'

  if (runtimeBlocked) return <RuntimeGate />

  // The panel mounts whenever it is open; only HOW it is presented depends on
  // the width, so every entry point works at every supported window size.
  const detailsInline = viewportWidth >= DETAILS_INLINE_MIN

  return (
    <div className="flex h-full w-full overflow-hidden" style={{ background: 'var(--bg-app)' }}>
      {/* Each column owns its own 56px `.drag` strip (the sidebar header, the
          chat header, the details header). A single app-wide drag strip cannot
          work: a drag region swallows every pointer event beneath it. */}
      <Sidebar onSearchMessages={openMessageSearch} />

      <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--surface-0)' }}>
        <ChatView />
      </main>

      {detailsOpen && detailsInline ? <DetailsDrawer /> : null}
      {detailsOpen && !detailsInline ? <DetailsOverlay /> : null}

      <Toaster />
      <ConfirmDialog />
      <ShortcutsDialog />

      {modal?.kind === 'bot' ? (
        <BotSheet botId={modal.botId} presetId={modal.preset} onClose={closeModal} />
      ) : null}
      {modal?.kind === 'group' ? (
        <GroupSheet conversationId={modal.conversationId} onClose={closeModal} />
      ) : null}
      {modal?.kind === 'settings' ? (
        <SettingsModal tab={modal.tab} onClose={closeModal} />
      ) : null}
      {modal?.kind === 'everyone' ? (
        <EveryoneConfirm input={modal.input} botCount={modal.botCount} onClose={closeModal} />
      ) : null}

      {palette === 'command' ? <CommandPalette onClose={() => setPalette(null)} /> : null}
      {palette === 'search' ? (
        <SearchPalette initialQuery={searchSeed} onClose={() => setPalette(null)} />
      ) : null}
    </div>
  )
}

/**
 * The details panel below `DETAILS_INLINE_MIN`, presented as a right-anchored
 * overlay above the transcript.
 *
 * The panel is only 320px, so it fits over the 900px minimum window — what it
 * cannot do at that width is take a column of its own without squeezing the
 * transcript below a readable measure. Overlaying keeps the control alive at
 * every size, which is the whole point: it is a real panel with editable
 * members, model and permission preferences, workspace and session controls and
 * a destructive delete, none of which survive being demoted to a native menu.
 *
 * Modal semantics (scrim, Esc, focus containment) because it covers the content
 * it describes. `--z-overlay` keeps it under popovers, the palette and dialogs —
 * "Edit" opens a sheet that must land on top of this.
 */
function DetailsOverlay(): ReactElement {
  const setDetailsOpen = useUiStore((s) => s.setDetailsOpen)
  const close = useCallback(() => setDetailsOpen(false), [setDetailsOpen])
  const panelRef = useRef<HTMLDivElement>(null)

  // Also owns Escape: the trap listens in the capture phase and stops the event,
  // so the app-level Escape hotkey never sees it.
  useFocusTrap(panelRef, true, close)

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 'var(--z-overlay)' }} role="presentation">
      <div
        aria-hidden
        onMouseDown={close}
        className="absolute inset-0"
        style={{
          background: 'var(--overlay)',
          animation: 'scrim-in var(--dur-base) var(--ease-out-quad)'
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Conversation details"
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex outline-none"
        style={{ boxShadow: 'var(--shadow-dialog)' }}
      >
        <DetailsDrawer />
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/** The window's own draggable strip, used by every full-window state. */
function DragStrip(): ReactElement {
  return <div className="drag shrink-0" style={{ height: 'var(--header-h)' }} />
}

/**
 * The boot skeleton mirrors the real three-zone layout, so the app does not
 * visibly re-flow when the data lands. Skeletons are delayed 250ms internally —
 * a fast boot shows nothing at all rather than a flash.
 */
function BootScreen(): ReactElement {
  return (
    <div className="flex h-full w-full" style={{ background: 'var(--bg-app)' }}>
      <div
        className="flex h-full flex-col"
        style={{
          width: 'var(--sidebar-w)',
          background: 'var(--surface-1)',
          borderRight: '1px solid var(--border-1)'
        }}
      >
        <div className="drag" style={{ height: 'var(--header-h)', paddingLeft: titleBarInsetLeft() }} />
        <div style={{ padding: '4px 16px' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-[10px]" style={{ height: 60 }}>
              <Skeleton width={40} height={40} radius="var(--r-full)" index={i} />
              <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 6 }}>
                <Skeleton width={`${52 + ((i * 13) % 30)}%`} height={11} index={i} />
                <Skeleton width={`${68 + ((i * 7) % 24)}%`} height={9} index={i} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1" style={{ background: 'var(--surface-0)' }}>
        <DragStrip />
      </div>
    </div>
  )
}

function BootErrorScreen({ message }: { message: string }): ReactElement {
  const [retrying, setRetrying] = useState(false)
  return (
    <FullWindow>
      <Panel
        icon={<AlertTriangle size={24} strokeWidth={1.5} style={{ color: 'var(--fg-danger)' }} />}
        title="Claude Bot could not start"
        body="Your Bots and transcripts are stored locally and were not touched. Restarting usually clears this."
        detail={message}
      >
        <Button
          variant="filled"
          loading={retrying}
          leading={<RefreshCw size={16} strokeWidth={1.75} />}
          onClick={() => {
            setRetrying(true)
            resetBootstrap()
            void useAppStore.getState().bootstrap()
          }}
        >
          Try again
        </Button>
      </Panel>
    </FullWindow>
  )
}

/* ------------------------------------------------------------------ *
 * Runtime remediation
 * ------------------------------------------------------------------ */

/**
 * Claude Bot is a client for the Claude Code the user already has. If that
 * is missing or signed out, nothing in the app can run, so this replaces the
 * whole window with the specific fix — never a generic error.
 */
function RuntimeGate(): ReactElement {
  const runtime = useAppStore((s) => s.runtime)
  const recheckRuntime = useAppStore((s) => s.recheckRuntime)
  const [checking, setChecking] = useState(false)

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      await recheckRuntime()
    } finally {
      setChecking(false)
    }
  }, [recheckRuntime])

  const availability = runtime?.availability ?? 'missing'

  const copy =
    availability === 'unauthenticated'
      ? {
          title: 'Claude Code isn’t signed in',
          body: 'Run `claude` once in a terminal and finish signing in. Claude Bot uses your existing Claude subscription — there is no separate API key to enter.'
        }
      : availability === 'error'
        ? {
            title: 'Claude Code could not be started',
            body: 'The executable was found but did not respond to a version check. Check that it runs in your terminal, then recheck.'
          }
        : {
            title: 'Claude Code isn’t installed',
            body: 'Claude Bot runs your locally installed Claude Code. Install it, sign in once, then come back — everything else is already set up.'
          }

  return (
    <FullWindow>
      <Panel
        icon={<Terminal size={24} strokeWidth={1.5} style={{ color: 'var(--fg-warning)' }} />}
        title={copy.title}
        body={copy.body}
        detail={runtime?.detail ?? null}
      >
        {availability === 'missing' ? (
          <div
            className="selectable mb-[16px] flex w-full items-center gap-[10px]"
            style={{
              padding: '10px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 'var(--r-4)'
            }}
          >
            <code
              className="min-w-0 flex-1 truncate text-left text-[var(--fg-primary)]"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-code)' }}
            >
              {INSTALL_COMMAND}
            </code>
            <Button
              size="sm"
              variant="ghost"
              leading={<Copy size={14} strokeWidth={1.75} />}
              onClick={() => {
                void withToast(() => bridge().system.copyText(INSTALL_COMMAND), {
                  successTitle: 'Command copied'
                })
              }}
            >
              Copy
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-[8px]">
          <Button
            variant="filled"
            leading={<Terminal size={16} strokeWidth={1.75} />}
            onClick={() => {
              void withToast(() => bridge().runtime.openLoginTerminal(), {
                errorTitle: 'Could not open a terminal'
              })
            }}
          >
            {availability === 'unauthenticated' ? 'Open Terminal to sign in' : 'Open Terminal'}
          </Button>
          <Button
            loading={checking}
            leading={<RefreshCw size={16} strokeWidth={1.75} />}
            onClick={() => void recheck()}
          >
            Recheck
          </Button>
          <Button
            variant="ghost"
            leading={<FolderSearch size={16} strokeWidth={1.75} />}
            onClick={() => {
              void withToast(
                async () => {
                  const picked = await bridge().runtime.pickExecutable()
                  if (picked.path) await useAppStore.getState().recheckRuntime()
                  return picked
                },
                { errorTitle: 'Could not use that executable' }
              )
            }}
          >
            Choose executable…
          </Button>
        </div>

        {runtime?.executablePath ? (
          <p
            className="selectable mt-[16px] truncate text-[var(--fg-tertiary)]"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', maxWidth: 460 }}
            title={runtime.executablePath}
          >
            {runtime.executablePath}
            {runtime.version ? ` · v${runtime.version}` : ''}
          </p>
        ) : null}
      </Panel>
      <Toaster />
    </FullWindow>
  )
}

/* ------------------------------------------------------------------ *
 * Shared full-window chrome
 * ------------------------------------------------------------------ */

function FullWindow({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-app)' }}>
      <DragStrip />
      <div className="flex min-h-0 flex-1 items-center justify-center" style={{ padding: 24 }}>
        {children}
      </div>
    </div>
  )
}

function Panel({
  icon,
  title,
  body,
  detail,
  children
}: {
  icon: ReactElement
  title: string
  body: string
  detail?: string | null
  children?: ReactNode
}): ReactElement {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div
      className="flex flex-col items-center text-center"
      style={{ maxWidth: 520, marginTop: -40 }}
    >
      <span
        className="mb-[16px] grid place-items-center"
        style={{ width: 56, height: 56, borderRadius: 'var(--r-6)', background: 'var(--surface-2)' }}
      >
        {icon}
      </span>
      <h1
        className="text-[var(--fg-primary)]"
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550
        }}
      >
        {title}
      </h1>
      <p
        className="mt-[8px] mb-[20px] text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-ui)', lineHeight: 'var(--lh-ui)' }}
      >
        {body}
      </p>
      {children}
      {detail ? (
        <div className="mt-[20px] flex w-full flex-col items-center">
          <button
            type="button"
            onClick={() => setShowDetail((open) => !open)}
            className="text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]"
            style={{ fontSize: 'var(--fs-meta)' }}
          >
            {showDetail ? 'Hide details' : 'Show details'}
          </button>
          {showDetail ? (
            <pre
              className="selectable scroller mt-[10px] w-full overflow-auto text-left text-[var(--fg-tertiary)]"
              style={{
                maxHeight: 160,
                padding: 12,
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-4)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-micro)',
                whiteSpace: 'pre-wrap'
              }}
            >
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}
      <p
        className="mt-[24px] flex items-center gap-[6px] text-[var(--fg-quaternary)]"
        style={{ fontSize: 'var(--fs-micro)' }}
      >
        Settings <Kbd keys="mod+," />
      </p>
    </div>
  )
}
