import { forwardRef, useRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'
import { useAutosizeTextarea } from '@/hooks/useAutosizeTextarea'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  /** Autosizes up to this height, then scrolls internally. */
  maxHeight?: number
  minHeight?: number
  value: string
}

/**
 * The autosizing sibling of `Input`. `value` is required (and controlled)
 * because the autosize measurement has to run on the same value React rendered —
 * an uncontrolled textarea would resize a frame late.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, maxHeight = 240, minHeight = 120, className, style, value, ...rest },
  forwarded
) {
  const local = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(local, value, maxHeight)

  return (
    <textarea
      {...rest}
      value={value}
      ref={(node) => {
        local.current = node
        if (typeof forwarded === 'function') forwarded(node)
        else if (forwarded) forwarded.current = node
      }}
      aria-invalid={invalid || undefined}
      rows={1}
      className={cn(
        'selectable scroller no-drag w-full resize-none text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]',
        'transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'focus:border-[var(--input-border-hover)]',
        className
      )}
      style={{
        minHeight,
        padding: '10px 12px',
        background: 'var(--input-bg)',
        border: `1px solid ${invalid ? 'var(--fg-danger)' : 'var(--input-border)'}`,
        borderRadius: 'var(--r-5)',
        fontSize: 'var(--fs-chrome)',
        lineHeight: 'var(--lh-chrome)',
        letterSpacing: 'var(--ls-chrome)',
        caretColor: 'var(--accent)',
        ...style
      }}
    />
  )
})
