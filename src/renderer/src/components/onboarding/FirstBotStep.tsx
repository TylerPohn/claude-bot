import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ArrowLeft, CircleCheck, FolderOpen, Sparkles, TriangleAlert } from 'lucide-react'

import type { AvatarType, Bot, BotAccent, PermissionMode } from '@shared/types'
import type { BotDraftInput } from '@shared/schemas'
import { nextFreeAccent } from '@/lib/accent'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { Textarea } from '@/components/ui/Textarea'

import type { StepPrimaryAction } from './Onboarding'

type Preset = BotDraftInput & { presetId: string; tagline: string }

/** PRD §35 screen 4 asks for exactly these fields. Model stays a short list —
 *  `default` means "don't pass --model at all", which is what most people want. */
const MODEL_OPTIONS = [
  { value: 'default', label: 'Use my Claude Code default' },
  { value: 'opus', label: 'Opus — deepest reasoning' },
  { value: 'sonnet', label: 'Sonnet — balanced' },
  { value: 'haiku', label: 'Haiku — fastest' }
]

const MAX_NAME = 40

interface FormState {
  name: string
  title: string
  description: string
  workspace: string
  model: string
  avatarType: AvatarType
  avatarValue: string
  accent: BotAccent
  permissionMode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
}

function formFromPreset(
  preset: Preset | null,
  accent: BotAccent,
  defaultWorkspace: string | null
): FormState {
  return {
    name: preset?.name ?? '',
    title: preset?.title ?? '',
    description: preset?.description ?? '',
    workspace: preset?.defaultWorkingDirectory ?? defaultWorkspace ?? '',
    model: (preset?.model as string | undefined) ?? 'default',
    avatarType: (preset?.avatarType as AvatarType | undefined) ?? 'shape',
    avatarValue: preset?.avatarValue ?? 'circle',
    accent: (preset?.accent as BotAccent | undefined) ?? accent,
    permissionMode: (preset?.permissionMode as PermissionMode | undefined) ?? 'default',
    // Presets carry real guardrails (a Reviewer cannot write files); carry them
    // through rather than silently dropping them on the way into the form.
    allowedTools: preset?.allowedTools ?? [],
    disallowedTools: preset?.disallowedTools ?? []
  }
}

