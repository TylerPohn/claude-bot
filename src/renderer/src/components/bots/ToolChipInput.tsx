import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { Plus, X } from 'lucide-react'

import { botDraftSchema } from '@shared/schemas'
import { cn } from '@/lib/cn'

/**
 * Allowed / disallowed tool patterns, as chips.
 *
 * A tool entry is a Claude Code permission pattern (`Bash`, `Read`,
 * `Bash(git *)`), so it is validated against the SAME schema the main process
 * validates with — `botDraftSchema.shape.allowedTools` — rather than a private
 * regex that could drift from it. Rejecting the pattern here means the user
 * finds out while typing instead of on save.
 */

/** Patterns worth offering. The parameterised ones teach the syntax by example. */
export const TOOL_SUGGESTIONS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'Bash(git *)',
  'Bash(npm test)'
] as const

export interface ToolChipInputProps {
  label: string
  value: string[]
  onChange(next: string[]): void
  /** Offered as one-tap chips under the field; already-added ones are hidden. */
  suggestions?: readonly string[]
  placeholder?: string
  hint?: string
  /** `danger` tints the chips — used for the disallowed list. */
  tone?: 'neutral' | 'danger'
  id?: string
}

/** Validate one pattern with the shared schema; returns the error or null. */
function validateTool(pattern: string): string | null {
  const parsed = botDraftSchema.shape.allowedTools.safeParse([pattern])
  if (parsed.success) return null
  return parsed.error.issues[0]?.message ?? 'That is not a valid tool pattern.'
}

export function ToolChipInput({
  label,
  value,
  onChange,
  suggestions = TOOL_SUGGESTIONS,
  placeholder = 'Add a tool, then press Enter',
  hint,
  tone = 'neutral',
  id
}: ToolChipInputProps): ReactElement {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const errorId = `${fieldId}-error`

  const commit = useCallback(
    (raw: string): boolean => {
      const pattern = raw.trim()
      if (!pattern) return false
      if (value.includes(pattern)) {
        setError(`${pattern} is already on the list.`)
        return false
      }
      const problem = validateTool(pattern)
      if (problem) {
        setError(problem)
        return false
      }
      setError(null)
      onChange([...value, pattern])
      return true
    },
    [onChange, value]
  )

  const remove = useCallback(
    (pattern: string) => {
      setError(null)
      onChange(value.filter((v) => v !== pattern))
    },
    [onChange, value]
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        if (!text.trim()) return
        // Enter inside a form would submit it; the chip field owns Enter while
        // there is text to commit, and lets it through once the field is empty.
        // Tab is deliberately NOT intercepted — trapping Tab in a text field to
        // commit a chip is the kind of cleverness that strands keyboard users;
        // the blur handler commits instead.
        e.preventDefault()
        if (commit(text)) setText('')
        return
      }
      if (e.key === 'Backspace' && text === '' && value.length > 0) {
        e.preventDefault()
        remove(value[value.length - 1]!)
      }
    },
    [commit, remove, text, value]
  )

  const chipFg = tone === 'danger' ? 'var(--fg-danger)' : 'var(--fg-primary)'
  const chipBg = tone === 'danger' ? 'rgba(242, 120, 126, 0.12)' : 'var(--chip-bg)'
  const unused = suggestions.filter((s) => !value.includes(s))

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      <label
        htmlFor={fieldId}
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

      {/* One focus ring around the whole control: clicking anywhere in the box
          focuses the text field, which is what a chip input is expected to do. */}
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            inputRef.current?.focus()
          }
        }}
        className="flex flex-wrap items-center transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] focus-within:border-[var(--input-border-hover)]"
        style={{
          gap: 6,
          minHeight: 44,
          padding: '7px 10px',
          background: 'var(--input-bg)',
          border: `1px solid ${error ? 'var(--fg-danger)' : 'var(--input-border)'}`,
          borderRadius: 'var(--r-5)'
        }}
      >
        {value.map((pattern) => (
          <span
            key={pattern}
            className="inline-flex shrink-0 items-center"
            style={{
              height: 26,
              gap: 4,
              padding: '0 4px 0 9px',
              background: chipBg,
              color: chipFg,
              borderRadius: 'var(--r-chip)',
              fontSize: 'var(--fs-meta)',
              letterSpacing: 'var(--ls-meta)',
              fontWeight: 510,
              fontFamily: 'var(--font-mono)'
            }}
          >
            {pattern}
            <button
              type="button"
              aria-label={`Remove ${pattern}`}
              onClick={() => remove(pattern)}
              className="grid place-items-center rounded-full transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-active)]"
              style={{ width: 18, height: 18, color: 'var(--fg-tertiary)' }}
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </span>
        ))}

        <input
          id={fieldId}
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (text.trim() && commit(text)) setText('')
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="selectable min-w-[120px] flex-1 bg-transparent text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]"
          style={{
            height: 26,
            fontSize: 'var(--fs-chrome)',
            letterSpacing: 'var(--ls-chrome)',
            caretColor: 'var(--accent)'
          }}
        />
      </div>

      {unused.length > 0 ? (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          {unused.map((pattern) => (
            <button
              key={pattern}
              type="button"
              onClick={() => {
                commit(pattern)
                inputRef.current?.focus()
              }}
              className={cn(
                'inline-flex shrink-0 items-center transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
                'hover:bg-[var(--surface-active)] hover:text-[var(--fg-primary)] active:scale-[0.97]'
              )}
              style={{
                height: 24,
                gap: 4,
                padding: '0 8px 0 6px',
                background: 'transparent',
                border: '1px dashed var(--border-2)',
                borderRadius: 'var(--r-chip)',
                color: 'var(--fg-tertiary)',
                fontSize: 'var(--fs-micro)',
                letterSpacing: 'var(--ls-micro)',
                fontFamily: 'var(--font-mono)'
              }}
            >
              <Plus size={12} strokeWidth={1.75} aria-hidden />
              {pattern}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-[var(--fg-danger)]"
          style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
        >
          {error}
        </p>
      ) : hint ? (
        <p
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)'
          }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
}
