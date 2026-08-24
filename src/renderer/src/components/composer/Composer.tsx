import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, AtSign, CornerUpLeft, FolderInput, Paperclip, Plus, SquareSlash, X } from 'lucide-react'

import type { Bot } from '@shared/types'
import type { AttachmentInput, SendMessageInput } from '@shared/schemas'
import { MAX_MESSAGE_BODY } from '@shared/schemas'
import { accentAlpha, accentOf, accentVar } from '@/lib/accent'
import { bridge, errorMessage, withToast } from '@/lib/ipc'
import { plainTextPreview } from '@/lib/format'
import { useAutosizeTextarea } from '@/hooks/useAutosizeTextarea'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { contentColumnStyle } from '@/components/chat/contentColumn'
import { IconButton } from '@/components/ui/IconButton'
import { Popover, PopoverDivider, PopoverItem } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'
import { MentionPicker } from './MentionPicker'
import type { CaretAnchor } from './MentionPicker'
import { AttachmentTray } from './AttachmentTray'
import { RoutingSelector } from './RoutingSelector'
import type { Routing } from './RoutingSelector'
import { STOP_NOTE, StopButton, useStopRequest } from './StopButton'
import { SlashPicker, filterSlashCommands } from './SlashPicker'
import type { SlashCommand } from './SlashPicker'
import {
  buildMentionOptions,
  deriveMentions,
  effectiveMentions,
  filterMentionOptions,
  findMentionTrigger,
  findSlashTrigger,
  forgetMentions,
  hasEveryone,
  insertMention,
  mentionDeleteRange,
  recallMentions,
  rememberMentions,
  splitForHighlight,
  syncMentions,
  toMentionInputs,
  trimForSend
} from './mentionText'
import type { HighlightSegment, MentionMark, MentionOption } from './mentionText'

/**
 * The composer dock (DESIGN §2.5, §3.6; PRD §10.4, §11).
 *
 * Two things here are load-bearing and non-obvious:
 *
 * 1. MENTION CHIPS OVER A TEXTAREA. A `<textarea>` cannot contain elements, and
 *    `contenteditable` breaks IME composition, native undo and paste. So the
 *    textarea is layered — transparent text, real caret — over an aria-hidden
 *    mirror that renders the same string with chip spans. Both share ONE style
 *    object, so a change can never desynchronise their metrics, and the chips
 *    use padding cancelled by an equal negative margin so the background can
 *    grow without moving a single glyph.
 *
 * 2. MENTIONS ARE STRUCTURED. The mention list travels to `messages.send`; main
 *    trusts it and never re-parses the text (PRD §11.5). Indices are recomputed
 *    against the stored display strings on every edit, so typing before a chip
 *    shifts it and typing inside one destroys it.
 */

const MAX_ATTACHMENTS = 10
/**
 * The cap `messages:send` enforces, mirrored here so an over-length message is
 * stopped in the composer instead of coming back from the validator. MUST stay
 * equal to `sendMessageSchema.body`'s `.max()` in src/shared/schemas — the whole
 * point is that the user never sees a failure phrased in terms of a field called
 * "body", which is not a thing this UI has.
 *
 * Deliberately NOT a `maxLength` on the textarea: that would silently swallow
 * the tail of a large paste, which is worse than refusing to send and keeping
 * every character the user pasted.
 */
/** Mirrors the server-side cap so the counter and the validator agree. */
const MAX_BODY_CHARS = MAX_MESSAGE_BODY
/** How near the cap the counter appears. Invisible below this — a counter that
 *  is always on is noise on the 99.99% of messages nowhere near the limit. */
const COUNTER_REVEAL_CHARS = 20_000
const LINE_HEIGHT = 22
const MAX_LINES = 8
/** 8 lines of text; the pill's 11px top/bottom padding brings it to the 198px cap. */
const MAX_TEXT_HEIGHT = LINE_HEIGHT * MAX_LINES
/** Clearance for the 32px trailing button inset 6px from the pill's right edge. */
const TRAILING_GUTTER = 34

/**
 * THE shared text metrics. Both layers get this exact object: any divergence in
 * font, size, tracking, wrapping or padding shows up as chips sliding off the
 * text they are supposed to be behind.
 */
const TEXT_STYLE: CSSProperties = {
  margin: 0,
  padding: 0,
  paddingRight: TRAILING_GUTTER,
  border: 0,
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--fs-ui)',
  lineHeight: 'var(--lh-ui)',
  letterSpacing: 'var(--ls-ui)',
  fontWeight: 400,
  fontFeatureSettings: 'var(--font-features)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  wordBreak: 'normal',
  tabSize: 4,
  textAlign: 'left'
}

/**
 * Rules that cannot be expressed inline.
 *
 * `::placeholder` is transparent because the VISIBLE placeholder is drawn by the
 * mirror (the textarea's own text is transparent, and a UA-coloured placeholder
 * would show through as a second copy). The attribute stays on the element for
 * assistive tech.
 *
 * `::selection` is deliberately translucent: the selection rectangle paints in
 * the textarea's layer, above the mirror, so an opaque highlight would hide the
 * very text it is selecting.
 *
 * The scrollbar is hidden because a 6px scrollbar steals 6px of content width
 * from the textarea and from nothing else — past 8 lines, every wrap point would
 * drift away from the mirror.
 */
const COMPOSER_CSS = `
.ccb-composer-input::placeholder { color: transparent; }
.ccb-composer-input::selection { background: color-mix(in srgb, var(--accent) 38%, transparent); }
.ccb-composer-input { scrollbar-width: none; }
.ccb-composer-input::-webkit-scrollbar { width: 0; height: 0; display: none; }
`

const EMPTY_ATTACHMENTS: AttachmentInput[] = []

/** Routing is a per-conversation preference for the session, not a saved field. */
const routingCache = new Map<string, Routing>()
/** DESIGN §4.4: the stop note shows once per conversation per session. */
const stopNoteDismissed = new Set<string>()

/* ------------------------------------------------------------------ *
 * "Take the caret" requests from outside the dock
 *
 * Choosing Reply from a message's action bar used to leave focus on the toolbar
 * button, which is `tabIndex={-1}` — so every character the user typed next was
 * silently swallowed and they had to hunt for the field. The composer, not the
 * caller, owns `taRef` and the `programmaticFocus` ring suppression, so a caller
 * must not reach in with a querySelector; it raises this signal instead and
 * whichever composer is mounted for that conversation answers it.
 *
 * `keyboard` is the activation modality: a keyboard activation SHOULD paint the
 * focus ring (the user needs to see where focus went), a mouse click should not.
 * ------------------------------------------------------------------ */

type ComposerFocusListener = (conversationId: string, keyboard: boolean) => void
const composerFocusListeners = new Set<ComposerFocusListener>()

/** Move the caret into the composer for `conversationId`, at the end of the draft. */
export function focusComposer(conversationId: string, options?: { keyboard?: boolean }): void {
  for (const listener of composerFocusListeners) listener(conversationId, options?.keyboard ?? false)
}

export interface ComposerProps {
  /** Defaults to the active conversation. */
  conversationId?: string
  className?: string
}

