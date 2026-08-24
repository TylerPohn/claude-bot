import { useEffect, useMemo } from 'react'
import type { ReactElement } from 'react'
import { MessageSquarePlus, Plus } from 'lucide-react'

import type { Bot } from '@shared/types'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Composer } from '@/components/composer/Composer'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'

/**
 * The chat column: floating header, transcript, composer dock.
 *
 * The three stack in a flex column where only the transcript scrolls, so the
 * header and the composer stay put while a turn streams — the composer in
 * particular must never move or be disabled during a run (DESIGN §4.4:
 * interruption in this product is conversational, so the input has to stay live).
 */

export function ChatView(): ReactElement {
  const conversationId = useUiStore((state) => state.activeConversationId)
  const conversation = useAppStore((state) =>
    conversationId ? state.conversations[conversationId] : undefined
  )

  useEffect(() => {
    if (!conversationId) return
    const state = useAppStore.getState()
    // Idempotent in the store; this is the surface that needs the transcript, so
    // it asks for it rather than trusting whichever control navigated here.
    void state.loadMessages(conversationId)
    void state.markRead(conversationId)
  }, [conversationId])

  if (!conversationId || !conversation) return <NoConversation />

  const isGroup = conversation.type === 'group'

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--surface-0)' }}>
      <ChatHeader conversationId={conversationId} />
      <MessageList
        conversationId={conversationId}
        isGroup={isGroup}
        emptyState={
          isGroup ? (
            <GroupEmptyState conversationId={conversationId} />
          ) : (
            <DirectEmptyState conversationId={conversationId} />
          )
        }
      />
      <Composer />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Nothing selected
 * ------------------------------------------------------------------ */

function NoConversation(): ReactElement {
  const hasBots = useAppStore((state) => state.botOrder.length > 0)

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--surface-0)' }}>
      {/* The column still has to be draggable when there is no header. */}
      <div className="drag shrink-0" style={{ height: 'var(--header-h)' }} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center" style={{ padding: 24, marginTop: -40 }}>
        <span
          className="mb-[16px] grid place-items-center"
          style={{ width: 56, height: 56, borderRadius: 'var(--r-6)', background: 'var(--surface-2)' }}
        >
          <MessageSquarePlus size={24} strokeWidth={1.5} className="text-[var(--fg-tertiary)]" />
        </span>
        <h2
          className="text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-h1)',
            lineHeight: 'var(--lh-h1)',
            letterSpacing: 'var(--ls-h1)',
            fontWeight: 550
          }}
        >
          {hasBots ? 'Pick a Bot to get started' : 'Your Claude Code team, in a chat app'}
        </h2>
        <p
          className="mt-[8px] text-center text-[var(--fg-secondary)]"
          style={{ fontSize: 'var(--fs-ui)', lineHeight: 'var(--lh-ui)', maxWidth: 400 }}
        >
          {hasBots
            ? 'Choose a conversation on the left, or create another teammate for a job you keep repeating.'
            : 'Create your first Bot — give it a name, a job and a working folder, and it keeps its own conversation and its own Claude session.'}
        </p>
        <div className="mt-[20px] flex items-center" style={{ gap: 8 }}>
          <Button
            variant="filled"
            leading={<Plus size={16} strokeWidth={1.75} />}
            onClick={() => useUiStore.getState().openModal({ kind: 'bot' })}
          >
            New Bot
          </Button>
          <span className="flex items-center gap-[6px] text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
            <Kbd keys="mod+n" />
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * A conversation with no messages yet
 * ------------------------------------------------------------------ */

/**
 * Openers the USER might actually say, authored here.
 *
 * These used to be mined out of `bot.description` — but a description IS the
 * standing system prompt (PromptBuilder puts it under "Standing instructions:"),
 * so it is written in the second person, addressed TO the Bot. Slicing sentences
 * out of it put the Bot's own orders in the user's mouth: five of the six
 * shipped presets open with "You are the …", so the first screen of a brand-new
 * Bot offered "You are the senior implementation engineer on this team" as a
 * thing to click and send. Filtering cannot rescue the category — what survives
 * a regex is still a rule ("Always run the suite before reporting back"), never
 * an opening line. If per-Bot starters are wanted they have to be AUTHORED, on
 * the preset and on the Bot row, not extracted.
 *
 * (This is the one deliberate deviation from DESIGN §764's "derived from the
 * Bot's description".)
 */
const OPENERS = ['What can you take off my plate?', 'What should we do first?']

function suggestionsFor(bot: Bot | undefined): string[] {
  return [
    // The only slot that varies, and it asks about the Bot's world rather than
    // quoting its instructions back. Longest first: the three are centred, so
    // they read as a designed set only while the widths taper.
    bot?.defaultWorkingDirectory
      ? 'Give me a short tour of the working folder'
      : 'How should I brief you on a new task?',
    ...OPENERS
  ]
}

/**
 * Put the suggestion in the composer rather than sending it. The user gets to
 * edit it first, which is the difference between a shortcut and a surprise.
 */
function useSuggestion(conversationId: string): (text: string) => void {
  return (text: string) => {
    useUiStore.getState().setDraft(conversationId, { text })
    // The composer is the only textarea in the chat column; focusing it puts the
    // caret where the user is already looking.
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('main textarea')
      if (input) {
        input.focus()
        input.setSelectionRange(text.length, text.length)
      }
    })
  }
}