export function FirstBotStep({
  createdBotId,
  onCreated,
  onSkip,
  onPrimaryAction
}: {
  createdBotId: string | null
  onCreated(botId: string, conversationId: string): void
  onSkip(): void
  /** Hands this screen's forward action to the persistent footer — see
   *  `StepPrimaryAction` in Onboarding for why it does not live here. */
  onPrimaryAction(action: StepPrimaryAction | null): void
}): ReactElement {
  const bots = useAppStore((s) => s.bots)
  const defaultWorkspace = useAppStore((s) => s.settings?.defaultWorkspace ?? null)
  const createdBot = useAppStore((s) => (createdBotId ? s.bots[createdBotId] : undefined))

  const [presets, setPresets] = useState<Preset[] | null>(null)
  const [presetsFailed, setPresetsFailed] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [chosen, setChosen] = useState<Preset | null>(null)
  const [creating, setCreating] = useState(false)
  const [workspaceMissing, setWorkspaceMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void bridge()
      .bots.presets()
      .then((loaded) => {
        if (!cancelled) setPresets(loaded as Preset[])
      })
      .catch(() => {
        // The picker is a convenience; "Create your own" always works.
        if (!cancelled) setPresetsFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const takenNames = useMemo(() => {
    const set = new Set<string>()
    for (const bot of Object.values(bots)) set.add(bot.name.trim().toLowerCase())
    return set
  }, [bots])

  const freeAccent = useMemo(
    () => nextFreeAccent(Object.values(bots).map((bot) => bot.accent)),
    [bots]
  )

  const checkWorkspace = useCallback(async (path: string) => {
    const trimmed = path.trim()
    if (trimmed.length === 0) {
      setWorkspaceMissing(false)
      return
    }
    try {
      setWorkspaceMissing(!(await bridge().system.pathExists(trimmed)))
    } catch {
      // If we cannot tell, do not cry wolf.
      setWorkspaceMissing(false)
    }
  }, [])

  const choose = useCallback(
    (preset: Preset | null) => {
      setChosen(preset)
      const next = formFromPreset(preset, freeAccent, defaultWorkspace)
      setForm(next)
      void checkWorkspace(next.workspace)
    },
    [checkWorkspace, defaultWorkspace, freeAccent]
  )

  const trimmedName = form?.name.trim() ?? ''
  const nameProblem =
    form === null
      ? null
      : trimmedName.length === 0
        ? null
        : trimmedName.length > MAX_NAME
          ? `Keep names under ${MAX_NAME} characters.`
          : trimmedName.includes('@')
            ? 'Names cannot contain @ — that character addresses a Bot in a message.'
            : takenNames.has(trimmedName.toLowerCase())
              ? 'You already have a Bot with that name.'
              : null

  const workspacePath = form?.workspace.trim() ?? ''

  /**
   * A blank Workspace is not "unset": `resolveWorkspace` falls through bot →
   * setting → `homedir()`, so pressing Create on an untouched form produced a
   * Bot whose spawned process ran with cwd `$HOME` — and three of the six
   * presets (Builder, Debugger, Test Engineer) ship `acceptEdits`, so a
   * first-run user got a Bot auto-applying edits anywhere in their home folder
   * without the flow ever saying so. The folder is required here, and it has to
   * exist: a typed-but-wrong path resolves the same way.
   *
   * The requirement is unconditional rather than tied to `permissionMode`,
   * because this screen never renders that field and the headline below already
   * promises "a name, a job and a folder to work in".
   */
  const canCreate =
    form !== null &&
    trimmedName.length > 0 &&
    nameProblem === null &&
    workspacePath.length > 0 &&
    !workspaceMissing &&
    !creating

  /** Why Create is disabled. The footer prints this beside the button; when a
   *  field is already showing the problem in red, point at the field rather
   *  than repeating its message out of context. */
  const blockedReason =
    form === null || creating
      ? null
      : trimmedName.length === 0
        ? 'Give your Bot a name to continue.'
        : workspacePath.length === 0
          ? 'Choose the folder this Bot should work in.'
          : nameProblem !== null || workspaceMissing
            ? 'Fix the highlighted field to continue.'
            : null

  const create = useCallback(async () => {
    if (!form || !canCreate) return
    setCreating(true)
    const draft: BotDraftInput = {
      name: form.name.trim(),
      title: form.title.trim() || null,
      description: form.description,
      avatarType: form.avatarType,
      avatarValue: form.avatarValue,
      accent: form.accent,
      defaultWorkingDirectory: form.workspace.trim() || null,
      model: form.model,
      permissionMode: form.permissionMode,
      allowedTools: form.allowedTools,
      disallowedTools: form.disallowedTools
    }
    const created = await withToast(
      async () => {
        const bot = await useAppStore.getState().createBot(draft)
        // Creating the Bot also creates the chat you are about to be dropped into.
        const conversation = await useAppStore.getState().createDirect(bot.id)
        return { bot, conversation }
      },
      { errorTitle: 'Could not create that Bot' }
    )
    setCreating(false)
    if (created) onCreated(created.bot.id, created.conversation.id)
  }, [canCreate, form, onCreated])

  /* ---- the footer's primary action ------------------------------------ *
   * This screen has two sub-states and neither of them advances by "Continue":
   * on the picker there is nothing to create yet, and on the form the forward
   * action is `create()`. Both used to leave the footer's Continue disabled
   * with no label change and no reason, so the first-run user's most-used
   * control went dead on the most important screen while the real button sat
   * below the fold. Publish the action instead; the shell renders it.
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (createdBotId) {
      // Stepped back onto a screen whose work is done: plain Continue.
      onPrimaryAction(null)
      return
    }
    if (!form) {
      onPrimaryAction({
        label: 'Continue',
        disabled: true,
        reason: 'Choose a preset, or create your own.',
        run: () => {}
      })
      return
    }
    onPrimaryAction({
      label: trimmedName ? `Create ${trimmedName}` : 'Create Bot',
      disabled: !canCreate,
      loading: creating,
      reason: blockedReason,
      run: () => void create()
    })
  }, [blockedReason, canCreate, create, createdBotId, creating, form, onPrimaryAction, trimmedName])

  /* ---- already created ------------------------------------------------ */

  if (createdBotId) return <CreatedPanel bot={createdBot ?? null} />

  /* ---- the compact form ------------------------------------------------ */

  if (form) {
    const patch = (next: Partial<FormState>): void => setForm((current) => ({ ...current!, ...next }))

    return (
      <form
        className="flex flex-col"
        // Nothing in here is a submit button — the footer owns Create — and a
        // form with more than one text field does not implicitly submit, so
        // Enter would otherwise do nothing at all on this screen. onSubmit stays
        // as a guard in case a submit control is ever added inside.
        onSubmit={(e) => {
          e.preventDefault()
          if (canCreate) void create()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          if (!(e.target instanceof HTMLInputElement) || !canCreate) return
          e.preventDefault()
          void create()
        }}
      >
        <button
          type="button"
          onClick={() => {
            setForm(null)
            setChosen(null)
          }}
          className="flex items-center self-start rounded-[var(--r-3)] text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
          style={{ gap: 6, marginBottom: 16, fontSize: 'var(--fs-meta)' }}
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          {chosen ? 'Choose a different preset' : 'Back to presets'}
        </button>

        <div className="flex items-center" style={{ gap: 14, marginBottom: 20 }}>
          <BotAvatar
            name={trimmedName || 'New Bot'}
            avatarType={form.avatarType}
            avatarValue={form.avatarValue}
            accent={form.accent}
            size={56}
          />
          <div className="flex min-w-0 flex-col" style={{ gap: 2 }}>
            <p
              className="truncate"
              style={{
                fontSize: 'var(--fs-h1)',
                lineHeight: 'var(--lh-h1)',
                letterSpacing: 'var(--ls-h1)',
                fontWeight: 550,
                color: trimmedName ? 'var(--fg-primary)' : 'var(--fg-quaternary)'
              }}
            >
              {trimmedName || 'Your first Bot'}
            </p>
            <p
              className="truncate"
              style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
            >
              {form.title.trim() || 'Give it one primary job'}
            </p>
          </div>
        </div>

        <div className="flex flex-col" style={{ gap: 14 }}>
          <Field label="Name" error={nameProblem}>
            <Input
              size="lg"
              value={form.name}
              maxLength={MAX_NAME + 8}
              placeholder="Short name"
              invalid={Boolean(nameProblem)}
              autoFocus={!chosen}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field label="Role" hint="One primary job reads better than “General Helper”.">
            <Input
              size="lg"
              value={form.title}
              maxLength={60}
              placeholder="Implementation engineer"
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>

          <Field
            label="Description"
            hint="Standing instructions. Sent with every turn — use the chat for one-off asks."
          >
            <Textarea
              value={form.description}
              minHeight={104}
              maxHeight={220}
              placeholder="What this Bot owns, how it should work, and what it must never do."
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <Field
            label="Workspace"
            hint="The folder this Bot works in. Pick one — without it the Bot falls back to your whole home folder. You can override it per conversation."
            error={workspaceMissing ? 'That folder does not exist on this computer.' : null}
          >
            <div className="flex items-center" style={{ gap: 8 }}>
              <Input
                size="lg"
                value={form.workspace}
                placeholder="~/Projects/your-repo"
                invalid={workspaceMissing}
                spellCheck={false}
                onChange={(e) => patch({ workspace: e.target.value })}
                onBlur={(e) => void checkWorkspace(e.target.value)}
              />
              <Button
                variant="secondary"
                leading={<FolderOpen size={16} strokeWidth={1.75} />}
                style={{ height: 44, borderRadius: 'var(--r-5)' }}
                onClick={() => {
                  void withToast(
                    async () => {
                      const picked = await bridge().system.pickDirectory(
                        form.workspace.trim() || undefined
                      )
                      if (picked.path) {
                        patch({ workspace: picked.path })
                        setWorkspaceMissing(false)
                      }
                      return picked
                    },
                    { errorTitle: 'Could not open the folder picker' }
                  )
                }}
              >
                Browse…
              </Button>
            </div>
          </Field>

          {/* The one preset field with real blast radius, and the only one this
              compact form does not render a control for. Say it out loud rather
              than letting a user discover it the first time a Bot rewrites a
              file. Wording matches Settings → Claude so the two agree. */}
          {form.permissionMode === 'acceptEdits' ? (
            <p
              className="flex items-start"
              style={{
                gap: 6,
                marginTop: -4,
                fontSize: 'var(--fs-micro)',
                lineHeight: 'var(--lh-micro)',
                color: 'var(--fg-tertiary)'
              }}
            >
              <TriangleAlert
                size={12}
                strokeWidth={1.75}
                aria-hidden
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <span>
                This preset applies file edits without asking, in the folder above. Commands still
                follow Claude Code’s rules, and you can change this in the Bot’s profile later.
              </span>
            </p>
          ) : null}

          <Field label="Model">
            <Select
              options={MODEL_OPTIONS}
              value={form.model}
              onChange={(e) => patch({ model: e.target.value })}
            />
          </Field>
        </div>

        {/* The Create button that used to sit here now lives in the footer,
            where it is on screen without scrolling. The reassurance stays with
            the fields it is about. */}
        <p
          className="mt-[22px]"
          style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}
        >
          Everything here is editable later.
        </p>
      </form>
    )
  }

  /* ---- the picker ------------------------------------------------------ */

  return (
    <div className="flex flex-col">
      <h1
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550,
          color: 'var(--fg-primary)'
        }}
      >
        Create your first Bot
      </h1>
      <p
        className="mt-[8px]"
        style={{
          maxWidth: 520,
          fontSize: 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          color: 'var(--fg-secondary)'
        }}
      >
        A Bot is a name, a job and a folder to work in. Start from a preset — you can change every
        part of it afterwards.
      </p>

      <div className="mt-[22px] grid grid-cols-2" style={{ gap: 10 }}>
        {presets === null && !presetsFailed
          ? [0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                className="flex items-start"
                style={{
                  gap: 12,
                  minHeight: 104,
                  padding: 14,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 'var(--r-6)'
                }}
              >
                <Skeleton width={44} height={44} radius="var(--r-full)" index={index} />
                <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 8, paddingTop: 4 }}>
                  <Skeleton width="56%" height={11} index={index} />
                  <Skeleton width="88%" height={9} index={index} />
                  <Skeleton width="70%" height={9} index={index} />
                </div>
              </div>
            ))
          : (presets ?? []).map((preset) => (
              <PresetCard key={preset.presetId} preset={preset} onSelect={() => choose(preset)} />
            ))}

        <button
          type="button"
          onClick={() => choose(null)}
          className="col-span-2 flex items-center text-left transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:border-[var(--border-2)] hover:bg-[var(--surface-active)]"
          style={{
            gap: 12,
            minHeight: 60,
            padding: '12px 14px',
            background: 'var(--surface-hover)',
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--r-6)'
          }}
        >
          <span
            aria-hidden
            className="grid shrink-0 place-items-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--r-full)',
              background: 'var(--surface-2)',
              color: 'var(--fg-secondary)'
            }}
          >
            <Sparkles size={16} strokeWidth={1.75} />
          </span>
          <span className="flex min-w-0 flex-col" style={{ gap: 1 }}>
            <span
              style={{
                fontSize: 'var(--fs-label)',
                fontWeight: 550,
                color: 'var(--fg-primary)'
              }}
            >
              Create your own
            </span>
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-secondary)' }}>
              Start from a blank profile and describe the job yourself.
            </span>
          </span>
        </button>
      </div>

      {presetsFailed ? (
        <p
          className="mt-[12px]"
          style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
        >
          The built-in presets could not be loaded, but you can still create a Bot from scratch.
        </p>
      ) : null}

      <button
        type="button"
        onClick={onSkip}
        className="mt-[18px] self-start rounded-[var(--r-3)] text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
        style={{ fontSize: 'var(--fs-meta)' }}
      >
        I’ll create one later
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function PresetCard({
  preset,
  onSelect
}: {
  preset: Preset
  onSelect(): void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-start text-left transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:border-[var(--border-2)] hover:bg-[var(--surface-active)]"
      style={{
        gap: 12,
        minHeight: 104,
        padding: 14,
        background: 'var(--surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-6)'
      }}
    >
      <BotAvatar
        name={preset.name}
        avatarType={(preset.avatarType as AvatarType | undefined) ?? 'shape'}
        avatarValue={preset.avatarValue ?? 'circle'}
        accent={(preset.accent as BotAccent | undefined) ?? 'violet'}
        size={44}
      />
      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <span
          className="truncate"
          style={{
            fontSize: 'var(--fs-label)',
            lineHeight: 'var(--lh-label)',
            letterSpacing: 'var(--ls-label)',
            fontWeight: 550,
            color: 'var(--fg-primary)'
          }}
        >
          {preset.name}
        </span>
        {preset.title ? (
          <span
            className="truncate"
            style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-tertiary)' }}
          >
            {preset.title}
          </span>
        ) : null}
        <span
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            marginTop: 2,
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            color: 'var(--fg-secondary)'
          }}
        >
          {preset.tagline}
        </span>
      </span>
    </button>
  )
}

