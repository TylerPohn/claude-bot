/**
 * Bot CRUD. Every mutation broadcasts a `bot:*` event so the sidebar, the chat
 * header and any open sheet converge on the same row without re-fetching.
 */
import { z } from 'zod'

import { IPC_CHANNELS } from '@shared/types/api'
import { botDraftSchema, botPatchSchema, idSchema } from '@shared/schemas'
import { emit } from '@main/events'
import { botsRepo } from '@main/db/repositories/bots'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { BOT_PRESETS } from '@main/db/seed'
import { AppError } from '@main/lib/errors'

import { handle, noInput } from './index'
import { getScheduler } from '@main/orchestration/JobScheduler'

const byIdSchema = z.object({ id: idSchema })
const createSchema = z.object({ draft: botDraftSchema })
const updateSchema = z.object({ id: idSchema, patch: botPatchSchema })
const flagSchema = z.object({ id: idSchema, value: z.boolean() })

function requireBot(id: string) {
  const bot = botsRepo.get(id)
  if (!bot) throw new AppError('not_found', 'That Bot no longer exists.')
  return bot
}

export function registerBotsIpc(): void {
  // Hidden Bots are included: the renderer needs them to render historical
  // messages and the "hidden" section of the Bot list.
  handle(IPC_CHANNELS.botsList, noInput, () => botsRepo.list(true))

  handle(IPC_CHANNELS.botsGet, byIdSchema, ({ id }) => botsRepo.get(id))

  handle(IPC_CHANNELS.botsCreate, createSchema, ({ draft }) => {
    const bot = botsRepo.create(draft)
    emit('bot:created', { bot })
    return bot
  })

  handle(IPC_CHANNELS.botsUpdate, updateSchema, ({ id, patch }) => {
    requireBot(id)
    const bot = botsRepo.update(id, patch)
    emit('bot:updated', { bot })
    // Conversation summaries denormalize the member roster for the sidebar, so a
    // rename or avatar change has to re-emit the conversations this Bot is in.
    for (const summary of conversationsRepo.listSummaries()) {
      if (summary.memberBotIds.includes(id)) emit('conversation:updated', { conversation: summary })
    }
    return bot
  })

  handle(IPC_CHANNELS.botsDuplicate, byIdSchema, ({ id }) => {
    requireBot(id)
    const bot = botsRepo.duplicate(id)
    emit('bot:created', { bot })
    return bot
  })

  handle(IPC_CHANNELS.botsSetPinned, flagSchema, ({ id, value }) => {
    requireBot(id)
    const bot = botsRepo.update(id, { pinned: value })
    emit('bot:updated', { bot })
    return bot
  })

  handle(IPC_CHANNELS.botsSetHidden, flagSchema, ({ id, value }) => {
    requireBot(id)
    const bot = botsRepo.update(id, { hidden: value })
    emit('bot:updated', { bot })
    return bot
  })

  handle(IPC_CHANNELS.botsRemove, byIdSchema, async ({ id }) => {
    requireBot(id)
    // Stop first. A turn still streaming would keep writing rows that reference
    // this bot, and the delete underneath it surfaced to the user as
    // "FOREIGN KEY constraint failed" with the finished answer thrown away.
    await getScheduler().stopBot(id)
    // Capture membership BEFORE the delete strips it, so we know which
    // conversations need a refreshed summary afterwards.
    const affected = conversationsRepo
      .listSummaries()
      .filter((summary) => summary.memberBotIds.includes(id))
      .map((summary) => summary.id)

    const removal = botsRepo.remove(id)
    emit('bot:deleted', { botId: id })

    // Deleting a Bot can take a conversation with it: an empty 1:1 chat whose
    // only member was this Bot is dropped outright (and every newly created Bot
    // has one, because the New Bot sheet opens a direct chat immediately). The
    // renderer prunes a row ONLY on `conversation:deleted`, so re-emitting
    // `conversation:updated` for the ids captured before the delete used to skip
    // it silently — `getSummary` returns null — and left a ghost chat in the
    // sidebar that opened normally and failed only on send.
    for (const conversationId of affected) {
      if (removal.deletedConversationIds.includes(conversationId)) {
        emit('conversation:deleted', { conversationId })
        continue
      }
      const summary = conversationsRepo.getSummary(conversationId)
      // A summary that vanished without the repo reporting it is gone all the
      // same (getSummary does not filter hidden rows, so null never means
      // "merely hidden"). Treat it as deleted rather than leaving the row.
      if (summary) emit('conversation:updated', { conversation: summary })
      else emit('conversation:deleted', { conversationId })
    }
  })

  handle(IPC_CHANNELS.botsPresets, noInput, () => BOT_PRESETS)
}
