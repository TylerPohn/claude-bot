import type { ReactElement } from 'react'

import { BotList } from '@/components/bots/BotList'

/**
 * The manage-all roster, embedded rather than reimplemented.
 *
 * `BotList` brings its own filter row, empty state and internal scroller, so it
 * needs a height-constrained parent and nothing else — the tab supplies the same
 * 24px gutter the other panes use and then gets out of the way. Its own body
 * must not scroll, or the grid would end up with two nested scrollbars.
 *
 * Opening the Bot sheet from here replaces this dialog: `uiStore` holds exactly
 * one modal, which is deliberate — two stacked dialogs is a worse outcome than
 * losing your place in Settings.
 */
export function BotsTab(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ padding: '4px 24px 24px' }}>
      <BotList className="flex-1" />
    </div>
  )
}