function SuggestionPill({
  label,
  onClick
}: {
  label: string
  onClick(): void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'max-w-full truncate text-left',
        'transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
        'hover:bg-[var(--surface-3)] active:scale-[0.99]'
      )}
      style={{
        height: 40,
        padding: '0 16px',
        borderRadius: 20,
        background: 'var(--surface-2)',
        fontSize: 'var(--fs-chrome)',
        letterSpacing: 'var(--ls-chrome)',
        color: 'var(--fg-primary)'
      }}
    >
      {label}
    </button>
  )
}

function DirectEmptyState({ conversationId }: { conversationId: string }): ReactElement {
  const bot = useAppStore((state) => {
    const conversation = state.conversations[conversationId]
    const id = conversation?.memberBotIds[0]
    return id ? state.bots[id] : undefined
  })
  const title = useAppStore((state) => state.conversationTitle(conversationId))
  const apply = useSuggestion(conversationId)
  const suggestions = useMemo(() => suggestionsFor(bot), [bot])

  return (
    <div className="flex flex-col items-center text-center" style={{ padding: '0 8px' }}>
      <BotAvatar bot={bot ?? null} name={title} size={64} />
      <h2
        className="mt-[14px] text-[var(--fg-primary)]"
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550
        }}
      >
        {title}
      </h2>
      {bot?.title ? (
        <p
          className="mt-[2px] text-[var(--fg-secondary)]"
          style={{ fontSize: 'var(--fs-ui)', lineHeight: 'var(--lh-ui)' }}
        >
          {bot.title}
        </p>
      ) : null}

      <div className="mt-[20px] flex w-full flex-col items-center" style={{ gap: 8 }}>
        {suggestions.map((suggestion) => (
          <SuggestionPill key={suggestion} label={suggestion} onClick={() => apply(suggestion)} />
        ))}
      </div>

      <p
        className="mt-[18px] text-[var(--fg-tertiary)]"
        style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
      >
        Describe the outcome you want.
      </p>
    </div>
  )
}

/** The multi-assignment example from DESIGN §4.2, adapted to this group's members. */
function groupExample(names: string[]): string {
  if (names.length < 2) return ''
  const [first, second, third] = names
  if (third) {
    return `@${first} gather the source material and link every claim. @${second} turn the findings into a draft. @${third} check the draft against the sources and list only blocking issues.`
  }
  return `@${first} gather the source material and link every claim. @${second} turn the findings into a draft.`
}

function GroupEmptyState({ conversationId }: { conversationId: string }): ReactElement {
  // Both selectors MUST return a stable reference. zustand hands the selector
  // straight to useSyncExternalStore and compares snapshots with Object.is, so a
  // selector that builds the member array inline hands back a NEW array on every
  // call, React never sees the snapshot settle, and the render loop trips React
  // error #185 ("Maximum update depth exceeded") — which took down the entire
  // renderer for any group with zero messages, i.e. every group the moment it was
  // created. Derive outside the selector (same shape as ChatHeader/PinnedStrip).
  const memberBotIds = useAppStore((state) => state.conversations[conversationId]?.memberBotIds)
  const bots = useAppStore((state) => state.bots)
  const members = useMemo(
    () => (memberBotIds ?? []).map((id) => bots[id]).filter((bot): bot is Bot => Boolean(bot)),
    [memberBotIds, bots]
  )
  const apply = useSuggestion(conversationId)
  const example = useMemo(() => groupExample(members.map((bot) => bot.name)), [members])

  return (
    <div className="flex flex-col items-center text-center" style={{ padding: '0 8px' }}>
      <div className="flex items-center">
        {members.slice(0, 6).map((bot, index) => (
          <span
            key={bot.id}
            style={{
              marginLeft: index === 0 ? 0 : -10,
              borderRadius: '50%',
              boxShadow: '0 0 0 3px var(--surface-0)'
            }}
          >
            <BotAvatar bot={bot} size={44} />
          </span>
        ))}
      </div>

      <h2
        className="mt-[14px] text-[var(--fg-primary)]"
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550
        }}
      >
        {members.length} Bots in this group
      </h2>
      <p
        className="mt-[6px] text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-ui)', lineHeight: 'var(--lh-ui)', maxWidth: 420 }}
      >
        Describe the shared outcome and who owns the next step.
      </p>

      {example ? (
        <button
          type="button"
          onClick={() => apply(example)}
          className="mt-[18px] max-w-full text-left transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-3)]"
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--r-5)',
            background: 'var(--surface-2)',
            maxWidth: 480
          }}
        >
          <span
            className="block text-[var(--fg-tertiary)]"
            style={{ fontSize: 'var(--fs-micro)', fontWeight: 550, marginBottom: 4 }}
          >
            Try this
          </span>
          <span
            className="block text-[var(--fg-secondary)]"
            style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
          >
            {example}
          </span>
        </button>
      ) : null}

      <p
        className="mt-[16px] text-[var(--fg-tertiary)]"
        style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
      >
        With no @mention, one Bot answers by a fixed rule — @mention a Bot to choose.
      </p>
    </div>
  )
}
