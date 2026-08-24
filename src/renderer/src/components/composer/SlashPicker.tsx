import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { Brain, Eraser, FolderCog, ShieldCheck, UserPlus, Users } from 'lucide-react'

import type { CaretAnchor } from './MentionPicker'
import { PickerEmpty, PickerHeading, PickerPanel } from './MentionPicker'

/**
 * The `/` picker: the six v1 app commands from PRD §30.
 *
 * These are APP commands, not Claude Code slash commands and not skills —
 * selecting one opens the matching surface and never sends text to a Bot.
 * Discovering the user's real Claude Code commands is explicitly phase 2
 * (PRD §31), so nothing here pretends to list them.
 */

export type SlashCommandId =
  | 'newbot'
  | 'newgroup'
  | 'clear-ui'
  | 'workspace'
  | 'model'
  | 'permissions'

export interface SlashCommand {
  id: SlashCommandId
  /** The literal token, including the slash. */
  token: string
  description: string
  icon: ReactElement
}

const ICON = { size: 16, strokeWidth: 1.75 } as const

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'newbot', token: '/newbot', description: 'Create a Bot', icon: <UserPlus {...ICON} /> },
  { id: 'newgroup', token: '/newgroup', description: 'Start a group', icon: <Users {...ICON} /> },
  {
    id: 'clear-ui',
    token: '/clear-ui',
    description: 'Clear this transcript view',
    icon: <Eraser {...ICON} />
  },
  {
    id: 'workspace',
    token: '/workspace',
    description: 'Working directory',
    icon: <FolderCog {...ICON} />
  },
  { id: 'model', token: '/model', description: 'Model for this chat', icon: <Brain {...ICON} /> },
  {
    id: 'permissions',
    token: '/permissions',
    description: 'Permission mode',
    icon: <ShieldCheck {...ICON} />
  }
]

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((command) => command.id.startsWith(q))
}

export interface SlashPickerProps {
  commands: SlashCommand[]
  activeIndex: number
  anchor: CaretAnchor
  listId: string
  optionId(index: number): string
  onSelect(command: SlashCommand): void
  onHover(index: number): void
}

export function SlashPicker({
  commands,
  activeIndex,
  anchor,
  listId,
  optionId,
  onSelect,
  onHover
}: SlashPickerProps): ReactElement {
  const activeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <PickerPanel anchor={anchor} id={listId} label="App commands">
      <PickerHeading>Commands</PickerHeading>
      {commands.length === 0 ? <PickerEmpty>No matching command</PickerEmpty> : null}
      {commands.map((command, index) => {
        const active = index === activeIndex
        return (
          <div
            key={command.id}
            id={optionId(index)}
            ref={active ? activeRef : undefined}
            role="option"
            aria-selected={active}
            onMouseMove={() => onHover(index)}
            onMouseDown={(e) => {
              // Keep the caret in the textarea; the composer owns the edit.
              e.preventDefault()
              onSelect(command)
            }}
            className="flex cursor-default items-center rounded-[8px]"
            style={{
              height: 40,
              padding: '0 10px',
              gap: 10,
              background: active ? 'var(--surface-2)' : 'transparent'
            }}
          >
            <span
              className="grid shrink-0 place-items-center"
              style={{ width: 16, height: 16, color: 'var(--fg-secondary)' }}
            >
              {command.icon}
            </span>
            <span
              className="min-w-0 flex-1 truncate"
              style={{
                fontSize: 'var(--fs-chrome)',
                lineHeight: 'var(--lh-chrome)',
                letterSpacing: 'var(--ls-chrome)',
                fontWeight: 550,
                fontFamily: 'var(--font-mono)',
                color: 'var(--fg-primary)'
              }}
            >
              {command.token}
            </span>
            <span
              className="shrink-0 truncate"
              style={{
                maxWidth: 150,
                fontSize: 'var(--fs-micro)',
                lineHeight: 'var(--lh-micro)',
                color: 'var(--fg-tertiary)'
              }}
            >
              {command.description}
            </span>
          </div>
        )
      })}
    </PickerPanel>
  )
}
