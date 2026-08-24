import type { ReactElement } from 'react'
import { CircleCheck, CircleHelp, CircleAlert, RefreshCw, Terminal } from 'lucide-react'

import type { RuntimeStatus } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'

/**
 * Screen 3 — verify authentication (PRD §35).
 *
 * The probe reads Claude Code's own login state (`claude auth status`, then
 * `claude doctor`, then on-disk credential evidence). It never sends a prompt, so
 * it costs no meaningful quota — and when none of those three answer, the runtime
 * reports "unverified" rather than guessing. This screen says so plainly instead
 * of claiming a green check it has not earned.
 */
function isUnverified(detail: string | null | undefined): boolean {
  if (!detail) return false
  return /unverified|could not verify/i.test(detail)
}

export function AuthStep({
  status,
  checking,
  watching,
  onRecheck,
  onOpenTerminal,
  onBack
}: {
  status: RuntimeStatus | null
  checking: boolean
  /** True while the flow is re-probing on its own timer. */
  watching: boolean
  onRecheck(): void
  onOpenTerminal(): void
  onBack(): void
}): ReactElement {
  const availability = status?.availability ?? 'checking'
  const unverified = availability === 'ok' && isUnverified(status?.detail)
  const signedIn = availability === 'ok' && !unverified
  const runtimeMissing = availability === 'missing' || availability === 'error'

  const verdict = runtimeMissing
    ? {
        label: 'Claude Code is not available yet',
        tone: 'var(--fg-warning)',
        icon: <CircleAlert size={18} strokeWidth={1.75} />,
        body: 'Go back a step and point the app at a working Claude Code first — there is nothing to sign in to until then.'
      }
    : availability === 'unauthenticated'
      ? {
          label: 'Not signed in',
          tone: 'var(--fg-danger)',
          icon: <CircleAlert size={18} strokeWidth={1.75} />,
          body:
            status?.detail ??
            'Claude Code reports that you are not signed in. Open a terminal, run `claude`, and finish signing in there.'
        }
      : unverified
        ? {
            label: 'Could not confirm your sign-in',
            tone: 'var(--fg-warning)',
            icon: <CircleHelp size={18} strokeWidth={1.75} />,
            body:
              status?.detail ??
              'This build of Claude Code does not report its login state. That is usually fine — if a turn fails with a login error, sign in from a terminal and come back.'
          }
        : signedIn
          ? {
              label: 'Signed in',
              tone: 'var(--fg-success)',
              icon: <CircleCheck size={18} strokeWidth={1.75} />,
              body: status?.detail ?? 'Claude Code is signed in and ready.'
            }
          : {
              label: 'Checking…',
              tone: 'var(--fg-secondary)',
              icon: <Spinner size={16} />,
              body: 'Reading Claude Code’s own login state.'
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
        Check your Claude sign-in
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
        Bots run under your own Claude subscription. This check only reads Claude Code’s login
        state — it never sends a prompt to a model, so it uses no meaningful quota.
      </p>

      <section
        className="mt-[24px] flex items-start"
        style={{
          gap: 12,
          padding: 16,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-1)',
          borderRadius: 'var(--r-5)'
        }}
      >
        <span
          aria-hidden
          className="grid shrink-0 place-items-center"
          style={{ width: 20, height: 20, marginTop: 1, color: verdict.tone }}
        >
          {verdict.icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 3 }}>
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
            className="selectable"
            style={{
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              color: 'var(--fg-secondary)'
            }}
          >
            {verdict.body}
          </p>
        </div>
      </section>

      <div className="mt-[16px] flex flex-wrap items-center" style={{ gap: 10 }}>
        {runtimeMissing ? (
          <Button variant="secondary" onClick={onBack}>
            Back to detection
          </Button>
        ) : (
          <Button
            variant={signedIn ? 'secondary' : 'filled'}
            onClick={onOpenTerminal}
            leading={<Terminal size={16} strokeWidth={1.75} />}
          >
            {signedIn ? 'Open Claude Code in Terminal' : 'Open Terminal to sign in'}
          </Button>
        )}
        <Button
          variant="ghost"
          loading={checking}
          onClick={onRecheck}
          leading={<RefreshCw size={16} strokeWidth={1.75} />}
        >
          Recheck
        </Button>
        {watching && !runtimeMissing ? (
          <span className="shimmer-text" style={{ fontSize: 'var(--fs-meta)' }}>
            Rechecking automatically…
          </span>
        ) : null}
      </div>

      <p
        className="mt-[20px]"
        style={{
          maxWidth: 520,
          fontSize: 'var(--fs-micro)',
          lineHeight: 'var(--lh-micro)',
          color: 'var(--fg-quaternary)'
        }}
      >
        Signing in happens entirely inside Claude Code. This app never sees, stores or transmits
        your credentials, and there is no separate API key to enter.
      </p>
    </div>
  )
}
