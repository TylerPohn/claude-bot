import { useCallback, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'

import type { AvatarType, BotAccent, BotShape } from '@shared/types'
import { BOT_ACCENTS, BOT_SHAPES } from '@shared/types'
import { cn } from '@/lib/cn'
import { ACCENT_LABEL } from '@/lib/accent'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Input } from '@/components/ui/Input'

/**
 * The avatar picker — the product's signature visual, made editable.
 *
 * Every swatch is a REAL `<BotAvatar/>`, not an icon standing in for one, so the
 * user is choosing the exact artwork they will get. The shape row re-renders in
 * the currently selected colour and the colour row re-renders in the currently
 * selected shape, which means the two rows always agree with the 96px preview
 * and there is no "why does it look different now" moment after saving.
 *
 * Selection is a radiogroup with roving tabindex (arrow keys move, Tab leaves),
 * because a 10-item swatch row that costs 10 Tab stops is hostile to keyboards.
 */

export interface AvatarSelection {
  avatarType: AvatarType
  avatarValue: string
  accent: BotAccent
}

export interface AvatarPickerProps {
  value: AvatarSelection
  onChange(next: AvatarSelection): void
  /** Used for the initials fallback and as the preview's accessible name. */
  name: string
  className?: string
}

/** Human labels for the shape row's accessible names. */
const SHAPE_LABEL: Record<BotShape, string> = {
  circle: 'Circle',
  squircle: 'Squircle',
  teardrop: 'Teardrop',
  egg: 'Egg',
  hexagon: 'Hexagon',
  capsule: 'Capsule',
  arch: 'Arch',
  clover: 'Clover',
  triangle: 'Triangle',
  flag: 'Flag'
}

/**
 * A working-teammate emoji set. Deliberately small and curated: an exhaustive
 * emoji keyboard is a different product, and the free-text field below the grid
 * already accepts anything the user can paste.
 */
const EMOJI_CHOICES = [
  '🤖', '🛠️', '🔬', '🧭', '📦', '🧪', '🐞', '📊', '🗂️', '✍️',
  '🚀', '🔍', '🧠', '⚙️', '📐', '🧱', '🎯', '🔔', '📝', '🧹',
  '💡', '🛡️', '📮', '🗺️', '⏱️', '🧾', '🪄', '🔧', '📚', '🎨'
] as const

const TYPE_OPTIONS: Array<{ value: AvatarType; label: string }> = [
  { value: 'shape', label: 'Shape' },
  { value: 'emoji', label: 'Emoji' },
  { value: 'initials', label: 'Initials' }
]

/** Default `avatarValue` when the user switches between avatar types. */
function valueForType(type: AvatarType, current: AvatarSelection): string {
  if (type === current.avatarType) return current.avatarValue
  if (type === 'shape') return (BOT_SHAPES as readonly string[]).includes(current.avatarValue)
    ? current.avatarValue
    : 'circle'
  if (type === 'emoji') return '🤖'
  // Initials render from the name when the stored value is empty, so an empty
  // string here is correct — it keeps following a rename instead of freezing.
  return ''
}

