import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { Sticker } from 'lucide-react'

import type { Bot, ConversationSummary } from '@shared/types'
import { conversationPatchSchema, createGroupSchema } from '@shared/schemas'
import { withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { GroupAvatar } from '@/components/ui/BotAvatar'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Sheet } from '@/components/ui/Sheet'
import { Field, FormSection, WorkspaceField } from '@/components/bots/BotForm'
import { MemberPicker } from './MemberPicker'

/**
 * Create / edit a group conversation.
 *
 * The four things that actually change how a group behaves are, in order: who is
 * in it, which folder it runs in, who answers when nobody is named, and what it
 * is called. The sheet is laid out in exactly that order.
 */

const MIN_MEMBERS = 2
const MAX_MEMBERS = 10
const SOFT_MAX_MEMBERS = 6

/** Group icons: places and projects rather than faces, so they read at 20px. */
const GROUP_EMOJI = [
  '💬', '🏗️', '🚢', '🧩', '📌', '🗓️', '🔭', '🧪',
  '📈', '🛰️', '🏷️', '🧵', '🗃️', '⚡', '🌱', '🔥',
  '🧰', '🎛️', '📓', '🛎️', '🧊', '🪵', '🎯', '🧯'
] as const

interface GroupDraft {
  name: string
  icon: string
  memberBotIds: string[]
  workspaceDirectory: string
  defaultResponderBotId: string
}

/**
 * The name a group gets when the user does not type one. Built from the members
 * so an unnamed group is still identifiable in a sidebar full of them.
 */
