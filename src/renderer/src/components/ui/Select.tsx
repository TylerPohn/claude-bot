import { forwardRef } from 'react'
import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/cn'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[]
  /** Rendered as a disabled first option when the value is empty. */
  placeholder?: string
}

/**
 * A native `<select>` wearing the app's clothes. No popover library: the native
 * control gets keyboard behaviour, type-ahead and platform rendering for free,
 * and a custom listbox would have to reimplement all three.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, style, ...rest },
  ref
) {
  return (
    <div
      className={cn('no-drag relative inline-flex w-full items-center', className)}
      style={{
        height: 36,
        background: 'var(--input-bg)',
        border: '1px solid var(--input-border)',
        borderRadius: 'var(--r-4)',
        ...style
      }}
    >
      <select
        {...rest}
        ref={ref}
        className="h-full w-full appearance-none bg-transparent pr-[30px] pl-[10px] text-[var(--fg-primary)]"
        style={{ fontSize: 'var(--fs-chrome)', letterSpacing: 'var(--ls-chrome)' }}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className="pointer-events-none absolute right-[10px] text-[var(--fg-tertiary)]"
      />
    </div>
  )
})
