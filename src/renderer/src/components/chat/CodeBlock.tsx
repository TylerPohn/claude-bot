import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Check, Copy } from 'lucide-react'

import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import { cn } from '@/lib/cn'
import { bridge } from '@/lib/ipc'

/**
 * A fenced code block.
 *
 * WHY `shiki/core` AND NOT `shiki`. The full bundle carries every grammar and
 * theme shiki ships (~6 MB) plus the Oniguruma WASM binary. The core entry with
 * the JavaScript regex engine and fifteen hand-picked grammars is a fraction of
 * that, loads no WASM, and covers everything Claude Code actually writes.
 *
 * WHY THE HIGHLIGHTER IS CREATED ONCE AT MODULE SCOPE. Creating it is expensive
 * (grammar compilation) and it is completely stateless from the caller's point of
 * view. One instance is shared by every code block in every conversation.
 *
 * WHY HIGHLIGHTING WAITS FOR THE CLOSING FENCE. A highlighter re-tokenizes the
 * entire fence on every change; doing that 30 times a second on a program that is
 * still being written burns the main thread and makes the colours strobe as the
 * parser's idea of the syntax changes. Until the fence closes this renders plain
 * preformatted text in the same font, size and background, so the swap when the
 * closing ``` lands is invisible apart from the colour arriving.
 */

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>
type ThemedToken = ReturnType<Highlighter['codeToTokensBase']>[number][number]

const THEME_DARK = 'github-dark'
const THEME_LIGHT = 'github-light'

/** Aliases Claude Code emits that are not grammar names. */
const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  yml: 'yaml',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  mdx: 'markdown',
  rs: 'rust',
  golang: 'go',
  patch: 'diff',
  htm: 'html',
  scss: 'css',
  postcss: 'css',
  psql: 'sql'
}

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light')],
    langs: [
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/tsx'),
      import('@shikijs/langs/jsx'),
      import('@shikijs/langs/python'),
      import('@shikijs/langs/bash'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/yaml'),
      import('@shikijs/langs/sql'),
      import('@shikijs/langs/css'),
      import('@shikijs/langs/html'),
      import('@shikijs/langs/markdown'),
      import('@shikijs/langs/rust'),
      import('@shikijs/langs/go'),
      import('@shikijs/langs/diff')
    ]
  })
  return highlighterPromise
}

/** Human label shown in the block's corner. */
const LANG_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  tsx: 'TSX',
  jsx: 'JSX',
  python: 'Python',
  bash: 'Shell',
  json: 'JSON',
  yaml: 'YAML',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  markdown: 'Markdown',
  rust: 'Rust',
  go: 'Go',
  diff: 'Diff'
}

function normalizeLang(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (key.length === 0) return null
  return LANG_ALIAS[key] ?? key
}

/** Reads the live theme so the highlighter picks the matching palette. */
function currentTheme(): string {
  if (typeof document === 'undefined') return THEME_DARK
  return document.documentElement.dataset.theme === 'light' ? THEME_LIGHT : THEME_DARK
}

function useDocumentTheme(): string {
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => {
    // The theme lives in a data attribute on <html>, which App.tsx rewrites when
    // the preference or the OS changes. An observer is the only way to notice.
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

export interface CodeBlockProps {
  code: string
  lang?: string | null
  /** False while the fence is still open, i.e. the code is still arriving. */
  closed?: boolean
  className?: string
}

const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: '12px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-code)',
  lineHeight: 'var(--lh-code)',
  letterSpacing: 0,
  tabSize: 2
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  closed = true,
  className
}: CodeBlockProps): ReactElement {
  const theme = useDocumentTheme()
  const language = useMemo(() => normalizeLang(lang), [lang])
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!closed || !language || code.length === 0) {
      setTokens(null)
      return
    }
    // Very large blocks are left plain: tokenizing 200 KB of output on the main
    // thread is a visible freeze, and nobody reads that as source anyway.
    if (code.length > 120_000) {
      setTokens(null)
      return
    }

    void getHighlighter()
      .then((highlighter) => {
        if (cancelled) return
        if (!highlighter.getLoadedLanguages().includes(language)) {
          setTokens(null)
          return
        }
        setTokens(highlighter.codeToTokensBase(code, { lang: language, theme }))
      })
      .catch(() => {
        // A grammar failure must never blank out the user's code.
        if (!cancelled) setTokens(null)
      })

    return () => {
      cancelled = true
    }
  }, [code, language, theme, closed])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const label = language ? (LANG_LABEL[language] ?? language) : null

  const copy = (): void => {
    void bridge().system.copyText(code)
    setCopied(true)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className={cn('hover-target ccb-code relative my-[10px]', className)}
      style={{
        background: 'var(--bubble-nested-bg)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-card-inner)',
        overflow: 'hidden'
      }}
    >
      {/* The label and the copy button sit in the same absolutely positioned
          strip so neither can ever reflow the code beneath them. */}
      <div
        className="pointer-events-none absolute top-0 right-0 left-0 flex items-center justify-between"
        style={{ padding: '6px 8px 0 12px' }}
      >
        <span
          className="truncate text-[var(--fg-quaternary)]"
          style={{ fontSize: 'var(--fs-nano)', letterSpacing: 'var(--ls-nano)', fontWeight: 550 }}
        >
          {label ?? ''}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          className={cn(
            'hover-actions pointer-events-auto grid place-items-center rounded-[var(--r-3)]',
            'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]',
            'transition-[background-color,color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]'
          )}
          style={{
            width: 24,
            height: 24,
            background: 'var(--surface-2)',
            opacity: copied ? 1 : undefined
          }}
        >
          {copied ? (
            <Check size={13} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
          ) : (
            <Copy size={13} strokeWidth={1.75} />
          )}
        </button>
      </div>

      {/* Its own horizontal scroller: a wide line must never make the whole
          transcript scroll sideways. */}
      {/* The language label sits in an absolutely positioned strip, so the code
          needs its own top inset to clear it rather than flowing underneath. */}
      {/* `overscroll-behavior-y: auto` undoes `.scroller`'s `contain` on the
          vertical axis. `overflow-x: auto` also makes overflow-y compute to
          `auto`, so this is a vertical scroll container with nothing to scroll:
          with `contain` it ATE every wheel event aimed at the transcript, and a
          reader flicking the trackpad over a code block watched the transcript
          refuse to move. Sideways containment is kept — a wide line must still
          never chain out into the transcript. */}
      <div
        className="scroller selectable overflow-x-auto"
        style={{
          paddingTop: label ? 14 : 0,
          overscrollBehaviorX: 'contain',
          overscrollBehaviorY: 'auto'
        }}
      >
        {tokens ? (
          <pre style={PRE_STYLE}>
            <code style={{ display: 'block', width: 'max-content', minWidth: '100%' }}>
              {tokens.map((line, i) => (
                <span key={i} style={{ display: 'block', minHeight: 'var(--lh-code)' }}>
                  {line.map((token, j) => (
                    <span key={j} style={{ color: token.color, fontStyle: fontStyleOf(token) }}>
                      {token.content}
                    </span>
                  ))}
                </span>
              ))}
            </code>
          </pre>
        ) : (
          <pre style={{ ...PRE_STYLE, color: 'var(--fg-secondary)' }}>
            <code style={{ display: 'block', width: 'max-content', minWidth: '100%' }}>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
})

/** Shiki encodes bold/italic/underline as a bitmask on the token. */
function fontStyleOf(token: ThemedToken): CSSProperties['fontStyle'] {
  return typeof token.fontStyle === 'number' && (token.fontStyle & 1) !== 0 ? 'italic' : undefined
}
