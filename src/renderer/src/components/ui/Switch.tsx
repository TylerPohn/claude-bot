import type { ReactElement } from 'react'

import { cn } from '@/lib/cn'

/** 32 × 18 track, 14px thumb, 100ms — DESIGN §3 component table. */
export interface SwitchProps {
  checked: boolean
  onChange(checked: boolean): void
  label: string
  /** Hide the visual label but keep it as the accessible name. */
  hideLabel?: boolean
  disabled?: boolean
  id?: string
  className?: string
}

export function Switch({
  checked,
  onChange,
  label,
  hideLabel = true,
  disabled,
  id,
  className
}: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'no-drag inline-flex shrink-0 items-center gap-[8px]',
        'disabled:pointer-events-none disabled:opacity-40',
        className
      )}
    >
      <span
        aria-hidden
        className="relative block shrink-0 rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
        style={{
          width: 32,
          height: 18,
          // NOT --surface-3. That token is #e8e8e8 in light theme, which put a
          // #fcfcfc thumb on a 1.19:1 track on a 1.09:1 card — the off switches
          // in Settings simply were not visible. --switch-track-off carries the
          // per-theme value that clears WCAG 1.4.11 on both counts.
          background: checked ? 'var(--accent)' : 'var(--switch-track-off)'
        }}
      >
        <span
          className="absolute top-[2px] block rounded-full transition-[transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
          style={{
            width: 14,
            height: 14,
            left: 2,
            background: 'var(--white)',
            // The same lift the Segmented indicator and the slider knob carry,
            // for the same reason: it keeps the thumb's edge legible where it
            // sits over the lighter end of its track.
            boxShadow: 'var(--shadow-low)',
            transform: checked ? 'translateX(14px)' : 'translateX(0)'
          }}
        />
      </span>
      {hideLabel ? null : (
        <span style={{ fontSize: 'var(--fs-chrome)' }} className="text-[var(--fg-primary)]">
          {label}
        </span>
      )}
    </button>
  )
}
