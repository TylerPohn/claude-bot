import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  FolderSearch,
  RefreshCw,
  TriangleAlert
} from 'lucide-react'

import type { RuntimeStatus } from '@shared/types'
import { bridge, withToast } from '@/lib/ipc'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'

/** The one-liner that installs Claude Code for the overwhelming majority of users. */
const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

/**
 * Screen 2 — detect Claude Code (PRD §35). Installed / Not found, the version and
 * the resolved path, with real remediation when it is missing. `Continue` is
 * blocked until an executable actually resolves; `Skip setup` in the header is
 * always available, because a hard block with no exit is a trap.
 */
export function DetectStep({
  status,
  checking,
  watching,
  onRecheck,
  onPickExecutable
}: {
  status: RuntimeStatus | null
  checking: boolean
  /** True while the flow is re-probing on its own timer. */
  watching: boolean
  onRecheck(): void
  onPickExecutable(): void
}): ReactElement {
  const availability = status?.availability ?? 'checking'
  const found = availability === 'ok' || availability === 'unauthenticated'

  const verdict =
    availability === 'missing'
      ? {
          label: 'Not found',
          tone: 'var(--fg-danger)',
          icon: <CircleAlert size={18} strokeWidth={1.75} />,
          body: 'Claude Code Bots could not find a Claude Code executable on this computer.'
        }
      : availability === 'error'
        ? {
            label: 'Found, but not responding',
            tone: 'var(--fg-warning)',
            icon: <TriangleAlert size={18} strokeWidth={1.75} />,
            body: 'The executable exists but did not answer a version check. Try running it once in your terminal.'
          }
        : found
          ? {
              label: 'Installed',
              tone: 'var(--fg-success)',
              icon: <CircleCheck size={18} strokeWidth={1.75} />,
              body: 'Claude Code is ready. Your Bots will run through it.'
            }
          : {
              label: 'Checking…',
              tone: 'var(--fg-secondary)',
              icon: <Spinner size={16} />,
              body: 'Looking for Claude Code on your PATH and in the usual install locations.'
            }

  return (
    <div className="flex flex-col">
      <h1
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550,
          color: 'var(--fg-primary)'
        }}
      >
        Find your Claude Code
      </h1>
      <p
        className="mt-[8px]"
        style={{
          maxWidth: 520,
          fontSize: 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          color: 'var(--fg-secondary)'
        }}
      >
        This app never talks to Anthropic directly. Every turn is run by the Claude Code CLI
        installed on this computer, under your own account.
      </p>

      <section
        className="mt-[24px] flex flex-col"
        style={{
          padding: 16,
          gap: 14,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-1)',
          borderRadius: 'var(--r-5)'
        }}
      >
        <div className="flex items-start" style={{ gap: 12 }}>
          <span
            aria-hidden
            className="grid shrink-0 place-items-center"
            style={{ width: 20, height: 20, marginTop: 1, color: verdict.tone }}
          >
            {verdict.icon}
          </span>
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
            <p
              style={{
                fontSize: 'var(--fs-label)',
                lineHeight: 'var(--lh-label)',
                fontWeight: 550,
                color: verdict.tone
              }}
            >
              {verdict.label}
            </p>
            <p
              style={{
                fontSize: 'var(--fs-meta)',
                lineHeight: 'var(--lh-meta)',
                color: 'var(--fg-secondary)'
              }}
            >
              {verdict.body}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            loading={checking}
            onClick={onRecheck}
            leading={<RefreshCw size={14} strokeWidth={1.75} />}
          >
            Recheck
          </Button>
        </div>

        <dl className="flex flex-col" style={{ gap: 8 }}>
          <Field label="Version">
            {status?.version ? (
              <Mono>{status.version}</Mono>
            ) : (
              <Muted>{found ? 'Unknown' : 'Not available yet'}</Muted>
            )}
          </Field>
          <Field
            label="Path"
            action={
              status?.executablePath ? <CopyButton value={status.executablePath} /> : undefined
            }
          >
            {status?.executablePath ? (
              <Mono title={status.executablePath}>{status.executablePath}</Mono>
            ) : (
              <Muted>Not available yet</Muted>
            )}
          </Field>
        </dl>
      </section>

      {availability === 'missing' ? (
        <section className="mt-[16px] flex flex-col" style={{ gap: 10 }}>
          <p
            style={{
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              color: 'var(--fg-secondary)'
            }}
          >
            Install it in a terminal, then come back — this screen updates on its own.
          </p>
          <div
            className="selectable flex items-center"
            style={{
              gap: 10,
              padding: '10px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 'var(--r-4)'
            }}
          >
            <code
              className="min-w-0 flex-1 truncate"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-code)',
                color: 'var(--fg-primary)'
              }}
            >
              {INSTALL_COMMAND}
            </code>
            <CopyButton value={INSTALL_COMMAND} label="Copy install command" />
          </div>
        </section>
      ) : null}

      {status?.detail && availability === 'error' ? (
        <p
          className="selectable mt-[12px]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            color: 'var(--fg-tertiary)',
            fontFamily: 'var(--font-mono)'
          }}
        >
          {status.detail}
        </p>
      ) : null}

      <div className="mt-[16px] flex flex-wrap items-center" style={{ gap: 10 }}>
        <Button
          variant="secondary"
          onClick={onPickExecutable}
          leading={<FolderSearch size={16} strokeWidth={1.75} />}
        >
          Choose executable…
        </Button>
        {watching ? (
          /* One motion element, driven by something real: the app genuinely is
             re-probing every few seconds while this line is on screen. It
             disappears the moment the loop stops, so it never claims to be
             watching when it is not. */
          <span className="shimmer-text" style={{ fontSize: 'var(--fs-meta)' }}>
            Watching for Claude Code…
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function Field({
  label,
  children,
  action
}: {
  label: string
  children: ReactNode
  action?: ReactNode
}): ReactElement {
  return (
    <div className="flex items-center" style={{ gap: 10 }}>
      <dt
        className="shrink-0"
        style={{ width: 56, fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
      >
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
      {action}
    </div>
  )
}

function Mono({ children, title }: { children: ReactNode; title?: string }): ReactElement {
  return (
    <span
      className="selectable block truncate"
      title={title}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-code)',
        color: 'var(--fg-primary)'
      }}
    >
      {children}
    </span>
  )
}

function Muted({ children }: { children: ReactNode }): ReactElement {
  return (
    <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-quaternary)' }}>{children}</span>
  )
}

/** Copies to the clipboard and confirms in place — a toast for a two-word action
 *  is more interruption than information. */
function CopyButton({ value, label = 'Copy path' }: { value: string; label?: string }): ReactElement {
  const [copied, setCopied] = useState(false)

  return (
    <IconButton
      label={copied ? 'Copied' : label}
      size={28}
      onClick={() => {
        void withToast(() => bridge().system.copyText(value), {
          errorTitle: 'Could not copy to the clipboard'
        }).then((result) => {
          if (result === null) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? (
        <Check size={14} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
      ) : (
        <Copy size={14} strokeWidth={1.75} />
      )}
    </IconButton>
  )
}
