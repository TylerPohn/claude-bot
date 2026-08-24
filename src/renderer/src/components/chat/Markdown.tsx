import { createContext, memo, useContext, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { Nodes as MdastNodes, Parents as MdastParents, Root as MdastRoot } from 'mdast'
import type { Plugin } from 'unified'

import { cn } from '@/lib/cn'
import { bridge } from '@/lib/ipc'
import { CodeBlock } from './CodeBlock'
import {
  hasOpenFence,
  isPlainProse,
  repairStreamingMarkdown,
  splitMarkdownBlocks
} from './markdownBlocks'

/**
 * The streaming-safe markdown renderer.
 *
 * THE STRATEGY, IN ORDER OF IMPORTANCE:
 *
 *  1. The body is split into top-level blocks (see `markdownBlocks.ts`). Each
 *     block is a `React.memo` component keyed on its raw source, so a token
 *     arriving at the end of a 200-line answer re-parses one paragraph, not the
 *     whole document.
 *  2. `components`, `remarkPlugins` and `rehypePlugins` are MODULE-LEVEL
 *     CONSTANTS. Inline literals are new references on every render, which makes
 *     every memo comparison fail and silently undoes all of point 1.
 *  3. The final block is repaired before parsing, so half-typed emphasis never
 *     flickers between raw `**foo` and bold as the closing marker lands.
 *
 * SECURITY. react-markdown 10 is safe by default and this file keeps it that
 * way: no `rehype-raw` (so bot-authored HTML is inert), no `urlTransform`
 * override (so the built-in `javascript:` sanitiser stays on), an explicit
 * `disallowedElements` list, and links that go through `system.openExternal`
 * instead of navigating the renderer.
 */

/* ------------------------------------------------------------------ *
 * Scoped stylesheet
 *
 * Markdown output is a tree we do not build, so its typography has to be
 * addressed with descendant selectors — nested list markers, first-child
 * margins, `pre > code` versus inline code, the streaming caret on the last
 * element of the last block. Inline style props cannot express any of that.
 * The sheet is injected once, is scoped entirely under `.md-body`, and uses
 * only tokens from tokens.css.
 * ------------------------------------------------------------------ */

const STYLE_ID = 'ccb-markdown-styles'

const MD_CSS = `
.md-body {
  font-size: var(--fs-ui);
  line-height: var(--lh-ui);
  letter-spacing: var(--ls-ui);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.md-body :where(p, ul, ol, pre, blockquote, table, h1, h2, h3, h4, h5, h6, hr) { margin: 0; }
.md-block > * { margin-top: 10px; }
.md-block > :first-child { margin-top: 0; }
.md-block + .md-block { margin-top: 10px; }
.md-block > :where(h1, h2, h3) { margin-top: 16px; }

.md-body h1 { font-size: var(--fs-h1); line-height: var(--lh-h1); letter-spacing: var(--ls-h1); font-weight: 550; }
.md-body h2 { font-size: 17px; line-height: 24px; letter-spacing: -0.014em; font-weight: 550; }
.md-body h3 { font-size: var(--fs-title); line-height: var(--lh-title); letter-spacing: var(--ls-title); font-weight: 550; }
.md-body :where(h4, h5, h6) { font-size: var(--fs-ui); line-height: var(--lh-ui); font-weight: 550; }

.md-body strong { font-weight: 590; }
.md-body em { font-style: italic; }
.md-body del { color: var(--fg-tertiary); }

.md-body ul, .md-body ol { padding-left: 22px; }
.md-body ul { list-style: disc; }
.md-body ul ul { list-style: circle; }
.md-body ul ul ul { list-style: square; }
.md-body ol { list-style: decimal; }
.md-body li { margin: 2px 0; }
.md-body li::marker { color: var(--fg-tertiary); }
.md-body li > :where(ul, ol) { margin-top: 2px; }
.md-body li > p { margin-top: 0; }
.md-body li > p + p { margin-top: 8px; }
.md-body ul.contains-task-list { list-style: none; padding-left: 1px; }
.md-body li.task-list-item { display: flex; align-items: flex-start; gap: 8px; }

.md-body .ccb-task {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 3.5px;
  border-radius: var(--r-2);
  border: 1.5px solid var(--border-3);
}
.md-body .ccb-task[data-checked='true'] { background: var(--accent); border-color: var(--accent); }
.md-body .ccb-task[data-checked='true']::after {
  content: '';
  width: 7px;
  height: 3.5px;
  border-left: 1.75px solid var(--fg-on-accent);
  border-bottom: 1.75px solid var(--fg-on-accent);
  transform: translateY(-1px) rotate(-45deg);
}

.md-body blockquote {
  border-left: 2px solid var(--border-3);
  padding-left: 12px;
  color: var(--fg-secondary);
}
.md-body hr { border: 0; border-top: 1px solid var(--border-1); }
.md-block > hr { margin-top: 14px; }

.md-body :not(pre) > code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--chip-bg);
  border: 1px solid var(--border-1);
  border-radius: var(--r-3);
  padding: 1px 5px;
}

/* overflow-x: auto forces overflow-y to compute to auto as well, which makes this
   a vertical scroll container with zero scrollable extent. .scroller sets
   overscroll-behavior: contain, so a wheel gesture with the pointer over a table
   used to be swallowed here and the transcript simply did not move. Contain
   sideways (a wide table must never chain), chain vertically. */
.md-body .md-table { overflow-x: auto; overscroll-behavior-x: contain; overscroll-behavior-y: auto; max-width: 100%; }
.md-body table {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
  font-size: var(--fs-meta);
  line-height: var(--lh-meta);
  letter-spacing: var(--ls-meta);
}
.md-body :where(th, td) {
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-1);
}
.md-body th { font-weight: 550; color: var(--fg-secondary); white-space: nowrap; border-bottom-color: var(--border-2); }
.md-body tbody tr:last-child td { border-bottom: 0; }

.md-body a { color: var(--link); text-decoration: none; }
.md-body a:hover { text-decoration: underline; text-underline-offset: 2px; }
.md-body a.md-link-inert { color: inherit; text-decoration: underline dotted; text-underline-offset: 2px; }

.md-body img { display: block; max-width: 100%; height: auto; border-radius: var(--r-4); }
.md-body .md-img-fallback { color: var(--fg-tertiary); font-size: var(--fs-meta); font-style: italic; }

/* The streaming caret rides the last element of the last block so closed blocks
   are never touched, and never lands inside a code block. */
.md-block.is-incomplete > :last-child:not(.ccb-code)::after,
.md-block.is-incomplete.md-plain::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  opacity: 0.7;
  animation: caret 1s steps(2, start) infinite;
}

/* Inverted tone: markdown inside the white user bubble. Token colours are tuned
   for the dark transcript ground and would vanish here, so the few colour-bearing
   elements fall back to neutral translucency that works on any fill. */
.md-body[data-tone='invert'] :not(pre) > code {
  background: rgba(128, 128, 128, 0.18);
  border-color: rgba(128, 128, 128, 0.28);
}
.md-body[data-tone='invert'] a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.md-body[data-tone='invert'] blockquote { border-left-color: rgba(128, 128, 128, 0.4); color: inherit; opacity: 0.78; }
.md-body[data-tone='invert'] li::marker { color: inherit; }
.md-body[data-tone='invert'] :where(th, td) { border-bottom-color: rgba(128, 128, 128, 0.28); }
.md-body[data-tone='invert'] del { color: inherit; opacity: 0.6; }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = MD_CSS
  document.head.append(style)
}

ensureStyles()

/* ------------------------------------------------------------------ *
 * hast helpers
 * ------------------------------------------------------------------ */

function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(hastText).join('')
  return ''
}

function languageOf(node: Element | undefined): string | null {
  // hast types `className` as a union wide enough that TypeScript narrows the
  // string branch away, so the value is read as unknown and narrowed by hand.
  const raw: unknown = node?.properties?.className
  const classes = Array.isArray(raw)
    ? raw.map((entry) => String(entry))
    : typeof raw === 'string'
      ? raw.split(/\s+/)
      : []
  for (const name of classes) {
    if (name.startsWith('language-')) return name.slice('language-'.length)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Rehype: real task-list checkboxes
 *
 * `input` is on the disallowed list (it is an interactive control we never want
 * bot output to create), which would otherwise delete GFM's task-list markers
 * along with it. Rehype plugins run BEFORE the disallow filter, so rewriting the
 * checkbox into an inert span here keeps the checklist readable without ever
 * putting a real form control in the transcript.
 * ------------------------------------------------------------------ */

function convertTaskInputs(children: unknown[]): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as Element | undefined
    if (!child || child.type !== 'element') continue
    if (child.tagName === 'input' && String(child.properties?.type) === 'checkbox') {
      const checkbox: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['ccb-task'],
          'data-checked': child.properties?.checked ? 'true' : 'false'
        },
        children: []
      }
      children[i] = checkbox
      continue
    }
    convertTaskInputs(child.children)
  }
}

const rehypeTaskCheckbox: Plugin<[], Root> = () => {
  return (tree: Root): void => {
    convertTaskInputs(tree.children as RootContent[])
  }
}

/* ------------------------------------------------------------------ *
 * Remark: a single newline is a line break
 *
 * CommonMark collapses a soft break to a space, which is right for a document
 * and wrong for a messenger: a Bot answering with one item per line, or a user
 * who pressed ⇧Enter three times, came back as a single run-on paragraph. Chat
 * products all render single newlines as breaks, so every `\n` inside a `text`
 * node is rewritten into a `break` here.
 *
 * This is the rewrite `remark-breaks` performs, written locally because it is
 * ten lines of tree walking and this renderer does not take a dependency for
 * that. Two things it must NOT touch, both handled by construction:
 *  - CODE. Fenced and indented code are `code` nodes and inline spans are
 *    `inlineCode`; neither is a `text` node, so their newlines are never seen.
 *  - TABLES. A GFM cell cannot contain a newline, and rewriting inside one
 *    would only ever be wrong, so `table` subtrees are skipped outright.
 * `markdownBlocks.ts` is not involved: the split still happens on blank lines,
 * so block boundaries, memo keys and the plain-prose fast path are unchanged
 * (the fast path only ever takes single-line blocks).
 * ------------------------------------------------------------------ */

function softBreaksToHard(node: MdastParents): void {
  // A table's cells are line-delimited by definition; nothing inside one can
  // legitimately carry a newline.
  if (node.type === 'table') return

  const children = node.children as MdastNodes[]
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!
    if (child.type === 'text') {
      if (!child.value.includes('\n')) continue
      const pieces = child.value.split(/\r?\n/)
      const replacement: MdastNodes[] = []
      for (let p = 0; p < pieces.length; p += 1) {
        if (p > 0) replacement.push({ type: 'break' })
        if (pieces[p]!.length > 0) replacement.push({ type: 'text', value: pieces[p]! })
      }
      children.splice(i, 1, ...replacement)
      i += replacement.length - 1
      continue
    }
    if ('children' in child) softBreaksToHard(child)
  }
}

const remarkSoftBreaks: Plugin<[], MdastRoot> = () => {
  return (tree: MdastRoot): void => {
    softBreaksToHard(tree)
  }
}

/* ------------------------------------------------------------------ *
 * Module-level constants — see point 2 at the top of this file
 * ------------------------------------------------------------------ */

const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkSoftBreaks]
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeTaskCheckbox]

/** Interactive or script-bearing elements bot output may never produce. */
const DISALLOWED_ELEMENTS: readonly string[] = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input'
]

/** True while the block ends inside a fence that has not closed yet. */
const OpenFenceContext = createContext(false)

function MarkdownLink({
  href,
  children,
  title
}: {
  href?: string
  title?: string
  children?: ReactNode
}): ReactElement {
  const external = typeof href === 'string' && /^https?:\/\//i.test(href)

  if (!external) {
    // Anything that is not http(s) — a relative path, a mailto, a file URL —
    // renders as inert text with the target visible on hover. The renderer never
    // navigates and never hands an unknown scheme to the OS.
    return (
      <a className="md-link-inert" title={href ?? title} onClick={(e) => e.preventDefault()}>
        {children}
      </a>
    )
  }

  return (
    <a
      href={href}
      title={title ?? href}
      onClick={(event) => {
        // Opening in the default browser, never in the app window: a navigation
        // inside the renderer would replace the whole app.
        event.preventDefault()
        void bridge().system.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

function MarkdownPre({ node }: { node?: Element }): ReactElement {
  const codeNode = node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code'
  )
  const source = codeNode ? hastText(codeNode) : ''
  const openFence = useContext(OpenFenceContext)

  return (
    <CodeBlock
      code={source.replace(/\n$/, '')}
      lang={languageOf(codeNode)}
      closed={!openFence}
    />
  )
}

function MarkdownTable({ children }: { children?: ReactNode }): ReactElement {
  // Its own horizontal scroller. A wide table must never make the transcript
  // itself scroll sideways.
  return (
    <div className="md-table scroller">
      <table>{children}</table>
    </div>
  )
}

function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed || typeof src !== 'string' || src.length === 0) {
    return <span className="md-img-fallback">{alt || 'Image unavailable'}</span>
  }
  return (
    <img
      src={src}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  pre: MarkdownPre,
  table: MarkdownTable,
  img: MarkdownImage
}

/* ------------------------------------------------------------------ *
 * One block
 * ------------------------------------------------------------------ */

interface MarkdownBlockProps {
  raw: string
  index: number
  incomplete: boolean
}

const MarkdownBlockView = memo(
  function MarkdownBlockView({ raw, incomplete }: MarkdownBlockProps): ReactElement | null {
    // Repair is applied ONLY to a block that is still being written. A finished
    // message must render exactly the markdown its author produced.
    const source = incomplete ? repairStreamingMarkdown(raw) : raw
    const openFence = incomplete && hasOpenFence(raw)

    const trimmed = source.trim()
    if (trimmed.length === 0) return null

    // Fast path: a single line of ordinary prose, which is what most chat
    // messages are. Skips a micromark parse and a hast→JSX conversion on every
    // delta. Restricted to single-line blocks so it can never disagree with the
    // parser about soft line breaks.
    if (!trimmed.includes('\n') && isPlainProse(trimmed)) {
      return (
        <p className={cn('md-block md-plain', incomplete && 'is-incomplete')}>{trimmed}</p>
      )
    }

    return (
      <div className={cn('md-block', incomplete && 'is-incomplete')}>
        <OpenFenceContext.Provider value={openFence}>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={COMPONENTS}
            disallowedElements={DISALLOWED_ELEMENTS}
            unwrapDisallowed
          >
            {source}
          </ReactMarkdown>
        </OpenFenceContext.Provider>
      </div>
    )
  },
  // `components` / `remarkPlugins` / `rehypePlugins` are module constants rather
  // than props, so their identity is fixed and only the block's own content and
  // streaming flag can change what it renders.
  (prev, next) =>
    prev.raw === next.raw && prev.index === next.index && prev.incomplete === next.incomplete
)

/* ------------------------------------------------------------------ *
 * Public component
 * ------------------------------------------------------------------ */

export interface MarkdownProps {
  content: string
  /** True while tokens are still arriving: repairs and carets the last block. */
  streaming?: boolean
  /** `invert` = rendered on the filled user bubble. */
  tone?: 'default' | 'invert'
  className?: string
}

export function Markdown({
  content,
  streaming = false,
  tone = 'default',
  className
}: MarkdownProps): ReactElement | null {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])
  if (blocks.length === 0) return null

  const lastIndex = blocks.length - 1

  return (
    <div
      className={cn('md-body selectable', className)}
      data-tone={tone === 'invert' ? 'invert' : undefined}
    >
      {blocks.map((raw, index) => (
        <MarkdownBlockView
          // The index is the identity: blocks are append-only, so block 3 is
          // always block 3 and React keeps its DOM across deltas.
          key={index}
          raw={raw}
          index={index}
          incomplete={streaming && index === lastIndex}
        />
      ))}
    </div>
  )
}
