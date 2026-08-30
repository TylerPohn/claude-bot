import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { FileDown, Info, Pencil, Trash2, X } from 'lucide-react'

import type { Bot, ModelPreference, PermissionMode } from '@shared/types'
import { bridge, withToast } from '@/lib/ipc'
import { pluralize } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { DrawerSection, FieldRow } from '@/components/settings/SettingRow'
import { MembersSection } from './MembersSection'
import { SessionsSection } from './SessionsSection'
import { WorkspaceSection } from './WorkspaceSection'

const MODEL_LABEL: Record<string, string> = {
  default: 'Claude Code default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  bypassPermissions: 'YOLO — no permission checks'
}

function modelLabel(model: ModelPreference): string {
  return MODEL_LABEL[model] ?? model
}

/**
 * A Bot's permission mode as it will actually RUN.
 *
 * `default` is not a mode Claude Code runs in — JobScheduler falls through to
 * Settings › Claude › Default permission mode when it spawns. This panel used to
 * print a flat "Ask" for it, which asserted a safety posture the Bot was not
 * running under for as long as that setting said anything else, and nothing in
 * the app corrected it. The Model row above already handles the same situation
 * honestly ("Claude Code default"), so this one now names the resolved mode and
 * says where it came from.
 */
function permissionLabel(mode: PermissionMode, appDefault: PermissionMode): string {
  if (mode !== 'default') return PERMISSION_LABEL[mode]
  return `${PERMISSION_LABEL[appDefault]} (app default)`
}

/**
 * The 320px conversation details panel (DESIGN §2.6).
 *
 * `App.tsx` mounts this only while `detailsOpen` is true and the window is wide
 * enough, so the panel animates in on mount rather than transitioning a width:
 * animating layout width would reflow the transcript on every frame of the
 * slide, which is the one thing this panel must never do while text is
 * streaming next to it.
 */
