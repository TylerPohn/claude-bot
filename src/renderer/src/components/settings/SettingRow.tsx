import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/cn'
import { bridge } from '@/lib/ipc'
import { useUiStore } from '@/stores/uiStore'
import { IconButton } from '@/components/ui/IconButton'

/**
 * The layout primitives every settings pane and the details drawer share.
 *
 * Keeping them in one file is what stops five tabs from slowly drifting into
 * five different label sizes: a settings dialog reads as sloppy the moment two
 * rows disagree about their baseline.
 */

/* ------------------------------------------------------------------ *
 * Section
 * ------------------------------------------------------------------ */

export interface SettingsSectionProps {
  title: string
  /** Sits under the heading, above the first row. */
  description?: ReactNode
  children: ReactNode
  className?: string
  /** Tints the frame for a destructive group (Data → Danger zone). */
  danger?: boolean
}

/**
 * A titled group of rows. The heading is 12px/510 `--fg-tertiary` in sentence
 * case (DESIGN §2.6); the rows sit on `--surface-2` so the pane's `--surface-3`
 * ground still reads as the layer beneath them.
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
  danger = false
}: SettingsSectionProps): ReactElement {
  return (
    <section className={cn('flex flex-col', className)} style={{ marginBottom: 24 }}>
      <h3
        className="text-[var(--fg-tertiary)]"
        style={{
          fontSize: 'var(--fs-micro)',
          lineHeight: 'var(--lh-micro)',
          letterSpacing: 'var(--ls-micro)',
          fontWeight: 510,
          marginBottom: 8
        }}
      >
        {title}
      </h3>
      {description ? (
        <p
          className="text-[var(--fg-secondary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            marginBottom: 10
          }}
        >
          {description}
        </p>
      ) : null}
      <div
        style={{
          background: 'var(--surface-2)',
          border: `1px solid ${danger ? 'rgba(242, 120, 126, 0.28)' : 'var(--border-1)'}`,
          borderRadius: 'var(--r-5)',
          padding: '2px 14px'
        }}
      >
        {children}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------ */

export interface SettingRowProps {
  label: ReactNode
  /** The "why" line. Every non-obvious setting must have one. */
  description?: ReactNode
  /** Right-aligned control: a Switch, a Select, a Button. */
  control?: ReactNode
  /** Full-width control rendered under the label block (sliders, chip inputs). */
  children?: ReactNode
  /** Associates the visible label with the control it names. */
  controlId?: string
  /** Extra line under everything — a warning, a resolved value, a hint. */
  footnote?: ReactNode
  disabled?: boolean
  className?: string
}

