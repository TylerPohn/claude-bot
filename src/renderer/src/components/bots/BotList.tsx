import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  Trash2,
  Users
} from 'lucide-react'

import type { Bot, PermissionMode } from '@shared/types'
import type { ContextMenuItem } from '@shared/types/api'
import { cn } from '@/lib/cn'
import { withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { useContextMenu } from '@/hooks/useContextMenu'
import { Badge } from '@/components/ui/Badge'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'

/**
 * The manage-all roster, reachable from Settings → Bots.
 *
 * The sidebar answers "who is talking to me right now"; this answers "what is
 * every Bot configured to do" — so it is a table, and every column is a setting
 * the user might need to audit across the whole roster at once (model,
 * permission mode, working folder, pinned/hidden state).
 */

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  plan: 'Plan',
  default: 'Ask',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'YOLO'
}

const MODEL_LABEL: Record<string, string> = {
  default: 'Default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

/** Five columns plus the action cluster. The whole grid scrolls horizontally
 *  inside its own container rather than letting the dialog body scroll. */
const GRID = 'minmax(180px, 1.7fr) 96px 116px minmax(140px, 1.5fr) 168px'

export interface BotListProps {
  /** Defaults to opening the Bot sheet for that Bot. */
  onEdit?(botId: string): void
  onCreate?(): void
  className?: string
}

export function BotList({ onEdit, onCreate, className }: BotListProps = {}): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const botOrder = useAppStore((s) => s.botOrder)
  const openModal = useUiStore((s) => s.openModal)
  const contextMenu = useContextMenu()

  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Bot | null>(null)

  const edit = useCallback(
    (botId: string) => {
      if (onEdit) onEdit(botId)
      else openModal({ kind: 'bot', botId })
    },
    [onEdit, openModal]
  )

  const create = useCallback(() => {
    if (onCreate) onCreate()
    else openModal({ kind: 'bot' })
  }, [onCreate, openModal])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return botOrder
      .map((id) => bots[id])
      .filter((bot): bot is Bot => Boolean(bot))
      .filter((bot) => (showHidden ? true : !bot.hidden))
      .filter((bot) => {
        if (!needle) return true
        return (
          bot.name.toLowerCase().includes(needle) ||
          (bot.title ?? '').toLowerCase().includes(needle) ||
          (bot.defaultWorkingDirectory ?? '').toLowerCase().includes(needle)
        )
      })
  }, [bots, botOrder, query, showHidden])

  const hiddenCount = useMemo(
    () => Object.values(bots).filter((b) => b.hidden).length,
    [bots]
  )

  /** Distinguishes "you have no Bots" from "they are all hidden" — the same
   *  empty grid, two completely different next actions. */
  const allHidden = hiddenCount > 0 && hiddenCount === Object.keys(bots).length && !showHidden

  const duplicate = useCallback((bot: Bot) => {
    void withToast(() => useAppStore.getState().duplicateBot(bot.id), {
      successTitle: `Duplicated ${bot.name}`,
      errorTitle: 'Could not duplicate this Bot'
    })
  }, [])

  const togglePinned = useCallback((bot: Bot) => {
    void withToast(() => useAppStore.getState().setBotPinned(bot.id, !bot.pinned), {
      errorTitle: 'Could not change the pin'
    })
  }, [])

  const toggleHidden = useCallback((bot: Bot) => {
    void withToast(() => useAppStore.getState().setBotHidden(bot.id, !bot.hidden), {
      errorTitle: 'Could not change visibility'
    })
  }, [])

  const openRowMenu = useCallback(
    async (bot: Bot, e?: ReactMouseEvent) => {
      const items: ContextMenuItem[] = [
        { id: 'edit', label: 'Edit Profile' },
        { id: 'duplicate', label: 'Duplicate' },
        { type: 'separator' },
        { id: 'pin', label: bot.pinned ? 'Unpin' : 'Pin' },
        { id: 'hide', label: bot.hidden ? 'Show in sidebar' : 'Hide from sidebar' },
        { type: 'separator' },
        { id: 'delete', label: 'Delete…', danger: true }
      ]
      const choice = await contextMenu(items, e)
      if (choice === 'edit') edit(bot.id)
      else if (choice === 'duplicate') duplicate(bot)
      else if (choice === 'pin') togglePinned(bot)
      else if (choice === 'hide') toggleHidden(bot)
      else if (choice === 'delete') setPendingDelete(bot)
    },
    [contextMenu, duplicate, edit, togglePinned, toggleHidden]
  )

  return (
    <div className={cn('flex min-h-0 flex-col', className)} style={{ gap: 12 }}>
      <div className="flex shrink-0 items-center" style={{ gap: 8 }}>
        <Input
          className="min-w-0 flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, job or folder"
          aria-label="Filter Bots"
          leading={<Search size={16} strokeWidth={1.75} aria-hidden />}
        />
        {hiddenCount > 0 ? (
          <Button
            variant={showHidden ? 'secondary' : 'ghost'}
            onClick={() => setShowHidden((v) => !v)}
            aria-pressed={showHidden}
            leading={
              showHidden ? (
                <Eye size={16} strokeWidth={1.75} aria-hidden />
              ) : (
                <EyeOff size={16} strokeWidth={1.75} aria-hidden />
              )
            }
          >
            {`Hidden (${hiddenCount})`}
          </Button>
        ) : null}
        <Button
          variant="filled"
          onClick={create}
          leading={<Plus size={16} strokeWidth={1.75} aria-hidden />}
        >
          New Bot
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Users size={32} strokeWidth={1.75} aria-hidden />}
          title={
            query.trim()
              ? 'No Bots match that'
              : allHidden
                ? 'Every Bot is hidden'
                : 'No Bots yet'
          }
          body={
            query.trim()
              ? 'Try a shorter search, or clear the filter to see the whole roster.'
              : allHidden
                ? 'They still exist and still have their history — the sidebar just doesn’t list them.'
                : 'Create your first teammate and give it a job, a folder and a set of standing instructions.'
          }
          action={
            query.trim() ? (
              <Button variant="secondary" onClick={() => setQuery('')}>
                Clear filter
              </Button>
            ) : allHidden ? (
              <Button variant="secondary" onClick={() => setShowHidden(true)}>
                Show hidden Bots
              </Button>
            ) : (
              <Button variant="filled" onClick={create}>
                Create your first teammate
              </Button>
            )
          }
        />
      ) : (
        <div className="scroller min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          {/* Real table semantics: a div grid with no roles reads as one long
              run of text, and the columns are the point of this view. */}
          <div role="table" aria-label="All Bots" style={{ minWidth: 720 }}>
            <div
              role="row"
              className="grid items-center"
              style={{
                gridTemplateColumns: GRID,
                height: 28,
                padding: '0 8px',
                gap: 12,
                position: 'sticky',
                top: 0,
                zIndex: 1,
                background: 'var(--surface-3)'
              }}
            >
              <HeaderCell>Bot</HeaderCell>
              <HeaderCell>Model</HeaderCell>
              <HeaderCell>Permissions</HeaderCell>
              <HeaderCell>Working folder</HeaderCell>
              <HeaderCell align="right">State</HeaderCell>
            </div>

            <div role="rowgroup" className="flex flex-col">
              {rows.map((bot) => (
                <BotRow
                  key={bot.id}
                  bot={bot}
                  onEdit={() => edit(bot.id)}
                  onDuplicate={() => duplicate(bot)}
                  onTogglePinned={() => togglePinned(bot)}
                  onToggleHidden={() => toggleHidden(bot)}
                  onDelete={() => setPendingDelete(bot)}
                  onMenu={(e) => void openRowMenu(bot, e)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDelete ? (
        <DangerConfirm
          title={`Delete ${pendingDelete.name}?`}
          body={`This removes ${pendingDelete.name} from your roster and from every group it belongs to. Messages it already sent stay in their conversations, still attributed to ${pendingDelete.name}. Hide it instead if you might want it back.`}
          confirmLabel="Delete"
          secondaryLabel={pendingDelete.hidden ? undefined : 'Hide instead'}
          onSecondary={() => {
            const bot = pendingDelete
            setPendingDelete(null)
            void withToast(() => useAppStore.getState().setBotHidden(bot.id, true), {
              successTitle: `${bot.name} is hidden`,
              errorTitle: 'Could not hide this Bot'
            })
          }}
          onConfirm={() => {
            const bot = pendingDelete
            setPendingDelete(null)
            void withToast(() => useAppStore.getState().deleteBot(bot.id), {
              successTitle: `Deleted ${bot.name}`,
              errorTitle: 'Could not delete this Bot'
            })
          }}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------ */

function BotRow({
  bot,
  onEdit,
  onDuplicate,
  onTogglePinned,
  onToggleHidden,
  onDelete,
  onMenu
}: {
  bot: Bot
  onEdit(): void
  onDuplicate(): void
  onTogglePinned(): void
  onToggleHidden(): void
  onDelete(): void
  onMenu(e: ReactMouseEvent): void
}): ReactElement {
  const model = MODEL_LABEL[bot.model] ?? bot.model
  const folder = bot.defaultWorkingDirectory ?? ''
  const folderName = folder ? (folder.split(/[\\/]/).filter(Boolean).pop() ?? folder) : ''

  return (
    <div
      role="row"
      className="hover-target row-pill grid items-center"
      style={{ gridTemplateColumns: GRID, height: 56, padding: '0 8px', gap: 12 }}
      onDoubleClick={onEdit}
      onContextMenu={onMenu}
    >
      <div role="cell" className="flex min-w-0 items-center" style={{ gap: 10 }}>
        <BotAvatar bot={bot} size={32} />
        <div className="flex min-w-0 flex-col" style={{ gap: 1 }}>
          <span
            className="truncate text-[var(--fg-primary)]"
            style={{
              fontSize: 'var(--fs-chrome)',
              lineHeight: '18px',
              letterSpacing: 'var(--ls-chrome)',
              fontWeight: 550,
              opacity: bot.hidden ? 0.55 : 1
            }}
          >
            {bot.name}
          </span>
          <span
            className="truncate text-[var(--fg-tertiary)]"
            style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px' }}
          >
            {bot.title ?? '—'}
          </span>
        </div>
      </div>

      <Cell>{model}</Cell>
      <Cell>{PERMISSION_LABEL[bot.permissionMode]}</Cell>

      <div role="cell" className="min-w-0" title={folder || undefined}>
        {folder ? (
          <span
            className="block truncate text-[var(--fg-secondary)]"
            style={{ fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)' }}
          >
            {folderName}
          </span>
        ) : (
          <span className="text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
            Not set
          </span>
        )}
      </div>

      <div role="cell" className="relative flex items-center justify-end" style={{ gap: 6 }}>
        {/* Badges stay put; only the action bar toggles opacity, so the row can
            never reflow under the pointer. */}
        <div className="flex items-center" style={{ gap: 4 }}>
          {bot.pinned ? <Badge tone="accent">Pinned</Badge> : null}
          {bot.hidden ? <Badge tone="neutral">Hidden</Badge> : null}
        </div>

        <div
          className="hover-actions absolute right-0 flex items-center"
          style={{
            gap: 2,
            padding: '0 2px',
            borderRadius: 'var(--r-full)',
            background: 'var(--surface-3)',
            boxShadow: 'var(--shadow-low)'
          }}
        >
          <IconButton size={28} label={`Edit ${bot.name}`} onClick={onEdit}>
            <SquarePen size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton size={28} label={`Duplicate ${bot.name}`} onClick={onDuplicate}>
            <Copy size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            size={28}
            label={bot.pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}
            onClick={onTogglePinned}
          >
            {bot.pinned ? (
              <PinOff size={14} strokeWidth={1.75} />
            ) : (
              <Pin size={14} strokeWidth={1.75} />
            )}
          </IconButton>
          <IconButton
            size={28}
            label={bot.hidden ? `Show ${bot.name} in the sidebar` : `Hide ${bot.name} from the sidebar`}
            onClick={onToggleHidden}
          >
            {bot.hidden ? (
              <Eye size={14} strokeWidth={1.75} />
            ) : (
              <EyeOff size={14} strokeWidth={1.75} />
            )}
          </IconButton>
          <IconButton
            size={28}
            label={`Delete ${bot.name}`}
            onClick={onDelete}
            className="hover:text-[var(--fg-danger)]"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton size={28} label={`More actions for ${bot.name}`} onClick={onMenu}>
            <Ellipsis size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function HeaderCell({
  children,
  align = 'left'
}: {
  children: ReactNode
  align?: 'left' | 'right'
}): ReactElement {
  return (
    <span
      role="columnheader"
      className="truncate text-[var(--fg-tertiary)]"
      style={{
        fontSize: 'var(--fs-micro)',
        lineHeight: '16px',
        letterSpacing: 'var(--ls-micro)',
        fontWeight: 510,
        textAlign: align
      }}
    >
      {children}
    </span>
  )
}

function Cell({ children }: { children: ReactNode }): ReactElement {
  return (
    <span
      role="cell"
      className="truncate text-[var(--fg-secondary)]"
      style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px' }}
    >
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Destructive confirmation
 * ------------------------------------------------------------------ */

/**
 * A confirmation that can safely open ON TOP of another dialog.
 *
 * The app-wide confirm lives in `uiStore.modal`, which is a single slot — using
 * it here would unmount the Settings dialog this list lives inside, and the user
 * would lose their place just to answer a yes/no question. So this one is local,
 * and it takes over the keyboard by listening on `window` in the CAPTURE phase:
 * capture runs window → document, so it fires before the host dialog's own focus
 * trap (which listens on `document`) and can stop Escape and Tab from reaching
 * it. Registration order would otherwise put the host first, and Escape would
 * close both surfaces at once.
 */
function DangerConfirm({
  title,
  body,
  confirmLabel,
  secondaryLabel,
  onConfirm,
  onSecondary,
  onCancel
}: {
  title: string
  body: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm(): void
  onSecondary?(): void
  onCancel(): void
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('[data-initial-focus]')?.focus()
    })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (items.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const index = items.findIndex((el) => el === document.activeElement)
      const next = e.shiftKey
        ? (index <= 0 ? items.length - 1 : index - 1)
        : (index === -1 || index === items.length - 1 ? 0 : index + 1)
      items[next]?.focus()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      restoreTo.current?.focus({ preventScroll: true })
    }
  }, [onCancel])

  return createPortal(
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ zIndex: 'calc(var(--z-dialog) + 5)' }}
      role="presentation"
    >
      <div
        aria-hidden
        onMouseDown={onCancel}
        className="absolute inset-0"
        style={{ background: 'var(--overlay)', animation: 'scrim-in var(--dur-base) var(--ease-out-quad)' }}
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex flex-col"
        style={{
          width: 'min(400px, calc(100vw - 32px))',
          padding: 20,
          gap: 12,
          background: 'var(--surface-3)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--r-popover)',
          boxShadow: 'var(--shadow-dialog)',
          animation: 'dialog-in var(--dur-base) var(--ease-out-quad)'
        }}
      >
        <h2
          className="text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-title)',
            lineHeight: 'var(--lh-title)',
            letterSpacing: 'var(--ls-title)',
            fontWeight: 550
          }}
        >
          {title}
        </h2>
        <p
          className="selectable text-[var(--fg-secondary)]"
          style={{ fontSize: 'var(--fs-chrome)', lineHeight: 'var(--lh-chrome)' }}
        >
          {body}
        </p>
        <div className="mt-[4px] flex items-center justify-end" style={{ gap: 8 }}>
          <Button variant="ghost" data-initial-focus onClick={onCancel}>
            Cancel
          </Button>
          {secondaryLabel ? (
            <Button variant="secondary" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            variant="danger"
            onClick={onConfirm}
            style={{ background: 'var(--fg-danger)', color: 'var(--white)' }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
