import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { Spinner } from './Spinner'

/**
 * Heights are 28 (sm) and 32 (md) — DESIGN §2.4 action buttons. Radius is
 * `--r-button` (14px), which at a 32px height reads as a soft rectangle rather
 * than a pill; `iconOnly` swaps to a true circle.
 */
export type ButtonVariant = 'filled' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  iconOnly?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

const VARIANT_STYLE: Record<ButtonVariant, string> = {
  filled: 'bg-[var(--btn-filled-bg)] text-[var(--btn-filled-fg)] hover:bg-[var(--btn-filled-hover)]',
  secondary:
    'bg-[var(--btn-secondary-bg)] text-[var(--fg-primary)] hover:bg-[var(--surface-active)]',
  ghost: 'bg-transparent text-[var(--fg-primary)] hover:bg-[var(--btn-ghost-hover)]',
  danger: 'bg-[var(--btn-secondary-bg)] text-[var(--fg-danger)] hover:bg-[var(--surface-active)]'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconOnly = false,
    leading,
    trailing,
    className,
    children,
    disabled,
    type = 'button',
    style,
    ...rest
  },
  ref
) {
  const height = size === 'sm' ? 28 : 32
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cn(
        'no-drag relative inline-flex shrink-0 items-center justify-center gap-[6px]',
        'font-[550] whitespace-nowrap',
        'transition-[background-color,opacity,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40',
        VARIANT_STYLE[variant],
        className
      )}
      style={{
        height,
        minWidth: iconOnly ? height : undefined,
        width: iconOnly ? height : undefined,
        padding: iconOnly ? 0 : size === 'sm' ? '0 10px' : '0 14px',
        borderRadius: iconOnly ? 'var(--r-full)' : 'var(--r-button)',
        fontSize: size === 'sm' ? 'var(--fs-meta)' : 'var(--fs-chrome)',
        letterSpacing: size === 'sm' ? 'var(--ls-meta)' : 'var(--ls-chrome)',
        ...style
      }}
    >
      {/* The label keeps its box while loading so the button never resizes. */}
      <span
        className={cn('inline-flex items-center gap-[6px]', loading && 'opacity-0')}
        aria-hidden={loading || undefined}
      >
        {leading}
        {children}
        {trailing}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={14} />
        </span>
      ) : null}
    </button>
  )
})
