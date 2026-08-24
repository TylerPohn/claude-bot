import type { ReactElement } from 'react'

import type { AvatarType, BotAccent } from '@shared/types'
import { cn } from '@/lib/cn'
import { BotAvatar } from '@/components/ui/BotAvatar'

/**
 * The live preview at the top of the Bot editor.
 *
 * Two things are previewed, because they are the two places a Bot is actually
 * recognised: the identity block (avatar + name + job) and a pixel-faithful copy
 * of the 60px sidebar row it will occupy — same 40px avatar, same 15/550 name,
 * same 13px preview line, same fixed height (DESIGN §2.2). Showing the row is
 * what makes the colour and shape choice feel consequential instead of decorative.
 */

export interface BotPreviewCardProps {
  name: string
  title: string
  avatarType: AvatarType
  avatarValue: string
  accent: BotAccent
  /** Standing instructions — used only for the sidebar row's preview line. */
  description?: string
  className?: string
}

export function BotPreviewCard({
  name,
  title,
  avatarType,
  avatarValue,
  accent,
  description,
  className
}: BotPreviewCardProps): ReactElement {
  const displayName = name.trim() || 'Unnamed Bot'
  const displayTitle = title.trim()
  // The sidebar shows the last message; a Bot with no history shows the same
  // "No messages yet" line the real row uses, so nothing here is invented data.
  const preview = 'No messages yet'

  return (
    <section
      aria-label="Preview"
      className={cn('flex flex-col', className)}
      style={{
        gap: 12,
        padding: 14,
        background: 'var(--surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-6)'
      }}
    >
      <div className="flex items-center" style={{ gap: 12 }}>
        <BotAvatar
          avatarType={avatarType}
          avatarValue={avatarValue}
          accent={accent}
          name={displayName}
          size={44}
        />
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
          <p
            className="truncate text-[var(--fg-primary)]"
            style={{
              fontSize: 'var(--fs-title)',
              lineHeight: 'var(--lh-title)',
              letterSpacing: 'var(--ls-title)',
              fontWeight: 550
            }}
          >
            {displayName}
          </p>
          <p
            className="truncate"
            style={{
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              letterSpacing: 'var(--ls-meta)',
              color: displayTitle ? 'var(--fg-secondary)' : 'var(--fg-quaternary)'
            }}
          >
            {displayTitle || 'No job title yet'}
          </p>
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: 6 }}>
        <p
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontWeight: 510
          }}
        >
          In your sidebar
        </p>

        {/* A faithful copy of the real row, on the real sidebar surface. Not
            interactive and hidden from assistive tech — it is an illustration,
            and a screen reader announcing a fake conversation would be a lie. */}
        <div
          aria-hidden
          style={{
            background: 'var(--surface-1)',
            borderRadius: 'var(--r-5)',
            padding: '0 8px',
            border: '1px solid var(--border-1)'
          }}
        >
          <div className="flex items-center" style={{ height: 60, gap: 10, padding: '10px 8px' }}>
            <BotAvatar
              avatarType={avatarType}
              avatarValue={avatarValue}
              accent={accent}
              name={displayName}
              size={40}
            />
            <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
              <span className="flex items-baseline" style={{ gap: 8 }}>
                <span
                  className="min-w-0 flex-1 truncate text-[var(--fg-primary)]"
                  style={{
                    fontSize: 'var(--fs-ui)',
                    lineHeight: '20px',
                    letterSpacing: 'var(--ls-ui)',
                    fontWeight: 550
                  }}
                >
                  {displayName}
                </span>
                <span
                  className="shrink-0 text-[var(--fg-tertiary)]"
                  style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px' }}
                >
                  now
                </span>
              </span>
              <span
                className="min-w-0 truncate text-[var(--fg-secondary)]"
                style={{
                  fontSize: 'var(--fs-meta)',
                  lineHeight: '18px',
                  letterSpacing: 'var(--ls-meta)'
                }}
              >
                {description?.trim() ? firstLine(description) : preview}
              </span>
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/** First sentence-ish of the standing instructions, for the preview line. */
function firstLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat
}
