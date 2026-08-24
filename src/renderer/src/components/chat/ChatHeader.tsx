import { useCallback } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { Ellipsis, FolderOpen, Info } from 'lucide-react'

import type { ContextMenuItem } from '@shared/types/api'
import { cn } from '@/lib/cn'
import { pluralize } from '@/lib/format'
import { bridge, withToast } from '@/lib/ipc'
import { useContextMenu } from '@/hooks/useContextMenu'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import { IconButton } from '@/components/ui/IconButton'

/**
 * The chat header (DESIGN §2.3).
 *
 * It is NOT a bordered bar. It is a floating row on the transcript ground, and
 * the separation comes from a 24px gradient scrim underneath it that fades
 * scrolled content out. A hard 1px rule here is the single fastest way to make
 * a messenger look like an admin console.
 *
 * The bar is a window drag region and every control inside it is `.no-drag`:
 * drag regions swallow all pointer events, so a button that forgets this emits
 * no clicks and no hover at all.
 */

export interface ChatHeaderProps {
  conversationId: string
}

export function ChatHeader({ conversationId }: ChatHeaderProps): ReactElement | null {
  const conversation = useAppStore((state) => state.conversations[conversationId])
  const title = useAppStore((state) => state.conversationTitle(conversationId))
  const bots = useAppStore((state) => state.bots)
  const running = useAppStore(
    (state) => state.conversations[conversationId]?.runningBotIds.length ?? 0
  )
  const queued = useAppStore(
    (state) => state.conversations[conversationId]?.queuedBotIds.length ?? 0
  )
  const detailsOpen = useUiStore((state) => state.detailsOpen)

  const openContextMenu = useContextMenu()

  const memberBots = (conversation?.memberBotIds ?? [])
    .map((id) => bots[id])
    .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot))

  const workspace =
    conversation?.workspaceDirectory ?? memberBots[0]?.defaultWorkingDirectory ?? null

  const workspaceMenu = useCallback(
    async (event?: ReactMouseEvent) => {
      const items: ContextMenuItem[] = [
        { id: 'details', label: 'Conversation details' },
        { type: 'separator' },
        { id: 'reveal', label: 'Reveal in Finder', enabled: Boolean(workspace) },
        { id: 'terminal', label: 'Open in Terminal', enabled: Boolean(workspace) },
        { id: 'editor', label: 'Open in VS Code', enabled: Boolean(workspace) },
        { type: 'separator' },
        { id: 'change', label: 'Change working folder…' }
      ]
      const choice = await openContextMenu(items, event)
      if (!choice) return
      switch (choice) {
        case 'details':
          useUiStore.getState().setDetailsOpen(true)
          break
        case 'reveal':
          if (workspace) void bridge().system.revealPath(workspace)
          break
        case 'terminal':
          if (workspace) {
            void withToast(() => bridge().system.openTerminalAt(workspace), {
              errorTitle: 'Could not open a terminal'
            })
          }
          break
        case 'editor':
          if (workspace) {
            void withToast(() => bridge().system.openEditorAt(workspace), {
              errorTitle: 'Could not open an editor'
            })
          }
          break
        case 'change': {
          const picked = await bridge().system.pickDirectory(workspace ?? undefined)
          if (!picked.path) return
          await withToast(
            () =>
              useAppStore
                .getState()
                .updateConversation(conversationId, { workspaceDirectory: picked.path }),
            { successTitle: 'Working folder updated', errorTitle: 'Could not set that folder' }
          )
          break
        }
      }
    },
    [conversationId, openContextMenu, workspace]
  )

  const actionsMenu = useCallback(
    async (event?: ReactMouseEvent) => {
      const state = useAppStore.getState()
      const current = state.conversations[conversationId]
      if (!current) return
      const ui = useUiStore.getState()
      const isDirect = current.type === 'direct'
      const botId = current.memberBotIds[0]
      const busy = current.runningBotIds.length > 0

      const items: ContextMenuItem[] = [
        { id: 'edit', label: isDirect ? 'Edit Profile' : 'Edit group' },
        { id: 'details', label: 'Conversation details' },
        { id: 'workspace', label: 'Working folder…' },
        { type: 'separator' },
        { id: 'stop', label: 'Stop this conversation', enabled: busy },
        { id: 'unread', label: 'Mark as unread' },
        { id: 'pin', label: current.pinned ? 'Unpin' : 'Pin' },
        { id: 'hide', label: 'Hide from sidebar' },
        { type: 'separator' },
        { id: 'export', label: 'Export transcript…' },
        ...(isDirect ? [{ id: 'duplicate', label: 'Duplicate' } as ContextMenuItem] : []),
        { type: 'separator' },
        { id: 'delete', label: 'Delete', danger: true }
      ]

      const choice = await openContextMenu(items, event)
      if (!choice) return

      switch (choice) {
        case 'edit':
          if (isDirect && botId) ui.openModal({ kind: 'bot', botId })
          else ui.openModal({ kind: 'group', conversationId })
          break
        case 'details':
          ui.setDetailsOpen(true)
          break
        case 'workspace':
          void workspaceMenu()
          break
        case 'stop':
          void state.stopConversation(conversationId)
          break
        case 'unread':
          // Reopening the conversation is what clears it again, so simply
          // stepping away from it is enough.
          ui.setActive(null)
          break
        case 'pin':
          void state.updateConversation(conversationId, { pinned: !current.pinned })
          break
        case 'hide':
          void state.updateConversation(conversationId, { hidden: true })
          break
        case 'export': {
          const result = await bridge().conversations.exportMarkdown(conversationId)
          const path = result.path
          if (path) {
            ui.toast({
              level: 'success',
              title: 'Transcript exported',
              body: path,
              actionLabel: 'Reveal',
              onAction: () => {
                void bridge().system.revealPath(path)
              }
            })
          }
          break
        }
        case 'duplicate':
          if (botId) void state.duplicateBot(botId)
          break
        case 'delete':
          ui.confirm({
            title: `Delete ${title}?`,
            body: isDirect
              ? 'This removes the conversation and its transcript. The Bot’s profile and anything it wrote to disk are untouched. If you may need the history later, hide the chat instead.'
              : 'This removes the group and its transcript. The member Bots and their own chats are untouched.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: () => {
              void state.deleteConversation(conversationId)
            }
          })
          break
      }
    },
    [conversationId, openContextMenu, title, workspaceMenu]
  )

  if (!conversation) return null

  const isGroup = conversation.type === 'group'

  // Both counts, not the first non-zero one (PRD §23.3). `running > 0` used to
  // short-circuit, so an @everyone across six Bots with maxConcurrentBots: 3 read
  // "3 working" and gave no hint that three more turns were waiting — hiding the
  // queue at exactly the moment it means something. The member-count fallback has
  // to survive: with both counts at zero this must not collapse to an empty
  // string, because the render guard below drops the subtitle entirely.
  const busy = [
    running > 0 ? `${running} working` : null,
    queued > 0 ? `${queued} queued` : null
  ].filter((part): part is string => part !== null)

  const subtitle = isGroup
    ? busy.length > 0
      ? busy.join(' · ')
      : pluralize(conversation.memberBotIds.length, 'Bot')
    : null

  return (
    <header
      className="drag relative z-[var(--z-header)] flex shrink-0 items-center"
      style={{
        height: 'var(--header-h)',
        paddingInline: 12,
        gap: 8,
        background: 'var(--surface-0)'
      }}
    >
      <button
        type="button"
        onClick={(event) => void actionsMenu(event)}
        aria-label={`${title} actions`}
        className={cn(
          'no-drag flex min-w-0 items-center transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
          'hover:bg-[var(--surface-3)]'
        )}
        style={{
          height: 36,
          padding: '4px 12px 4px 4px',
          gap: 8,
          borderRadius: 'var(--r-full)',
          background: 'var(--surface-2)'
        }}
      >
        {isGroup && memberBots.length > 1 ? (
          <GroupAvatar members={memberBots} size={24} />
        ) : (
          <BotAvatar
            bot={memberBots[0] ?? null}
            name={title}
            size={24}
            working={running > 0}
            avatarType={memberBots[0] ? undefined : 'emoji'}
            avatarValue={memberBots[0] ? undefined : (conversation.icon ?? '💬')}
          />
        )}

        <span className="flex min-w-0 flex-col items-start">
          <span className="flex min-w-0 items-center gap-[6px]">
            <span
              className="min-w-0 truncate text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-title)',
                lineHeight: subtitle ? '18px' : 'var(--lh-title)',
                letterSpacing: 'var(--ls-title)',
                fontWeight: 550
              }}
            >
              {title}
            </span>
            {running > 0 ? (
              /* Static fill on purpose: the avatar beside it already carries the
                 pulsing accent ring, and one indicator gets exactly one moving
                 element (DESIGN §6). */
              <span
                role="img"
                aria-label="Working"
                title="Working"
                className="shrink-0 rounded-full"
                style={{ width: 6, height: 6, background: 'var(--accent)' }}
              />
            ) : null}
          </span>
          {subtitle ? (
            <span
              className="truncate text-[var(--fg-tertiary)]"
              style={{ fontSize: 'var(--fs-micro)', lineHeight: '14px' }}
            >
              {subtitle}
            </span>
          ) : null}
        </span>
      </button>

      <div className="drag min-w-0 flex-1" />

      <div className="flex shrink-0 items-center" style={{ gap: 4 }}>
        <IconButton
          label="Working folder"
          title={workspace ?? 'No working folder set'}
          onClick={() => {
            const ui = useUiStore.getState()
            // Below 1180 the details drawer is suppressed by the layout, so the
            // button falls back to the actions that panel would have offered
            // rather than doing nothing at all.
            if (ui.viewportWidth >= 1180) {
              ui.setDetailsOpen(true)
              window.dispatchEvent(new CustomEvent('ccb:details-section', { detail: 'workspace' }))
            } else {
              void workspaceMenu()
            }
          }}
        >
          <FolderOpen size={18} strokeWidth={1.75} />
        </IconButton>

        <IconButton
          label="Conversation details"
          active={detailsOpen}
          onClick={() => useUiStore.getState().toggleDetails()}
        >
          <Info size={18} strokeWidth={1.75} />
        </IconButton>

        <IconButton label="More actions" onClick={(event) => void actionsMenu(event)}>
          <Ellipsis size={18} strokeWidth={1.75} />
        </IconButton>
      </div>

      {/* The scrim, not a border: 24px of the transcript ground fading to
          transparent so scrolled content dissolves under the header. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 left-0"
        style={{
          top: '100%',
          height: 24,
          background: 'linear-gradient(var(--surface-0), transparent)'
        }}
      />
    </header>
  )
}
