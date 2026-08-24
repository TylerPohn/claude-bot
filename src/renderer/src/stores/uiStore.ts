import { create } from 'zustand'

import type { AttachmentInput, SendMessageInput } from '@shared/schemas'

/**
 * Transient UI state: what is open, what is selected, what the user has typed but
 * not sent. Nothing here is authoritative — the app store owns server-ish data.
 *
 * A hand-rolled `localStorage` slice is used instead of zustand's `persist`
 * middleware so that (a) exactly the fields marked "persist" in the renderer
 * contract are written, (b) a corrupt or older payload degrades to defaults
 * silently rather than throwing during hydration, and (c) writes are coalesced
 * into one per frame — drafts change on every keystroke.
 */

export interface Toast {
  id: string
  level: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
  actionLabel?: string
  onAction?: () => void
}

export interface Draft {
  text: string
  attachments: AttachmentInput[]
  replyToId: string | null
}

export type SettingsTab = 'general' | 'claude' | 'bots' | 'data' | 'about'

export type Modal =
  | null
  | { kind: 'bot'; botId?: string; preset?: string }
  | { kind: 'group'; conversationId?: string }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'onboarding' }
  | { kind: 'shortcuts' }
  | {
      kind: 'confirm'
      title: string
      body?: string
      confirmLabel: string
      danger?: boolean
      onConfirm: () => void
    }
  | { kind: 'everyone'; input: SendMessageInput; botCount: number }

export interface UiState {
  activeConversationId: string | null
  detailsOpen: boolean
  sidebarWidth: number
  sidebarCollapsed: boolean
  collapsedSections: Record<string, boolean>
  showHidden: boolean
  /** Live window width. Drives the responsive rules in DESIGN §2.1 (sidebar
   *  collapses below 1000; below 1180 the details panel overlays the transcript
   *  instead of taking a column beside it) without ever writing to the user's
   *  own persisted sidebar/details preference. Width changes PRESENTATION only —
   *  it must never make `detailsOpen` unreachable, which is what made the ⓘ
   *  button a dead control at every size below 1180. */
  viewportWidth: number
  drafts: Record<string, Draft>
  /**
   * Where the user was reading in each transcript, so leaving a conversation and
   * coming back does not dump them at the newest message with a few hundred rows
   * to wheel back through.
   *
   * A MISSING entry means "at the bottom", which is both the default and the
   * right answer for a live conversation — only a reader who has deliberately
   * scrolled up gets an entry. Session-only, deliberately NOT persisted: a
   * `scrollTop` is meaningful only against the page set currently loaded, and
   * after a restart the transcript reloads just its last page, so a stored
   * offset would restore to the wrong message.
   */
  scrollOffsets: Record<string, number>
  modal: Modal
  palette: null | 'command' | 'search'
  toasts: Toast[]
  jumpToMessageId: string | null

  setActive(id: string | null): void
  openModal(m: Modal): void
  closeModal(): void
  setDraft(conversationId: string, patch: Partial<Draft>): void
  clearDraft(conversationId: string): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
  jumpTo(messageId: string): void
  /**
   * Record the transcript offset for a conversation. Pass `null` for "at the
   * bottom", which forgets the entry so the conversation re-opens following the
   * stream. Call it when LEAVING a conversation (or throttled), not on every
   * scroll event: this writes to the store, and the transcript emits scroll
   * events continuously while a turn streams.
   */
  rememberScroll(conversationId: string, offset: number | null): void

  /* ---- chrome ------------------------------------------------------- */
  setSidebarWidth(width: number): void
  toggleSidebar(): void
  setSidebarCollapsed(collapsed: boolean): void
  setDetailsOpen(open: boolean): void
  toggleDetails(): void
  toggleSection(id: string): void
  setShowHidden(show: boolean): void
  setViewportWidth(width: number): void
  setPalette(palette: null | 'command' | 'search'): void
  /** Convenience wrapper around the confirm modal. */
  confirm(options: {
    title: string
    body?: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  }): void
  clearJump(): void
}

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_DEFAULT_WIDTH = 248

const STORAGE_KEY = 'ccb.ui'

interface PersistedUi {
  detailsOpen: boolean
  sidebarWidth: number
  sidebarCollapsed: boolean
  collapsedSections: Record<string, boolean>
  drafts: Record<string, Draft>
}

const EMPTY_PERSISTED: PersistedUi = {
  detailsOpen: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  collapsedSections: {},
  drafts: {}
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function readPersisted(): PersistedUi {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_PERSISTED
    const parsed = JSON.parse(raw) as Partial<PersistedUi>
    return {
      detailsOpen: typeof parsed.detailsOpen === 'boolean' ? parsed.detailsOpen : false,
      sidebarWidth: clampWidth(parsed.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH),
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : false,
      collapsedSections:
        parsed.collapsedSections && typeof parsed.collapsedSections === 'object'
          ? parsed.collapsedSections
          : {},
      drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {}
    }
  } catch {
    // A corrupt payload is not worth blocking boot over.
    return EMPTY_PERSISTED
  }
}

const initial = readPersisted()

let toastSeq = 0

