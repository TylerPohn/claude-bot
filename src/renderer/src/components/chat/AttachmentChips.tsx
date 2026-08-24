import { memo } from 'react'
import type { ReactElement } from 'react'
import { File, FolderOpen, Image as ImageIcon, TriangleAlert } from 'lucide-react'

import type { Attachment } from '@shared/types'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { bridge } from '@/lib/ipc'

/**
 * Attachments on a sent message.
 *
 * v1 attaches files BY PATH — nothing is copied into the app (PRD §17), so a
 * file can legitimately disappear between being attached and being opened. That
 * case is shown rather than hidden: a missing file renders struck through with a
 * warning tint, because silently opening nothing is the worse failure.
 */

export interface AttachmentChipsProps {
  attachments: Attachment[]
  /** `invert` = inside the filled user bubble. */
  tone?: 'default' | 'invert'
  className?: string
}

export const AttachmentChips = memo(function AttachmentChips({
  attachments,
  tone = 'default',
  className
}: AttachmentChipsProps): ReactElement | null {
  if (attachments.length === 0) return null
  const invert = tone === 'invert'

  return (
    <div className={cn('flex flex-wrap', className)} style={{ gap: 6, marginTop: 6 }}>
      {attachments.map((attachment) => {
        const Icon =
          attachment.kind === 'folder' ? FolderOpen : attachment.kind === 'image' ? ImageIcon : File
        const size = formatBytes(attachment.sizeBytes)

        return (
          <button
            key={attachment.id}
            type="button"
            disabled={attachment.missing}
            onClick={() => void bridge().system.openPath(attachment.path)}
            title={attachment.missing ? `Missing: ${attachment.path}` : attachment.path}
            className={cn(
              'no-drag flex max-w-full items-center transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
              !attachment.missing && 'hover:bg-[var(--surface-active)]'
            )}
            style={{
              height: 26,
              padding: '0 9px',
              gap: 6,
              borderRadius: 'var(--r-full)',
              background: invert ? 'rgba(128,128,128,0.18)' : 'var(--chip-bg)',
              border: `1px solid ${
                attachment.missing
                  ? 'var(--fg-danger)'
                  : invert
                    ? 'rgba(128,128,128,0.28)'
                    : 'var(--border-1)'
              }`,
              cursor: attachment.missing ? 'default' : 'pointer'
            }}
          >
            {attachment.missing ? (
              <TriangleAlert
                size={13}
                strokeWidth={1.75}
                className="shrink-0"
                style={{ color: 'var(--fg-danger)' }}
              />
            ) : (
              <Icon
                size={13}
                strokeWidth={1.75}
                className="shrink-0"
                style={{ color: invert ? 'currentColor' : 'var(--fg-secondary)', opacity: 0.85 }}
              />
            )}
            <span
              className="truncate"
              style={{
                fontSize: 'var(--fs-meta)',
                lineHeight: 'var(--lh-meta)',
                letterSpacing: 'var(--ls-meta)',
                fontWeight: 550,
                textDecoration: attachment.missing ? 'line-through' : undefined,
                color: attachment.missing ? 'var(--fg-danger)' : undefined,
                maxWidth: 220
              }}
            >
              {attachment.name}
            </span>
            {size && !attachment.missing ? (
              <span
                className="shrink-0"
                style={{
                  fontSize: 'var(--fs-micro)',
                  opacity: 0.6,
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {size}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
})