export function AvatarPicker({ value, onChange, name, className }: AvatarPickerProps): ReactElement {
  const shape = (BOT_SHAPES as readonly string[]).includes(value.avatarValue)
    ? (value.avatarValue as BotShape)
    : 'circle'

  const setType = useCallback(
    (type: AvatarType) => {
      onChange({ ...value, avatarType: type, avatarValue: valueForType(type, value) })
    },
    [onChange, value]
  )

  return (
    <div className={cn('flex flex-col', className)} style={{ gap: 14 }}>
      <div className="flex items-center" style={{ gap: 16 }}>
        {/* The 96px live preview. Same component, same geometry, same eyes as
            every other avatar in the app — DESIGN §2.8 avatar sizes table. */}
        <BotAvatar
          avatarType={value.avatarType}
          avatarValue={value.avatarValue}
          accent={value.accent}
          name={name || 'New Bot'}
          size={96}
        />

        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 8 }}>
          <Segmented
            label="Avatar style"
            options={TYPE_OPTIONS}
            value={value.avatarType === 'image' ? 'shape' : value.avatarType}
            onChange={setType}
          />
          <p
            className="text-[var(--fg-tertiary)]"
            style={{
              fontSize: 'var(--fs-micro)',
              lineHeight: 'var(--lh-micro)',
              letterSpacing: 'var(--ls-micro)'
            }}
          >
            {value.avatarType === 'emoji'
              ? 'Emoji sit on the app’s neutral surface, so they ignore the colour row.'
              : value.avatarType === 'initials'
                ? 'Leave the initials blank to keep following the Bot’s name.'
                : 'The house style: a flat blob with two white eye slits.'}
          </p>
        </div>
      </div>

      {value.avatarType === 'shape' ? (
        <SwatchGroup
          label="Avatar shape"
          items={BOT_SHAPES.map((s) => ({
            key: s,
            label: SHAPE_LABEL[s],
            selected: shape === s,
            onSelect: () => onChange({ ...value, avatarValue: s }),
            render: (
              <BotAvatar avatarType="shape" avatarValue={s} accent={value.accent} name="" size={30} />
            )
          }))}
        />
      ) : null}

      {value.avatarType === 'emoji' ? (
        <div className="flex flex-col" style={{ gap: 10 }}>
          <SwatchGroup
            label="Avatar emoji"
            items={EMOJI_CHOICES.map((e) => ({
              key: e,
              label: e,
              selected: value.avatarValue === e,
              onSelect: () => onChange({ ...value, avatarValue: e }),
              render: (
                <span
                  style={{ fontSize: 20, fontFamily: 'var(--font-emoji)', lineHeight: 1 }}
                >
                  {e}
                </span>
              )
            }))}
          />
          <Input
            aria-label="Custom emoji"
            value={value.avatarValue}
            maxLength={8}
            placeholder="Or paste any emoji"
            onChange={(e) => onChange({ ...value, avatarValue: e.target.value })}
            style={{ fontFamily: 'var(--font-emoji)' }}
          />
        </div>
      ) : null}

      {value.avatarType === 'initials' ? (
        <Input
          aria-label="Initials"
          value={value.avatarValue}
          maxLength={3}
          placeholder={name.trim() ? `Defaults to ${initialsPreview(name)}` : 'Up to 3 letters'}
          onChange={(e) => onChange({ ...value, avatarValue: e.target.value.toUpperCase() })}
        />
      ) : null}

      {value.avatarType === 'emoji' ? null : (
        <SwatchGroup
          label="Avatar colour"
          items={BOT_ACCENTS.map((accent) => ({
            key: accent,
            label: ACCENT_LABEL[accent],
            selected: value.accent === accent,
            onSelect: () => onChange({ ...value, accent }),
            render: (
              <BotAvatar
                avatarType={value.avatarType === 'initials' ? 'initials' : 'shape'}
                avatarValue={value.avatarType === 'initials' ? value.avatarValue || name : shape}
                accent={accent}
                name={name}
                size={28}
              />
            )
          }))}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Swatch grid
 * ------------------------------------------------------------------ */

interface SwatchItem {
  key: string
  label: string
  selected: boolean
  onSelect(): void
  render: ReactNode
}

/**
 * Ten cells across a fixed grid rather than a horizontally scrolling strip: a
 * scroller hides half the palette behind an affordance nobody notices, and the
 * whole point of the picker is seeing every option at once.
 */
function SwatchGroup({ label, items }: { label: string; items: SwatchItem[] }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']
      if (!keys.includes(e.key)) return
      const buttons = Array.from(
        containerRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]') ?? []
      )
      if (buttons.length === 0) return
      const current = buttons.findIndex((b) => b === document.activeElement)
      const from = current === -1 ? buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true') : current
      // A 10-wide grid: Down/Up move a whole row, which is what the eye expects
      // when the group wraps to two rows (the emoji set does).
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 10 : -10
      let next: number
      if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = buttons.length - 1
      else next = Math.max(0, Math.min(buttons.length - 1, (from === -1 ? 0 : from) + step))
      e.preventDefault()
      buttons[next]?.focus()
      buttons[next]?.click()
    },
    []
  )

  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.selected)
  )

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="grid"
      style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 8, padding: '3px 0' }}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="radio"
          aria-checked={item.selected}
          aria-label={item.label}
          // Roving tabindex: one stop for the whole group, arrows move inside it.
          tabIndex={index === activeIndex ? 0 : -1}
          onClick={item.onSelect}
          className={cn(
            'grid aspect-square place-items-center rounded-full',
            // 100ms / --ease-out-quad, the app-wide hover+reveal timing. The
            // scale is deliberately small: a swatch that leaps reads as a toy.
            'transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
            'hover:bg-[var(--surface-hover)] active:scale-[0.94]'
          )}
          style={{
            background: item.selected ? 'var(--surface-2)' : 'transparent',
            transform: item.selected ? 'scale(1.06)' : undefined,
            // outline (not box-shadow) so the ring follows the border-radius and
            // never participates in layout. DESIGN §3.10: 2px ring at 2px offset.
            outline: item.selected ? '2px solid var(--border-3)' : undefined,
            outlineOffset: item.selected ? 2 : undefined
          }}
        >
          <span aria-hidden className="grid place-items-center">
            {item.render}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Segmented control
 * ------------------------------------------------------------------ */

/** DESIGN §3.8: 32px tall, radius 8, `--surface-2` track, `--surface-3` thumb. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange(next: T): void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        e.preventDefault()
        const index = options.findIndex((o) => o.value === value)
        const next = (index + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length
        onChange(options[next]!.value)
        ref.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
      }}
      className="inline-flex w-full"
      style={{
        height: 32,
        padding: 2,
        gap: 2,
        background: 'var(--surface-2)',
        borderRadius: 'var(--r-4)'
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className="flex-1 rounded-[var(--r-3)] transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
            style={{
              background: selected ? 'var(--surface-3)' : 'transparent',
              color: selected ? 'var(--fg-primary)' : 'var(--fg-secondary)',
              fontSize: 'var(--fs-meta)',
              letterSpacing: 'var(--ls-meta)',
              fontWeight: selected ? 550 : 400
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function initialsPreview(source: string): string {
  const parts = source.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
