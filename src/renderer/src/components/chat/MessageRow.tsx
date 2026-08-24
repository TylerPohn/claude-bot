import { memo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'

import type { Message } from '@shared/types'
import { cn } from '@/lib/cn'
import { formatCost, formatDuration, formatTime } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { ActivityStrip } from '@/components/activity/ActivityStrip'
import { AttachmentChips } from './AttachmentChips'
import { Markdown } from './Markdown'
import { MessageActions } from './MessageActions'
import { ReactionBar } from './ReactionBar'
import { ReplyPreview } from './ReplyPreview'
import { SystemMessage } from './SystemMessage'
import { WorkingIndicator } from './WorkingIndicator'

/**
 * One message. iMessage-shaped, not Slack-shaped — and the differences are the
 * whole point:
 *
 *  - IN A DIRECT CHAT THERE IS NO PER-MESSAGE AVATAR AND NO PER-MESSAGE
 *    TIMESTAMP. Identity lives in the header pill, time lives in the centred day
 *    separator and in this bubble's hover tooltip. A column of repeated avatars
 *    and 8:41 AM stamps is what makes a chat app read as a work tool instead of
 *    a messenger.
 *  - In a GROUP chat a 20px avatar and the sender's name appear ONCE per run of
 *    consecutive messages, not on every bubble.
 *  - Gaps carry the grouping: 4px inside a run, 12px across runs.
 *
 * The component is `React.memo`'d on the message OBJECT. The store's delta
 * reducer replaces exactly one message and rebuilds one array, so at 30 deltas a
 * second only the streaming row re-renders — every other row's props are
 * reference-identical and the memo hits.
 */

/* ------------------------------------------------------------------ *
 * Chat-scoped stylesheet
 *
 * Two rules that inline styles genuinely cannot express: pointer-events keyed on
 * an ancestor's :hover (a hover bar sitting at opacity 0 must not eat clicks
 * meant for the bubble underneath it) and the tooltip-free hover reveal of the
 * bubble's own time.
 * ------------------------------------------------------------------ */

const STYLE_ID = 'ccb-chat-styles'

const CHAT_CSS = `
.msg-actions { pointer-events: none; }
.hover-target:hover .msg-actions,
.hover-target:focus-within .msg-actions,
.msg-actions:focus-within { pointer-events: auto; }
@media (hover: none) { .msg-actions { pointer-events: auto; } }
`

function ensureChatStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CHAT_CSS
  document.head.append(style)
}

ensureChatStyles()

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * DESIGN §2.4's "status bubble": a terse acknowledgement — `Done`, `Sent`,
 * `Pulled and added` — is sized to its content with tighter padding instead of
 * sitting in a full-width bubble with an awkward amount of air around it.
 */
