import type { ReactElement, ReactNode } from 'react'

import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Kbd } from './Kbd'
import { Modal } from './Modal'

/**
 * Help ▸ Keyboard Shortcuts (DESIGN §4.8).
 *
 * The app's keyboard model was previously surfaced NOWHERE: ⌘B collapsed the
 * sidebar with no menu entry and no visible control, and the transcript's arrow
 * navigation — genuinely good, and the only way to reach a message's action bar
 * from the keyboard — was undiscoverable. A shortcut that no surface mentions
 * may as well not exist.
 *
 * EVERY row below is a binding that actually works; nothing here is aspirational.
 * If you add a shortcut, add it here in the same change, and if you remove one,
 * remove it here — a shortcuts sheet that lies is worse than none at all.
 * (It lives in ui/ because it is nothing but Modal + Kbd.)
 */

interface Shortcut {
  keys: ReactNode
  label: string
}

function Row({ keys, label }: Shortcut): ReactElement {
  return (
    <div className="flex items-center gap-[16px]" style={{ minHeight: 28 }}>
      <span
        className="min-w-0 flex-1 text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
      >
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-[4px]">{keys}</span>
    </div>
  )
}

function Group({ title, rows }: { title: string; rows: Shortcut[] }): ReactElement {
  return (
    <section className="mb-[18px] last:mb-0">
      <h3
        className="mb-[6px] text-[var(--fg-tertiary)]"
        style={{
          fontSize: 'var(--fs-nano)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 550
        }}
      >
        {title}
      </h3>
      <div className="flex flex-col">
        {rows.map((row) => (
          <Row key={row.label} keys={row.keys} label={row.label} />
        ))}
      </div>
    </section>
  )
}

export function ShortcutsDialog(): ReactElement | null {
  const modal = useUiStore((s) => s.modal)
  const closeModal = useUiStore((s) => s.closeModal)
  // The send key is a preference, so the sheet has to read it rather than
  // hard-code Enter — telling half the users the wrong key is the exact failure
  // this surface exists to prevent.
  const sendKey = useAppStore((s) => s.settings?.sendKey ?? 'enter')

  if (!modal || modal.kind !== 'shortcuts') return null

  const send = sendKey === 'mod+enter' ? 'mod+enter' : 'enter'
  const newline = sendKey === 'mod+enter' ? 'enter' : 'shift+enter'

  return (
    <Modal width={520} onClose={closeModal} title="Keyboard shortcuts">
      <Group
        title="App"
        rows={[
          { keys: <Kbd keys="mod+k" />, label: 'Command palette' },
          { keys: <Kbd keys="mod+f" />, label: 'Search every message' },
          { keys: <Kbd keys="mod+n" />, label: 'New Bot' },
          { keys: <Kbd keys="mod+shift+n" />, label: 'New Group Chat' },
          { keys: <Kbd keys="mod+," />, label: 'Settings' },
          { keys: <Kbd keys="mod+r" />, label: 'Reload the window' }
        ]}
      />
      <Group
        title="Layout"
        rows={[
          { keys: <Kbd keys="mod+b" />, label: 'Show or hide the sidebar' },
          { keys: <Kbd keys="mod+i" />, label: 'Conversation details' }
        ]}
      />
      <Group
        title="Conversations"
        rows={[
          {
            keys: (
              <>
                <Kbd keys="ctrl+tab" />
                <span style={{ fontSize: 'var(--fs-nano)', color: 'var(--fg-quaternary)' }}>/</span>
                <Kbd keys="ctrl+shift+tab" />
              </>
            ),
            label: 'Next / previous conversation'
          },
          {
            keys: (
              <>
                <Kbd keys="mod+1" />
                <span style={{ fontSize: 'var(--fs-nano)', color: 'var(--fg-quaternary)' }}>–</span>
                <Kbd keys="mod+9" />
              </>
            ),
            label: 'Jump to sidebar position'
          },
          { keys: <Kbd keys="mod+shift+u" />, label: 'Mark this conversation read' },
          { keys: <Kbd keys="mod+shift+e" />, label: 'Export transcript as Markdown' }
        ]}
      />
      <Group
        title="Composer"
        rows={[
          { keys: <Kbd keys={send} />, label: 'Send' },
          { keys: <Kbd keys={newline} />, label: 'New line' },
          { keys: <Kbd keys="up" />, label: 'Edit your last message (empty composer)' },
          { keys: <Kbd keys="@" />, label: 'Mention a Bot' },
          { keys: <Kbd keys="/" />, label: 'Insert a skill' },
          { keys: <Kbd keys="escape" />, label: 'Dismiss picker → leave the composer' }
        ]}
      />
      {/* Both keys kill the running Claude Code processes for the focused
          conversation; the only difference is the confirmation. ⌘⇧K used to be
          documented as sending a “Stop now” message — copy inherited from
          DESIGN §4.4.3, which assumes a product with no stop API. This one
          spawns real processes and kills them, so no such message exists
          anywhere in the app. Describe what the keys do, or the dialog teaches
          a behaviour the user will wait for and never see. */}
      <Group
        title="While a Bot is working"
        rows={[
          { keys: <Kbd keys="mod+." />, label: 'Stop this conversation immediately' },
          { keys: <Kbd keys="mod+shift+k" />, label: 'Stop, after a confirmation' }
        ]}
      />
      <Group
        title="Transcript"
        rows={[
          {
            keys: (
              <>
                <Kbd keys="up" />
                <Kbd keys="down" />
              </>
            ),
            label: 'Move between messages'
          },
          { keys: <Kbd keys="right" />, label: 'Enter the focused message’s actions' },
          { keys: <Kbd keys="left" />, label: 'Leave the action bar' }
        ]}
      />
    </Modal>
  )
}