export function DetailsDrawer(): ReactElement | null {
  const detailsOpen = useUiStore((s) => s.detailsOpen)
  const activeConversationId = useUiStore((s) => s.activeConversationId)
  const setDetailsOpen = useUiStore((s) => s.setDetailsOpen)
  const openModal = useUiStore((s) => s.openModal)
  const confirm = useUiStore((s) => s.confirm)
  const toast = useUiStore((s) => s.toast)

  const conversation = useAppStore((s) =>
    activeConversationId ? s.conversations[activeConversationId] : undefined
  )
  const bots = useAppStore((s) => s.bots)
  const deleteConversation = useAppStore((s) => s.deleteConversation)
  // What a Bot stored on `default` resolves to at spawn time.
  const appDefaultPermission = useAppStore((s) => s.settings?.defaultPermissionMode) ?? 'default'

  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const members = useMemo(
    () =>
      conversation
        ? conversation.memberBotIds.map((id) => bots[id]).filter((b): b is Bot => Boolean(b))
        : [],
    [bots, conversation]
  )

  const primaryBot = conversation?.type === 'direct' ? members[0] : undefined
  const title = primaryBot?.name ?? conversation?.name ?? ''

  /* ---- danger zone -------------------------------------------------- */

  const [exporting, setExporting] = useState(false)

  const exportMarkdown = useCallback(async () => {
    if (!conversation) return
    setExporting(true)
    try {
      const result = await withToast(() => bridge().conversations.exportMarkdown(conversation.id), {
        errorTitle: 'Could not export this conversation'
      })
      // A null path is a cancelled save dialog, not a failure.
      if (!result?.path) return
      const path = result.path
      toast({
        level: 'success',
        title: 'Conversation exported',
        body: path,
        actionLabel: 'Reveal',
        onAction: () => {
          void bridge().system.revealPath(path)
        }
      })
    } finally {
      setExporting(false)
    }
  }, [conversation, toast])

  const clearTranscript = useCallback(() => {
    if (!conversation) return
    confirm({
      title: `Clear the transcript in ${title}?`,
      body: `Every message here is deleted from this computer, and each Bot starts a fresh Claude session — so it will not remember what was said. Files in your workspace are untouched. There is no undo; export the conversation first if you want a copy.`,
      confirmLabel: 'Clear transcript',
      danger: true,
      onConfirm: () => {
        void withToast(() => bridge().conversations.clearTranscript(conversation.id), {
          errorTitle: 'Could not clear the transcript',
          successTitle: 'Transcript cleared'
        })
      }
    })
  }, [confirm, conversation, title])

  const removeConversation = useCallback(() => {
    if (!conversation) return
    confirm({
      title: `Delete ${title}?`,
      body:
        conversation.type === 'direct'
          ? `This removes the conversation and its messages from this computer. ${title} itself stays in your roster, and nothing it changed on disk is undone. Hide the chat instead if you might want the history later.`
          : 'This removes the group and its messages from this computer. The Bots themselves stay in your roster, and nothing they changed on disk is undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void withToast(() => deleteConversation(conversation.id), {
          errorTitle: 'Could not delete this conversation'
        })
      }
    })
  }, [confirm, conversation, deleteConversation, title])

  if (!detailsOpen) return null

  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full shrink-0 flex-col"
      style={{
        width: 'var(--details-w)',
        background: 'var(--surface-1)',
        borderLeft: '1px solid var(--border-1)',
        transform: entered ? 'translateX(0)' : 'translateX(var(--details-w))',
        transition: 'transform var(--dur-slow) var(--ease-out-quart)'
      }}
    >
      {/* This column owns its own drag strip; a window-wide one would swallow
          every click in the panels beneath it. */}
      <header
        className="drag flex shrink-0 items-center gap-[8px]"
        style={{ height: 'var(--header-h)', padding: '0 8px 0 16px' }}
      >
        <h2
          className="min-w-0 flex-1 truncate text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-title)',
            lineHeight: 'var(--lh-title)',
            letterSpacing: 'var(--ls-title)',
            fontWeight: 550
          }}
        >
          Details
        </h2>
        <IconButton label="Close details" onClick={() => setDetailsOpen(false)}>
          <X size={18} strokeWidth={1.75} />
        </IconButton>
      </header>

      {!conversation ? (
        <EmptyState
          compact
          icon={<Info size={20} strokeWidth={1.5} />}
          title="Nothing selected"
          body="Open a conversation to see its members, workspace and sessions."
        />
      ) : (
        <ScrollArea className="flex-1" style={{ padding: '0 16px 20px' }}>
          {/* ---- identity ------------------------------------------- */}
          <DrawerSection
            title={conversation.type === 'direct' ? 'Bot' : 'Group'}
            divider={false}
            action={
              <Button
                size="sm"
                variant="ghost"
                leading={<Pencil size={14} strokeWidth={1.75} />}
                onClick={() =>
                  openModal(
                    conversation.type === 'direct' && primaryBot
                      ? { kind: 'bot', botId: primaryBot.id }
                      : { kind: 'group', conversationId: conversation.id }
                  )
                }
              >
                Edit
              </Button>
            }
          >
            <div className="flex items-center gap-[12px]" style={{ marginBottom: 10 }}>
              {conversation.type === 'direct' && primaryBot ? (
                <BotAvatar
                  bot={primaryBot}
                  size={44}
                  working={conversation.runningBotIds.length > 0}
                />
              ) : (
                <GroupAvatar members={members} size={44} />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className="selectable truncate text-[var(--fg-primary)]"
                  style={{
                    fontSize: 'var(--fs-title)',
                    lineHeight: 'var(--lh-title)',
                    letterSpacing: 'var(--ls-title)',
                    fontWeight: 550
                  }}
                >
                  {title}
                </span>
                <span
                  className="truncate text-[var(--fg-tertiary)]"
                  style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
                >
                  {conversation.type === 'direct'
                    ? (primaryBot?.title ?? 'No title set')
                    : pluralize(members.length, 'Bot')}
                </span>
              </div>
            </div>

            {conversation.type === 'direct' && primaryBot ? (
              <>
                <p
                  className="selectable text-[var(--fg-secondary)]"
                  style={{
                    padding: '10px 12px',
                    background: 'var(--chip-bg)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 'var(--r-4)',
                    fontSize: 'var(--fs-meta)',
                    lineHeight: 'var(--lh-meta)',
                    letterSpacing: 'var(--ls-meta)',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {primaryBot.description.trim().length > 0
                    ? primaryBot.description
                    : 'No standing instructions yet. Edit the Bot to describe what it should always do — that description is sent with every single turn.'}
                </p>
                <div style={{ marginTop: 4 }}>
                  <FieldRow label="Model" value={modelLabel(primaryBot.model)} />
                  <FieldRow
                    label="Permissions"
                    value={permissionLabel(primaryBot.permissionMode, appDefaultPermission)}
                  />
                </div>
              </>
            ) : null}
          </DrawerSection>

          {conversation.type === 'group' ? (
            <MembersSection conversation={conversation} />
          ) : null}

          <WorkspaceSection conversation={conversation} />

          <SessionsSection conversation={conversation} />

          {/* ---- danger zone ---------------------------------------- */}
          <DrawerSection title="Danger zone">
            <div className="flex flex-col" style={{ gap: 6 }}>
              <DangerRow
                label="Export as Markdown"
                description="A plain-text copy of this conversation, saved wherever you choose."
                action={
                  <Button
                    size="sm"
                    loading={exporting}
                    leading={<FileDown size={14} strokeWidth={1.75} />}
                    onClick={() => void exportMarkdown()}
                  >
                    Export
                  </Button>
                }
              />
              <DangerRow
                label="Clear transcript"
                description="Deletes every message here and starts each Bot on a fresh Claude session."
                action={
                  <Button size="sm" variant="danger" onClick={clearTranscript}>
                    Clear
                  </Button>
                }
              />
              <DangerRow
                label={conversation.type === 'direct' ? 'Delete conversation' : 'Delete group'}
                description={
                  conversation.type === 'direct'
                    ? 'Removes this chat. The Bot stays in your roster.'
                    : 'Removes this group. Its Bots stay in your roster.'
                }
                action={
                  <Button
                    size="sm"
                    variant="danger"
                    leading={<Trash2 size={14} strokeWidth={1.75} />}
                    onClick={removeConversation}
                  >
                    Delete
                  </Button>
                }
              />
            </div>
          </DrawerSection>
        </ScrollArea>
      )}
    </aside>
  )
}

function DangerRow({
  label,
  description,
  action
}: {
  label: string
  description: string
  action: ReactElement
}): ReactElement {
  return (
    <div className="flex items-center gap-[10px]" style={{ minHeight: 44 }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: '18px',
            letterSpacing: 'var(--ls-meta)',
            fontWeight: 550
          }}
        >
          {label}
        </span>
        <span
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: '16px',
            letterSpacing: 'var(--ls-micro)'
          }}
        >
          {description}
        </span>
      </div>
      <span className="shrink-0">{action}</span>
    </div>
  )
}
