import { useCallback } from 'react'
import type { ReactElement } from 'react'
import { Square } from 'lucide-react'

import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'

/**
 * Stop (DESIGN §4.4, PRD §22).
 *
 * Stop is always available and always visible while a run is in flight, in two
 * shapes that share one code path: the labelled pill above the composer (which
 * says how many Bots it will stop) and the circular glyph inside the pill.
 *
 * The confirm copy is fixed and non-negotiable — stopping kills the Claude Code
 * process group, but a file that was already written stays written, and implying
 * otherwise would be a lie the user only discovers later.
 */

export const STOP_NOTE = "This doesn't undo actions already completed."

export interface StopRequest {
  /** Bots with a running or queued job in this conversation. */
  count: number
  label: string
  requestStop(): void
}

/**
 * Shared by the pill, the in-pill glyph and the `⌘⇧K` shortcut, so all three
 * ask the same question and take the same action.
 */
export function useStopRequest(conversationId: string, onStopped?: () => void): StopRequest {
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const bots = useAppStore((s) => s.bots)
  const stopConversation = useAppStore((s) => s.stopConversation)
  const confirm = useUiStore((s) => s.confirm)

  const names: string[] = []
  if (conversation) {
    const seen = new Set<string>()
    for (const id of [...conversation.runningBotIds, ...conversation.queuedBotIds]) {
      if (seen.has(id)) continue
      seen.add(id)
      names.push(bots[id]?.name ?? 'Bot')
    }
  }

  const count = names.length
  const label = count > 1 ? `Stop ${count} Bots` : `Stop ${names[0] ?? 'Bot'}`
  const title = count > 1 ? `Stop ${count} Bots?` : `Stop ${names[0] ?? 'this Bot'}?`

  const requestStop = useCallback(() => {
    if (count === 0) return
    confirm({
      title,
      body: `Partial output stays in the transcript. ${STOP_NOTE}`,
      confirmLabel: 'Stop',
      danger: true,
      onConfirm: () => {
        void stopConversation(conversationId)
        onStopped?.()
      }
    })
  }, [confirm, conversationId, count, onStopped, stopConversation, title])

  return { count, label, requestStop }
}

export interface StopButtonProps {
  conversationId: string
  variant?: 'pill' | 'glyph'
  /** Fired once the stop request is sent, so the caller can surface the note. */
  onStopped?(): void
}

export function StopButton({
  conversationId,
  variant = 'pill',
  onStopped
}: StopButtonProps): ReactElement | null {
  const { count, label, requestStop } = useStopRequest(conversationId, onStopped)

  if (count === 0) return null

  if (variant === 'glyph') {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={requestStop}
        className="no-drag grid shrink-0 place-items-center rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-active)] active:scale-[0.96]"
        style={{ width: 32, height: 32, background: 'var(--surface-3)', color: 'var(--fg-primary)' }}
      >
        {/* A FILLED square: the outline glyph at this size reads as an empty
            checkbox rather than a stop control. */}
        <Square size={12} strokeWidth={1.75} fill="currentColor" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={requestStop}
      className="no-drag inline-flex items-center transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-active)] active:scale-[0.98]"
      style={{
        height: 28,
        gap: 7,
        padding: '0 12px 0 10px',
        borderRadius: 'var(--r-chip)',
        background: 'var(--surface-3)',
        color: 'var(--fg-primary)',
        fontSize: 'var(--fs-meta)',
        lineHeight: 'var(--lh-meta)',
        letterSpacing: 'var(--ls-meta)',
        fontWeight: 550
      }}
    >
      <Square size={11} strokeWidth={1.75} fill="currentColor" />
      {label}
    </button>
  )
}
