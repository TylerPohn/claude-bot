import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, ChevronDown, Shuffle, Users } from 'lucide-react'

import type { Bot } from '@shared/types'
import type { SendMessageInput } from '@shared/schemas'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Popover } from '@/components/ui/Popover'
import { Tooltip } from '@/components/ui/Tooltip'

/**
 * Group routing (PRD §11.4). With no `@mention` typed, SOMETHING has to decide
 * which Bot answers, and guessing silently is the worst option — so the choice
 * is visible above the pill and defaults to `Auto`.
 *
 * `Auto` runs the local deterministic router in main (default responder → the
 * only idle Bot → first member). It deliberately does NOT spend a Claude request
 * on choosing a Bot.
 *
 * Hidden entirely in a direct chat, and hidden while a mention is present —
 * an explicit `@` outranks this control, and showing both invites the reader to
 * wonder which one wins.
 */

export type Routing = NonNullable<SendMessageInput['routing']>

const AUTO_TOOLTIP =
  'Auto picks one Bot with a local rule — the group’s default responder, otherwise the only idle Bot, otherwise the first member.\nMention a Bot with @ to be explicit.'

export interface RoutingSelectorProps {
  members: Bot[]
  value: Routing
  onChange(next: Routing): void
}

export function RoutingSelector({ members, value, onChange }: RoutingSelectorProps): ReactElement {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  const selectedBot = value.mode === 'bot' ? members.find((b) => b.id === value.botId) : undefined
  const label =
    value.mode === 'everyone' ? 'Everyone' : value.mode === 'bot' ? (selectedBot?.name ?? 'Auto') : 'Auto'

  const leading =
    value.mode === 'everyone' ? (
      <Users size={13} strokeWidth={1.75} />
    ) : selectedBot ? (
      <BotAvatar bot={selectedBot} size={14} />
    ) : (
      <Shuffle size={13} strokeWidth={1.75} />
    )

  const trigger = (
    <button
      ref={anchorRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="no-drag inline-flex items-center transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
      style={{
        height: 26,
        gap: 6,
        padding: '0 8px 0 7px',
        borderRadius: 'var(--r-chip)',
        background: value.mode === 'auto' ? 'var(--chip-bg)' : 'var(--surface-2)',
        color: value.mode === 'everyone' ? 'var(--attention)' : 'var(--fg-secondary)',
        fontSize: 'var(--fs-micro)',
        lineHeight: 'var(--lh-micro)',
        letterSpacing: 'var(--ls-micro)',
        fontWeight: 510
      }}
    >
      {leading}
      <span className="max-w-[140px] truncate">{label}</span>
      <ChevronDown size={12} strokeWidth={2} style={{ opacity: 0.7 }} />
    </button>
  )

  return (
    <div className="flex shrink-0 items-center" style={{ gap: 8, paddingBottom: 6 }}>
      <span
        style={{
          fontSize: 'var(--fs-micro)',
          lineHeight: 'var(--lh-micro)',
          color: 'var(--fg-tertiary)'
        }}
      >
        Reply from
      </span>

      {/* Only `Auto` needs explaining; a named Bot explains itself. */}
      {value.mode === 'auto' ? (
        <Tooltip label={AUTO_TOOLTIP} side="top">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        side="top"
        align="start"
        // 320 to match the mention picker (DESIGN §780). At 240 a 226px row left
        // the name column ~60px — "Debug…" for Debugger, "Test En…" for Test
        // Engineer — in the one control that decides who answers, while the
        // picker sitting right next to it showed the same Bots in full.
        width={320}
        label="Choose who answers"
      >
        <RoutingRow
          label="Auto"
          hint="Let the group decide"
          selected={value.mode === 'auto'}
          leading={<Shuffle size={14} strokeWidth={1.75} />}
          onSelect={() => {
            onChange({ mode: 'auto' })
            setOpen(false)
          }}
        />
        {members.map((bot) => (
          <RoutingRow
            key={bot.id}
            label={bot.name}
            hint={bot.title ?? undefined}
            selected={value.mode === 'bot' && value.botId === bot.id}
            leading={<BotAvatar bot={bot} size={16} />}
            onSelect={() => {
              onChange({ mode: 'bot', botId: bot.id })
              setOpen(false)
            }}
          />
        ))}
        <RoutingRow
          label="Everyone"
          hint={`All ${members.length} Bots reply`}
          selected={value.mode === 'everyone'}
          leading={<Users size={14} strokeWidth={1.75} />}
          onSelect={() => {
            onChange({ mode: 'everyone' })
            setOpen(false)
          }}
        />
      </Popover>
    </div>
  )
}

function RoutingRow({
  label,
  hint,
  selected,
  leading,
  onSelect
}: {
  label: string
  hint?: string
  selected: boolean
  leading: ReactElement
  onSelect(): void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-center rounded-[6px] text-left transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-hover)]"
      style={{ height: 34, padding: '0 8px', gap: 8 }}
    >
      <span
        className="grid shrink-0 place-items-center"
        style={{ width: 16, height: 16, color: 'var(--fg-secondary)' }}
      >
        {leading}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate"
          style={{ fontSize: 'var(--fs-chrome)', color: 'var(--fg-primary)' }}
        >
          {label}
        </span>
      </span>
      {hint ? (
        <span
          // THE HINT YIELDS FIRST. It used to be `shrink-0` with a fixed 96px
          // cap, so the name — `flex-1`, i.e. flex-basis 0 — absorbed the whole
          // shortfall and truncated long before the job title did. `0 1 auto`
          // takes only the width it needs (a short hint hands the rest back to
          // the name) and a proportional cap bounds the long ones.
          className="min-w-0 truncate"
          style={{
            flex: '0 1 auto',
            // 45% of a 320px row is ~130px, the same ceiling the mention picker
            // gives its job titles.
            maxWidth: '45%',
            fontSize: 'var(--fs-micro)',
            color: 'var(--fg-tertiary)'
          }}
        >
          {hint}
        </span>
      ) : null}
      <span className="grid shrink-0 place-items-center" style={{ width: 14, height: 14 }}>
        {selected ? (
          <Check size={14} strokeWidth={2} style={{ color: 'var(--fg-primary)' }} />
        ) : null}
      </span>
    </button>
  )
}