export function SettingRow({
  label,
  description,
  control,
  children,
  controlId,
  footnote,
  disabled = false,
  className
}: SettingRowProps): ReactElement {
  // A <label> with no control is a lie to a screen reader, so the element only
  // becomes one when it actually points at something.
  const LabelTag = controlId ? 'label' : 'div'

  return (
    <div
      className={cn(
        'flex flex-col',
        // The last row must not draw a divider against the group's own border.
        '[&:not(:last-child)]:border-b [&:not(:last-child)]:border-[var(--border-1)]',
        disabled && 'opacity-50',
        className
      )}
      style={{ padding: '12px 0' }}
      aria-disabled={disabled || undefined}
    >
      <div className="flex items-start gap-[16px]">
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 3 }}>
          <LabelTag
            {...(controlId ? { htmlFor: controlId } : {})}
            className="text-[var(--fg-primary)]"
            style={{
              fontSize: 'var(--fs-chrome)',
              lineHeight: 'var(--lh-chrome)',
              letterSpacing: 'var(--ls-chrome)',
              fontWeight: 550
            }}
          >
            {label}
          </LabelTag>
          {description ? (
            <p
              className="text-[var(--fg-tertiary)]"
              style={{
                fontSize: 'var(--fs-meta)',
                lineHeight: 'var(--lh-meta)',
                letterSpacing: 'var(--ls-meta)'
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {control ? (
          <div className="flex shrink-0 items-center gap-[8px]" style={{ paddingTop: 2 }}>
            {control}
          </div>
        ) : null}
      </div>

      {children ? <div style={{ marginTop: 10 }}>{children}</div> : null}
      {footnote ? <div style={{ marginTop: 8 }}>{footnote}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Slider
 * ------------------------------------------------------------------ */

export interface SettingsSliderProps {
  value: number
  min: number
  max: number
  step?: number
  onChange(value: number): void
  /** Accessible name — required, the visible label lives in the row above. */
  label: string
  id?: string
  /** The current value, rendered above the track and centred on the thumb,
   *  e.g. `3 Bots` or `115%`. */
  valueLabel?: string
  /** Small captions under the two ends of the track. */
  minLabel?: string
  maxLabel?: string
  disabled?: boolean
}

/**
 * A native `<input type="range">` at zero opacity over a drawn track.
 *
 * The native element keeps every behaviour that matters — arrow keys, Home/End,
 * page steps, drag, and the ARIA slider role with live value text — while the
 * visible track is ordinary DOM that themes correctly in both palettes.
 * Styling `::-webkit-slider-thumb` directly would have worked too, but it can
 * only be reached through generated CSS, and the thumb would then be invisible
 * if that one utility ever failed to emit.
 */
export function SettingsSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  id,
  valueLabel,
  minLabel,
  maxLabel,
  disabled = false
}: SettingsSliderProps): ReactElement {
  const [focused, setFocused] = useState(false)
  const span = max - min
  const ratio = span <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / span))

  /* The readout is centred on the thumb, so it has to know its own width to stay
     inside the track at the two ends. Measured rather than assumed: the strings
     are caller-supplied ("3 Bots · recommended" is far wider than "85%") and
     every one of them rescales with the Text size setting. No dependency array —
     one guarded offsetWidth read per render is cheaper than being wrong. */
  const readoutRef = useRef<HTMLSpanElement>(null)
  const [readoutWidth, setReadoutWidth] = useState(0)
  useLayoutEffect(() => {
    const measured = readoutRef.current?.offsetWidth ?? 0
    setReadoutWidth((current) => (current === measured ? current : measured))
  })

  /* The thumb's CENTRE, not `ratio * 100%`: the 14px thumb travels between 7px
     and (track - 7px), so the naive percentage misses it by up to 7px at the
     ends — on a caption whose whole job is to point at the thumb. */
  const thumbCentre = `calc(${ratio * 100}% - ${ratio * 14}px + 7px)`

  const minCaption = minLabel ?? String(min)
  const maxCaption = maxLabel ?? String(max)

  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      {valueLabel ? (
        // The readout used to sit in the caption row below, between the two
        // scale ends — `justify-between` pinned it to the horizontal CENTRE of
        // the track, so it lined up with the thumb only when the value happened
        // to be mid-range, and at either end it printed the same string twice
        // ("85%  85%  130%"). It now rides above the thumb instead.
        <div className="relative" style={{ height: 'var(--lh-micro)' }}>
          <span
            ref={readoutRef}
            className="absolute top-0 whitespace-nowrap text-[var(--fg-primary)]"
            style={{
              // Clamped to the track: half a wide readout would otherwise hang
              // outside the card at either extreme.
              left: `max(0px, min(calc(${thumbCentre} - ${readoutWidth / 2}px), calc(100% - ${readoutWidth}px)))`,
              fontSize: 'var(--fs-micro)',
              lineHeight: 'var(--lh-micro)',
              letterSpacing: 'var(--ls-micro)',
              fontWeight: 550,
              fontVariantNumeric: 'tabular-nums',
              transition: 'left var(--dur-fast) var(--ease-out-quad)'
            }}
          >
            {valueLabel}
          </span>
        </div>
      ) : null}
      <div className="relative flex items-center" style={{ height: 20 }}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={valueLabel}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="no-drag absolute inset-0 z-10 m-0 w-full cursor-pointer opacity-0 disabled:cursor-default"
          style={{ height: 20 }}
        />
        <span
          aria-hidden
          className="absolute right-0 left-0 block rounded-full"
          style={{ height: 4, background: 'var(--surface-3)' }}
        />
        <span
          aria-hidden
          className="absolute left-0 block rounded-full"
          style={{
            height: 4,
            width: `${ratio * 100}%`,
            background: disabled ? 'var(--fg-quaternary)' : 'var(--accent)',
            transition: 'width var(--dur-fast) var(--ease-out-quad)'
          }}
        />
        <span
          aria-hidden
          className="absolute block rounded-full"
          style={{
            width: 14,
            height: 14,
            // The thumb centre travels between 7px and (width - 7px), which is
            // exactly what the native input does, so the drawn thumb and the
            // real hit target never separate.
            left: `calc(${ratio * 100}% - ${ratio * 14}px)`,
            background: 'var(--white)',
            boxShadow: focused
              ? '0 0 0 2px var(--focus-ring-color), var(--shadow-low)'
              : 'var(--shadow-low)',
            transition: 'left var(--dur-fast) var(--ease-out-quad), box-shadow var(--dur-fast)'
          }}
        />
      </div>
      {minLabel || maxLabel ? (
        // Just the two scale ends. An end drops out when the readout above is
        // already showing that exact string, so the slider can never print one
        // number twice.
        <div
          className="flex items-center justify-between text-[var(--fg-quaternary)]"
          style={{ fontSize: 'var(--fs-micro)', letterSpacing: 'var(--ls-micro)' }}
        >
          <span>{minCaption === valueLabel ? '' : minCaption}</span>
          <span>{maxCaption === valueLabel ? '' : maxCaption}</span>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Copyable value
 * ------------------------------------------------------------------ */

export interface CopyFieldProps {
  value: string | null
  /** Shown instead of the value when there is nothing to show. */
  empty?: string
  /** Accessible name for the copy button, e.g. `Copy executable path`. */
  copyLabel: string
  mono?: boolean
  className?: string
  /** Optional leading element (a status dot, a bot avatar). */
  leading?: ReactNode
}

/**
 * A path or an id: selectable, wrapping to at most two lines, with a copy
 * button that confirms in place. Copying is a high-frequency, low-stakes
 * action — a toast for every one would be noise, so the icon swaps to a check
 * for a beat instead.
 */
export function CopyField({
  value,
  empty = 'Not set',
  copyLabel,
  mono = true,
  className,
  leading
}: CopyFieldProps): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(async () => {
    if (!value) return
    try {
      await bridge().system.copyText(value)
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      useUiStore.getState().toast({ level: 'error', title: 'Could not copy that' })
    }
  }, [value])

  return (
    <div
      className={cn('flex w-full items-center gap-[8px]', className)}
      style={{
        minHeight: 32,
        padding: '5px 4px 5px 10px',
        background: 'var(--chip-bg)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-4)'
      }}
    >
      {leading}
      {/* Paths and session ids WRAP rather than truncate. The `direction: rtl`
          trick that keeps a path's tail visible reorders leading slashes and
          leaves invisible bidi controls inside anything the user selects — and
          this text is deliberately selectable. Two lines fit almost every real
          path; the title and the copy button cover the rest. */}
      <span
        className={cn(
          'min-w-0 flex-1',
          value ? 'selectable text-[var(--fg-primary)]' : 'text-[var(--fg-quaternary)]'
        )}
        style={{
          fontFamily: mono && value ? 'var(--font-mono)' : 'inherit',
          fontSize: mono && value ? 'var(--fs-micro)' : 'var(--fs-meta)',
          lineHeight: '16px',
          overflowWrap: 'anywhere',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
        title={value ?? undefined}
      >
        {value ?? empty}
      </span>
      <IconButton
        label={copied ? 'Copied' : copyLabel}
        size={24}
        disabled={!value}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check size={14} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
        ) : (
          <Copy size={14} strokeWidth={1.75} />
        )}
      </IconButton>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Details drawer chrome (DESIGN §2.6)
 *
 * The drawer is only 320px wide, so it uses a tighter scale than the settings
 * pane: a 12px/510 heading, 40px field rows, and hairline dividers instead of
 * cards. These live here rather than in the drawer itself so the drawer's own
 * sub-sections can import them without importing their parent.
 * ------------------------------------------------------------------ */

export function DrawerSection({
  title,
  action,
  children,
  /** The first section in the panel sits under the header and needs no rule. */
  divider = true,
  className
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  divider?: boolean
  className?: string
}): ReactElement {
  return (
    <section
      className={cn('flex flex-col', className)}
      style={{
        padding: divider ? '16px 0 4px' : '12px 0 4px',
        borderTop: divider ? '1px solid var(--border-1)' : undefined
      }}
    >
      <div className="flex items-center gap-[8px]" style={{ minHeight: 20, marginBottom: 8 }}>
        <h3
          className="min-w-0 flex-1 truncate text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontWeight: 510
          }}
        >
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** 40px row: label 13px `--fg-secondary` left, value 13px `--fg-primary` right. */
export function FieldRow({
  label,
  value,
  title
}: {
  label: string
  value: ReactNode
  title?: string
}): ReactElement {
  return (
    <div className="flex items-center gap-[12px]" style={{ minHeight: 40 }}>
      <span
        className="shrink-0 text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
      >
        {label}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-right text-[var(--fg-primary)]"
        style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
        title={title}
      >
        {value}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Inline note
 * ------------------------------------------------------------------ */

export type NoteTone = 'neutral' | 'warning' | 'danger' | 'accent'

const NOTE_TONE: Record<NoteTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: 'var(--fg-secondary)', bg: 'var(--chip-bg)', border: 'var(--border-1)' },
  warning: {
    fg: 'var(--fg-warning)',
    bg: 'rgba(253, 215, 63, 0.10)',
    border: 'rgba(253, 215, 63, 0.24)'
  },
  danger: {
    fg: 'var(--fg-danger)',
    bg: 'rgba(242, 120, 126, 0.10)',
    border: 'rgba(242, 120, 126, 0.24)'
  },
  accent: { fg: 'var(--accent)', bg: 'var(--accent-soft)', border: 'var(--border-1)' }
}

/** A short inline explanation, used for guardrail warnings and missing paths. */
export function Note({
  tone = 'neutral',
  icon,
  children,
  className
}: {
  tone?: NoteTone
  icon?: ReactNode
  children: ReactNode
  className?: string
}): ReactElement {
  const style = NOTE_TONE[tone]
  return (
    <div
      className={cn('flex items-start gap-[8px]', className)}
      style={{
        padding: '8px 10px',
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 'var(--r-4)',
        color: tone === 'neutral' ? 'var(--fg-secondary)' : style.fg,
        fontSize: 'var(--fs-meta)',
        lineHeight: 'var(--lh-meta)',
        letterSpacing: 'var(--ls-meta)'
      }}
    >
      {icon ? (
        <span className="shrink-0" style={{ marginTop: 1, color: style.fg }}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Stable ids for label/control pairing without hand-managed strings. */
export function useControlId(prefix: string): string {
  const id = useId()
  return `${prefix}${id}`
}

/**
 * Slider state that renders instantly and writes once the user stops moving.
 *
 * Every settings control writes through `updateSettings`, which is a real IPC
 * round-trip to SQLite. Committing on each of the ~30 change events a drag emits
 * would be wasteful and would make the thumb stutter behind the echoed value; a
 * trailing commit keeps the control perfectly live and the store authoritative.
 */
export function useSliderValue(
  value: number,
  commit: (next: number) => void,
  delay = 160
): [number, (next: number) => void] {
  const [local, setLocal] = useState(value)
  const timer = useRef<number | null>(null)
  const pending = useRef(false)

  // While a commit is in flight the store still holds the old value; adopting it
  // here would snap the thumb backwards mid-drag.
  useEffect(() => {
    if (!pending.current) setLocal(value)
  }, [value])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const set = useCallback(
    (next: number) => {
      pending.current = true
      setLocal(next)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        pending.current = false
        commit(next)
      }, delay)
    },
    [commit, delay]
  )

  return [local, set]
}