export function suggestGroupName(members: Bot[]): string {
  const names = members.map((b) => b.name)
  if (names.length === 0) return 'New group'
  if (names.length === 1) return `${names[0]} group`
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`
  return `${names[0]}, ${names[1]} & ${names.length - 2} others`
}

export function GroupSheet({
  conversationId,
  onClose
}: {
  conversationId?: string
  onClose: () => void
}): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const conversation = useAppStore((s) =>
    conversationId ? (s.conversations[conversationId] ?? null) : null
  )
  const isEdit = conversation !== null

  const [draft, setDraft] = useState<GroupDraft>(() => ({
    name: conversation?.name ?? '',
    icon: conversation?.icon ?? '',
    memberBotIds: conversation ? [...conversation.memberBotIds] : [],
    workspaceDirectory: conversation?.workspaceDirectory ?? '',
    defaultResponderBotId: conversation?.defaultResponderBotId ?? ''
  }))
  const [saving, setSaving] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const emojiPanelRef = useRef<HTMLDivElement>(null)
  const emojiAnchor = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLFormElement>(null)
  const formId = useId()
  const nameId = useId()
  const responderId = useId()
  const emojiPanelId = useId()

  const baseline = useRef<string>('')
  if (baseline.current === '') baseline.current = JSON.stringify(draft)

  const patch = useCallback((next: Partial<GroupDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }))
  }, [])

  const members = useMemo(
    () => draft.memberBotIds.map((id) => bots[id]).filter((b): b is Bot => Boolean(b)),
    [bots, draft.memberBotIds]
  )

  const suggestion = useMemo(() => suggestGroupName(members), [members])
  const effectiveName = (draft.name.trim() || suggestion).slice(0, 60)

  // A responder who has been removed from the group can no longer own a turn.
  useEffect(() => {
    if (draft.defaultResponderBotId && !draft.memberBotIds.includes(draft.defaultResponderBotId)) {
      patch({ defaultResponderBotId: '' })
    }
  }, [draft.defaultResponderBotId, draft.memberBotIds, patch])

  /**
   * The icon grid is an INLINE disclosure, not a `Popover`. A popover portals to
   * the body at `--z-popover` (600), which sits *below* this sheet's
   * `--z-dialog` (700), and its Escape handler registers on `document` after the
   * sheet's focus trap — so it would render behind the panel and Escape would
   * close the whole sheet instead of the menu. Inline sidesteps both.
   *
   * Escape is still claimed here, in the CAPTURE phase on `window`: capture runs
   * window → document, so this fires before the sheet's trap and can keep a
   * dismissal of the grid from also dismissing the sheet.
   */
  useEffect(() => {
    if (!emojiOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setEmojiOpen(false)
      emojiAnchor.current?.focus()
    }
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (emojiPanelRef.current?.contains(target)) return
      if (emojiAnchor.current?.contains(target)) return
      setEmojiOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [emojiOpen])

  const errors = useMemo<Partial<Record<keyof GroupDraft, string>>>(() => {
    const out: Partial<Record<keyof GroupDraft, string>> = {}
    const payload = {
      name: effectiveName,
      icon: draft.icon || null,
      memberBotIds: draft.memberBotIds,
      workspaceDirectory: draft.workspaceDirectory.trim() || null
    }
    // Same schema main validates against, so nothing can pass here and fail there.
    const parsed = isEdit
      ? conversationPatchSchema.safeParse({ ...payload, defaultResponderBotId: draft.defaultResponderBotId || null })
      : createGroupSchema.safeParse(payload)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]
        if (typeof key !== 'string') continue
        const field = key as keyof GroupDraft
        if (!out[field]) out[field] = issue.message
      }
    }
    // The schema allows 1 member (a direct chat uses the same table); a *group*
    // needs two, and that rule lives here.
    if (draft.memberBotIds.length < MIN_MEMBERS) {
      out.memberBotIds = `Pick at least ${MIN_MEMBERS} Bots.`
    }
    return out
  }, [draft, effectiveName, isEdit])

  const valid = Object.keys(errors).length === 0
  const dirty = JSON.stringify(draft) !== baseline.current

  const requestClose = useCallback(() => {
    // Esc while the prompt is up backs out of the prompt, not out of the sheet.
    if (confirmingDiscard) {
      setConfirmingDiscard(false)
      return
    }
    if (dirty && !saving) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }, [confirmingDiscard, dirty, onClose, saving])

  // The footer swaps wholesale; move focus with it.
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus()
  }, [confirmingDiscard])

  const save = useCallback(async (): Promise<boolean> => {
    if (!valid || saving) return false
    const icon = draft.icon.trim() || null
    const workspaceDirectory = draft.workspaceDirectory.trim() || null
    const responder = draft.defaultResponderBotId || null
    setSaving(true)
    try {
      if (conversation) {
        const updated = await withToast(
          () =>
            useAppStore.getState().updateConversation(conversation.id, {
              name: effectiveName,
              icon,
              memberBotIds: draft.memberBotIds,
              workspaceDirectory,
              defaultResponderBotId: responder
            }),
          { errorTitle: 'Could not save this group' }
        )
        if (updated) baseline.current = JSON.stringify(draft)
        return updated !== null
      }

      const created = await withToast<ConversationSummary>(
        () =>
          useAppStore.getState().createGroup({
            name: effectiveName,
            icon,
            memberBotIds: draft.memberBotIds,
            workspaceDirectory
          }),
        { errorTitle: 'Could not create this group' }
      )
      if (!created) return false
      baseline.current = JSON.stringify(draft)

      // `createGroup`'s schema has no responder field, so the choice is applied
      // as a follow-up patch rather than being silently dropped.
      if (responder) {
        await withToast(
          () => useAppStore.getState().updateConversation(created.id, { defaultResponderBotId: responder }),
          { errorTitle: 'The group was created, but the default responder was not saved' }
        )
      }
      useUiStore.getState().setActive(created.id)
      return true
    } finally {
      setSaving(false)
    }
  }, [conversation, draft, effectiveName, saving, valid])

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (saving) return
      if (!valid) {
        // DESIGN §6: invalid actions squish for 150ms. Never a shake.
        const node = rootRef.current
        if (node) {
          node.classList.remove('squish')
          void node.offsetWidth
          node.classList.add('squish')
        }
        const firstKey = (['memberBotIds', 'name', 'workspaceDirectory'] as const).find(
          (key) => errors[key]
        )
        const target = document.querySelector<HTMLElement>(`[data-field="${firstKey ?? 'name'}"]`)
        target?.scrollIntoView({ block: 'center' })
        target?.focus({ preventScroll: true })
        return
      }
      void save().then((ok) => {
        if (ok) onClose()
      })
    },
    [errors, onClose, save, saving, valid]
  )

  return (
    <Sheet
      width={480}
      onClose={requestClose}
      title={isEdit ? 'Group settings' : 'New Group Chat'}
      description={
        isEdit
          ? 'Members, folder and routing apply from the next message onward. Nothing already sent changes.'
          : 'A group is 2–10 Bots and you. Mention a Bot to give it the task, or leave it unaddressed and one answers by a fixed rule.'
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
              loading={saving}
              // Reads as disabled but still takes the click, so pressing it
              // explains what is missing instead of doing nothing at all.
              aria-disabled={!valid || undefined}
              style={!valid ? { opacity: 0.4 } : undefined}
            >
              {isEdit ? 'Save changes' : 'Create group'}
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
        style={{ gap: 22 }}
      >
        {/* Live identity preview: the same overlapping-avatar cluster the
            sidebar will draw for this group. */}
        <section
          aria-label="Preview"
          className="flex items-center"
          style={{
            gap: 12,
            padding: 14,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 'var(--r-6)'
          }}
        >
          {draft.icon ? (
            <span
              className="grid shrink-0 place-items-center"
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'var(--surface-3)',
                fontFamily: 'var(--font-emoji)',
                fontSize: 22,
                lineHeight: 1
              }}
            >
              {draft.icon}
            </span>
          ) : (
            <GroupAvatar members={members} size={44} />
          )}
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
            <p
              className="truncate text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-title)',
                lineHeight: 'var(--lh-title)',
                letterSpacing: 'var(--ls-title)',
                fontWeight: 550
              }}
            >
              {effectiveName}
            </p>
            <p
              className="truncate text-[var(--fg-secondary)]"
              style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
            >
              {members.length === 0
                ? 'No Bots yet'
                : `${members.length} Bot${members.length === 1 ? '' : 's'} · ${members
                    .map((b) => b.name)
                    .join(', ')}`}
            </p>
          </div>
        </section>

        <FormSection title="Members">
          <MemberPicker
            selected={draft.memberBotIds}
            onChange={(memberBotIds) => patch({ memberBotIds })}
            min={MIN_MEMBERS}
            max={MAX_MEMBERS}
            softMax={SOFT_MAX_MEMBERS}
            autoFocus
          />
        </FormSection>

        <FormSection title="Identity">
          <Field
            label="Group name"
            htmlFor={nameId}
            error={errors.name}
            hint={draft.name.trim() ? undefined : `Leave blank to use “${suggestion}”.`}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <button
                ref={emojiAnchor}
                type="button"
                onClick={() => setEmojiOpen((v) => !v)}
                aria-label="Group icon"
                aria-expanded={emojiOpen}
                aria-controls={emojiPanelId}
                className="grid shrink-0 place-items-center transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--input-bg-hover)]"
                style={{
                  width: 44,
                  height: 44,
                  background: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  borderRadius: 'var(--r-5)',
                  color: 'var(--fg-tertiary)'
                }}
              >
                {draft.icon ? (
                  <span style={{ fontFamily: 'var(--font-emoji)', fontSize: 20, lineHeight: 1 }}>
                    {draft.icon}
                  </span>
                ) : (
                  <Sticker size={18} strokeWidth={1.75} aria-hidden />
                )}
              </button>

              <Input
                id={nameId}
                data-field="name"
                size="lg"
                className="min-w-0 flex-1"
                value={draft.name}
                maxLength={60}
                placeholder={suggestion}
                invalid={Boolean(errors.name)}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
          </Field>

          {emojiOpen ? (
            <div
              id={emojiPanelId}
              ref={emojiPanelRef}
              role="group"
              aria-label="Group icon"
              className="flex flex-col"
              style={{
                gap: 8,
                padding: 8,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-1)',
                borderRadius: 'var(--r-5)',
                animation: 'slide-up-in var(--dur-fast) var(--ease-out-quad)'
              }}
            >
              <div
                className="grid"
                style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 4 }}
              >
                {GROUP_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={emoji}
                    aria-pressed={draft.icon === emoji}
                    onClick={() => {
                      patch({ icon: emoji })
                      setEmojiOpen(false)
                      emojiAnchor.current?.focus()
                    }}
                    className="grid aspect-square place-items-center rounded-[var(--r-3)] transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-hover)] active:scale-[0.94]"
                    style={{
                      background: draft.icon === emoji ? 'var(--surface-3)' : 'transparent',
                      fontFamily: 'var(--font-emoji)',
                      fontSize: 18,
                      lineHeight: 1
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  patch({ icon: '' })
                  setEmojiOpen(false)
                  emojiAnchor.current?.focus()
                }}
              >
                Use member avatars instead
              </Button>
            </div>
          ) : null}

        </FormSection>

        <FormSection
          title="Workspace"
          description="Priority when a Bot runs here: this folder first, then that Bot’s own default, then your app default, then your home folder."
        >
          <WorkspaceField
            label="Group working directory"
            optional
            field="workspaceDirectory"
            value={draft.workspaceDirectory}
            onChange={(workspaceDirectory) => patch({ workspaceDirectory })}
            error={errors.workspaceDirectory}
            emptyHint="Not set — every Bot uses its own default folder."
          />
        </FormSection>

        <FormSection title="Routing">
          <Field
            label="Default responder"
            htmlFor={responderId}
            hint={
              draft.defaultResponderBotId
                ? 'Auto routing hands unaddressed messages to this Bot. Mentioning someone else still wins.'
                : 'With no default, one Bot answers by a fixed rule — the only idle Bot if the others are busy, otherwise the first member. Name a Bot here to make it explicit.'
            }
          >
            <Select
              id={responderId}
              value={draft.defaultResponderBotId}
              onChange={(e) => patch({ defaultResponderBotId: e.target.value })}
              options={[
                { value: '', label: 'Auto — fixed rule' },
                ...members.map((bot) => ({ value: bot.id, label: bot.name }))
              ]}
            />
          </Field>
          <p
            className="text-[var(--fg-quaternary)]"
            style={{ fontSize: 'var(--fs-micro)', lineHeight: 'var(--lh-micro)' }}
          >
            Addressing order: an @mention beats the default responder, and @everyone beats both.
          </p>
        </FormSection>
      </form>
    </Sheet>
  )
}
