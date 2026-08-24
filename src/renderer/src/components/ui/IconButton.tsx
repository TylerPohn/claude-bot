import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * The 32×32 circular chrome button from DESIGN §2.3. `label` is required — an
 * icon-only control with no accessible name is invisible to a screen reader and
 * has no tooltip text to borrow.
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  children: ReactNode
  size?: number
  variant?: 'ghost' | 'surface'
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, size = 32, variant = 'ghost', active = false, className, style, ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={rest['aria-pressed'] ?? (active || undefined)}
      className={cn(
        'no-drag grid shrink-0 place-items-center rounded-full',
        // One branch, not `text-secondary` plus a conditional `text-primary`:
        // both are Tailwind utilities in the same layer, so the winner is their
        // order in the stylesheet, not in the class attribute — the pressed
        // state's brighter glyph silently lost that race and never painted.
        active
          ? 'text-[var(--fg-primary)]'
          : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]',
        'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40',
        // A surface variant and the pressed state paint the same raised fill —
        // that fill is what tells the ⓘ details toggle apart from the buttons
        // beside it. These used to be `.icon-btn[data-variant]` rules in
        // main.css because the unlayered `button { background: none }` reset beat
        // every `bg-*` utility; the reset is in `@layer base` now, so the plain
        // utilities work and the CSS-side special case is gone.
        variant === 'surface' || active
          ? 'bg-[var(--surface-2)] hover:bg-[var(--surface-3)]'
          : 'bg-transparent hover:bg-[var(--btn-ghost-hover)]',
        className
      )}
      style={{ width: size, height: size, ...style }}
    >
      {children}
    </button>
  )
})
