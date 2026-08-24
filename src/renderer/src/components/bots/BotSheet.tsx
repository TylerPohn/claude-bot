import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { BotForm, useBotForm } from './BotForm'
import { BotPreviewCard } from './BotPreviewCard'

/**
 * Create / edit a Bot.
 *
 * A right-hand `Sheet` rather than a centred modal: the form is tall, the
 * transcript stays visible beside it, and the panel is anchored to the edge it
 * slides in from. 480px is DESIGN §3.10's editor width — wide enough that all
 * ten avatar shapes fit on one row without a hidden horizontal scroller.
 */
export function BotSheet({
  botId,
  presetId,
  onClose
}: {
  botId?: string
  presetId?: string
  onClose: () => void
}): ReactElement {
  const form = useBotForm(botId, presetId)
  const formId = useId()
  const rootRef = useRef<HTMLFormElement>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const keepEditingRef = useRef<HTMLButtonElement>(null)

  // Entering the discard state swaps the whole footer out from under the
  // pointer; without moving focus, a keyboard user is left pointing at a button
  // that no longer exists.
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus()
  }, [confirmingDiscard])

  /**
   * Esc and the scrim both land here. Losing a long standing-instruction draft
   * to a stray Esc is the kind of thing that makes an app feel careless, so a
   * dirty form asks first — inline in the footer rather than as a second dialog,
   * because two stacked focus traps fight over Tab and Escape.
   */
  const requestClose = useCallback(() => {
    // Esc while the prompt is up backs out of the prompt, not out of the sheet.
    if (confirmingDiscard) {
      setConfirmingDiscard(false)
      return
    }
    if (form.dirty && !form.saving) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }, [confirmingDiscard, form.dirty, form.saving, onClose])

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (form.saving) return
      if (!form.valid) {
        // DESIGN §6: an invalid action is a 150ms scale(.98) squish, never a
        // shake. Removing the class and forcing a reflow re-triggers it when
        // the user submits twice in a row.
        const node = rootRef.current
        if (node) {
          node.classList.remove('squish')
          void node.offsetWidth
          node.classList.add('squish')
        }
        form.focusFirstError()
        return
      }
      void form.save().then((ok) => {
        if (ok) onClose()
      })
    },
    [form, onClose]
  )

  return (
    <Sheet
      width={480}
      onClose={requestClose}
      title={form.isEdit ? 'Edit Profile' : 'New Bot'}
      description={
        form.isEdit
          ? 'Changes apply to every future turn, in every conversation this Bot is in.'
          : 'A Bot is a persistent teammate with its own instructions, folder and permissions. All of it stays editable.'
      }
      footer={
        confirmingDiscard ? (
          <div className="flex w-full items-center justify-between" style={{ gap: 8 }}>
            <span
              className="text-[var(--fg-secondary)]"
              style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
            >
              Discard your changes?
            </span>
            <div className="flex items-center" style={{ gap: 8 }}>
              <Button ref={keepEditingRef} variant="ghost" onClick={() => setConfirmingDiscard(false)}>
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmingDiscard(false)
                  onClose()
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="filled"
              loading={form.saving}
              // Presented as disabled, but still clickable: a truly disabled
              // button swallows the click and the user never learns which field
              // is wrong. Clicking squishes the form and focuses the problem.
              aria-disabled={!form.valid || undefined}
              style={!form.valid ? { opacity: 0.4 } : undefined}
            >
              {form.isEdit ? 'Save changes' : 'Create Bot'}
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        ref={rootRef}
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col"
        style={{ gap: 20 }}
      >
        <BotPreviewCard
          name={form.state.name}
          title={form.state.title}
          avatarType={form.state.avatarType}
          avatarValue={form.state.avatarValue}
          accent={form.state.accent}
          description={form.state.description}
        />
        <BotForm form={form} />
      </form>
    </Sheet>
  )
}
