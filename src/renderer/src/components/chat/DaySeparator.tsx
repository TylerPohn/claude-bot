import { memo } from 'react'
import type { ReactElement } from 'react'

import { formatDaySeparator } from '@/lib/format'

/**
 * The centred day separator — and, in a direct chat, the ONLY place a time
 * appears in the transcript.
 *
 * This is the biggest single departure from a Slack-shaped client: messages
 * carry no per-message timestamp, so the separator is what anchors the reader in
 * time. Its format is verbatim from DESIGN §2.4: `Today 7:58 AM`,
 * `Yesterday 4:12 PM`, `Tuesday 9:03 AM`, `Mar 4 9:03 AM`.
 */
export const DaySeparator = memo(function DaySeparator({ at }: { at: string }): ReactElement {
  return (
    <div
      className="flex justify-center text-[var(--fg-tertiary)]"
      style={{
        margin: '20px 0 12px',
        fontSize: 'var(--fs-meta)',
        lineHeight: 'var(--lh-meta)',
        letterSpacing: 'var(--ls-meta)',
        fontWeight: 400
      }}
    >
      {formatDaySeparator(at)}
    </div>
  )
})
