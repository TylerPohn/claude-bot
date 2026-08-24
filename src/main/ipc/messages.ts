/**
 * The send / retry / stop surface. All the real work lives in
 * `ConversationService` (persist -> route -> enqueue); this file is validation,
 * event fan-out and nothing else.
 */
import { z } from 'zod'

import { IPC_CHANNELS } from '@shared/types/api'
import { idSchema, reactionSchema, sendMessageSchema } from '@shared/schemas'
import { emit } from '@main/events'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { messagesRepo } from '@main/db/repositories/messages'
import { AppError } from '@main/lib/errors'
import { getScheduler } from '@main/orchestration/JobScheduler'
import {
  cancelPendingEveryone,
  confirmEveryone,
  forgetPendingEveryone,
  retry,
  sendMessage
} from '@main/services/ConversationService'

import { handle } from './index'

const confirmEveryoneSchema = sendMessageSchema.extend({
  /** "Don't ask again for this group" (PRD 11.3). */
  remember: z.boolean().default(false)
})
const cancelPendingSchema = z.object({ conversationId: idSchema })
const retrySchema = z.object({ messageId: idSchema })
const stopSchema = z.object({ jobId: idSchema })
const stopConversationSchema = z.object({ conversationId: idSchema })
const removeSchema = z.object({ messageId: idSchema })

export function registerMessagesIpc(): void {
  handle(IPC_CHANNELS.messagesSend, sendMessageSchema, (input) => sendMessage(input))

  handle(IPC_CHANNELS.messagesConfirmEveryone, confirmEveryoneSchema, (input) =>
    confirmEveryone(input)
  )

  // The @everyone dialog's Cancel / Esc / scrim dismiss. Main owns both halves of
  // the cleanup (the row and the pending-confirmation entry) so the renderer
  // cannot leave one without the other.
  handle(IPC_CHANNELS.messagesCancelPending, cancelPendingSchema, ({ conversationId }) =>
    cancelPendingEveryone(conversationId)
  )

  handle(IPC_CHANNELS.messagesRetry, retrySchema, ({ messageId }) => retry(messageId))

  handle(IPC_CHANNELS.messagesStop, stopSchema, ({ jobId }) => getScheduler().stop(jobId))

  handle(IPC_CHANNELS.messagesStopConversation, stopConversationSchema, ({ conversationId }) =>
    getScheduler().stopConversation(conversationId)
  )

  handle(IPC_CHANNELS.messagesReact, reactionSchema, ({ messageId, emoji }) => {
    const message = messagesRepo.toggleReaction(messageId, emoji)
    emit('message:updated', { message })
    return message
  })

  handle(IPC_CHANNELS.messagesRemove, removeSchema, ({ messageId }) => {
    const message = messagesRepo.get(messageId)
    if (!message) throw new AppError('not_found', 'That message no longer exists.')

    messagesRepo.remove(messageId)
    // This may be the row a pending @everyone confirmation is holding; if it is,
    // that confirmation now points at nothing and must be dropped with it.
    forgetPendingEveryone(message.conversationId, messageId)
    emit('message:deleted', { messageId, conversationId: message.conversationId })

    // The sidebar preview may have been this message.
    const summary = conversationsRepo.getSummary(message.conversationId)
    if (summary) emit('conversation:updated', { conversation: summary })
  })
}
