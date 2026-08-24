import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Info } from 'lucide-react'

import type { Bot, ConversationSummary } from '@shared/types'
import type { ConversationSessionInfo } from '@shared/types/api'
import { formatDaySeparator } from '@/lib/format'
import { bridge } from '@/lib/ipc'
import { useAppEvent } from '@/hooks/useEvent'
import { useAppStore } from '@/stores/appStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { CopyField, DrawerSection, Note } from '@/components/settings/SettingRow'

interface SessionEntry {
  bot: Bot
  sessionId: string | null
  seenAt: string | null
}

/**
 * Read-only view of the Claude Code session each Bot is resuming in this
 * conversation.
 *
 * The ids come from `bot_conversation_sessions` over IPC, which is the same row
 * the scheduler resumes from. This used to be derived from the jobs THIS WINDOW
 * had seen since launch, which meant that after every restart the panel said
 * "Starts on the next reply" for every Bot — asserting, in the one panel whose
 * whole job is to answer "did my team keep its context?", the exact opposite of
 * the truth, and inviting the user to "fix" it with Clear transcript, which
 * really does destroy the sessions.
 *
 * Live jobs remain an overlay for the case the database cannot cover: a session
 * id observed on a job whose row was never written (the Bot or conversation was
 * deleted mid-turn) still shows.
 */
export function SessionsSection({
  conversation
}: {
  conversation: ConversationSummary
}): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const jobs = useAppStore((s) => s.jobs)

  const [persisted, setPersisted] = useState<ConversationSessionInfo[] | null>(null)
  // Bumped to re-run the fetch. A counter rather than a callback so the effect
  // keeps a single cancellation path for both the initial load and refreshes.
  const [refreshToken, setRefreshToken] = useState(0)
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setPersisted(null)
    bridge()
      .conversations.sessions(conversation.id)
      .then((rows) => {
        if (!cancelled) setPersisted(rows)
      })
      .catch(() => {
        // A conversation deleted while its drawer is open is the normal way this
        // fails, and the drawer is about to close. Fall back to the job overlay
        // rather than putting an error in a read-only informational panel.
        if (!cancelled) setPersisted([])
      })
    return () => {
      cancelled = true
    }
  }, [conversation.id, refreshToken])

  // A turn writes its session id mid-run, so the panel would otherwise show
  // yesterday's answer for as long as it stays open.
  useAppEvent('job:updated', ({ job }) => {
    if (job.conversationId === conversation.id) refresh()
  })
  // Clear transcript drops every session for this conversation.
  useAppEvent('conversation:transcriptCleared', ({ conversationId }) => {
    if (conversationId === conversation.id) refresh()
  })

  const entries = useMemo<SessionEntry[]>(() => {
    const stored: Record<string, { sessionId: string | null; at: string | null }> = {}
    for (const row of persisted ?? []) {
      stored[row.botId] = { sessionId: row.claudeSessionId, at: row.updatedAt }
    }

    const latest: Record<string, { sessionId: string; at: string }> = {}
    for (const job of Object.values(jobs)) {
      if (job.conversationId !== conversation.id) continue
      if (!job.claudeSessionId) continue
      const previous = latest[job.botId]
      if (!previous || job.createdAt > previous.at) {
        latest[job.botId] = { sessionId: job.claudeSessionId, at: job.createdAt }
      }
    }

    return conversation.memberBotIds
      .map((id) => bots[id])
      .filter((bot): bot is Bot => Boolean(bot))
      .map((bot) => {
        // The database wins: it is written first (as soon as Claude Code reports
        // the session) and it is what `--resume` will actually be given.
        const row = stored[bot.id]
        const live = latest[bot.id]
        const sessionId = row?.sessionId ?? live?.sessionId ?? null
        return {
          bot,
          sessionId,
          // The date describes the session, so it is only shown when there is
          // one. A cleared pairing keeps its row (with a fresh `updated_at`) and
          // would otherwise print today's date beside "Starts on the next reply".
          seenAt: sessionId === null ? null : (row?.at ?? live?.at ?? null)
        }
      })
  }, [bots, conversation.id, conversation.memberBotIds, jobs, persisted])

  return (
    <DrawerSection title="Claude sessions">
      <ul className="flex flex-col" style={{ gap: 10 }}>
        {entries.map(({ bot, sessionId, seenAt }) => (
          <li key={bot.id} className="flex flex-col" style={{ gap: 4 }}>
            <div className="flex items-center gap-[8px]">
              <BotAvatar bot={bot} size={16} />
              <span
                className="min-w-0 flex-1 truncate text-[var(--fg-secondary)]"
                style={{ fontSize: 'var(--fs-micro)', letterSpacing: 'var(--ls-micro)' }}
              >
                {bot.name}
              </span>
              {seenAt ? (
                <span
                  className="shrink-0 text-[var(--fg-quaternary)]"
                  style={{ fontSize: 'var(--fs-nano)' }}
                >
                  {formatDaySeparator(seenAt)}
                </span>
              ) : null}
            </div>
            <CopyField
              value={sessionId}
              // Until the first read lands, say nothing rather than asserting
              // that a Bot has no session — that false claim is the bug this
              // panel was fixed for.
              empty={persisted === null ? 'Reading…' : 'Starts on the next reply'}
              copyLabel={`Copy ${bot.name}’s Claude session id`}
            />
          </li>
        ))}
      </ul>

      <Note tone="neutral" icon={<Info size={14} strokeWidth={1.75} />} className="mt-[10px]">
        These ids are local. They let a Bot resume its own Claude Code session instead of starting
        cold, and they are deliberately left out of every export because they are the closest thing
        this app stores to a token.
      </Note>

      <p
        className="mt-[8px] text-[var(--fg-quaternary)]"
        style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
      >
        If Claude Code can no longer resume one, the app starts a fresh session on its own and says
        so in the transcript — nothing you see here is lost. To force every Bot in this conversation
        onto a new session, use <em>Clear transcript</em> below.
      </p>
    </DrawerSection>
  )
}
