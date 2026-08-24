import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/** 36px, `--input-bg`, a 1px translucent border, radius `--r-4`. */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leading?: ReactNode
  trailing?: ReactNode
  invalid?: boolean
  /** 44px is the form-field height used in sheets and modals (DESIGN §3.10).
   *  Shadows the native `size` attribute, which this app never uses. */
  size?: 'md' | 'lg'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, invalid, size = 'md', className, style, ...rest },
  ref
) {
  const height = size === 'lg' ? 44 : 36
  return (
    <div
      className={cn(
        // `field` moves the focus ring onto this wrapper (the box the user sees
        // as the field) and off the transparent inner <input>. See main.css.
        'field no-drag group relative flex w-full items-center gap-[8px]',
        'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'focus-within:border-[var(--input-border-hover)]',
        className
      )}
      style={{
        height,
        padding: `0 ${size === 'lg' ? 14 : 10}px`,
        background: 'var(--input-bg)',
        border: `1px solid ${invalid ? 'var(--fg-danger)' : 'var(--input-border)'}`,
        borderRadius: size === 'lg' ? 'var(--r-5)' : 'var(--r-4)',
        ...style
      }}
    >
      {leading ? (
        <span className="grid shrink-0 place-items-center text-[var(--fg-tertiary)]">
          {leading}
        </span>
      ) : null}
      <input
        {...rest}
        ref={ref}
        aria-invalid={invalid || undefined}
        className="selectable min-w-0 flex-1 bg-transparent text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]"
        style={{
          fontSize: 'var(--fs-chrome)',
          letterSpacing: 'var(--ls-chrome)',
          caretColor: 'var(--accent)'
        }}
      />
      {trailing ? <span className="grid shrink-0 place-items-center">{trailing}</span> : null}
    </div>
  )
})
