/**
 * Conversation lifecycle, message paging and search.
 *
 * Two behaviours worth calling out:
 *   - `createDirect` is idempotent. A Bot has exactly one direct chat (PRD 9.1),
 *     so asking twice returns the existing thread instead of forking history.
 *   - `setFocused` is how the renderer tells main which conversation is on
 *     screen; NotificationService uses it to suppress notifications for the
 *     conversation the user is already looking at (PRD 33), and the app menu
 *     uses it for Stop and Export transcript. It used to ride on `markRead`,
 *     which the renderer skips whenever it already believes the unread count is
 *     0 — so re-opening an already-read conversation never told main anything
 *     and notifications fired for the chat filling the screen.
 */
import { z } from 'zod'

import { IPC_CHANNELS } from '@shared/types/api'
import type { ConversationSessionInfo, MessagePage } from '@shared/types/api'
import {
  conversationPatchSchema,
  createGroupSchema,
  getMessagesSchema,
  idSchema,
  searchSchema
} from '@shared/schemas'
import { emit } from '@main/events'
import { botsRepo } from '@main/db/repositories/bots'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { messagesRepo } from '@main/db/repositories/messages'
import { searchRepo } from '@main/db/repositories/search'
import { sessionsRepo } from '@main/db/repositories/sessions'
import { AppError } from '@main/lib/errors'
import { getScheduler } from '@main/orchestration/JobScheduler'
import {
  bankFocusedRead,
  getFocusedConversationId,
  setFocusedConversation
} from '@main/services/NotificationService'
import { refreshBadgeNow } from '@main/services/BadgeService'
import { exportConversationMarkdown } from '@main/services/ExportService'

import { handle, noInput } from './index'

const byIdSchema = z.object({ id: idSchema })
/** Null is a real value here: nothing is on screen after a delete or a deselect. */
const setFocusedSchema = z.object({ id: idSchema.nullable() })
const createDirectSchema = z.object({ botId: idSchema })
const createGroupInputSchema = z.object({ input: createGroupSchema })
const updateSchema = z.object({ id: idSchema, patch: conversationPatchSchema })

function requireSummary(id: string) {
  const summary = conversationsRepo.getSummary(id)
  if (!summary) throw new AppError('not_found', 'That conversation no longer exists.')
  return summary
}

