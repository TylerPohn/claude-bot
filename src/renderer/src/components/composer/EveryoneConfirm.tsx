import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'

import type { SendMessageInput } from '@shared/schemas'
import { errorMessage } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { MentionMark } from './mentionText'
import { forgetMentions, rememberMentions } from './mentionText'

/**
 * The `@everyone` gate (PRD §11.3).
 *
 * Main refuses a group-wide fan-out and returns `needsEveryoneConfirm`; this is
 * the only surface that can complete it. The warning is about the user's Claude
 * subscription quota, which is the real and only cost — never about API keys or
 * billing (PRD §37).
 *
 * "Don't ask again for this group" is remembered per conversation by main
 * (`skipEveryoneConfirm`), not per app.
 *
 * DECLINING IS NOT JUST CLOSING. Main persists the user's message before it puts
 * this dialog up, and the composer clears its draft at the same moment, so a bare
 * `onClose` left the message stranded in the transcript AND the user's typing
 * gone. Worse, the stranded row is a complete non-empty user message, so the
 * group context bridge replays the instruction the user just declined into the
 * next Bot that runs. Cancel, Esc and a click on the scrim all go through
 * `decline` below, which removes the row and puts the text back in the composer.
 */

export interface EveryoneConfirmProps {
  input: SendMessageInput
  botCount: number
  onClose(): void
}

export function EveryoneConfirm({
  input,
  botCount,
  onClose
}: EveryoneConfirmProps): ReactElement {
  const [remember, setRemember] = useState(false)
  const [running, setRunning] = useState(false)
  const confirmEveryone = useAppStore((s) => s.confirmEveryone)
  const cancelEveryone = useAppStore((s) => s.cancelEveryone)

  const decline = useCallback(async () => {
    // Esc and the scrim are live while `Run` is in flight (only the Cancel button
    // is disabled), and pulling the row out from under an accepted fan-out would
    // leave the Bots answering a message that no longer exists.
    if (running) return
    // Restore the draft FIRST. If the IPC is slow the user still sees their text
    // come back, and `cancelEveryone` toasts rather than throwing, so the close
    // below always runs.
    useUiStore.getState().setDraft(input.conversationId, {
      text: input.body,
      attachments: input.attachments ?? [],
      replyToId: input.replyToMessageId ?? null
    })
    // `input.mentions` were built from the trimmed body that was sent, and the
    // restored text IS that body, so the spans line up unchanged. Restoring them
    // keeps @everyone a chip rather than plain text the next time the composer
    // mounts for this conversation.
    rememberMentions(
      input.conversationId,
      (input.mentions ?? []).map(
        (mention): MentionMark => ({
          botId: mention.botId ?? null,
          display: mention.display,
          everyone: mention.everyone ?? false,
          startIndex: mention.startIndex,
          endIndex: mention.endIndex
        })
      )
    )
    await cancelEveryone(input.conversationId)
    onClose()
  }, [cancelEveryone, input, onClose, running])

  const run = useCallback(async () => {
    setRunning(true)
    try {
      await confirmEveryone(input, remember)
      // The draft is only cleared once the fan-out is actually accepted, so a
      // failure here never costs the user their message.
      useUiStore.getState().clearDraft(input.conversationId)
      forgetMentions(input.conversationId)
      onClose()
    } catch (thrown) {
      useUiStore.getState().toast({
        level: 'error',
        title: 'Message not sent',
        body: errorMessage(thrown)
      })
      setRunning(false)
    }
  }, [confirmEveryone, input, onClose, remember])

  return (
    <Modal
      width={400}
      // Esc and the scrim route through this same handler, so no dismiss path can
      // leave the declined message behind.
      onClose={() => void decline()}
      hideClose
      title={`Run ${botCount} Bots?`}
      footer={
        <>
          <Button variant="ghost" onClick={() => void decline()} disabled={running}>
            Cancel
          </Button>
          <Button data-autofocus variant="filled" loading={running} onClick={() => void run()}>
            Run
          </Button>
        </>
      }
    >
      <p
        className="selectable text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-chrome)', lineHeight: 'var(--lh-chrome)' }}
      >
        This may use your Claude Code quota quickly.
      </p>

      <label
        className="mt-[16px] flex cursor-default items-center"
        style={{ gap: 8, fontSize: 'var(--fs-meta)', color: 'var(--fg-secondary)' }}
      >
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
        />
        Don&apos;t ask again for this group
      </label>
    </Modal>
  )
}
