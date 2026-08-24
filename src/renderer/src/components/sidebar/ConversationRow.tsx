import { memo, useCallback } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'

import { MoreHorizontal } from 'lucide-react'

import type { ContextMenuItem } from '@shared/types/api'
import { cn } from '@/lib/cn'
import { formatRelativeShort, plainTextPreview } from '@/lib/format'
import { bridge } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { useContextMenu } from '@/hooks/useContextMenu'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import { StatusDot } from '@/components/ui/StatusDot'
import type { StatusState } from '@/components/ui/StatusDot'

/**
 * The primary object in the app: one 60px conversation row.
 *
 * Height is FIXED. The preview is a single ellipsized line and the timestamp
 * never wraps, so no amount of content can make rows in the list disagree about
 * their height — a list whose rows jitter as messages stream is the fastest way
 * to make a sidebar feel cheap.
 */

/** System outcomes that mean the user has to do something. */
const ATTENTION_KINDS: Record<string, string> = {
  permission_denied: 'Needs permission to continue',
  rate_limit: 'Claude usage limit reached',
  workspace_missing: 'Working folder is missing',
  loop_guard: 'Stopped to avoid a loop',
  bot_removed: 'A Bot in this chat was removed',
  interrupted: 'Interrupted — needs a look'
}

/** How far back to look for the signal that decides the row's state. */
const TAIL = 8

export interface RowSignals {
  /** Non-null when the row is in the needs-attention state; the string is the
   *  preview replacement copy (DESIGN §3.2). */
  attention: string | null
  unread: boolean
  working: boolean
  queued: boolean
  /** Live phase from the running Bot's most recent tool activity. */
  phase: string | null
  /** Name of the sole running Bot, when exactly one is running. */
  runningName: string | null
}

/**
 * Every selector below returns a PRIMITIVE or a stable store reference. Returning
 * a freshly-built object from a zustand selector would make `useSyncExternalStore`
 * re-render on every single delta (30/s per running Bot) instead of only when the
 * derived value actually changes.
 */
export function useRowSignals(conversationId: string): RowSignals {
  const isActive = useUiStore((s) => s.activeConversationId === conversationId)

  const unreadCount = useAppStore((s) => s.conversations[conversationId]?.unreadCount ?? 0)
  const running = useAppStore((s) => s.conversations[conversationId]?.runningBotIds.length ?? 0)
  const queued = useAppStore((s) => s.conversations[conversationId]?.queuedBotIds.length ?? 0)

  const phase = useAppStore((s) => {
    const list = s.messages[conversationId]
    if (!list) return null
    for (let i = list.length - 1; i >= 0 && i >= list.length - TAIL; i -= 1) {
      const message = list[i]!
      if (message.status !== 'streaming' && message.status !== 'running') continue
      const activity = message.activities[message.activities.length - 1]
      return activity ? activity.title : null
    }
    return null
  })

  const runningName = useAppStore((s) => {
    const ids = s.conversations[conversationId]?.runningBotIds
    if (!ids || ids.length !== 1) return null
    return s.bots[ids[0]!]?.name ?? null
  })

  const attention = useAppStore((s) => {
    // Opening a conversation clears both attention and unread (DESIGN §3.4).
    if (isActive) return null
    const list = s.messages[conversationId]
    if (list) {
      for (let i = list.length - 1; i >= 0 && i >= list.length - TAIL; i -= 1) {
        const message = list[i]!
        if (message.authorType === 'system' && message.systemKind) {
          const reason = ATTENTION_KINDS[message.systemKind]
          if (reason) return reason
          if (message.systemKind === 'handoff') {
            return `Handed off to ${message.authorName ?? 'another Bot'}`
          }
        }
        if (message.status === 'error') return 'Last run failed — needs a look'
      }
      return null
    }
    // Transcript not loaded: jobs still tell us whether the last run failed.
    let latest: string | null = null
    let latestAt = ''
    for (const job of Object.values(s.jobs)) {
      if (job.conversationId !== conversationId) continue
      const at = job.completedAt ?? job.createdAt
      if (at < latestAt) continue
      latestAt = at
      latest = job.status === 'error' ? 'Last run failed — needs a look' : null
    }
    return latest
  })

  return {
    attention,
    unread: unreadCount > 0 && !isActive,
    working: running > 0,
    queued: queued > 0,
    phase,
    runningName
  }
}

export interface ConversationRowProps {
  conversationId: string
  /** Rendered inside the collapsed 56px rail: avatar only. */
  compact?: boolean
}