export function Composer({ conversationId, className }: ComposerProps): ReactElement | null {
  const activeId = useUiStore((s) => s.activeConversationId)
  const id = conversationId ?? activeId ?? null
  const exists = useAppStore((s) => (id ? s.conversations[id] !== undefined : false))

  if (!id || !exists) return null
  // Keyed: switching conversations rebuilds the composer from that
  // conversation's draft instead of unwinding the previous one's state.
  return <ComposerInner key={id} conversationId={id} className={className} />
}

interface PickerState {
  kind: 'mention' | 'slash'
  start: number
  query: string
  caret: number
}

function ComposerInner({
  conversationId,
  className
}: {
  conversationId: string
  className?: string
}): ReactElement {
  /* ---- store ------------------------------------------------------- */

  const conversation = useAppStore((s) => s.conversations[conversationId])
  const botsById = useAppStore((s) => s.bots)
  const messages = useAppStore((s) => s.messages[conversationId])
  const sendKey = useAppStore((s) => s.settings?.sendKey ?? 'enter')
  const sendMessage = useAppStore((s) => s.sendMessage)

  const draft = useUiStore((s) => s.drafts[conversationId])
  const setDraft = useUiStore((s) => s.setDraft)
  const clearDraft = useUiStore((s) => s.clearDraft)
  const toast = useUiStore((s) => s.toast)
  const viewportWidth = useUiStore((s) => s.viewportWidth)

  const text = draft?.text ?? ''
  const attachments = draft?.attachments ?? EMPTY_ATTACHMENTS
  const replyToId = draft?.replyToId ?? null

  const isGroup = conversation?.type === 'group'
  const memberIds = conversation?.memberBotIds
  const members = useMemo(() => {
    const out = []
    for (const botId of memberIds ?? []) {
      const bot = botsById[botId]
      if (bot) out.push(bot)
    }
    return out
  }, [memberIds, botsById])

  const options = useMemo(
    () => buildMentionOptions(members, isGroup),
    [members, isGroup]
  )

  /* ---- local state ------------------------------------------------- */

  const [marks, setMarksState] = useState<MentionMark[]>(() => {
    const startingText = useUiStore.getState().drafts[conversationId]?.text ?? ''
    const cached = recallMentions(conversationId)
    if (cached) return syncMentions(startingText, cached)
    // A draft restored from a previous run has text but no marks; rebuild them
    // once from the roster so the chips come back.
    const app = useAppStore.getState()
    const conv = app.conversations[conversationId]
    const roster = (conv?.memberBotIds ?? []).map((b) => app.bots[b]).filter((b) => b !== undefined)
    return deriveMentions(startingText, buildMentionOptions(roster, conv?.type === 'group'))
  })
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [anchor, setAnchor] = useState<CaretAnchor | null>(null)
  const [focused, setFocused] = useState(false)
  const [focusRing, setFocusRing] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [dropRect, setDropRect] = useState<DOMRect | null>(null)
  const [missing, setMissing] = useState<Record<string, boolean>>({})
  const [invalid, setInvalid] = useState(false)
  const [noteDismissed, setNoteDismissed] = useState(() => stopNoteDismissed.has(conversationId))
  const [stoppedRecently, setStoppedRecently] = useState(false)
  const [routing, setRoutingState] = useState<Routing>(
    () => routingCache.get(conversationId) ?? { mode: 'auto' }
  )

  const taRef = useRef<HTMLTextAreaElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  /** The block above the pill: reply preview, attachment chips, routing row. */
  const stackRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const caretMarkerRef = useRef<HTMLSpanElement>(null)
  const columnRef = useRef<HTMLElement | null>(null)

  const marksRef = useRef(marks)
  const missingRef = useRef(missing)
  const pickerRef = useRef(picker)
  const dismissedRef = useRef<{ kind: 'mention' | 'slash'; start: number } | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const sendingRef = useRef(false)

  missingRef.current = missing
  pickerRef.current = picker

  const uid = useId()
  const listId = `${uid}-picker`
  const optionId = useCallback((index: number) => `${uid}-opt-${index}`, [uid])

  const setMarks = useCallback(
    (next: MentionMark[]) => {
      marksRef.current = next
      rememberMentions(conversationId, next)
      setMarksState(next)
    },
    [conversationId]
  )

  const setRouting = useCallback(
    (next: Routing) => {
      routingCache.set(conversationId, next)
      setRoutingState(next)
    },
    [conversationId]
  )

  // Sized from the MIRROR, which already renders this exact text at the exact
  // same metrics. Measuring the textarea itself means collapsing it to one row
  // first, and that transient made the transcript above lose its scroll offset
  // on every keystroke — see the hook.
  useAutosizeTextarea(taRef, text, MAX_TEXT_HEIGHT, mirrorRef)

  /* ---- derived ------------------------------------------------------ */

  const mentionOptions = useMemo(
    () =>
      picker?.kind === 'mention' ? filterMentionOptions(options, picker.query) : [],
    [options, picker]
  )
  const slashCommands = useMemo(
    () => (picker?.kind === 'slash' ? filterSlashCommands(picker.query) : []),
    [picker]
  )
  const optionCount = picker?.kind === 'mention' ? mentionOptions.length : slashCommands.length
  const safeIndex = optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1)

  /**
   * What the app will actually act on: committed chips plus anything typed by
   * hand that resolves to a member. Main re-parses a mention-less body, so this
   * is the set that decides routing — the UI must show the same one.
   */
  const marksInEffect = useMemo(
    () => effectiveMentions(text, marks, options),
    [text, marks, options]
  )
  const effectiveRef = useRef(marksInEffect)
  effectiveRef.current = marksInEffect

  const segments = useMemo(() => splitForHighlight(text, marksInEffect), [text, marksInEffect])
  const everyoneSelected = hasEveryone(marksInEffect)
  // Exactly what `trimForSend` will hand to IPC, so the counter, the send button
  // and the guard in `submit` can never disagree about whether this fits.
  const bodyLength = useMemo(() => text.trim().length, [text])
  const hasContent = bodyLength > 0 || attachments.length > 0
  const tooLong = bodyLength > MAX_BODY_CHARS
  const showCounter = bodyLength > MAX_BODY_CHARS - COUNTER_REVEAL_CHARS

  const title = conversation
    ? conversation.type === 'direct'
      ? (botsById[conversation.memberBotIds[0] ?? '']?.name ?? conversation.name)
      : conversation.name
    : ''
  const placeholder = conversation?.type === 'direct' ? `Ask ${title}` : `Message ${title}`

  const replyTo = useMemo(
    () => (replyToId ? messages?.find((m) => m.id === replyToId) : undefined),
    [messages, replyToId]
  )

  const noteTimerRef = useRef<number | null>(null)
  /** DESIGN §4.4: the note follows a stop, then gets out of the way. */
  const onStopped = useCallback(() => {
    setStoppedRecently(true)
    if (noteTimerRef.current !== null) window.clearTimeout(noteTimerRef.current)
    noteTimerRef.current = window.setTimeout(() => setStoppedRecently(false), 10000)
  }, [])
  useEffect(
    () => () => {
      if (noteTimerRef.current !== null) window.clearTimeout(noteTimerRef.current)
    },
    []
  )

  const { count: stoppableCount, requestStop } = useStopRequest(conversationId, onStopped)
  const showStopNote = !noteDismissed && (stoppableCount > 0 || stoppedRecently)

  /* ---- text plumbing ------------------------------------------------ */

  const applyText = useCallback(
    (nextText: string, nextMarks: MentionMark[]) => {
      setDraft(conversationId, { text: nextText })
      setMarks(nextMarks)
    },
    [conversationId, setDraft, setMarks]
  )

  /**
   * Re-evaluate the trigger under the caret. Called from every path that can
   * move the caret — typing, clicking, arrowing — because a picker that only
   * opens on keystrokes feels broken the moment you click back into a word.
   */
  const syncTrigger = useCallback(
    (value: string, caret: number, currentMarks: MentionMark[]) => {
      if (composingRef.current) return

      const slash = findSlashTrigger(value, caret)
      // Committed chips AND hand-typed names both count as "already a mention",
      // so the picker never re-opens on top of one.
      const mention = slash
        ? null
        : findMentionTrigger(value, caret, effectiveMentions(value, currentMarks, options))
      const found: PickerState | null = slash
        ? { kind: 'slash', ...slash }
        : mention
          ? { kind: 'mention', ...mention }
          : null

      if (!found) {
        dismissedRef.current = null
        if (pickerRef.current) setPicker(null)
        return
      }

      // Esc keeps the typed text but must not re-open on the next keystroke in
      // the same token (DESIGN §4.8).
      const dismissed = dismissedRef.current
      if (dismissed && dismissed.kind === found.kind && dismissed.start === found.start) {
        if (pickerRef.current) setPicker(null)
        return
      }
      dismissedRef.current = null

      // A query with a space that matches nothing is almost certainly ordinary
      // prose after an `@`; close so Enter still sends.
      if (found.kind === 'mention' && /\s/.test(found.query)) {
        if (filterMentionOptions(options, found.query).length === 0) {
          if (pickerRef.current) setPicker(null)
          return
        }
      }

      const previous = pickerRef.current
      if (!previous || previous.kind !== found.kind || previous.query !== found.query) {
        setActiveIndex(0)
      }
      setPicker(found)
    },
    [options]
  )

  const closePicker = useCallback((remember: boolean) => {
    const current = pickerRef.current
    if (!current) return
    if (remember) dismissedRef.current = { kind: current.kind, start: current.start }
    setPicker(null)
  }, [])

  /**
   * Apply an edit through `execCommand` when possible: it keeps the native undo
   * stack intact, which replacing the value from React state destroys. The
   * manual path is the fallback for when the (deprecated) command is refused.
   */
  const applyEdit = useCallback(
    (
      from: number,
      to: number,
      insert: string,
      nextText: string,
      nextMarks: MentionMark[],
      nextCaret: number
    ) => {
      const ta = taRef.current
      if (!ta) return
      // Set the marks first: the synchronous `input` event that execCommand
      // fires re-syncs against them, and they already match the new text.
      setMarks(nextMarks)
      ta.focus()
      ta.setSelectionRange(from, to)

      let ok = false
      try {
        ok = document.execCommand(insert.length > 0 ? 'insertText' : 'delete', false, insert)
      } catch {
        ok = false
      }
      if (!ok) {
        applyText(nextText, nextMarks)
        pendingCaretRef.current = nextCaret
      }
    },
    [applyText, setMarks]
  )

  // Restore a caret position that only the fallback edit path can know about.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(caret, caret)
  })

  const commitMention = useCallback(
    (option: MentionOption) => {
      const ta = taRef.current
      const current = pickerRef.current
      if (!ta || !current || current.kind !== 'mention') return
      // Re-read the live trigger: the caret may have moved since the last sync.
      const trigger = findMentionTrigger(ta.value, ta.selectionStart, marksRef.current) ?? {
        start: current.start,
        query: current.query,
        caret: current.caret
      }
      const edit = insertMention(ta.value, marksRef.current, trigger, option)
      applyEdit(trigger.start, trigger.caret, edit.inserted, edit.text, edit.marks, edit.caret)
      dismissedRef.current = null
      setPicker(null)
    },
    [applyEdit]
  )

  const openDetails = useCallback(() => {
    const ui = useUiStore.getState()
    ui.setDetailsOpen(true)
    if (ui.viewportWidth < 1180) {
      // App hides the drawer below 1180 — say so instead of doing nothing.
      ui.toast({
        level: 'info',
        title: 'Conversation details need a wider window',
        body: 'Widen the window to at least 1180px to show the details panel.'
      })
    }
  }, [])

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      // A command is not a message: the token never gets sent anywhere.
      applyText('', [])
      dismissedRef.current = null
      setPicker(null)
      taRef.current?.focus()

      const ui = useUiStore.getState()
      switch (command.id) {
        case 'newbot':
          ui.openModal({ kind: 'bot' })
          break
        case 'newgroup':
          ui.openModal({ kind: 'group' })
          break
        case 'clear-ui':
          ui.confirm({
            title: 'Clear this transcript?',
            body: 'This removes the messages shown here and starts the Bots on a fresh Claude session. Files and anything already done are untouched.',
            confirmLabel: 'Clear',
            danger: true,
            onConfirm: () => {
              void (async () => {
                const done = await withToast(
                  () => bridge().conversations.clearTranscript(conversationId),
                  { errorTitle: 'Could not clear this transcript' }
                )
                if (done === null) return
                // Main clears the rows but only emits `conversation:updated`, so
                // the loaded transcript is dropped here and re-fetched.
                useAppStore.setState((s) => {
                  const nextMessages = { ...s.messages }
                  const nextPagination = { ...s.pagination }
                  delete nextMessages[conversationId]
                  delete nextPagination[conversationId]
                  return { messages: nextMessages, pagination: nextPagination }
                })
                void useAppStore.getState().loadMessages(conversationId)
              })()
            }
          })
          break
        case 'workspace':
          openDetails()
          break
        case 'model':
        case 'permissions': {
          // Both live on the Bot in a direct chat; a group has one per member,
          // which is what the details drawer lists.
          const directBotId =
            conversation?.type === 'direct' ? conversation.memberBotIds[0] : undefined
          if (directBotId) ui.openModal({ kind: 'bot', botId: directBotId })
          else openDetails()
          break
        }
      }
    },
    [applyText, conversation, conversationId, openDetails]
  )

  const commitActive = useCallback(() => {
    const current = pickerRef.current
    if (!current) return
    if (current.kind === 'mention') {
      const option = mentionOptions[safeIndex]
      if (option) commitMention(option)
      return
    }
    const command = slashCommands[safeIndex]
    if (command) runSlashCommand(command)
  }, [commitMention, mentionOptions, runSlashCommand, safeIndex, slashCommands])

  /* ---- attachments -------------------------------------------------- */

  const verifyPaths = useCallback(async (list: AttachmentInput[]) => {
    const unchecked = list.filter((a) => missingRef.current[a.path] === undefined)
    if (unchecked.length === 0) return
    const results = await Promise.all(
      unchecked.map(async (attachment) => {
        try {
          return [attachment.path, !(await bridge().system.pathExists(attachment.path))] as const
        } catch {
          return [attachment.path, false] as const
        }
      })
    )
    setMissing((previous) => {
      const next = { ...previous }
      for (const [path, isMissing] of results) next[path] = isMissing
      return next
    })
  }, [])

  const addAttachments = useCallback(
    (incoming: AttachmentInput[]) => {
      if (incoming.length === 0) return
      const current = useUiStore.getState().drafts[conversationId]?.attachments ?? []
      const merged = [...current]
      let duplicates = 0
      let overflow = 0

      for (const item of incoming) {
        if (merged.some((a) => a.path === item.path)) {
          duplicates += 1
          continue
        }
        if (merged.length >= MAX_ATTACHMENTS) {
          overflow += 1
          continue
        }
        merged.push(item)
      }

      if (merged.length !== current.length) {
        setDraft(conversationId, { attachments: merged })
        void verifyPaths(merged)
      }
      // Nothing is ever dropped silently.
      if (duplicates > 0) {
        toast({
          level: 'info',
          title: duplicates === 1 ? 'Already attached' : `${duplicates} files were already attached`
        })
      }
      if (overflow > 0) {
        toast({
          level: 'warn',
          title: `You can attach up to ${MAX_ATTACHMENTS} files at a time`,
          body: `${overflow} ${overflow === 1 ? 'file was' : 'files were'} not added.`
        })
      }
    },
    [conversationId, setDraft, toast, verifyPaths]
  )

  const removeAttachment = useCallback(
    (index: number) => {
      const current = useUiStore.getState().drafts[conversationId]?.attachments ?? []
      const next = current.filter((_, i) => i !== index)
      setDraft(conversationId, { attachments: next })
      taRef.current?.focus()
    },
    [conversationId, setDraft]
  )

  const attachFiles = useCallback(async () => {
    setPlusOpen(false)
    const picked = await withToast(() => bridge().system.pickFiles(), {
      errorTitle: 'Could not open the file picker'
    })
    if (!picked) return
    addAttachments(
      picked.files.map((file) => ({
        path: file.path,
        name: file.name,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType
      }))
    )
  }, [addAttachments])

  const attachFolder = useCallback(async () => {
    setPlusOpen(false)
    const picked = await withToast(() => bridge().system.pickDirectory(), {
      errorTitle: 'Could not open the folder picker'
    })
    if (!picked?.path) return
    addAttachments([
      {
        path: picked.path,
        name: basename(picked.path),
        kind: 'folder',
        sizeBytes: null,
        mimeType: null
      }
    ])
  }, [addAttachments])

  const attachPaths = useCallback(
    async (paths: string[]) => {
      const unique = [...new Set(paths.filter((p) => p.length > 0))]
      if (unique.length === 0) return
      const checked = await Promise.all(
        unique.map(async (path) => {
          try {
            return { path, exists: await bridge().system.pathExists(path) }
          } catch {
            return { path, exists: false }
          }
        })
      )
      const good = checked.filter((c) => c.exists)
      const bad = checked.filter((c) => !c.exists)
      if (bad.length > 0) {
        toast({
          level: 'warn',
          title: bad.length === 1 ? 'That file could not be found' : 'Some files could not be found',
          body: bad.map((b) => b.path).join('\n')
        })
      }
      addAttachments(
        good.map(({ path }) => ({
          path,
          name: basename(path),
          kind: guessKind(path),
          sizeBytes: null,
          mimeType: null
        }))
      )
    },
    [addAttachments, toast]
  )

  // Re-check whenever the list changes (a restored draft arrives unchecked).
  useEffect(() => {
    void verifyPaths(attachments)
  }, [attachments, verifyPaths])

  /* ---- drag and drop over the whole chat column ---------------------- */

  useEffect(() => {
    columnRef.current =
      dockRef.current?.closest('main') ?? (dockRef.current?.parentElement as HTMLElement | null)
  }, [])

  const acceptDrop = useCallback(
    (transfer: DataTransfer) => {
      const paths = pathsFromTransfer(transfer)
      if (paths.length > 0) {
        void attachPaths(paths)
        return
      }
      // Electron 32+ removed `File.path`, and some sources carry no URI list, so
      // the path genuinely cannot be read here. Say so and offer the picker
      // rather than dropping the file on the floor.
      toast({
        level: 'warn',
        title: 'Could not read that file’s location',
        body: 'Attach it from the file picker instead.',
        actionLabel: 'Choose files…',
        onAction: () => void attachFiles()
      })
    },
    [attachFiles, attachPaths, toast]
  )

  useEffect(() => {
    let depth = 0

    const carriesFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const insideColumn = (e: DragEvent): boolean => {
      const column = columnRef.current
      if (!column) return true
      const rect = column.getBoundingClientRect()
      return (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      )
    }

    const onDragEnter = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      depth += 1
      if (!insideColumn(e)) return
      const column = columnRef.current
      setDropRect(column ? column.getBoundingClientRect() : null)
    }

    const onDragOver = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      // Required for `drop` to fire, and it stops Chromium from navigating the
      // window to the dropped file — which would blow the whole app away.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = insideColumn(e) ? 'copy' : 'none'
    }

    const onDragLeave = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDropRect(null)
    }

    const onDrop = (e: DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth = 0
      setDropRect(null)
      if (!insideColumn(e) || !e.dataTransfer) return
      acceptDrop(e.dataTransfer)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [acceptDrop])

  /* ---- sending ------------------------------------------------------- */

  const flashInvalid = useCallback(() => {
    setInvalid(true)
    window.setTimeout(() => setInvalid(false), 160)
  }, [])

  const submit = useCallback(async () => {
    if (sendingRef.current) return
    const current = useUiStore.getState().drafts[conversationId]
    const rawText = current?.text ?? ''
    const currentAttachments = current?.attachments ?? []
    const { body, mentions } = trimForSend(rawText, effectiveRef.current)

    if (body.length === 0 && currentAttachments.length === 0) {
      flashInvalid()
      return
    }

    // Stop it HERE. Sending it and letting the schema reject it produced the
    // toast "body: Invalid input" — a field name that exists nowhere in this UI,
    // no number, and nothing the user could act on. Everything they typed stays
    // in the draft either way, but now they are told what to do about it.
    if (body.length > MAX_BODY_CHARS) {
      flashInvalid()
      toast({
        level: 'warn',
        title: 'Message is too long',
        body: `It is ${body.length.toLocaleString()} characters and the limit is ${MAX_BODY_CHARS.toLocaleString()}. Trim about ${(body.length - MAX_BODY_CHARS).toLocaleString()}, or attach it as a file instead.`
      })
      return
    }

    const missingNow = currentAttachments.filter((a) => missingRef.current[a.path] === true)
    if (missingNow.length > 0) {
      toast({
        level: 'warn',
        title: missingNow.length === 1 ? 'One attachment is missing' : 'Some attachments are missing',
        body: `${missingNow.map((a) => a.name).join(', ')} no longer exists at that path.`
      })
    }

    const input: SendMessageInput = {
      conversationId,
      body,
      mentions: toMentionInputs(mentions),
      attachments: currentAttachments,
      replyToMessageId: current?.replyToId ?? null,
      routing
    }

    const priorMarks = marksRef.current
    sendingRef.current = true
    // Clear optimistically — main persists the user message before it decides
    // anything else, including the @everyone gate, so the text is already in
    // the transcript by the time this resolves.
    clearDraft(conversationId)
    setMarks([])
    forgetMentions(conversationId)
    setPicker(null)

    try {
      await sendMessage(input)
    } catch (thrown) {
      // Never lose what the user typed.
      setDraft(conversationId, {
        text: rawText,
        attachments: currentAttachments,
        replyToId: current?.replyToId ?? null
      })
      setMarks(syncMentions(rawText, priorMarks))
      toast({ level: 'error', title: 'Message not sent', body: errorMessage(thrown) })
    } finally {
      sendingRef.current = false
      taRef.current?.focus()
    }
  }, [
    clearDraft,
    conversationId,
    flashInvalid,
    routing,
    sendMessage,
    setDraft,
    setMarks,
    toast
  ])

  /* ---- keyboard ------------------------------------------------------ */

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Never interrupt an IME composition.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      const ta = e.currentTarget
      const mod = e.metaKey || e.ctrlKey
      const current = pickerRef.current

      if (current) {
        if (e.key === 'ArrowDown' && optionCount > 0) {
          e.preventDefault()
          setActiveIndex((i) => (Math.min(i, optionCount - 1) + 1) % optionCount)
          return
        }
        if (e.key === 'ArrowUp' && optionCount > 0) {
          e.preventDefault()
          setActiveIndex((i) => (Math.min(i, optionCount - 1) - 1 + optionCount) % optionCount)
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && optionCount > 0 && !mod && !e.shiftKey) {
          e.preventDefault()
          commitActive()
          return
        }
        // AN OPEN PICKER OWNS ENTER, even when it has nothing to offer. This
        // branch used to be part of the one above, gated on `optionCount > 0`,
        // so the instant a query stopped matching — "@Rev" in a group with no
        // Rev — Enter silently changed meaning from "accept this completion" to
        // "send the whole message", and a real Claude turn was spent on a
        // half-written one. The popover is still on screen showing "No matches"
        // (DESIGN §3.6 requires that empty row), so the key it visibly owns has
        // to do something visible: dismiss it. The dismissal is remembered, so
        // the picker does not spring back on the next keystroke in the same
        // token and the following Enter sends. ⌘Enter and Shift+Enter are
        // untouched — neither ever meant "accept the completion".
        if (e.key === 'Enter' && optionCount === 0 && !mod && !e.shiftKey) {
          e.preventDefault()
          closePicker(true)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          // Stop the app-level Esc: closing the picker is the whole action.
          e.stopPropagation()
          closePicker(true)
          return
        }
      }

      if (e.key === 'Escape') {
        e.stopPropagation()
        if (useUiStore.getState().drafts[conversationId]?.replyToId) {
          e.preventDefault()
          setDraft(conversationId, { replyToId: null })
          return
        }
        // DESIGN §4.8 requires Escape to LEAVE the field (bare J/K list nav only
        // works once the composer is not focused), but a bare `blur()` dropped
        // focus on <body>: nothing was ring-lit and the next Tab restarted at the
        // top of the app, ~41 stops from where the user was. Hand focus to the
        // transcript instead — it is `role="log"` with `tabIndex={0}`, it is the
        // thing directly above the composer, and Tab from there continues into
        // the composer rather than the sidebar.
        const log = document.querySelector<HTMLElement>('main [role="log"]')
        if (log) log.focus({ preventScroll: true })
        else ta.blur()
        return
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') && !mod && !e.altKey) {
        const range = mentionDeleteRange(
          effectiveRef.current,
          ta.selectionStart,
          ta.selectionEnd,
          e.key === 'Backspace' ? 'backward' : 'forward'
        )
        if (range) {
          // A chip is atomic: editing half of "@Product Manager" is never what
          // the user meant.
          e.preventDefault()
          const value = ta.value
          const nextText = value.slice(0, range.start) + value.slice(range.end)
          const remaining = marksRef.current.filter(
            (m) => !(m.startIndex === range.start && m.endIndex === range.end)
          )
          applyEdit(range.start, range.end, '', nextText, syncMentions(nextText, remaining), range.start)
          return
        }
      }

      // ↑ in an empty composer recalls the last thing you said (DESIGN §4.8).
      if (
        e.key === 'ArrowUp' &&
        !current &&
        ta.value.length === 0 &&
        attachments.length === 0 &&
        !mod
      ) {
        const previous = [...(messages ?? [])]
          .reverse()
          .find((m) => m.authorType === 'user' && m.bodyMarkdown.trim().length > 0)
        if (previous) {
          e.preventDefault()
          const restored = previous.bodyMarkdown
          const restoredMarks = previous.mentions.length
            ? syncMentions(
                restored,
                previous.mentions.map((m) => ({
                  botId: m.botId,
                  display: m.display,
                  everyone: m.everyone,
                  startIndex: m.startIndex,
                  endIndex: m.endIndex
                }))
              )
            : deriveMentions(restored, options)
          applyText(restored, restoredMarks)
          pendingCaretRef.current = restored.length
          return
        }
      }

      if (e.key === 'Enter') {
        if (mod || (sendKey === 'enter' && !e.shiftKey)) {
          e.preventDefault()
          void submit()
        }
        // Otherwise fall through: the browser inserts the newline.
      }
    },
    [
      applyEdit,
      applyText,
      attachments.length,
      closePicker,
      commitActive,
      conversationId,
      messages,
      optionCount,
      options,
      sendKey,
      setDraft,
      submit
    ]
  )

  // `⌘⇧K` stops the run from anywhere in the window (DESIGN §4.8).
  useHotkeys({ 'mod+shift+k': () => requestStop() }, stoppableCount > 0)

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = e.clipboardData.files
      const pasted = e.clipboardData.getData('text/plain')

      if (files.length > 0 && pasted.trim().length === 0) {
        // Pasted binary has no path we can hand to Claude Code (Electron 32+).
        toast({
          level: 'info',
          title: 'Pasted files need a path',
          body: 'Use Attach files… to pick it from disk.',
          actionLabel: 'Choose files…',
          onAction: () => void attachFiles()
        })
        return
      }

      const candidate = pasted.trim()
      if (!looksLikePath(candidate)) return
      const insertAt = e.currentTarget.selectionStart

      void bridge()
        .system.pathExists(candidate)
        .then((exists) => {
          if (!exists) return
          toast({
            level: 'info',
            title: 'Attach this file?',
            body: basename(candidate),
            actionLabel: 'Attach',
            onAction: () => {
              // Take the pasted path back out of the text, but only if it is
              // still exactly where it landed.
              const ta = taRef.current
              if (ta && ta.value.slice(insertAt, insertAt + candidate.length) === candidate) {
                const value = ta.value
                const nextText =
                  value.slice(0, insertAt) + value.slice(insertAt + candidate.length)
                applyEdit(
                  insertAt,
                  insertAt + candidate.length,
                  '',
                  nextText,
                  syncMentions(nextText, marksRef.current),
                  insertAt
                )
              }
              void attachPaths([candidate])
            }
          })
        })
        .catch(() => {
          // Path probing is best-effort; a failure just means no offer.
        })
    },
    [applyEdit, attachFiles, attachPaths, toast]
  )

  /* ---- caret anchor for the pickers ---------------------------------- */

  useLayoutEffect(() => {
    if (!picker) {
      if (anchor) setAnchor(null)
      return
    }
    const marker = caretMarkerRef.current
    const pill = pillRef.current
    if (!marker || !pill) return
    const pillRect = pill.getBoundingClientRect()
    // Everything stacked above the pill — a reply preview, attachment chips, the
    // group routing row — is part of the message being composed, so the panel
    // has to clear it too. The block collapses to zero height when it holds
    // nothing, and then its top IS the pill's top.
    const stackTop = stackRef.current?.getBoundingClientRect().top ?? pillRect.top
    const next: CaretAnchor = {
      left: marker.getBoundingClientRect().left,
      composerTop: Math.min(pillRect.top, stackTop),
      composerBottom: pillRect.bottom
    }
    setAnchor((previous) =>
      previous &&
      Math.abs(previous.left - next.left) < 0.5 &&
      Math.abs(previous.composerTop - next.composerTop) < 0.5 &&
      Math.abs(previous.composerBottom - next.composerBottom) < 0.5
        ? previous
        : next
    )
  }, [anchor, picker, text, viewportWidth, attachments.length, replyToId, marksInEffect.length])

  /* ---- mirror scroll sync -------------------------------------------- */

  const syncScroll = useCallback(() => {
    const ta = taRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    mirror.style.transform = ta.scrollTop === 0 ? 'none' : `translateY(${-ta.scrollTop}px)`
  }, [])

  // Typing at the bottom of a scrolled textarea moves scrollTop without any
  // scroll event of its own, so re-sync after every render that changed text.
  useLayoutEffect(syncScroll, [syncScroll, text])

  /* ---- focus --------------------------------------------------------- */

  // Chromium starts a freshly loaded page in "keyboard mode", so a purely
  // programmatic focus still matches :focus-visible and would paint a heavy ring
  // around the composer on launch — before the user has touched anything. Flag
  // our own focus calls so the ring is reserved for real keyboard navigation.
  const programmaticFocus = useRef(false)

  const takeCaret = useCallback((keyboard: boolean) => {
    const ta = taRef.current
    if (!ta) return
    // The ring is for keyboard navigation only; see `programmaticFocus`.
    programmaticFocus.current = !keyboard
    ta.focus({ preventScroll: true })
    const end = ta.value.length
    ta.setSelectionRange(end, end)
  }, [])

  // Mount only — `takeCaret` is stable, so this runs once per conversation.
  useEffect(() => {
    // Opening a conversation should land the caret in the composer.
    takeCaret(false)
  }, [takeCaret])

  // Answer `focusComposer()` — raised by Reply in the message action bar.
  useEffect(() => {
    const listener: ComposerFocusListener = (id, keyboard) => {
      if (id !== conversationId) return
      takeCaret(keyboard)
    }
    composerFocusListeners.add(listener)
    return () => {
      composerFocusListeners.delete(listener)
    }
  }, [conversationId, takeCaret])

  /* ---- render -------------------------------------------------------- */

  const nodes = buildMirrorNodes(segments, picker?.start ?? null, botsById, caretMarkerRef)

  const trailing = renderTrailing()

  function renderTrailing(): ReactNode {
    if (!hasContent && stoppableCount > 0) {
      return (
        <StopButton conversationId={conversationId} variant="glyph" onStopped={onStopped} />
      )
    }
    // An over-length draft reads as "nothing to send here yet" rather than as a
    // live send button that swallows the click: `disabled` also sets
    // `pointer-events: none`, so a filled-looking button would simply do nothing.
    const canSend = hasContent && !tooLong
    return (
      <button
        type="button"
        aria-label="Send message"
        title={tooLong ? 'Message is too long to send' : 'Send message'}
        disabled={!hasContent || tooLong}
        onClick={() => void submit()}
        className="no-drag grid shrink-0 place-items-center rounded-full transition-[background-color,color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] active:scale-[0.96] disabled:pointer-events-none"
        style={{
          width: 32,
          height: 32,
          background: canSend ? 'var(--btn-filled-bg)' : 'transparent',
          color: canSend ? 'var(--btn-filled-fg)' : 'var(--fg-quaternary)',
          opacity: canSend ? 1 : 0.5
        }}
      >
        <ArrowUp size={18} strokeWidth={1.75} />
      </button>
    )
  }

  return (
    <div
      ref={dockRef}
      className={className}
      style={{
        position: 'relative',
        flexShrink: 0,
        background: 'var(--surface-0)',
        // No horizontal padding here: the 24px gutter is part of the content
        // column (contentColumn.ts) and is applied to the box below. Putting it
        // on this full-width box did nothing at all — the box is far wider than
        // the column's cap — while making it look as though the dock were
        // inset.
        padding: '8px 0 16px'
      }}
    >
      {/* React 19 hoists and de-duplicates a keyed <style>. */}
      <style href="ccb-composer" precedence="medium">
        {COMPOSER_CSS}
      </style>

      {/* The scrim fades scrolled transcript content into the dock instead of
          cutting it off with a border. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: -16,
          height: 16,
          pointerEvents: 'none',
          background: 'linear-gradient(transparent, var(--surface-0))'
        }}
      />

      {/* The composer's outer edges ARE the transcript's content column: same
          cap, same narrow breakpoint, same gutter — and the same scrollbar
          gutter, which the dock has to subtract by hand because it is not a
          scroll container. Without it the two columns agreed only while the cap
          was biting, and the composer sat 11px outboard on both edges as soon as
          the chat pane narrowed (details panel inline at 1180px). See
          contentColumn.ts. */}
      <div style={contentColumnStyle(viewportWidth, { reserveScrollbarGutter: true })}>
        {stoppableCount > 0 ? (
          <div className="flex justify-center" style={{ paddingBottom: 8 }}>
            <StopButton conversationId={conversationId} onStopped={onStopped} />
          </div>
        ) : null}

        {showStopNote ? (
          <div
            className="flex items-center justify-center"
            style={{ gap: 6, paddingBottom: 8, fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
          >
            <span>{STOP_NOTE}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                stopNoteDismissed.add(conversationId)
                setNoteDismissed(true)
              }}
              className="no-drag grid place-items-center rounded-full hover:bg-[var(--btn-ghost-hover)]"
              style={{ width: 18, height: 18, color: 'var(--fg-tertiary)' }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ) : null}

        {/* Everything above the pill lines up with the pill, not the dock:
            36px + 8px gap of `+` button. */}
        <div ref={stackRef} style={{ paddingLeft: 44 }}>
          {replyTo ? (
            <div
              className="flex items-center"
              style={{
                height: 32,
                gap: 8,
                marginBottom: 8,
                padding: '0 6px 0 10px',
                borderRadius: 'var(--r-4)',
                background: 'var(--surface-2)'
              }}
            >
              <CornerUpLeft size={14} strokeWidth={1.75} style={{ color: 'var(--fg-tertiary)' }} />
              <span
                className="shrink-0"
                style={{ fontSize: 'var(--fs-meta)', fontWeight: 550, color: 'var(--fg-secondary)' }}
              >
                {replyTo.authorType === 'user' ? 'You' : (replyTo.authorName ?? 'Bot')}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
              >
                {plainTextPreview(replyTo.bodyMarkdown, 90)}
              </span>
              <IconButton
                label="Cancel reply"
                size={24}
                onClick={() => {
                  setDraft(conversationId, { replyToId: null })
                  taRef.current?.focus()
                }}
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
          ) : null}

          <AttachmentTray
            attachments={attachments}
            missing={missing}
            onRemove={removeAttachment}
          />

          {isGroup && marksInEffect.length === 0 ? (
            <RoutingSelector members={members} value={routing} onChange={setRouting} />
          ) : null}
        </div>

        <div className="flex items-end" style={{ gap: 8 }}>
          {/* 36px circle OUTSIDE the pill; 4px lift centres it on a 44px pill. */}
          <Tooltip
            label={
              attachments.length >= MAX_ATTACHMENTS
                ? `You can attach up to ${MAX_ATTACHMENTS} files at a time`
                : 'Attach files, mention a Bot, run a command'
            }
            side="top"
          >
            <button
              ref={plusRef}
              type="button"
              aria-label="Add to this message"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen((open) => !open)}
              className="no-drag grid shrink-0 place-items-center rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-3)] active:scale-[0.96]"
              style={{
                width: 36,
                height: 36,
                marginBottom: 4,
                background: 'var(--surface-2)',
                // The same inset hairline the pill next to it wears, and for the
                // same reason: --surface-2 on the --surface-0 dock separates by
                // only 10 sRGB steps in light theme (1.09:1) against 28 in dark,
                // so without an edge the circle dissolved into the ground and
                // only the glyph read. Inset rather than a border so the 36px box
                // stays a true circle; unconditional because it matches the pill
                // in dark too, and it survives the hover class above.
                boxShadow: 'inset 0 0 0 1px var(--border-2)',
                color: 'var(--fg-secondary)'
              }}
            >
              <Plus size={18} strokeWidth={1.75} />
            </button>
          </Tooltip>

          <div
            ref={pillRef}
            onClick={(e) => {
              // Clicking the pill's padding should focus the field, like a real
              // input — but not when the click was on the trailing button.
              if (e.target === e.currentTarget) taRef.current?.focus()
            }}
            className={invalid ? 'squish' : undefined}
            style={{
              position: 'relative',
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              borderRadius: 'var(--r-input)',
              background: 'var(--input-bg)',
              // An INSET hairline rather than a border: with `box-sizing:
              // border-box`, a real 1px border would eat 2px of the 44px box and
              // the pill would stop being a true capsule (radius 22 = height/2)
              // at exactly the spec'd 11px padding.
              boxShadow: `inset 0 0 0 1px ${focused ? 'var(--input-border-hover)' : 'var(--border-2)'}`,
              outline: focusRing ? '2px solid var(--focus-ring-color)' : undefined,
              outlineOffset: focusRing ? 2 : undefined,
              padding: '11px 8px 11px 16px',
              transition:
                'background-color var(--dur-fast) var(--ease-out-quad), box-shadow var(--dur-fast) var(--ease-out-quad)'
            }}
          >
            <div style={{ position: 'relative' }}>
              {/* The mirror. Identical metrics, scroll-synced, aria-hidden. */}
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  right: 0,
                  // 4px of bleed on the left, paid back by the inner padding
                  // below: without it, a chip that starts a line has the left
                  // half of its rounded background clipped away.
                  left: -4,
                  overflow: 'hidden',
                  pointerEvents: 'none',
                  userSelect: 'none'
                }}
              >
                <div
                  ref={mirrorRef}
                  style={{ ...TEXT_STYLE, paddingLeft: 4, color: 'var(--fg-primary)' }}
                >
                  {text.length === 0 ? (
                    <span style={{ color: 'var(--fg-tertiary)' }}>{placeholder}</span>
                  ) : null}
                  {nodes}
                  {/* `pre-wrap` swallows a trailing newline; the textarea does
                      not, so the last empty line has to be re-created. */}
                  {text.endsWith('\n') ? '\n' : null}
                </div>
              </div>

              <textarea
                ref={taRef}
                rows={1}
                className="ccb-composer-input selectable no-drag block resize-none bg-transparent"
                style={{
                  ...TEXT_STYLE,
                  position: 'relative',
                  display: 'block',
                  maxHeight: MAX_TEXT_HEIGHT,
                  color: 'transparent',
                  caretColor: 'var(--fg-primary)',
                  outline: 'none'
                }}
                value={text}
                placeholder={placeholder}
                aria-label={placeholder}
                // The ARIA 1.2 combobox pattern, but only while a picker is
                // open: a permanent `role="combobox"` would cost the field its
                // "multi-line edit" announcement for the 99% of the time it is
                // just a message box.
                role={picker ? 'combobox' : undefined}
                aria-autocomplete={picker ? 'list' : undefined}
                aria-expanded={picker ? true : undefined}
                aria-controls={picker ? listId : undefined}
                aria-activedescendant={picker && optionCount > 0 ? optionId(safeIndex) : undefined}
                onChange={(e) => {
                  const value = e.target.value
                  const nextMarks = syncMentions(value, marksRef.current)
                  applyText(value, nextMarks)
                  syncTrigger(value, e.target.selectionStart, nextMarks)
                }}
                onKeyDown={onKeyDown}
                onKeyUp={(e) => {
                  // Caret moves that are not edits (arrows, Home/End) still change
                  // which token the caret is in.
                  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                    syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart, marksRef.current)
                  }
                }}
                onClick={(e) =>
                  syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart, marksRef.current)
                }
                onPaste={onPaste}
                onScroll={syncScroll}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false
                  syncTrigger(e.currentTarget.value, e.currentTarget.selectionStart, marksRef.current)
                }}
                onFocus={(e) => {
                  setFocused(true)
                  // Only draw the ring for keyboard focus; a mouse click into a
                  // text field does not need one, and neither does our own
                  // autofocus on mount.
                  const wasProgrammatic = programmaticFocus.current
                  programmaticFocus.current = false
                  setFocusRing(!wasProgrammatic && e.currentTarget.matches(':focus-visible'))
                }}
                onBlur={() => {
                  setFocused(false)
                  setFocusRing(false)
                  closePicker(false)
                  setPlusOpen(false)
                }}
              />
            </div>

            <div style={{ position: 'absolute', right: 6, bottom: 6 }}>{trailing}</div>
          </div>
        </div>

        {everyoneSelected || showCounter ? (
          <div
            className="flex items-baseline"
            style={{
              paddingLeft: 44,
              paddingTop: 6,
              gap: 12,
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              color: 'var(--fg-tertiary)'
            }}
          >
            {everyoneSelected ? <p>Everyone in this group will answer. Use sparingly.</p> : null}
            {showCounter ? (
              /* Appears only in the last 10% of the allowance, so the user meets
                 the limit while there is still room to do something about it —
                 the alternative was discovering it existed at the moment a send
                 failed. `ml-auto` keeps it on the right whether or not the
                 @everyone note is sharing the line. NOT a live region: it
                 changes on every keystroke, and a screen reader announcing a
                 running character count would be unusable. */
              <span
                className="ml-auto shrink-0"
                title={`Messages are limited to ${MAX_BODY_CHARS.toLocaleString()} characters`}
                style={{
                  color: tooLong ? 'var(--fg-danger)' : 'var(--fg-tertiary)',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: tooLong ? 550 : undefined
                }}
              >
                {bodyLength.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <Popover
        open={plusOpen}
        onClose={() => setPlusOpen(false)}
        anchorRef={plusRef}
        side="top"
        align="start"
        width={224}
        label="Add to this message"
      >
        <PopoverItem
          onSelect={() => void attachFiles()}
          disabled={attachments.length >= MAX_ATTACHMENTS}
          leading={<Paperclip size={16} strokeWidth={1.75} />}
        >
          Attach files…
        </PopoverItem>
        <PopoverItem
          onSelect={() => void attachFolder()}
          disabled={attachments.length >= MAX_ATTACHMENTS}
          leading={<FolderInput size={16} strokeWidth={1.75} />}
        >
          Attach folder…
        </PopoverItem>
        <PopoverDivider />
        <PopoverItem
          onSelect={() => {
            setPlusOpen(false)
            insertTrigger('@')
          }}
          leading={<AtSign size={16} strokeWidth={1.75} />}
        >
          Mention a Bot
        </PopoverItem>
        <PopoverItem
          onSelect={() => {
            setPlusOpen(false)
            insertTrigger('/')
          }}
          // A command only exists as the whole message, so this is unavailable
          // once there is something to send.
          disabled={text.length > 0}
          leading={<SquareSlash size={16} strokeWidth={1.75} />}
        >
          Run a command
        </PopoverItem>
      </Popover>

      {picker && anchor && picker.kind === 'mention' ? (
        <MentionPicker
          options={mentionOptions}
          members={members}
          activeIndex={safeIndex}
          anchor={anchor}
          listId={listId}
          optionId={optionId}
          onSelect={commitMention}
          onHover={setActiveIndex}
        />
      ) : null}

      {picker && anchor && picker.kind === 'slash' ? (
        <SlashPicker
          commands={slashCommands}
          activeIndex={safeIndex}
          anchor={anchor}
          listId={listId}
          optionId={optionId}
          onSelect={runSlashCommand}
          onHover={setActiveIndex}
        />
      ) : null}

      {dropRect
        ? createPortal(
            <div
              aria-hidden
              style={{
                position: 'fixed',
                top: dropRect.top,
                left: dropRect.left,
                width: dropRect.width,
                height: dropRect.height,
                zIndex: 'var(--z-overlay)',
                pointerEvents: 'none',
                background: 'var(--overlay)',
                animation: 'scrim-in var(--dur-fast) var(--ease-out-quad)'
              }}
            >
              <div
                className="grid place-items-center"
                style={{
                  position: 'absolute',
                  inset: 8,
                  border: '2px dashed var(--accent)',
                  borderRadius: 'var(--r-5)'
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--fs-ui)',
                    fontWeight: 550,
                    color: 'var(--fg-primary)'
                  }}
                >
                  Drop to attach
                </span>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )

  /** Insert a bare trigger character at the caret and let `syncTrigger` open the picker. */
  function insertTrigger(char: '@' | '/'): void {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    // `/` is only a command at the very start of an empty composer.
    if (char === '/' && ta.value.length > 0) return
    const start = char === '/' ? 0 : ta.selectionStart
    const end = char === '/' ? 0 : ta.selectionEnd
    const before = ta.value.slice(0, start)
    // `@` only triggers at a word boundary, so prepend a space when needed.
    const prefix = char === '@' && before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const insert = `${prefix}${char}`
    const nextText = before + insert + ta.value.slice(end)
    const nextMarks = syncMentions(nextText, marksRef.current)
    applyEdit(start, end, insert, nextText, nextMarks, start + insert.length)
    window.setTimeout(() => {
      const el = taRef.current
      if (el) syncTrigger(el.value, el.selectionStart, marksRef.current)
    }, 0)
  }
}

/* ------------------------------------------------------------------ *
 * Mirror
 * ------------------------------------------------------------------ */

/**
 * Build the mirrored content: plain runs, chip spans, and a zero-width marker at
 * the active trigger so the picker can be anchored to the real caret position.
 *
 * The chips carry the SAME font weight and size as the surrounding text and pay
 * for their padding with an equal negative margin. Anything else — a heavier
 * weight, a leading avatar, real padding — changes glyph advances and slides the
 * whole line out from under the textarea.
 */
function buildMirrorNodes(
  segments: HighlightSegment[],
  anchorIndex: number | null,
  bots: Record<string, Bot | undefined>,
  markerRef: RefObject<HTMLSpanElement | null>
): ReactNode[] {
  const marker = (
    <span
      key="caret-marker"
      ref={markerRef}
      style={{
        display: 'inline-block',
        width: 0,
        // Matching the line box height with `vertical-align: top` keeps this
        // from growing the line it sits on.
        height: 'var(--lh-ui)',
        verticalAlign: 'top'
      }}
    />
  )

  const out: ReactNode[] = []
  let markerPlaced = anchorIndex === null

  for (const segment of segments) {
    if (segment.kind === 'mention') {
      const bot = segment.mark.everyone ? undefined : bots[segment.mark.botId ?? '']
      const accent = bot ? accentOf(bot) : null
      out.push(
        <span
          key={`m-${segment.start}`}
          style={{
            color: accent ? accentVar(accent) : 'var(--accent)',
            background: accent ? accentAlpha(accent, 0.16) : 'var(--accent-soft)',
            borderRadius: 'var(--r-chip)',
            padding: '1px 4px',
            margin: '0 -4px',
            WebkitBoxDecorationBreak: 'clone',
            boxDecorationBreak: 'clone'
          }}
        >
          {segment.text}
        </span>
      )
      continue
    }

    const end = segment.start + segment.text.length
    if (!markerPlaced && anchorIndex !== null && anchorIndex >= segment.start && anchorIndex < end) {
      const cut = anchorIndex - segment.start
      if (cut > 0) out.push(<span key={`t-${segment.start}`}>{segment.text.slice(0, cut)}</span>)
      out.push(marker)
      out.push(<span key={`t-${anchorIndex}`}>{segment.text.slice(cut)}</span>)
      markerPlaced = true
      continue
    }
    out.push(<span key={`t-${segment.start}`}>{segment.text}</span>)
  }

  if (!markerPlaced) out.push(marker)
  return out
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

function guessKind(path: string): AttachmentInput['kind'] {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? 'image' : 'file'
}

function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false
  if (/[\r\n\t]/.test(value)) return false
  return value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value)
}

function fileUrlToPath(url: string): string {
  try {
    const decoded = decodeURI(url.trim().replace(/^file:\/\//, ''))
    // `file:///C:/x` decodes to `/C:/x` on Windows.
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return ''
  }
}

/**
 * Recover filesystem paths from a drop.
 *
 * Electron 32+ removed `File.path`, and the preload bridge exposes no
 * `webUtils.getPathForFile`, so this tries the legacy property, then the
 * platform's URI list. When both come up empty the caller offers the file
 * picker instead of failing quietly.
 */
function pathsFromTransfer(transfer: DataTransfer): string[] {
  const out: string[] = []

  for (const file of Array.from(transfer.files)) {
    const legacy = (file as File & { path?: string }).path
    if (typeof legacy === 'string' && legacy.length > 0) out.push(legacy)
  }
  if (out.length > 0) return out

  const uriList = transfer.getData('text/uri-list') || transfer.getData('text/plain')
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('file://')) {
      const path = fileUrlToPath(trimmed)
      if (path) out.push(path)
    } else if (looksLikePath(trimmed)) {
      out.push(trimmed)
    }
  }
  return out
}
