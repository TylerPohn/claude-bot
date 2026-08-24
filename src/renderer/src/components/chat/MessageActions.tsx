import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement, Ref } from 'react'
import { Check, Copy, CornerUpLeft, RotateCcw, SmilePlus, Trash2 } from 'lucide-react'

import type { Message } from '@shared/types'
import { cn } from '@/lib/cn'
import { bridge } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Popover } from '@/components/ui/Popover'
import { focusComposer } from '@/components/composer/Composer'
import { REACTION_EMOJI } from './ReactionBar'

/**
 * The hover action bar for one message.
 *
 * Three rules from the polish checklist, all of them non-negotiable:
 *
 *  - It is ABSOLUTELY POSITIONED, so it can never reflow the message it belongs
 *    to. A bar that pushes text sideways on hover makes a transcript feel loose.
 *  - It stays in the DOM permanently and toggles OPACITY only (`.hover-actions`),
 *    so focus traversal keeps working and nothing shifts as it appears.
 *  - It reveals on `:hover` and `:focus-within` of the message *and* of the bar
 *    itself, so a keyboard user can tab into it without it disappearing.
 *
 * KEYBOARD. The buttons are deliberately OUT of the sequential tab order
 * (`tabIndex={-1}`): with them in it, a 160-message transcript put 724 tab stops
 * between the log and the composer and forward-tabbing never terminated, because
 * scrolling old rows into view paged in 80 more messages. `MessageList` owns a
 * roving tab index over the message rows instead and moves focus in here with →
 * from the focused row; this bar is a `role="toolbar"`, which is the ARIA
 * contract for "arrow keys move between the controls".
 */

export interface MessageActionsProps {
  message: Message
  /** Which side of the bubble the message sits on. */
  align: 'left' | 'right'
}

export function MessageActions({ message, align }: MessageActionsProps): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const reactRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  // The emoji row IS the payload of the "Add reaction" action, and `Popover`
  // does no focus management of its own. Without this a keyboard user opened a
  // picker they could not reach: the portal renders at the end of <body>, so
  // Tab from the trigger walked the rest of the transcript first.
  useEffect(() => {
    if (!pickerOpen) return
    // One frame late on purpose: `Popover` renders itself `visibility: hidden`
    // until a layout effect has measured and placed it, and a hidden element
    // cannot take focus at all.
    const frame = requestAnimationFrame(() => {
      pickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      // Hand focus back to the trigger rather than letting it fall to <body>,
      // which would restart Tab at the top of the app — but only if the picker
      // still had it, so closing by clicking something else never yanks focus
      // away from whatever the user just clicked.
      const active = document.activeElement
      if (active === null || active === document.body) {
        reactRef.current?.focus({ preventScroll: true })
      }
    }
  }, [pickerOpen])

  const isBot = message.authorType === 'bot'
  const canRetry = isBot || message.status === 'error'

  const copy = (): void => {
    void bridge().system.copyText(message.bodyMarkdown)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const reply = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    useUiStore.getState().setDraft(message.conversationId, { replyToId: message.id })
    // Picking a reply target without moving the caret left focus on this button,
    // which is `tabIndex={-1}` — so the next thing the user typed went nowhere
    // at all. `detail === 0` marks a keyboard activation, where the composer's
    // focus ring is wanted; a real click reports its click count.
    focusComposer(message.conversationId, { keyboard: event.detail === 0 })
  }

  const remove = (): void => {
    useUiStore.getState().confirm({
      title: 'Delete this message?',
      body: 'It is removed from the transcript on this computer. Anything the Bot already did on disk is not undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void useAppStore.getState().deleteMessage(message.id)
      }
    })
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="Message actions"
        aria-orientation="horizontal"
        className={cn(
          'hover-actions msg-actions absolute z-[var(--z-base)] flex items-center',
          align === 'right' ? 'left-0' : 'right-0'
        )}
        style={{
          top: 0,
          transform: 'translateY(-50%)',
          height: 28,
          padding: 4,
          gap: 2,
          borderRadius: 'var(--r-4)',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-1)',
          boxShadow: 'var(--shadow-low)',
          // While the emoji picker is open the bar must stay visible even though
          // the pointer has left the message.
          opacity: pickerOpen ? 1 : undefined,
          pointerEvents: pickerOpen ? 'auto' : undefined
        }}
      >
        <ActionButton ref={reactRef} label="Add reaction" onClick={() => setPickerOpen(true)}>
          <SmilePlus size={14} strokeWidth={1.75} />
        </ActionButton>

        <ActionButton label="Reply" onClick={reply}>
          <CornerUpLeft size={14} strokeWidth={1.75} />
        </ActionButton>

        <ActionButton label={copied ? 'Copied' : 'Copy message'} onClick={copy}>
          {copied ? (
            <Check size={14} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
          ) : (
            <Copy size={14} strokeWidth={1.75} />
          )}
        </ActionButton>

        {canRetry ? (
          <ActionButton
            label={message.status === 'error' ? 'Retry' : 'Ask again'}
            onClick={() => void useAppStore.getState().retryMessage(message.id)}
          >
            <RotateCcw size={14} strokeWidth={1.75} />
          </ActionButton>
        ) : null}

        <ActionButton label="Delete message" onClick={remove} danger>
          <Trash2 size={14} strokeWidth={1.75} />
        </ActionButton>
      </div>

      <Popover
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchorRef={reactRef}
        align={align === 'right' ? 'start' : 'end'}
        width={176}
        label="Add a reaction"
      >
        <div ref={pickerRef} className="flex items-center" style={{ padding: 4, gap: 2 }}>
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                void useAppStore.getState().react(message.id, emoji)
                setPickerOpen(false)
              }}
              className="grid place-items-center rounded-[var(--r-3)] transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-hover)] active:scale-[0.92]"
              style={{ width: 38, height: 34, fontSize: 18, fontFamily: 'var(--font-emoji)' }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * 24×24 action button
 * ------------------------------------------------------------------ */

interface ActionButtonProps {
  label: string
  onClick(event: ReactMouseEvent<HTMLButtonElement>): void
  danger?: boolean
  children: ReactElement
  ref?: Ref<HTMLButtonElement>
}

function ActionButton({ label, onClick, danger, children, ref }: ActionButtonProps): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'no-drag grid shrink-0 place-items-center rounded-[var(--r-3)]',
        'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'hover:bg-[var(--surface-hover)] active:scale-[0.94]',
        danger
          ? 'text-[var(--fg-tertiary)] hover:text-[var(--fg-danger)]'
          : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
      )}
      // Never a sequential tab stop — see the KEYBOARD note at the top of this
      // file. Reachable with → from the focused message row.
      tabIndex={-1}
      style={{ width: 24, height: 24 }}
    >
      {children}
    </button>
  )
}