function ConversationRowImpl({ conversationId, compact = false }: ConversationRowProps): ReactElement | null {
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const title = useAppStore((s) => s.conversationTitle(conversationId))
  const members = useAppStore((s) => s.conversations[conversationId]?.memberBotIds)
  const bots = useAppStore((s) => s.bots)
  const selected = useUiStore((s) => s.activeConversationId === conversationId)
  const setActive = useUiStore((s) => s.setActive)

  const signals = useRowSignals(conversationId)
  const openContextMenu = useContextMenu()

  const open = useCallback(() => {
    setActive(conversationId)
    void useAppStore.getState().loadMessages(conversationId)
    void useAppStore.getState().markRead(conversationId)
  }, [conversationId, setActive])

  const onContextMenu = useCallback(
    async (e: ReactMouseEvent) => {
      const state = useAppStore.getState()
      const current = state.conversations[conversationId]
      if (!current) return
      const ui = useUiStore.getState()
      const isDirect = current.type === 'direct'
      const botId = current.memberBotIds[0]

      const items: ContextMenuItem[] = [
        { id: 'pin', label: current.pinned ? 'Unpin' : 'Pin' },
        { id: 'hide', label: current.hidden ? 'Unhide' : 'Hide from sidebar' },
        { id: 'read', label: 'Mark as read', enabled: current.unreadCount > 0 },
        { type: 'separator' },
        { id: 'edit', label: isDirect ? 'Edit Profile' : 'Edit group' },
        ...(isDirect ? [{ id: 'duplicate', label: 'Duplicate' } as ContextMenuItem] : []),
        { id: 'export', label: 'Export transcript…' },
        { type: 'separator' },
        { id: 'delete', label: 'Delete', danger: true }
      ]

      const choice = await openContextMenu(items, e)
      if (!choice) return

      switch (choice) {
        case 'pin':
          void state.updateConversation(conversationId, { pinned: !current.pinned })
          break
        case 'hide':
          void state.updateConversation(conversationId, { hidden: !current.hidden })
          break
        case 'read':
          void state.markRead(conversationId)
          break
        case 'edit':
          if (isDirect && botId) ui.openModal({ kind: 'bot', botId })
          else ui.openModal({ kind: 'group', conversationId })
          break
        case 'duplicate':
          if (botId) void state.duplicateBot(botId)
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
    [conversationId, openContextMenu, title]
  )

  if (!conversation) return null

  const memberBots = (members ?? []).map((id) => bots[id]).filter((b): b is NonNullable<typeof b> => Boolean(b))
  const primary = memberBots[0]

  // Priority is exclusive and ordered: needs-attention outranks unread.
  const dotState: StatusState = signals.attention
    ? 'attention'
    : signals.unread
      ? 'unread'
      : signals.queued && !signals.working
        ? 'queued'
        : 'idle'

  const avatar =
    conversation.type === 'group' && memberBots.length > 1 ? (
      <GroupAvatar members={memberBots} size={compact ? 32 : 40} />
    ) : (
      <BotAvatar
        bot={primary}
        name={title}
        size={compact ? 32 : 40}
        working={signals.working}
        avatarType={primary ? undefined : 'emoji'}
        avatarValue={primary ? undefined : (conversation.icon ?? '💬')}
      />
    )

  if (compact) {
    return (
      <button
        type="button"
        onClick={open}
        onContextMenu={(e) => void onContextMenu(e)}
        aria-current={selected ? 'true' : undefined}
        title={title}
        // `mx-auto`, not a fixed 8px inset. The rail is 56px wide with a 1px
        // right border, so its scroller's CONTENT box is 55px — a 40px pill with
        // 8px margins is a 56px margin box, and Chromium counted that one pixel
        // of overflow as horizontally scrollable: a 6px scrollbar thumb sat
        // painted across the empty rail like a stray divider, and ate 11px of
        // rail height. Auto margins centre the pill in whatever width it gets.
        className={cn(
          'row-pill relative mx-auto grid place-items-center rounded-[var(--r-row)]',
          'transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]'
        )}
        style={{ height: 48, width: 40 }}
        data-selected={selected || undefined}
      >
        {/* The badge hangs off the AVATAR, not off the 40x48 button. Anchored to
            the button it sat in the top-right corner of a box the 32px avatar is
            centred in, which put it ~6px clear of the blob with nothing behind
            it, and straddling the row pill's right edge so a hovered row cut it
            in half. PinnedStrip's comment explains the rest: bottom-right is the
            one corner every avatar shape — and every group cluster — draws ink
            in, and the ring separates the dot from that ink. */}
        <span className="relative flex">
          {avatar}
          {dotState !== 'idle' ? (
            <span className="absolute right-[2px] bottom-[2px]">
              <StatusDot state={dotState} ring ringColor="var(--surface-1)" />
            </span>
          ) : null}
        </span>
      </button>
    )
  }

  // While a Bot works and has not reported a phase yet, name the Bot that is
  // ACTUALLY running — never `memberBots[0]`. In a 1:1 chat member 0 is the Bot
  // the row is titled after, so the preview line read "Builder…" under the row
  // "Builder": zero information at the moment the user most wants some. In a
  // group, member 0 is only sometimes the runner, so it could name the wrong
  // Bot outright. With one runner we can name it; otherwise say what is true.
  const previewText = signals.attention
    ? signals.attention
    : signals.working
      ? (signals.phase ??
        (conversation.type === 'group' && signals.runningName
          ? `${signals.runningName}…`
          : 'Working…'))
      : conversation.lastMessagePreview
        ? conversation.type === 'group' && conversation.lastMessageAuthorName
          ? `${conversation.lastMessageAuthorName}: ${plainTextPreview(conversation.lastMessagePreview, 80)}`
          : plainTextPreview(conversation.lastMessagePreview, 90)
        : 'No messages yet'

  return (
    <div
      className="row-pill hover-target relative"
      data-selected={selected || undefined}
      style={{ marginInline: 8 }}
    >
      <button
        type="button"
        onClick={open}
        onContextMenu={(e) => void onContextMenu(e)}
        aria-current={selected ? 'true' : undefined}
        className="flex w-full items-center gap-[10px] rounded-[var(--r-row)] text-left"
        style={{ height: 60, padding: '10px 8px' }}
      >
        {avatar}

        <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
          <span className="flex items-baseline gap-[8px]">
            <span
              className="min-w-0 flex-1 truncate text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-ui)',
                lineHeight: '20px',
                letterSpacing: 'var(--ls-ui)',
                // Unread does more than a dot: the weight shift is what the eye
                // actually catches when scanning a full sidebar.
                fontWeight: signals.unread || signals.attention ? 590 : 550
              }}
            >
              {title}
            </span>
            {/* `row-timestamp` fades this out while the row is hovered: the ⋯
                button lands in exactly this cell (see below). */}
            <span
              className="row-timestamp shrink-0 text-[var(--fg-tertiary)]"
              style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px', fontWeight: 400 }}
            >
              {formatRelativeShort(conversation.lastMessageAt)}
            </span>
          </span>

          <span className="flex items-center gap-[8px]">
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                // One motion element per indicator: the shimmer runs through the
                // phase text, and the avatar carries the pulsing ring.
                signals.working && 'shimmer-text'
              )}
              style={{
                fontSize: 'var(--fs-meta)',
                lineHeight: '18px',
                letterSpacing: 'var(--ls-meta)',
                // No inline colour while shimmering: `.shimmer-text` paints the
                // text with a clipped gradient and needs `color: transparent`.
                color: signals.working
                  ? undefined
                  : signals.attention
                    ? 'var(--attention)'
                    : signals.unread
                      ? 'var(--fg-primary)'
                      : 'var(--fg-secondary)'
              }}
            >
              {previewText}
            </span>
            <StatusDot state={dotState} ringColor="var(--surface-1)" />
          </span>
        </span>
      </button>

      {/* The same menu as right-click, for people who never right-click. It is
          absolutely positioned and only toggles opacity, so it can neither
          reflow the row nor change its height.

          It sits in LINE 1's band (y 8→32 of the 60px row), flush in the
          timestamp's own trailing cell, and the timestamp fades out under it.
          It used to be vertically centred (`top-1/2 -translate-y-1/2`), which
          put the 24px opaque circle across the seam between the two lines: it
          sliced the timestamp ("Yester⋯y"), ate the tail of the preview line and
          grazed the status dot, all at once. Centring it is not a free choice —
          the row has content on both lines out to the same right edge. */}
      <button
        type="button"
        aria-label={`Actions for ${title}`}
        onClick={(e) => void onContextMenu(e)}
        className="hover-actions absolute top-[8px] right-[8px] grid h-[24px] w-[24px] place-items-center rounded-full text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
        style={{ background: 'var(--surface-3)', boxShadow: 'var(--shadow-low)' }}
      >
        <MoreHorizontal size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}

/**
 * Memoized on `conversationId`: the parent list re-renders whenever ANY
 * conversation changes, and without this every row would re-render with it.
 */
export const ConversationRow = memo(ConversationRowImpl)
