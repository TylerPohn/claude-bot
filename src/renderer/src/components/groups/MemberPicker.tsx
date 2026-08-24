import { useCallback, useId, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, Search, TriangleAlert, X } from 'lucide-react'

import type { Bot } from '@shared/types'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'

/**
 * Choose the Bots in a group.
 *
 * The limits are the product's, not decoration: a group holds 2–10 Bots, and the
 * UI is tuned for 2–6 because every extra member is another full Claude Code run
 * per turn (PRD §9.1). Above six the counter turns into a caution rather than a
 * hard stop — the user is allowed to do it, they just get told what it costs.
 */

export interface MemberPickerProps {
  selected: string[]
  onChange(next: string[]): void
  /** Hard floor. A group with one Bot is a direct chat. */
  min?: number
  /** Hard ceiling, enforced by the shared schema too. */
  max?: number
  /** Above this the counter turns into a quota caution. */
  softMax?: number
  label?: string
  /** `data-field` hook so an invalid submit can focus the picker. */
  fieldName?: string
  /** Marks the search field as the sheet's initial focus target. */
  autoFocus?: boolean
}

export function MemberPicker({
  selected,
  onChange,
  min = 2,
  max = 10,
  softMax = 6,
  label = 'Members',
  fieldName = 'memberBotIds',
  autoFocus = false
}: MemberPickerProps): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const botOrder = useAppStore((s) => s.botOrder)
  const openModal = useUiStore((s) => s.openModal)
  const [query, setQuery] = useState('')
  const searchId = useId()

  const roster = useMemo(
    () => botOrder.map((id) => bots[id]).filter((bot): bot is Bot => Boolean(bot)),
    [bots, botOrder]
  )

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return roster
    return roster.filter(
      (bot) =>
        bot.name.toLowerCase().includes(needle) || (bot.title ?? '').toLowerCase().includes(needle)
    )
  }, [query, roster])

  const atMax = selected.length >= max

  const toggle = useCallback(
    (botId: string) => {
      if (selected.includes(botId)) {
        onChange(selected.filter((id) => id !== botId))
        return
      }
      if (selected.length >= max) return
      onChange([...selected, botId])
    },
    [max, onChange, selected]
  )

  const countTone =
    selected.length < min
      ? 'var(--fg-tertiary)'
      : selected.length > softMax
        ? 'var(--fg-warning)'
        : 'var(--fg-secondary)'

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <label
          htmlFor={searchId}
          className="text-[var(--fg-secondary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            fontWeight: 510
          }}
        >
          {label}
        </label>
        <span
          aria-live="polite"
          className="shrink-0"
          style={{
            color: countTone,
            fontSize: 'var(--fs-micro)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {selected.length} of {max} selected
        </span>
      </div>

      <Input
        id={searchId}
        data-field={fieldName}
        data-autofocus={autoFocus || undefined}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Bots"
        leading={<Search size={16} strokeWidth={1.75} aria-hidden />}
      />

      {selected.length > 0 ? (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          {selected.map((id) => {
            const bot = bots[id]
            if (!bot) return null
            return (
              <span
                key={id}
                className="inline-flex items-center"
                style={{
                  height: 28,
                  gap: 6,
                  padding: '0 4px 0 4px',
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--r-chip)',
                  fontSize: 'var(--fs-meta)',
                  letterSpacing: 'var(--ls-meta)',
                  fontWeight: 510
                }}
              >
                <BotAvatar bot={bot} size={20} />
                <span className="max-w-[120px] truncate text-[var(--fg-primary)]">{bot.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${bot.name} from the group`}
                  onClick={() => toggle(id)}
                  className="grid place-items-center rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-active)]"
                  style={{ width: 20, height: 20, color: 'var(--fg-tertiary)' }}
                >
                  <X size={12} strokeWidth={1.75} />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}

      <div
        className="scroller"
        role="group"
        aria-label="Available Bots"
        style={{
          maxHeight: 264,
          overflowY: 'auto',
          padding: 4,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-1)',
          borderRadius: 'var(--r-5)'
        }}
      >
        {roster.length === 0 ? (
          <EmptyState
            compact
            title="No Bots to add yet"
            body="A group is made of Bots you already have. Create one first, then come back."
            action={
              <Button variant="secondary" onClick={() => openModal({ kind: 'bot' })}>
                New Bot
              </Button>
            }
          />
        ) : results.length === 0 ? (
          <EmptyState compact title="No Bots match that" body="Try a shorter search." />
        ) : (
          results.map((bot) => {
            const isSelected = selected.includes(bot.id)
            const blocked = !isSelected && atMax
            return (
              <button
                key={bot.id}
                type="button"
                // A toggle, not a link: `aria-pressed` is what makes Space and
                // Enter behave the way a checkbox row is expected to.
                aria-pressed={isSelected}
                disabled={blocked}
                onClick={() => toggle(bot.id)}
                className={cn(
                  'row-pill flex w-full items-center text-left',
                  'transition-[opacity] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
                  blocked && 'pointer-events-none opacity-40'
                )}
                style={{ height: 48, gap: 10, padding: '0 8px' }}
              >
                <BotAvatar bot={bot} size={28} />
                <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 1 }}>
                  <span
                    className="truncate text-[var(--fg-primary)]"
                    style={{
                      fontSize: 'var(--fs-chrome)',
                      lineHeight: '18px',
                      letterSpacing: 'var(--ls-chrome)',
                      fontWeight: 550
                    }}
                  >
                    {bot.name}
                  </span>
                  {bot.title ? (
                    <span
                      className="truncate text-[var(--fg-tertiary)]"
                      style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px' }}
                    >
                      {bot.title}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden
                  className="grid shrink-0 place-items-center transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 'var(--r-3)',
                    background: isSelected ? 'var(--accent)' : 'transparent',
                    border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border-3)'}`,
                    color: 'var(--fg-on-accent)'
                  }}
                >
                  {isSelected ? <Check size={12} strokeWidth={2.25} /> : null}
                </span>
              </button>
            )
          })
        )}
      </div>

      {selected.length < min ? (
        <p
          className="text-[var(--fg-tertiary)]"
          style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
        >
          Pick at least {min} Bots. For a single Bot, open its own chat instead.
        </p>
      ) : selected.length > softMax ? (
        <p
          className="flex items-start"
          style={{
            gap: 6,
            color: 'var(--fg-warning)',
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)'
          }}
        >
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-[1px] shrink-0" />
          <span>
            Groups read best with 2–{softMax} Bots. Above that, one @everyone message starts{' '}
            {selected.length} Claude Code runs at once and spends your allowance fast.
          </span>
        </p>
      ) : atMax ? (
        <p
          className="text-[var(--fg-tertiary)]"
          style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
        >
          That’s the maximum of {max}. Remove one to swap in another.
        </p>
      ) : null}
    </div>
  )
}