function isTerseAcknowledgement(body: string): boolean {
  const text = body.trim()
  if (text.length === 0 || text.length > 28) return false
  if (text.includes('\n')) return false
  return !/[*_`~[\]<>|#]/.test(text)
}

/** 20px avatar + 8px gap: the indent a group run's bubbles sit at. */
const AVATAR_GUTTER = 28

/**
 * The reasoning that was PERSISTED with this message.
 *
 * `state.thinking` is fed only by live `message:delta` events, so it is empty
 * for every message that was loaded from the database: with "Show thinking" on,
 * the panel appeared while a Bot worked and then disappeared forever at the next
 * launch, even though the text was sitting in `messages.thinking_markdown` the
 * whole time. `rowToMessage` already returns it (as the structurally wider
 * `MessageRecord`, main/db/rows.ts) and the value survives the IPC hop; the
 * shared `Message` type just does not declare the field yet, so it is read
 * structurally here rather than duplicated into a second store.
 */
function persistedThinking(message: Message): string | undefined {
  const value = message.thinkingMarkdown
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export interface MessageRowProps {
  message: Message
  /** Group conversations show a per-run avatar and sender name; direct chats do not. */
  isGroup: boolean
  /** First message of a run by this author. */
  runStart: boolean
  /** Last message of a run by this author. */
  runEnd: boolean
  /** 4px inside a run, 12px across runs (DESIGN §2.4). */
  gapTop: number
  /**
   * Roving tab index, owned by `MessageList`. Exactly ONE row in the transcript
   * carries 0; every other row carries -1 and is reachable with ↑/↓ from a
   * focused row. Before this the rows were not focusable at all and each one's
   * five hover-action buttons sat in the sequential tab order, which put 724 tab
   * stops between the transcript and the composer.
   */
  rowTabIndex: number
}

function MessageRowImpl({
  message,
  isGroup,
  runStart,
  runEnd,
  gapTop,
  rowTabIndex
}: MessageRowProps): ReactElement {
  const isUser = message.authorType === 'user'
  const isSystem = message.authorType === 'system'

  if (isSystem) {
    return (
      <div data-message-id={message.id} tabIndex={rowTabIndex} style={{ overflowAnchor: 'none' }}>
        <SystemMessage message={message} />
      </div>
    )
  }

  return (
    <ChatMessage
      message={message}
      isGroup={isGroup}
      runStart={runStart}
      runEnd={runEnd}
      gapTop={gapTop}
      rowTabIndex={rowTabIndex}
      isUser={isUser}
    />
  )
}

function ChatMessage({
  message,
  isGroup,
  runStart,
  runEnd,
  gapTop,
  rowTabIndex,
  isUser
}: MessageRowProps & { isUser: boolean }): ReactElement {
  const showThinking = useAppStore((state) => state.settings?.showThinking ?? false)
  const liveThinking = useAppStore((state) =>
    showThinking ? state.thinking[message.id] : undefined
  )
  // The live buffer wins while the turn streams; the persisted column covers
  // every message that was reloaded from disk.
  const thinking = showThinking ? (liveThinking ?? persistedThinking(message)) : undefined

  const body = message.bodyMarkdown
  const live =
    message.status === 'streaming' || message.status === 'running' || message.status === 'queued'
  const runningActivity = message.activities.some((activity) => activity.status === 'running')

  // The caret and the shimmer are two different motion elements; only one of
  // them may run at a time. While a tool is executing the text is not advancing,
  // so the shimmer owns the motion and the caret stands down.
  const showCaret = !isUser && message.status === 'streaming' && body.length > 0 && !runningActivity
  const showWorking = !isUser && live && (body.trim().length === 0 || runningActivity)

  const hasBubble = body.trim().length > 0 || message.attachments.length > 0
  const terse = !isUser && isTerseAcknowledgement(body)
  const failed = message.status === 'error'
  const stopped = message.status === 'cancelled' || message.status === 'interrupted'
  const hasReactions = message.reactions.some((reaction) => reaction.count > 0)
  // Computed here rather than inside the pill so the footer row knows whether
  // there is anything to lay out: a turn can carry a usage record that formats
  // to nothing at all.
  const usageParts = live ? EMPTY_USAGE : formatUsageParts(message.usage)

  const showAvatar = isGroup && !isUser && runEnd
  const showName = isGroup && !isUser && runStart

  const bubbleStyle: CSSProperties = {
    background: isUser ? 'var(--bubble-user-bg)' : 'var(--bubble-agent-bg)',
    color: isUser ? 'var(--bubble-user-fg)' : 'var(--bubble-agent-fg)',
    borderRadius: 'var(--r-bubble)',
    padding: terse ? '6px 12px' : '8px 14px',
    fontSize: 'var(--fs-ui)',
    lineHeight: 'var(--lh-ui)',
    letterSpacing: 'var(--ls-ui)',
    // An inset ring rather than a border: a real border would add 2px and shift
    // the bubble the moment a turn fails.
    boxShadow: failed ? 'inset 0 0 0 1px var(--fg-danger)' : undefined,
    opacity: stopped ? 0.7 : undefined
  }

  return (
    <div
      data-message-id={message.id}
      // Focusing the row is also what reveals its action bar: the bar toggles on
      // `.hover-target:focus-within`, and the row IS the hover target.
      tabIndex={rowTabIndex}
      className={cn('hover-target relative flex flex-col', isUser ? 'items-end' : 'items-start')}
      style={{
        marginTop: gapTop,
        // The transcript's scroll anchoring must never fight the spring: the
        // stick-to-bottom hook owns the scroll position.
        overflowAnchor: 'none',
        paddingLeft: isGroup && !isUser ? AVATAR_GUTTER : 0,
        // Reaction chips hang below the bubble; reserve the room so they can
        // never collide with the next message.
        paddingBottom: hasReactions ? 18 : 0
      }}
    >
      {showAvatar && !hasBubble ? (
        <span className="absolute" style={{ left: 0, bottom: 0, lineHeight: 0 }}>
          <BotAvatar
            name={message.authorName ?? 'Bot'}
            avatarType={message.authorAvatarType ?? undefined}
            avatarValue={message.authorAvatarValue ?? undefined}
            accent={message.authorAccent ?? undefined}
            size={20}
          />
        </span>
      ) : null}

      {showName ? (
        <span
          className="truncate text-[var(--fg-secondary)]"
          style={{
            marginBottom: 2,
            maxWidth: '100%',
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontWeight: 550
          }}
        >
          {message.authorName ?? 'Bot'}
        </span>
      ) : null}

      {thinking ? <ThinkingPanel text={thinking} /> : null}

      {message.activities.length > 0 ? (
        <ActivityStrip
          activities={message.activities}
          // The strip needs the MESSAGE's liveness to tell "still running" from
          // "was running when the turn was cut short"; see ActivityStrip.
          live={live}
          className="w-full"
          // Sits above the answer: what the Bot did, then what it says.
        />
      ) : null}

      {hasBubble ? (
        <div
          className="relative"
          style={{ maxWidth: terse ? undefined : 'min(640px, 80%)', marginTop: message.activities.length > 0 ? 6 : 0 }}
        >
          <MessageActions message={message} align={isUser ? 'right' : 'left'} />

          {/* Anchored to the BUBBLE, not the row (DESIGN §2.4: "aligned to the
              bubble's bottom edge"). Anchoring to the row would let anything
              rendered underneath — the usage line, a failure footer — push it
              out from under the bubble. */}
          {showAvatar ? (
            <span
              className="absolute"
              style={{ left: -AVATAR_GUTTER, bottom: 0, lineHeight: 0 }}
            >
              <BotAvatar
                name={message.authorName ?? 'Bot'}
                avatarType={message.authorAvatarType ?? undefined}
                avatarValue={message.authorAvatarValue ?? undefined}
                accent={message.authorAccent ?? undefined}
                size={20}
              />
            </span>
          ) : null}

          <div
            className="selectable"
            style={bubbleStyle}
            // DESIGN §2.4: the only per-message time in the product, and it only
            // appears on hover.
            title={formatTime(message.createdAt)}
          >
            {message.replyToMessageId ? (
              <ReplyPreview
                messageId={message.replyToMessageId}
                conversationId={message.conversationId}
                tone={isUser ? 'invert' : 'default'}
              />
            ) : null}

            {body.trim().length > 0 ? (
              <Markdown
                content={body}
                streaming={showCaret}
                tone={isUser ? 'invert' : 'default'}
              />
            ) : null}

            {message.attachments.length > 0 ? (
              <AttachmentChips
                attachments={message.attachments}
                tone={isUser ? 'invert' : 'default'}
              />
            ) : null}
          </div>

          {/* BUBBLE FOOTER — ONE absolutely-positioned row, shared by the
              reaction chips and the hover-only usage pill.

              They used to be two independent absolute siblings (chips at
              `bottom: 0` translated 12px down, pill at `top: 100%` + 2px). Their
              boxes overlapped by 10px, and because the pill has an opaque
              `--surface-2` fill and comes later in tree order it painted
              straight through the bottom half of both chips on the first hover
              of any finished Bot message carrying a reaction. Raising the chips
              with a z-index would only have swapped which one got sliced — their
              own opaque fill would then cut the pill — so they share a flex row
              and the browser keeps them apart, with no chip-row width to measure
              and nothing to drift as chips or count badges come and go.

              STILL OUT OF FLOW. A hover-only element in normal flow reserves
              height on every finished message: dead space down the transcript,
              and it pushes the run avatar off the bubble. The row is
              `pointer-events-none` so it cannot swallow clicks aimed at the
              bubble's bottom edge; the chips opt themselves back in. */}
          {hasReactions || usageParts.length > 0 ? (
            <div
              className="pointer-events-none absolute z-[1] flex items-center"
              style={{
                left: 0,
                right: 0,
                gap: 6,
                ...(hasReactions
                  ? // The 22px chip row overlaps the bubble's bottom-left corner
                    // by 10px (DESIGN §2.4) and hangs 12px below it, which is
                    // what the row's `paddingBottom: 18` already reserves.
                    { bottom: 0, transform: 'translateY(12px)', paddingLeft: 8 }
                  : // No chips means no reserved room below the bubble, so the
                    // pill keeps its own clearance instead of riding up onto the
                    // last line of the message.
                    { top: '100%', marginTop: 2 })
              }}
            >
              <ReactionBar messageId={message.id} reactions={message.reactions} />
              {usageParts.length > 0 ? (
                <UsageLine
                  parts={usageParts}
                  model={message.usage?.model ?? null}
                  // A user message's pill stays on the user's side of the row.
                  pushRight={isUser}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showWorking ? (
        <WorkingIndicator
          activities={message.activities}
          startedAt={message.createdAt}
          fallback={message.status === 'queued' ? 'Queued' : 'Working'}
          className={cn(hasBubble && 'mt-[4px]')}
        />
      ) : null}

      {failed ? <FailureFooter message={message} /> : null}
      {stopped && !failed ? (
        <span
          className="mt-[4px] text-[var(--fg-tertiary)]"
          style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
        >
          {message.status === 'interrupted'
            ? // The scheduler writes a real explanation here on startup recovery
              // ("This turn was interrupted when the app quit."). Printing the
              // Stop copy instead told the user they had cancelled something
              // they never touched.
              (message.errorText?.trim() ?? '') ||
              'This turn was interrupted before it finished.'
            : // Just the state. The caveat about actions already completed is
              // already delivered twice in this same interaction — in the Stop
              // confirmation dialog and in the note under the composer that
              // DESIGN §4.4 mandates — and repeating it on every stopped bubble
              // put five copies of one sentence on screen after an @everyone
              // fan-out was stopped.
              'Stopped'}
        </span>
      ) : null}

    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Footers
 * ------------------------------------------------------------------ */

function FailureFooter({ message }: { message: Message }): ReactElement {
  const isUser = message.authorType === 'user'
  return (
    <div
      className="mt-[4px] flex flex-wrap items-center"
      style={{ gap: 10, fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
    >
      <span className="flex items-center gap-[5px]" style={{ color: 'var(--fg-danger)' }}>
        <TriangleAlert size={13} strokeWidth={1.75} />
        {message.errorText?.trim() || (isUser ? 'Couldn’t send this message.' : 'This turn failed.')}
      </span>
      <button
        type="button"
        onClick={() => void useAppStore.getState().retryMessage(message.id)}
        className="text-[var(--accent)] hover:underline"
        style={{ fontWeight: 550 }}
      >
        Retry
      </button>
      <button
        type="button"
        onClick={() =>
          useUiStore.getState().confirm({
            title: 'Delete this message?',
            body: 'It is removed from the transcript on this computer.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: () => {
              void useAppStore.getState().deleteMessage(message.id)
            }
          })
        }
        className="text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
        style={{ fontWeight: 550 }}
      >
        Delete
      </button>
    </div>
  )
}

const EMPTY_USAGE: string[] = []

/** The pill's segments, in order. Empty when there is nothing worth showing. */
function formatUsageParts(usage: Message['usage']): string[] {
  if (!usage) return EMPTY_USAGE
  const parts: string[] = []
  const duration = formatDuration(usage.durationMs)
  if (duration) parts.push(duration)
  const cost = formatCost(usage.costUsd)
  if (cost) parts.push(cost)
  if (usage.numTurns !== null && usage.numTurns > 1) parts.push(`${usage.numTurns} turns`)
  return parts
}

/**
 * Cost and duration for a finished turn. Quiet by design — it is reference
 * information, revealed on hover, never competing with the answer itself.
 *
 * Positioning belongs to the footer row that owns this (see MessageRow); the
 * pill only decides which end of that row it hugs.
 */
function UsageLine({
  parts,
  model,
  pushRight
}: {
  parts: string[]
  model: string | null
  pushRight: boolean
}): ReactElement {
  return (
    <span
      className={cn(
        'hover-actions shrink-0 whitespace-nowrap',
        'rounded-[var(--r-2)] px-[5px] py-[1px] text-[var(--fg-tertiary)]'
      )}
      style={{
        // `auto` rather than `justify-content`, so a lone pill on a user message
        // still lands on the right while chips (when present) keep the left.
        marginLeft: pushRight ? 'auto' : undefined,
        background: 'var(--surface-2)',
        fontSize: 'var(--fs-nano)',
        lineHeight: '14px',
        letterSpacing: 'var(--ls-nano)',
        fontVariantNumeric: 'tabular-nums'
      }}
      title={model ?? undefined}
    >
      {parts.join(' · ')}
    </span>
  )
}

/**
 * Extended thinking, shown only when Settings → Show thinking is on. Collapsed
 * by default: it is context for a curious user, not part of the answer.
 */
function ThinkingPanel({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-[6px] flex w-full flex-col" style={{ gap: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-[6px] self-start rounded-[var(--r-3)] text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]"
        style={{ minHeight: 22, fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
      >
        <ChevronRight
          size={13}
          strokeWidth={1.75}
          style={{
            transform: open ? 'rotate(90deg)' : undefined,
            transition: 'transform var(--dur-fast) var(--ease-out-quad)'
          }}
        />
        Thinking
      </button>
      {open ? (
        <pre
          className="scroller selectable overflow-x-auto text-[var(--fg-tertiary)]"
          style={{
            margin: 0,
            // `overflow-x: auto` makes overflow-y compute to `auto` too, so
            // `.scroller`'s `overscroll-behavior: contain` turned this into a
            // wheel sink with nothing to scroll and froze the transcript under
            // the pointer. Chain vertically; keep sideways containment.
            overscrollBehaviorX: 'contain',
            overscrollBehaviorY: 'auto',
            maxWidth: 'min(640px, 80%)',
            padding: 12,
            background: 'var(--card-bg)',
            borderRadius: 'var(--r-5)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-code)',
            lineHeight: 'var(--lh-code)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}

export const MessageRow = memo(MessageRowImpl)
