import { memo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  ArrowRight,
  FolderX,
  Info,
  RefreshCw,
  Repeat,
  ShieldAlert,
  Square,
  Timer,
  UserMinus
} from 'lucide-react'

import type { Message, SystemMessageKind } from '@shared/types'
import { cn } from '@/lib/cn'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'

/**
 * System notices — the app talking, not a Bot.
 *
 * Every string here is the product's own remediation copy from PRD §37 and is
 * VERBATIM. Two rules the copy encodes:
 *
 *  - A usage limit never mentions API keys or billing. The user has a Claude
 *    subscription; suggesting they buy credits is both wrong and alarming.
 *  - Every failure names the fix, and where the fix is a thing the app can do,
 *    the card carries the button that does it.
 *
 * Permission denial gets DESIGN §2.4's nested-panel treatment rather than a thin
 * notice: it has to show the exact command that was refused, and a monospace
 * command inside a raised panel is how this product shows machine text.
 */

type Severity = 'info' | 'warn' | 'danger'

const SEVERITY_COLOR: Record<Severity, string> = {
  info: 'var(--fg-tertiary)',
  warn: 'var(--fg-warning)',
  danger: 'var(--fg-danger)'
}

/** Title + severity + glyph for the notice kinds that render as a thin card. */
const NOTICE: Record<
  Exclude<SystemMessageKind, 'handoff' | 'permission_denied'>,
  { title: string; severity: Severity; Icon: typeof Info }
> = {
  generic: { title: '', severity: 'info', Icon: Info },
  session_recovered: {
    // PRD §37, verbatim.
    title: 'Started a fresh Claude session because the previous session could not be resumed.',
    severity: 'info',
    Icon: RefreshCw
  },
  rate_limit: {
    // PRD §37, verbatim. Never mention API keys or billing.
    title:
      'Claude Code usage limit reached. Your Bot history is safe. Retry after your Claude allowance resets.',
    severity: 'warn',
    Icon: Timer
  },
  loop_guard: {
    title: 'Stopped to avoid a loop.',
    severity: 'warn',
    Icon: Repeat
  },
  workspace_missing: {
    title: 'This conversation’s working folder is missing.',
    severity: 'warn',
    Icon: FolderX
  },
  bot_removed: {
    title: 'A Bot in this conversation was removed.',
    severity: 'info',
    Icon: UserMinus
  },
  interrupted: {
    title: 'This run was interrupted.',
    severity: 'info',
    Icon: Square
  }
}

export interface SystemMessageProps {
  message: Message
}

export const SystemMessage = memo(function SystemMessage({
  message
}: SystemMessageProps): ReactElement | null {
  const kind: SystemMessageKind = message.systemKind ?? 'generic'

  if (kind === 'handoff') return <HandoffRow message={message} />
  if (kind === 'permission_denied') return <PermissionCard message={message} />

  const notice = NOTICE[kind as Exclude<SystemMessageKind, 'handoff' | 'permission_denied'>]
  const body = message.bodyMarkdown.trim()
  const title = notice.title || body || 'Something changed in this conversation.'
  // Main often sends a short body that is the opening clause of the canonical
  // copy. Printing both would show the same sentence twice, so the detail line
  // only appears when it actually adds something.
  const detail = notice.title && body.length > 0 && !isRestatement(notice.title, body) ? body : null
  const { Icon } = notice

  return (
    <NoticeCard severity={notice.severity} icon={<Icon size={16} strokeWidth={1.75} />}>
      <p
        className="selectable text-[var(--fg-primary)]"
        style={{
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          letterSpacing: 'var(--ls-meta)',
          fontWeight: 550
        }}
      >
        {title}
      </p>
      {detail ? (
        <p
          className="selectable mt-[3px] text-[var(--fg-secondary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            // Main writes multi-line notice bodies (the missing-workspace card
            // is "…not found: <path>\nSet a workspace…"). Under the default
            // `white-space: normal` the newline collapsed and the path was glued
            // to the next sentence with no punctuation, reading as one run-on.
            whiteSpace: 'pre-line',
            overflowWrap: 'anywhere'
          }}
        >
          {detail}
        </p>
      ) : null}

      {kind === 'workspace_missing' ? (
        <NoticeActions>
          <TextAction
            label="Choose a folder…"
            onClick={() => void chooseWorkspace(message.conversationId)}
          />
        </NoticeActions>
      ) : null}

      {kind === 'interrupted' ? <InterruptedActions message={message} /> : null}
    </NoticeCard>
  )
})

