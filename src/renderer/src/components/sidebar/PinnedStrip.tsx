import type { ReactElement } from 'react'

import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import { StatusDot } from '@/components/ui/StatusDot'
import { useRowSignals } from './ConversationRow'

/**
 * The horizontal pinned strip (DESIGN §2.2). 92px tall, 56px avatars, 64px
 * items, 12px gaps, and a divider inset 8px on each side so it separates from
 * the list below by lightness rather than by a full-bleed rule.
 *
 * Rendered only when at least one conversation is pinned — an empty strip is
 * 92px of dead space at the top of the most important list in the app.
 */
export function PinnedStrip({ conversationIds }: { conversationIds: string[] }): ReactElement | null {
  if (conversationIds.length === 0) return null

  return (
    // The divider is inset 8px on each side: the outer box carries the margin and
    // the border, the inner box scrolls. Drawing the rule on the scroller itself
    // would make it slide away with the content.
    <div style={{ marginInline: 8, borderBottom: '1px solid var(--border-1)' }}>
      <div
        role="list"
        aria-label="Pinned"
        className="scroller flex items-start overflow-x-auto"
        // `.scroller` sets `overscroll-behavior: contain` on BOTH axes, which on a
        // horizontal-only strip swallows vertical wheel gestures instead of
        // chaining them to the conversation list underneath.
        style={{
          height: 92,
          paddingTop: 8,
          gap: 12,
          overscrollBehaviorX: 'contain',
          overscrollBehaviorY: 'auto'
        }}
      >
        {conversationIds.map((id) => (
          <PinnedItem key={id} conversationId={id} />
        ))}
      </div>
    </div>
  )
}

function PinnedItem({ conversationId }: { conversationId: string }): ReactElement | null {
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const title = useAppStore((s) => s.conversationTitle(conversationId))
  const bots = useAppStore((s) => s.bots)
  const selected = useUiStore((s) => s.activeConversationId === conversationId)
  const setActive = useUiStore((s) => s.setActive)
  const signals = useRowSignals(conversationId)

  if (!conversation) return null

  const members = conversation.memberBotIds
    .map((id) => bots[id])
    .filter((b): b is NonNullable<typeof b> => Boolean(b))

  return (
    <button
      type="button"
      role="listitem"
      onClick={() => {
        setActive(conversationId)
        void useAppStore.getState().loadMessages(conversationId)
        void useAppStore.getState().markRead(conversationId)
      }}
      aria-current={selected ? 'true' : undefined}
      title={title}
      className="group flex shrink-0 flex-col items-center gap-[4px]"
      style={{ width: 64 }}
    >
      {/* `flex` rather than a bare inline box: the badge is anchored to this
          span's bottom edge, and an inline box's height would come from the
          line-height strut rather than from the avatar. */}
      <span className="relative flex">
        {conversation.type === 'group' && members.length > 1 ? (
          <GroupAvatar members={members} size={56} />
        ) : (
          <BotAvatar
            bot={members[0]}
            name={title}
            size={56}
            working={signals.working}
            avatarType={members[0] ? undefined : 'emoji'}
            avatarValue={members[0] ? undefined : (conversation.icon ?? '💬')}
          />
        )}
        {signals.attention || signals.unread ? (
          // Bottom-right, not top-right. The avatar is a blob inscribed in a
          // 56px square, so the TOP-right corner is ink nobody draws — the dot
          // floated in empty background there, and on a group cluster (whose top
          // member is inset) it detached completely. GroupAvatar always seats a
          // member flush in the bottom-right, so a 4px inset lands the badge on
          // the silhouette for both a single blob and a cluster.
          <span className="absolute right-[4px] bottom-[4px]">
            <StatusDot
              state={signals.attention ? 'attention' : 'unread'}
              size={10}
              ring
              ringColor="var(--surface-1)"
            />
          </span>
        ) : null}
      </span>
      <span
        className="w-full truncate text-center"
        style={{
          fontSize: 'var(--fs-micro)',
          lineHeight: '16px',
          fontWeight: 510,
          color: selected ? 'var(--fg-primary)' : 'var(--fg-secondary)'
        }}
      >
        {title}
      </span>
    </button>
  )
}