export const useUiStore = create<UiState>()((set, get) => ({
  activeConversationId: null,
  detailsOpen: initial.detailsOpen,
  sidebarWidth: initial.sidebarWidth,
  sidebarCollapsed: initial.sidebarCollapsed,
  collapsedSections: initial.collapsedSections,
  showHidden: false,
  viewportWidth: typeof window === 'undefined' ? 1180 : window.innerWidth,
  drafts: initial.drafts,
  scrollOffsets: {},
  modal: null,
  palette: null,
  toasts: [],
  jumpToMessageId: null,

  setActive(id) {
    if (get().activeConversationId === id) return
    // A pending jump belongs to the conversation it was requested for.
    set({ activeConversationId: id, jumpToMessageId: null })
  },

  openModal(m) {
    // Only one dialog layer at a time; a palette under a modal is unreachable.
    set({ modal: m, palette: null })
  },

  closeModal() {
    set({ modal: null })
  },

  setDraft(conversationId, patch) {
    set((s) => {
      const current = s.drafts[conversationId] ?? { text: '', attachments: [], replyToId: null }
      const next: Draft = { ...current, ...patch }
      const empty =
        next.text.length === 0 && next.attachments.length === 0 && next.replyToId === null
      if (empty) {
        if (!s.drafts[conversationId]) return s
        const drafts = { ...s.drafts }
        delete drafts[conversationId]
        return { drafts }
      }
      return { drafts: { ...s.drafts, [conversationId]: next } }
    })
  },

  clearDraft(conversationId) {
    set((s) => {
      if (!s.drafts[conversationId]) return s
      const drafts = { ...s.drafts }
      delete drafts[conversationId]
      return { drafts }
    })
  },

  toast(t) {
    toastSeq += 1
    const id = `toast-${toastSeq}`
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    // Errors linger; everything else is ambient and gets out of the way.
    const ttl = t.level === 'error' ? 9000 : t.actionLabel ? 8000 : 4500
    window.setTimeout(() => {
      get().dismissToast(id)
    }, ttl)
  },

  dismissToast(id) {
    set((s) => {
      if (!s.toasts.some((t) => t.id === id)) return s
      return { toasts: s.toasts.filter((t) => t.id !== id) }
    })
  },

  jumpTo(messageId) {
    // Always a fresh id so re-selecting the same search hit re-triggers the flash.
    set({ jumpToMessageId: messageId })
  },

  rememberScroll(conversationId, offset) {
    set((s) => {
      const current = s.scrollOffsets[conversationId]
      if (offset === null || offset <= 0) {
        if (current === undefined) return s
        const scrollOffsets = { ...s.scrollOffsets }
        delete scrollOffsets[conversationId]
        return { scrollOffsets }
      }
      const next = Math.round(offset)
      if (current === next) return s
      return { scrollOffsets: { ...s.scrollOffsets, [conversationId]: next } }
    })
  },

  clearJump() {
    if (get().jumpToMessageId === null) return
    set({ jumpToMessageId: null })
  },

  setSidebarWidth(width) {
    const next = clampWidth(width)
    if (get().sidebarWidth === next) return
    set({ sidebarWidth: next })
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  },

  setSidebarCollapsed(collapsed) {
    set({ sidebarCollapsed: collapsed })
  },

  setDetailsOpen(open) {
    set({ detailsOpen: open })
  },

  toggleDetails() {
    set((s) => ({ detailsOpen: !s.detailsOpen }))
  },

  toggleSection(id) {
    set((s) => ({ collapsedSections: { ...s.collapsedSections, [id]: !s.collapsedSections[id] } }))
  },

  setShowHidden(show) {
    set({ showHidden: show })
  },

  setViewportWidth(width) {
    if (get().viewportWidth === width) return
    set({ viewportWidth: width })
  },

  setPalette(palette) {
    set({ palette })
  },

  confirm(options) {
    set({ modal: { kind: 'confirm', ...options } })
  }
}))

/* ------------------------------------------------------------------ *
 * Persistence — one coalesced write per frame
 * ------------------------------------------------------------------ */

let writeQueued = false

function persist(): void {
  if (writeQueued) return
  writeQueued = true
  // Coalesce to one write per frame and read the LATEST state inside the frame:
  // drafts change on every keystroke, and writing a snapshot captured a frame
  // ago would persist stale text.
  requestAnimationFrame(() => {
    writeQueued = false
    const state = useUiStore.getState()
    const payload: PersistedUi = {
      detailsOpen: state.detailsOpen,
      sidebarWidth: state.sidebarWidth,
      sidebarCollapsed: state.sidebarCollapsed,
      collapsedSections: state.collapsedSections,
      drafts: state.drafts
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Quota or a locked-down profile. Losing a draft is bad; crashing is worse.
    }
  })
}

useUiStore.subscribe((state, previous) => {
  if (
    state.detailsOpen !== previous.detailsOpen ||
    state.sidebarWidth !== previous.sidebarWidth ||
    state.sidebarCollapsed !== previous.sidebarCollapsed ||
    state.collapsedSections !== previous.collapsedSections ||
    state.drafts !== previous.drafts
  ) {
    persist()
  }
})

/** Non-reactive read for callbacks and IPC handlers. */
export function uiState(): UiState {
  return useUiStore.getState()
}
