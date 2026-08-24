import type { ReactElement } from 'react'
import { FileText, Folder, Image as ImageIcon, TriangleAlert, X } from 'lucide-react'

import type { AttachmentInput } from '@shared/schemas'
import { formatBytes } from '@/lib/format'
import { Tooltip } from '@/components/ui/Tooltip'

/**
 * The attachment tray (DESIGN §2.5 / §3.6): sits directly above the pill, 64px
 * tall with an 8px gap, and scrolls horizontally rather than wrapping — a
 * wrapping tray pushes the composer around as files are added.
 *
 * v1 attachments are local PATHS, not uploads (PRD §17.1): nothing is copied,
 * the path is handed to Claude Code, and a file that has since moved is shown
 * struck through instead of failing silently at send time.
 */

export interface AttachmentTrayProps {
  attachments: AttachmentInput[]
  /** Paths that failed a `pathExists` check. */
  missing: Record<string, boolean>
  onRemove(index: number): void
}

function iconFor(kind: AttachmentInput['kind']): ReactElement {
  if (kind === 'folder') return <Folder size={18} strokeWidth={1.75} />
  if (kind === 'image') return <ImageIcon size={18} strokeWidth={1.75} />
  return <FileText size={18} strokeWidth={1.75} />
}

export function AttachmentTray({
  attachments,
  missing,
  onRemove
}: AttachmentTrayProps): ReactElement | null {
  if (attachments.length === 0) return null

  return (
    <div
      className="scroller flex shrink-0 items-center overflow-x-auto"
      // 8px of top padding, not a fixed height: `overflow-x: auto` forces
      // `overflow-y` to compute to auto, so the remove button's -6px overhang
      // would otherwise be clipped or spawn a vertical scrollbar. 8 + 56 = the
      // 64px tray the spec asks for.
      // `overscroll-behavior-y: auto` undoes `.scroller`'s `contain` on an axis
      // this tray cannot scroll: with `contain` a wheel gesture over the tray was
      // swallowed instead of chaining to whatever is behind it.
      style={{
        gap: 8,
        paddingTop: 8,
        marginBottom: 8,
        overflowY: 'hidden',
        overscrollBehaviorX: 'contain',
        overscrollBehaviorY: 'auto'
      }}
      aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
    >
      {attachments.map((attachment, index) => {
        const isMissing = missing[attachment.path] === true
        const subtitle = isMissing
          ? 'Missing'
          : attachment.kind === 'folder'
            ? 'Folder'
            : // An unknown size formats to an empty string; never show a blank line.
              formatBytes(attachment.sizeBytes ?? null) || 'File'

        return (
          <div
            key={`${attachment.path}-${index}`}
            className="hover-target relative flex shrink-0 items-center"
            style={{
              height: 56,
              padding: 8,
              gap: 10,
              borderRadius: 'var(--r-5)',
              background: 'var(--surface-2)',
              // Tinted from the warning token rather than a literal yellow, so
              // the light theme gets its own (much darker) amber.
              border: isMissing
                ? '1px solid color-mix(in srgb, var(--fg-warning) 40%, transparent)'
                : '1px solid var(--border-1)'
            }}
          >
            <span
              className="grid shrink-0 place-items-center"
              style={{
                width: 40,
                height: 40,
                borderRadius: 'var(--r-4)',
                background: isMissing
                  ? 'color-mix(in srgb, var(--fg-warning) 14%, transparent)'
                  : 'var(--chip-bg)',
                color: isMissing ? 'var(--fg-warning)' : 'var(--fg-secondary)'
              }}
            >
              {isMissing ? <TriangleAlert size={18} strokeWidth={1.75} /> : iconFor(attachment.kind)}
            </span>

            <span className="flex min-w-0 flex-col justify-center" style={{ gap: 2 }}>
              <Tooltip label={attachment.path} side="top">
                <span
                  className="truncate"
                  style={{
                    maxWidth: 168,
                    fontSize: 'var(--fs-meta)',
                    lineHeight: 'var(--lh-meta)',
                    fontWeight: 550,
                    color: 'var(--fg-primary)',
                    textDecoration: isMissing ? 'line-through' : undefined
                  }}
                >
                  {attachment.name}
                </span>
              </Tooltip>
              <span
                style={{
                  fontSize: 'var(--fs-micro)',
                  lineHeight: 'var(--lh-micro)',
                  color: isMissing ? 'var(--fg-warning)' : 'var(--fg-tertiary)'
                }}
              >
                {subtitle}
              </span>
            </span>

            {/* Absolutely positioned so revealing it can never reflow the tray;
                `.hover-actions` toggles opacity only, so it stays tabbable. */}
            <button
              type="button"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => onRemove(index)}
              className="hover-actions no-drag absolute grid place-items-center rounded-full"
              style={{
                top: -6,
                right: -6,
                width: 20,
                height: 20,
                background: 'var(--surface-3)',
                border: '1px solid var(--border-2)',
                color: 'var(--fg-secondary)',
                boxShadow: 'var(--shadow-low)'
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
