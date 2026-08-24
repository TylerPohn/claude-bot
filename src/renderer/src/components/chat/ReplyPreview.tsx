import type { ReactElement } from 'react'

import { cn } from '@/lib/cn'
import { plainTextPreview } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { ACCENT_HEX } from '@/components/ui/BotAvatar'

/**
 * The quoted stub shown at the top of a message that replies to another one
 * (PRD §18). Clicking it scrolls the transcript to the original and flashes it,
 * which is what makes flat replies workable without a separate thread pane.
 */

export interface ReplyPreviewProps {
  /** The message being replied TO. */
  messageId: string
  /** Scoped lookup — scanning every loaded transcript on each delta is not free. */
  conversationId: string
  /** `invert` = sitting inside the filled user bubble. */
  tone?: 'default' | 'invert'
  className?: string
}

export function ReplyPreview({
  messageId,
  conversationId,
  tone = 'default',
  className
}: ReplyPreviewProps): ReactElement | null {
  const target = useAppStore((state) =>
    state.messages[conversationId]?.find((message) => message.id === messageId)
  )

  const invert = tone === 'invert'
  const accent = target?.authorAccent ?? null
  const accentColor = accent ? ACCENT_HEX[accent] : 'var(--fg-secondary)'

  const author = target
    ? target.authorType === 'user'
      ? 'You'
      : (target.authorName ?? 'Bot')
    : 'Message'

  const preview = target
    ? plainTextPreview(target.bodyMarkdown, 90) || 'No text'
    : 'This message is no longer loaded'

  return (
    <button
      type="button"
      onClick={() => useUiStore.getState().jumpTo(messageId)}
      disabled={!target}
      title={target ? 'Jump to the replied-to message' : undefined}
      className={cn('flex w-full min-w-0 items-stretch gap-[8px] text-left', className)}
      style={{
        marginBottom: 6,
        opacity: invert ? 0.75 : 1,
        cursor: target ? 'pointer' : 'default'
      }}
    >
      <span
        aria-hidden
        className="shrink-0 self-stretch rounded-full"
        style={{ width: 2, background: invert ? 'currentColor' : accentColor }}
      />
      <span className="flex min-w-0 flex-col" style={{ gap: 1, paddingLeft: 2 }}>
        <span
          className="truncate"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontWeight: 550,
            color: invert ? 'inherit' : accentColor
          }}
        >
          {author}
        </span>
        <span
          className="truncate"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            color: invert ? 'inherit' : 'var(--fg-secondary)'
          }}
        >
          {preview}
        </span>
      </span>
    </button>
  )
}