/* ------------------------------------------------------------------ *
 * Handoff — visible orchestration, never invisible
 * ------------------------------------------------------------------ */

/**
 * DESIGN §3.5: a handoff is a full-width centred row, not a bubble — sender
 * avatar, the sentence, receiver avatar. A Bot silently picking up another Bot's
 * work is the single most confusing thing a multi-agent app can do, so this is
 * always rendered even when the note is empty.
 */
function HandoffRow({ message }: { message: Message }): ReactElement {
  const fromBot = useAppStore((state) =>
    message.handoffFromBotId ? state.bots[message.handoffFromBotId] : undefined
  )
  const toBot = useAppStore((state) =>
    message.authorBotId ? state.bots[message.authorBotId] : undefined
  )

  const fromName = fromBot?.name ?? 'A Bot'
  const toName = toBot?.name ?? message.authorName ?? 'another Bot'
  const note = message.bodyMarkdown.trim()

  return (
    <div className="flex flex-col items-center" style={{ margin: '12px 0' }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <BotAvatar bot={fromBot ?? null} name={fromName} size={20} />
        <span
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)'
          }}
        >
          <span style={{ color: 'var(--fg-secondary)', fontWeight: 550 }}>{fromName}</span> handed
          off to <span style={{ color: 'var(--fg-secondary)', fontWeight: 550 }}>{toName}</span>
        </span>
        <ArrowRight size={14} strokeWidth={1.75} className="text-[var(--fg-quaternary)]" />
        <BotAvatar
          bot={toBot ?? null}
          name={toName}
          avatarType={toBot ? undefined : (message.authorAvatarType ?? undefined)}
          avatarValue={toBot ? undefined : (message.authorAvatarValue ?? undefined)}
          accent={toBot ? undefined : (message.authorAccent ?? undefined)}
          size={20}
        />
      </div>
      {note.length > 0 ? (
        <p
          className="selectable mt-[6px] text-center text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            maxWidth: 520,
            overflowWrap: 'anywhere'
          }}
        >
          {note}
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Permission remediation
 * ------------------------------------------------------------------ */

/**
 * Print-mode Claude Code cannot round-trip an approval prompt, so there is no
 * Allow / Deny / Always-allow card in v1 (RENDERER scope deviation). What the
 * user gets instead is the exact refused operation plus the two things that
 * actually unblock it.
 */
