import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Plus, TriangleAlert, UserMinus } from 'lucide-react'

import type { Bot, ConversationSummary } from '@shared/types'
import { withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Popover, PopoverItem } from '@/components/ui/Popover'
import { Select } from '@/components/ui/Select'
import { StatusDot } from '@/components/ui/StatusDot'
import { DrawerSection, Note, useControlId } from '@/components/settings/SettingRow'

/** DESIGN §3.12 / PRD §9: groups are built for 2–6 and hard-capped at 10. */
const MIN_MEMBERS = 2
const COMFORTABLE_MEMBERS = 6
const MAX_MEMBERS = 10

export function MembersSection({
  conversation
}: {
  conversation: ConversationSummary
}): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const botOrder = useAppStore((s) => s.botOrder)
  const updateConversation = useAppStore((s) => s.updateConversation)
  const confirm = useUiStore((s) => s.confirm)

  const addRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [adding, setAdding] = useState(false)
  const responderId = useControlId('responder')

  const members = useMemo(
    () => conversation.memberBotIds.map((id) => bots[id]).filter((b): b is Bot => Boolean(b)),
    [bots, conversation.memberBotIds]
  )

  const candidates = useMemo(
    () =>
      botOrder
        .map((id) => bots[id])
        .filter((bot): bot is Bot => Boolean(bot))
        .filter((bot) => !conversation.memberBotIds.includes(bot.id)),
    [botOrder, bots, conversation.memberBotIds]
  )

  // A menu opened from the keyboard must land focus inside itself, or Tab walks
  // straight past it into the page behind.
  useEffect(() => {
    if (!adding) return
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [adding])

  const setMembers = useCallback(
    (memberBotIds: string[]) => {
      void withToast(() => updateConversation(conversation.id, { memberBotIds }), {
        errorTitle: 'Could not update the members'
      })
    },
    [conversation.id, updateConversation]
  )

  const remove = useCallback(
    (bot: Bot) => {
      confirm({
        title: `Remove ${bot.name} from ${conversation.name}?`,
        body: `Everything ${bot.name} already said stays in the transcript. It stops receiving new messages here, and its Claude session for this conversation is dropped.`,
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => setMembers(conversation.memberBotIds.filter((id) => id !== bot.id))
      })
    },
    [confirm, conversation.memberBotIds, conversation.name, setMembers]
  )

  const canRemove = members.length > MIN_MEMBERS
  const canAdd = members.length < MAX_MEMBERS && candidates.length > 0

  return (
    <DrawerSection
      title={`Members · ${members.length}`}
      action={
        <>
          <Button
            ref={addRef}
            size="sm"
            variant="ghost"
            disabled={!canAdd}
            title={
              members.length >= MAX_MEMBERS
                ? `A group holds up to ${MAX_MEMBERS} Bots.`
                : candidates.length === 0
                  ? 'Every Bot is already in this group.'
                  : undefined
            }
            leading={<Plus size={14} strokeWidth={1.75} />}
            onClick={() => setAdding((open) => !open)}
          >
            Add
          </Button>
          <Popover
            open={adding}
            onClose={() => setAdding(false)}
            anchorRef={addRef}
            align="end"
            width={232}
            label="Add a Bot to this group"
            className="scroller"
          >
            <div ref={menuRef} style={{ maxHeight: 268, overflowY: 'auto' }}>
              {candidates.map((bot) => (
                <PopoverItem
                  key={bot.id}
                  leading={<BotAvatar bot={bot} size={16} />}
                  onSelect={() => {
                    setAdding(false)
                    setMembers([...conversation.memberBotIds, bot.id])
                  }}
                >
                  {bot.name}
                </PopoverItem>
              ))}
            </div>
          </Popover>
        </>
      }
    >
      <ul className="flex flex-col" style={{ gap: 2 }}>
        {members.map((bot) => {
          const running = conversation.runningBotIds.includes(bot.id)
          const queued = !running && conversation.queuedBotIds.includes(bot.id)
          return (
            <li
              key={bot.id}
              className="hover-target row-pill flex items-center gap-[10px]"
              style={{ height: 44, padding: '0 6px' }}
            >
              <BotAvatar bot={bot} size={28} working={running} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className="truncate text-[var(--fg-primary)]"
                  style={{
                    fontSize: 'var(--fs-chrome)',
                    lineHeight: '18px',
                    letterSpacing: 'var(--ls-chrome)',
                    fontWeight: 550
                  }}
                >
                  {bot.name}
                </span>
                <span
                  className="truncate"
                  style={{
                    fontSize: 'var(--fs-micro)',
                    lineHeight: '15px',
                    letterSpacing: 'var(--ls-micro)',
                    color: running ? 'var(--accent)' : 'var(--fg-tertiary)'
                  }}
                >
                  {running ? 'Working now' : queued ? 'Queued' : (bot.title ?? 'No title set')}
                </span>
              </div>

              {running || queued ? (
                <StatusDot state={running ? 'working' : 'queued'} />
              ) : null}

              {/* Absolutely-positioned would reflow nothing, but a 320px row has
                  the space; opacity-only keeps focus traversal intact. */}
              <span className="hover-actions shrink-0">
                <IconButton
                  label={
                    canRemove
                      ? `Remove ${bot.name} from this group`
                      : `Groups need at least ${MIN_MEMBERS} Bots`
                  }
                  size={26}
                  disabled={!canRemove}
                  onClick={() => remove(bot)}
                >
                  <UserMinus size={14} strokeWidth={1.75} />
                </IconButton>
              </span>
            </li>
          )
        })}
      </ul>

      {members.length > COMFORTABLE_MEMBERS ? (
        <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />} className="mt-[8px]">
          Above {COMFORTABLE_MEMBERS} Bots a group gets hard to follow, and an @everyone turn spends
          your Claude allowance {members.length} times over.
        </Note>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <label
          htmlFor={responderId}
          className="mb-[6px] block text-[var(--fg-secondary)]"
          style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
        >
          Default responder
        </label>
        <Select
          id={responderId}
          value={conversation.defaultResponderBotId ?? ''}
          options={[
            { value: '', label: 'Auto — fixed rule' },
            ...members.map((bot) => ({ value: bot.id, label: bot.name }))
          ]}
          onChange={(e) => {
            const value = e.currentTarget.value
            void withToast(
              () =>
                updateConversation(conversation.id, {
                  defaultResponderBotId: value.length > 0 ? value : null
                }),
              { errorTitle: 'Could not set the default responder' }
            )
          }}
        />
        <p
          className="mt-[6px] text-[var(--fg-quaternary)]"
          style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
        >
          {conversation.defaultResponderBotId
            ? 'Messages with no @mention go to this Bot.'
            : 'With no @mention, one Bot answers by a fixed rule — the only idle Bot if the others are busy, otherwise the first member. Name a Bot here to make it explicit.'}
        </p>
      </div>
    </DrawerSection>
  )
}