export function registerConversationsIpc(): void {
  handle(IPC_CHANNELS.conversationsList, noInput, () => conversationsRepo.listSummaries())

  handle(IPC_CHANNELS.conversationsGet, byIdSchema, ({ id }) => conversationsRepo.getSummary(id))

  handle(IPC_CHANNELS.conversationsCreateDirect, createDirectSchema, ({ botId }) => {
    const bot = botsRepo.get(botId)
    if (!bot) throw new AppError('not_found', 'That Bot no longer exists.')

    const existing = conversationsRepo.findDirectForBot(botId)
    if (existing) return requireSummary(existing.id)

    const conversation = conversationsRepo.createDirect(bot)
    const summary = requireSummary(conversation.id)
    emit('conversation:created', { conversation: summary })
    return summary
  })

  handle(IPC_CHANNELS.conversationsCreateGroup, createGroupInputSchema, ({ input }) => {
    const members = botsRepo.getMany(input.memberBotIds)
    if (members.length !== new Set(input.memberBotIds).size) {
      throw new AppError('invalid_input', 'One of the selected Bots no longer exists.')
    }
    const conversation = conversationsRepo.createGroup(input)
    const summary = requireSummary(conversation.id)
    emit('conversation:created', { conversation: summary })
    return summary
  })

  handle(IPC_CHANNELS.conversationsUpdate, updateSchema, ({ id, patch }) => {
    requireSummary(id)
    const { memberBotIds, ...rest } = patch

    if (memberBotIds) {
      const members = botsRepo.getMany(memberBotIds)
      if (members.length !== new Set(memberBotIds).size) {
        throw new AppError('invalid_input', 'One of the selected Bots no longer exists.')
      }
      // Membership lives in its own table, so it is applied separately from the
      // scalar patch rather than being smuggled through `update`.
      conversationsRepo.setMembers(id, memberBotIds)
    }
    if (Object.keys(rest).length > 0) conversationsRepo.update(id, rest)

    const summary = requireSummary(id)
    emit('conversation:updated', { conversation: summary })
    return summary
  })

  handle(IPC_CHANNELS.conversationsRemove, byIdSchema, async ({ id }) => {
    requireSummary(id)
    // Kill live processes first: a running turn writing into a deleted
    // conversation would fail its foreign keys mid-stream.
    await getScheduler().stopConversation(id)
    conversationsRepo.remove(id)
    emit('conversation:deleted', { conversationId: id })
  })

  handle(IPC_CHANNELS.conversationsMarkRead, byIdSchema, ({ id }) => {
    requireSummary(id)
    conversationsRepo.markRead(id)
    emit('conversation:updated', { conversation: requireSummary(id) })
    // Opening a conversation is the one badge change the user is watching for,
    // so skip the coalescing window.
    refreshBadgeNow()
  })

  // Deliberately tolerant: the id may be null, and it may name a conversation
  // that has just been deleted. Neither is an error — this is a report of what
  // the renderer is showing, not a request to do anything to it.
  handle(IPC_CHANNELS.conversationsSetFocused, setFocusedSchema, ({ id }) => {
    // Anything that landed in the conversation the user is LEAVING arrived while
    // that transcript was on screen, so bank it before the focus moves.
    if (id !== getFocusedConversationId()) bankFocusedRead()
    setFocusedConversation(id)
  })

  handle(IPC_CHANNELS.conversationsGetMessages, getMessagesSchema, (input): MessagePage => {
    const page = messagesRepo.page(input.conversationId, input.before ?? null, input.limit)
    return { messages: page.messages, hasMore: page.hasMore, nextCursor: page.nextCursor }
  })

  handle(IPC_CHANNELS.conversationsSearch, searchSchema, ({ query, limit }) =>
    searchRepo.search(query, limit)
  )

  handle(IPC_CHANNELS.conversationsExportMarkdown, byIdSchema, ({ id }) => {
    requireSummary(id)
    return exportConversationMarkdown(id)
  })

  handle(IPC_CHANNELS.conversationsClearTranscript, byIdSchema, async ({ id }) => {
    const summary = requireSummary(id)
    // Before stopping, not after: cancelling a turn does not wait for it to unwind,
    // so a turn that is still in flight would otherwise reach its own `#finalize`
    // after this handler has returned and write its Claude session id back over the
    // NULL below. The Bot then resumed the session that still remembers every
    // message the user just deleted — see `JobScheduler.discardSessions`.
    getScheduler().discardSessions(id)
    await getScheduler().stopConversation(id)
    messagesRepo.clearConversation(id)
    // Claude's own session still remembers everything we just deleted locally, so
    // the sessions are dropped too — otherwise the Bots would keep answering from
    // a transcript the user believes is gone.
    for (const botId of summary.memberBotIds) sessionsRepo.clearSession(botId, id)
    // Both events matter. `conversation:updated` re-syncs the sidebar preview and
    // unread count; `conversation:transcriptCleared` is what tells the renderer to
    // drop the rows it has loaded. Emitting only the first left a no-undo delete
    // looking like it had failed — every message still on screen, and still
    // clickable — until the app was restarted.
    emit('conversation:updated', { conversation: requireSummary(id) })
    emit('conversation:transcriptCleared', { conversationId: id })
  })

  handle(IPC_CHANNELS.conversationsSessions, byIdSchema, ({ id }): ConversationSessionInfo[] => {
    const summary = requireSummary(id)
    // Read-only, and one call for the whole roster: the details drawer asks on
    // open and again whenever a turn moves, so an N+1 would be N+1 per event.
    return summary.memberBotIds.map((botId) => {
      const session = sessionsRepo.get(botId, id)
      return {
        botId,
        claudeSessionId: session?.claudeSessionId ?? null,
        updatedAt: session?.updatedAt ?? null
      }
    })
  })
}
