import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, ClipboardList } from 'lucide-react'

import type { DiagnosticsReport } from '@shared/types'
import { bridge, withToast } from '@/lib/ipc'
import { formatDaySeparator } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { CopyField, Note, SettingRow, SettingsSection } from './SettingRow'

/**
 * PRD §39, verbatim. This exact sentence is also the disclosure on the first
 * onboarding screen; it is reproduced here word for word so a user who wants to
 * re-read it later finds the same statement rather than a paraphrase.
 */
const PRIVACY_DISCLOSURE =
  'Chats are stored by this app on your computer. When a Bot runs, the app invokes your installed Claude Code client, which sends model requests according to your Anthropic account and privacy settings.'

/** `Chrome/141.0.0.0` inside the Electron user-agent. */
function chromiumVersion(): string {
  const match = /Chrome\/([\d.]+)/.exec(navigator.userAgent)
  return match?.[1] ?? 'unknown'
}

function pad(label: string): string {
  return label.padEnd(16, ' ')
}

function formatDiagnostics(report: DiagnosticsReport): string {
  const lines: string[] = [
    'Claude Bot — diagnostics',
    `Generated        ${new Date().toISOString()}`,
    '',
    `${pad('App')}${report.appVersion}`,
    `${pad('Electron')}${report.electronVersion}`,
    `${pad('Chromium')}${chromiumVersion()}`,
    `${pad('Node')}${report.nodeVersion}`,
    `${pad('Platform')}${report.platform} ${report.arch}`,
    '',
    `${pad('Claude Code')}${report.claudeVersion ?? 'not detected'}`,
    `${pad('Executable')}${report.claudeExecutablePath ?? 'not resolved'}`,
    `${pad('Database')}${report.dbPath}`,
    `${pad('Parse errors')}${report.parseErrors}`,
    '',
    'Recent process exits'
  ]

  if (report.recentExitCodes.length === 0) {
    lines.push('  none recorded this session')
  } else {
    for (const exit of report.recentExitCodes) {
      lines.push(
        `  ${exit.at}  job ${exit.jobId}  code ${exit.code ?? '—'}  signal ${exit.signal ?? '—'}`
      )
    }
  }

  lines.push('', 'Settings')
  for (const [key, value] of Object.entries(report.settings)) {
    lines.push(`  ${key.padEnd(36, ' ')}${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }

  return lines.join('\n')
}

export function AboutTab(): ReactElement {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void bridge()
      .system.diagnostics()
      .then((next) => {
        if (!cancelled) setReport(next)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const copyDiagnostics = useCallback(async () => {
    const result = await withToast(
      async () => {
        // Re-read rather than reusing the mounted snapshot: the interesting part
        // of a bug report is usually the exit code from thirty seconds ago.
        const fresh = await bridge().system.diagnostics()
        setReport(fresh)
        await bridge().system.copyText(formatDiagnostics(fresh))
        return fresh
      },
      { errorTitle: 'Could not build a diagnostics report' }
    )
    if (result === null) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [])

  return (
    <>
      <SettingsSection title="Versions">
        {failed ? (
          <SettingRow
            label="Version information is unavailable"
            description="The app could not read its own diagnostics. Restarting usually clears this."
          />
        ) : (
          <>
            <VersionRow label="Claude Bot" value={report?.appVersion} />
            <VersionRow label="Electron" value={report?.electronVersion} />
            <VersionRow label="Chromium" value={chromiumVersion()} />
            <VersionRow label="Node" value={report?.nodeVersion} />
            <VersionRow
              label="Platform"
              value={report ? `${report.platform} · ${report.arch}` : undefined}
            />
            <VersionRow
              label="Claude Code"
              value={
                report ? (report.claudeVersion ? `v${report.claudeVersion}` : 'Not detected') : undefined
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Privacy"
        description="The short version: your conversations stay here, your model requests go to Anthropic through the Claude Code you already installed."
      >
        <SettingRow
          label="Where your data goes"
          footnote={
            <div className="flex flex-col" style={{ gap: 10 }}>
              <blockquote
                className="selectable text-[var(--fg-primary)]"
                style={{
                  padding: '10px 14px',
                  borderLeft: '2px solid var(--border-3)',
                  background: 'var(--chip-bg)',
                  borderRadius: '0 var(--r-4) var(--r-4) 0',
                  fontSize: 'var(--fs-meta)',
                  lineHeight: 'var(--lh-meta)',
                  letterSpacing: 'var(--ls-meta)'
                }}
              >
                {PRIVACY_DISCLOSURE}
              </blockquote>
              <Note tone="neutral">
                <strong style={{ fontWeight: 550, color: 'var(--fg-primary)' }}>
                  Inference is not local.
                </strong>{' '}
                No model runs on this computer. Claude Bot stores and displays your Bots and
                transcripts locally; the thinking happens at Anthropic, billed against your own
                Claude subscription. This app has no server, no account of its own, and no analytics.
              </Note>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingRow
          label="Copy diagnostics"
          description="Versions, your platform, the database path, how many malformed stream lines have been seen, the last few Claude Code process exits, and your settings. No transcripts, no Bot descriptions, no credentials."
          control={
            <Button
              size="sm"
              leading={
                copied ? (
                  <Check size={14} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
                ) : (
                  <ClipboardList size={14} strokeWidth={1.75} />
                )
              }
              onClick={() => void copyDiagnostics()}
            >
              {copied ? 'Copied' : 'Copy diagnostics'}
            </Button>
          }
          footnote={
            <div className="flex flex-col" style={{ gap: 8 }}>
              <CopyField
                value={report?.dbPath ?? null}
                empty="Reading…"
                copyLabel="Copy database path"
              />
              <p className="text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
                {report
                  ? `${report.parseErrors} malformed stream ${
                      report.parseErrors === 1 ? 'line' : 'lines'
                    } · ${report.recentExitCodes.length} recent process ${
                      report.recentExitCodes.length === 1 ? 'exit' : 'exits'
                    }${
                      report.recentExitCodes[0]
                        ? ` · last ${formatDaySeparator(report.recentExitCodes[0].at)}`
                        : ''
                    }`
                  : ' '}
              </p>
            </div>
          }
        />
      </SettingsSection>
    </>
  )
}

function VersionRow({ label, value }: { label: string; value?: string }): ReactElement {
  return (
    <div
      className="flex items-center gap-[16px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-[var(--border-1)]"
      style={{ height: 40 }}
    >
      <span
        className="min-w-0 flex-1 truncate text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
      >
        {label}
      </span>
      {value === undefined ? (
        // Delayed internally, so a fast read never flashes a placeholder.
        <Skeleton width={72} height={10} />
      ) : (
        <span
          className="selectable shrink-0 text-[var(--fg-primary)]"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' }}
        >
          {value}
        </span>
      )}
    </div>
  )
}