function PermissionCard({ message }: { message: Message }): ReactElement {
  const bot = useAppStore((state) => (message.authorBotId ? state.bots[message.authorBotId] : undefined))
  const workspace = useAppStore(
    (state) =>
      state.conversations[message.conversationId]?.workspaceDirectory ??
      (message.authorBotId ? (state.bots[message.authorBotId]?.defaultWorkingDirectory ?? null) : null)
  )

  const body = message.bodyMarkdown.trim()
  const tool = extractToolName(body) ?? 'a tool'
  const botName = bot?.name ?? message.authorName ?? 'This Bot'
  const detail = body.length > 0 ? body : 'Claude Code refused the operation under the current permission mode.'

  return (
    <div
      style={{
        margin: '12px 0',
        background: 'var(--bubble-agent-bg)',
        borderRadius: 'var(--r-card)',
        padding: 16,
        maxWidth: 640
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <ShieldAlert size={16} strokeWidth={1.75} style={{ color: 'var(--fg-warning)' }} />
        <p
          className="selectable min-w-0 text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-ui)',
            lineHeight: '20px',
            letterSpacing: 'var(--ls-ui)',
            fontWeight: 550
          }}
        >
          {botName} needs permission to run {tool}
        </p>
      </div>

      <div
        className="mt-[12px]"
        style={{
          background: 'var(--bubble-nested-bg)',
          borderRadius: 'var(--r-card-inner)',
          padding: 14
        }}
      >
        <pre
          className="scroller selectable overflow-x-auto text-[var(--fg-secondary)]"
          style={{
            margin: 0,
            // `overflow-x: auto` makes overflow-y compute to `auto` too, so
            // `.scroller`'s `overscroll-behavior: contain` turned this into a
            // wheel sink with nothing to scroll and froze the transcript under
            // the pointer. Chain vertically; keep sideways containment.
            overscrollBehaviorX: 'contain',
            overscrollBehaviorY: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-code)',
            lineHeight: 'var(--lh-code)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {detail}
        </pre>
      </div>

      <div className="mt-[12px] flex flex-wrap items-center" style={{ gap: 8 }}>
        <ActionPill
          label="Open in Terminal"
          onClick={() => {
            if (!workspace) return
            void withToast(() => bridge().system.openTerminalAt(workspace), {
              errorTitle: 'Could not open a terminal'
            })
          }}
          disabled={!workspace}
          primary
        />
        <ActionPill
          label="Edit allowed tools"
          onClick={() => {
            if (message.authorBotId) {
              useUiStore.getState().openModal({ kind: 'bot', botId: message.authorBotId })
            }
          }}
          disabled={!message.authorBotId}
        />
      </div>
    </div>
  )
}

/** True when `body` says nothing the canonical `title` has not already said. */
function isRestatement(title: string, body: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
  const a = normalize(title)
  const b = normalize(body)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/** Pull the first backticked token out of the denial text — that is the tool. */
function extractToolName(body: string): string | null {
  const backticked = /`([^`\n]{1,60})`/.exec(body)
  if (backticked?.[1]) return backticked[1].trim()
  const named = /\b(Bash|Edit|Write|Read|WebFetch|WebSearch|NotebookEdit|Task|Glob|Grep)\b/.exec(body)
  return named?.[1] ?? null
}

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

function NoticeCard({
  severity,
  icon,
  children
}: {
  severity: Severity
  icon: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <div
      className="flex items-start"
      style={{
        margin: '12px 0',
        padding: '10px 12px',
        gap: 10,
        borderRadius: 'var(--r-5)',
        background: 'var(--card-bg)',
        border: '1px solid var(--border-1)',
        maxWidth: 640
      }}
    >
      <span className="mt-[1px] shrink-0" style={{ color: SEVERITY_COLOR[severity] }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function NoticeActions({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="mt-[8px] flex flex-wrap items-center" style={{ gap: 12 }}>
      {children}
    </div>
  )
}

function TextAction({
  label,
  onClick,
  disabled
}: {
  label: string
  onClick(): void
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="no-drag text-[var(--accent)] hover:underline disabled:pointer-events-none disabled:opacity-40"
      style={{ fontSize: 'var(--fs-meta)', fontWeight: 550 }}
    >
      {label}
    </button>
  )
}

/** DESIGN §2.4 action button: 32px tall, radius 14, 14px / 550. */
function ActionPill({
  label,
  onClick,
  disabled,
  primary
}: {
  label: string
  onClick(): void
  disabled?: boolean
  primary?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'no-drag inline-flex items-center justify-center whitespace-nowrap',
        'transition-[background-color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40',
        primary
          ? 'bg-[var(--btn-filled-bg)] text-[var(--btn-filled-fg)] hover:bg-[var(--btn-filled-hover)]'
          : 'bg-[var(--btn-secondary-bg)] text-[var(--fg-primary)] hover:bg-[var(--surface-active)]'
      )}
      style={{
        height: 32,
        padding: '0 14px',
        borderRadius: 'var(--r-button)',
        fontSize: 'var(--fs-chrome)',
        letterSpacing: 'var(--ls-chrome)',
        fontWeight: 550
      }}
    >
      {label}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function chooseWorkspace(conversationId: string): Promise<void> {
  const picked = await bridge().system.pickDirectory()
  if (!picked.path) return
  await withToast(
    () => useAppStore.getState().updateConversation(conversationId, { workspaceDirectory: picked.path }),
    { successTitle: 'Working folder updated', errorTitle: 'Could not set that folder' }
  )
}

/**
 * "Retry" on an interruption needs a real target. The message immediately above
 * the notice is the run that was cut short, so that is what gets resent.
 */
function InterruptedActions({ message }: { message: Message }): ReactElement | null {
  const targetId = useAppStore((state) => {
    const list = state.messages[message.conversationId]
    if (!list) return null
    const index = list.findIndex((entry) => entry.id === message.id)
    for (let i = (index === -1 ? list.length : index) - 1; i >= 0; i -= 1) {
      const candidate = list[i]!
      if (candidate.authorType === 'bot') return candidate.id
      if (candidate.authorType === 'user') return null
    }
    return null
  })

  if (!targetId) return null

  return (
    <NoticeActions>
      <TextAction
        label="Retry"
        onClick={() => void useAppStore.getState().retryMessage(targetId)}
      />
      <span
        className="text-[var(--fg-quaternary)]"
        style={{ fontSize: 'var(--fs-meta)' }}
      >
        This doesn’t undo actions already completed.
      </span>
    </NoticeActions>
  )
}