function Field({
  label,
  hint,
  error,
  children
}: {
  label: string
  hint?: string
  error?: string | null
  children: ReactElement
}): ReactElement {
  return (
    <label className="flex flex-col" style={{ gap: 6 }}>
      <span
        style={{
          fontSize: 'var(--fs-micro)',
          lineHeight: 'var(--lh-micro)',
          letterSpacing: 'var(--ls-micro)',
          fontWeight: 510,
          color: 'var(--fg-tertiary)'
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <span
          className="flex items-center"
          style={{ gap: 5, fontSize: 'var(--fs-micro)', color: 'var(--fg-danger)' }}
        >
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          {error}
        </span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}>{hint}</span>
      ) : null}
    </label>
  )
}

/** Shown when the user steps back onto this screen after creating a Bot. */
function CreatedPanel({ bot }: { bot: Bot | null }): ReactElement {
  return (
    <div className="flex flex-col items-center text-center">
      <BotAvatar bot={bot} name={bot?.name ?? 'Your Bot'} size={72} />
      <p
        className="mt-[16px] flex items-center"
        style={{ gap: 6, fontSize: 'var(--fs-meta)', color: 'var(--fg-success)' }}
      >
        <CircleCheck size={14} strokeWidth={1.75} aria-hidden />
        Created
      </p>
      <h1
        className="mt-[6px]"
        style={{
          fontSize: 'var(--fs-h1)',
          lineHeight: 'var(--lh-h1)',
          letterSpacing: 'var(--ls-h1)',
          fontWeight: 550,
          color: 'var(--fg-primary)'
        }}
      >
        {bot?.name ?? 'Your first Bot'}
      </h1>
      <p
        className="mt-[8px]"
        style={{
          maxWidth: 420,
          fontSize: 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          color: 'var(--fg-secondary)'
        }}
      >
        {bot?.title
          ? `${bot.title}. Its chat is ready — you can edit the profile any time from the sidebar.`
          : 'Its chat is ready. You can edit the profile any time from the sidebar.'}
      </p>
    </div>
  )
}
