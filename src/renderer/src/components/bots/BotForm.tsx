import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { FolderOpen, FolderSearch, Sparkles, TriangleAlert } from 'lucide-react'

import type { AvatarType, Bot, BotAccent, PermissionMode } from '@shared/types'
import { BOT_SHAPES } from '@shared/types'
import type { BotDraftInput } from '@shared/schemas'
import { botDraftSchema, modelSchema } from '@shared/schemas'
import { cn } from '@/lib/cn'
import { nextFreeAccent } from '@/lib/accent'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Note } from '@/components/settings/SettingRow'
import { AvatarPicker } from './AvatarPicker'
import { ToolChipInput, TOOL_SUGGESTIONS } from './ToolChipInput'

/**
 * The Bot editor's fields, state machine and validation.
 *
 * Validation is the SHARED zod schema (`botDraftSchema`), not a hand-written
 * mirror of it — main validates every IPC input against the same object, so a
 * field that passes here cannot be rejected there, and a rule only ever has to
 * change in one place. Uniqueness is the one rule zod cannot express (it needs
 * the roster), so it is layered on top and reported inline as the user types.
 */

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/** PRD §8.2's worked example of a standing instruction, verbatim. */
const EXAMPLE_DESCRIPTION =
  'You are the senior implementation engineer. Own coding tasks end-to-end. Prefer small, ' +
  'testable changes. Inspect the repo before editing. Run relevant tests after changes. ' +
  'Explain blockers briefly. Never push, deploy, or delete data unless explicitly asked.'

/**
 * PRD §15.1. `bypassPermissions` is deliberately absent and must never appear:
 * unrestricted execution is not a normal product path in this app.
 */
const PERMISSION_OPTIONS: Array<{
  value: PermissionMode
  label: string
  /** Empty for `default`, whose detail is resolved from settings at render. */
  detail: string
}> = [
  {
    value: 'plan',
    label: 'Plan',
    detail: 'Reads and analyses only. Writes no files and runs no commands.'
  },
  {
    value: 'default',
    label: 'Use app default',
    detail: ''
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    detail: 'File edits apply automatically. Commands still follow Claude Code’s rules.'
  }
]

/**
 * What a Bot left on `default` will ACTUALLY run with.
 *
 * `default` is not "Claude Code's normal rules": the scheduler resolves it
 * against Settings › Claude › Default permission mode at spawn time, so a Bot on
 * this option changes behaviour whenever that one setting changes. This sheet
 * used to label it "Ask" with the detail "Anything not already allowed is
 * refused and reported back" — a positive claim about runtime behaviour that
 * became false the moment the app default moved to Accept edits, which is how
 * one settings change silently handed every inheriting Bot unattended
 * file-write approval while three separate surfaces still read "Ask".
 */
const INHERITED_DETAIL: Record<PermissionMode, string> = {
  default:
    'Follows Settings › Claude, which is Ask today: Claude Code’s normal rules, so anything not already allowed is refused and reported back.',
  acceptEdits:
    'Follows Settings › Claude, which is Accept edits today — this Bot applies file edits without asking.',
  plan: 'Follows Settings › Claude, which is Plan today — this Bot reads and analyses only.'
}

/** The resolved mode, shown as a badge beside “Use app default”. */
const RESOLVED_BADGE: Record<PermissionMode, string> = {
  default: 'ASK',
  acceptEdits: 'ACCEPT EDITS',
  plan: 'PLAN'
}

/**
 * Suggestions offered under ALLOWED tools only.
 *
 * `--allowedTools` is an allow rule, and in headless mode (`claude -p`) there is
 * no prompt to fall back to — so a bare `Bash` chip is one tap from "every shell
 * command this Bot writes runs unattended". The same constant that feeds the
 * DISALLOWED field cannot be reused here: a bare `Bash` is the safest and most
 * useful chip on that side and the most dangerous on this one. Scoped patterns
 * teach the distinction that actually matters — `Bash` versus `Bash(npm test)`.
 */
const ALLOW_SUGGESTIONS = ['Read', 'Glob', 'Grep', 'Bash(git *)', 'Bash(npm test)'] as const

const MODEL_OPTIONS = [
  { value: 'default', label: 'Default — your Claude Code default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'custom', label: 'Custom model id…' }
]

const KNOWN_MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface BotDraftState {
  name: string
  title: string
  description: string
  avatarType: AvatarType
  avatarValue: string
  accent: BotAccent
  defaultWorkingDirectory: string
  /** The select's value; `custom` swaps in the free-text model id field. */
  modelChoice: string
  customModel: string
  permissionMode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
}

export interface BotFormApi {
  state: BotDraftState
  patch(next: Partial<BotDraftState>): void
  bot: Bot | null
  isEdit: boolean
  /** Field-keyed messages from the shared schema plus the uniqueness rule. */
  errors: Partial<Record<keyof BotDraftState, string>>
  valid: boolean
  dirty: boolean
  saving: boolean
  /** Focus + reveal the first invalid field. Called on an invalid submit. */
  focusFirstError(): void
  save(): Promise<boolean>
}

function draftFromBot(bot: Bot): BotDraftState {
  const known = (KNOWN_MODELS as readonly string[]).includes(bot.model)
  return {
    name: bot.name,
    title: bot.title ?? '',
    description: bot.description,
    avatarType: bot.avatarType,
    avatarValue: bot.avatarValue,
    accent: bot.accent,
    defaultWorkingDirectory: bot.defaultWorkingDirectory ?? '',
    modelChoice: known ? bot.model : 'custom',
    customModel: known ? '' : bot.model,
    permissionMode: bot.permissionMode,
    allowedTools: [...bot.allowedTools],
    disallowedTools: [...bot.disallowedTools]
  }
}

/** The shape the roster uses least, so a new Bot never duplicates a silhouette. */
function leastUsedShape(bots: Bot[]): string {
  const counts = new Map<string, number>()
  for (const shape of BOT_SHAPES) counts.set(shape, 0)
  for (const bot of bots) {
    if (bot.avatarType !== 'shape') continue
    counts.set(bot.avatarValue, (counts.get(bot.avatarValue) ?? 0) + 1)
  }
  let best: string = BOT_SHAPES[0]
  let bestCount = Number.POSITIVE_INFINITY
  for (const shape of BOT_SHAPES) {
    const count = counts.get(shape) ?? 0
    if (count < bestCount) {
      best = shape
      bestCount = count
    }
  }
  return best
}

/** Top-to-bottom order of the fields on screen, for error focus. */
const FIELD_ORDER: Array<keyof BotDraftState> = [
  'avatarValue',
  'name',
  'title',
  'description',
  'defaultWorkingDirectory',
  'customModel',
  'permissionMode',
  'allowedTools',
  'disallowedTools'
]

export function toDraftInput(state: BotDraftState): BotDraftInput {
  const title = state.title.trim()
  const workspace = state.defaultWorkingDirectory.trim()
  return {
    name: state.name.trim(),
    title: title || null,
    description: state.description,
    avatarType: state.avatarType,
    avatarValue: state.avatarValue,
    accent: state.accent,
    defaultWorkingDirectory: workspace || null,
    model: state.modelChoice === 'custom' ? state.customModel.trim() : state.modelChoice,
    permissionMode: state.permissionMode,
    allowedTools: state.allowedTools,
    disallowedTools: state.disallowedTools
  }
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

export function useBotForm(botId?: string, presetId?: string): BotFormApi {
  const bots = useAppStore((s) => s.bots)
  const settings = useAppStore((s) => s.settings)
  const bot = botId ? (bots[botId] ?? null) : null

  const [state, setState] = useState<BotDraftState>(() => {
    if (bot) return draftFromBot(bot)
    const roster = Object.values(bots)
    return {
      name: '',
      title: '',
      description: '',
      avatarType: 'shape',
      avatarValue: leastUsedShape(roster),
      accent: nextFreeAccent(roster.map((b) => b.accent)),
      defaultWorkingDirectory: settings?.defaultWorkspace ?? '',
      modelChoice: (KNOWN_MODELS as readonly string[]).includes(settings?.defaultModel ?? 'default')
        ? (settings?.defaultModel ?? 'default')
        : 'custom',
      customModel: (KNOWN_MODELS as readonly string[]).includes(settings?.defaultModel ?? 'default')
        ? ''
        : (settings?.defaultModel ?? ''),
      permissionMode: settings?.defaultPermissionMode ?? 'default',
      allowedTools: [],
      disallowedTools: []
    }
  })
  const [saving, setSaving] = useState(false)
  const baseline = useRef<string>('')
  if (baseline.current === '') baseline.current = JSON.stringify(state)

  const patch = useCallback((next: Partial<BotDraftState>) => {
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  // Presets are templates: they hydrate the form once, then everything is the
  // user's. Re-hydrating on a later render would overwrite their typing.
  const hydrated = useRef(false)
  useEffect(() => {
    if (!presetId || botId || hydrated.current) return
    hydrated.current = true
    let cancelled = false
    void (async () => {
      try {
        const presets = await bridge().bots.presets()
        const preset = presets.find((p) => p.presetId === presetId)
        if (!preset || cancelled) return
        const next: BotDraftState = {
          name: preset.name,
          title: preset.title ?? '',
          description: preset.description ?? '',
          avatarType: (preset.avatarType as AvatarType | undefined) ?? 'shape',
          avatarValue: preset.avatarValue ?? 'circle',
          accent: (preset.accent as BotAccent | undefined) ?? 'violet',
          defaultWorkingDirectory:
            preset.defaultWorkingDirectory ?? settings?.defaultWorkspace ?? '',
          modelChoice: (KNOWN_MODELS as readonly string[]).includes(preset.model ?? 'default')
            ? (preset.model ?? 'default')
            : 'custom',
          customModel: (KNOWN_MODELS as readonly string[]).includes(preset.model ?? 'default')
            ? ''
            : (preset.model ?? ''),
          permissionMode: preset.permissionMode ?? 'default',
          allowedTools: [...(preset.allowedTools ?? [])],
          disallowedTools: [...(preset.disallowedTools ?? [])]
        }
        setState(next)
        baseline.current = JSON.stringify(next)
      } catch {
        // A preset that cannot be read is not worth blocking creation over —
        // the user still gets a blank, fully working form.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [botId, presetId, settings?.defaultWorkspace])

  const takenNames = useMemo(() => {
    const set = new Set<string>()
    for (const other of Object.values(bots)) {
      if (other.id === botId) continue
      set.add(other.name.trim().toLowerCase())
    }
    return set
  }, [bots, botId])

  const errors = useMemo<Partial<Record<keyof BotDraftState, string>>>(() => {
    const out: Partial<Record<keyof BotDraftState, string>> = {}
    const parsed = botDraftSchema.safeParse(toDraftInput(state))
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]
        if (typeof key !== 'string') continue
        const field = (key === 'model' ? 'customModel' : key) as keyof BotDraftState
        if (!out[field]) out[field] = issue.message
      }
    }
    // The one rule the schema cannot see: it needs the rest of the roster.
    if (!out.name && state.name.trim() && takenNames.has(state.name.trim().toLowerCase())) {
      out.name = `Another Bot is already called “${state.name.trim()}”.`
    }
    if (state.modelChoice === 'custom' && !out.customModel) {
      const model = modelSchema.safeParse(state.customModel.trim())
      if (!model.success) {
        out.customModel = state.customModel.trim()
          ? (model.error.issues[0]?.message ?? 'That model id is not valid.')
          : 'Enter a model id, or pick one of the named models.'
      }
    }
    return out
  }, [state, takenNames])

  const valid = Object.keys(errors).length === 0
  const dirty = JSON.stringify(state) !== baseline.current

  const focusFirstError = useCallback(() => {
    // Visual order, not object-key order: the user should be taken to the first
    // problem they can see, which is not necessarily the first zod issue.
    const first = FIELD_ORDER.find((key) => errors[key])
    if (!first) return
    const node = document.querySelector<HTMLElement>(`[data-field="${String(first)}"]`)
    // Tell the field to stop being polite: the user has tried to save.
    node?.dispatchEvent(new CustomEvent('ccb:reveal-error', { bubbles: false }))
    node?.scrollIntoView({ block: 'center', behavior: 'auto' })
    node?.focus({ preventScroll: true })
  }, [errors])

  const save = useCallback(async (): Promise<boolean> => {
    if (!valid || saving) return false
    const input = toDraftInput(state)
    setSaving(true)
    try {
      if (bot) {
        const result = await withToast(() => useAppStore.getState().updateBot(bot.id, input), {
          errorTitle: 'Could not save this Bot'
        })
        if (result) baseline.current = JSON.stringify(state)
        return result !== null
      }

      const created = await withToast(() => useAppStore.getState().createBot(input), {
        errorTitle: 'Could not create this Bot'
      })
      if (!created) return false
      baseline.current = JSON.stringify(state)

      // A Bot with no conversation is a dead end, so drop the user straight into
      // its chat. Main may already have opened one; reuse it rather than making
      // a second thread for the same Bot.
      await useAppStore.getState().refreshConversations()
      const existing = Object.values(useAppStore.getState().conversations).find(
        (c) => c.type === 'direct' && c.memberBotIds.length === 1 && c.memberBotIds[0] === created.id
      )
      const conversation =
        existing ??
        (await withToast(() => useAppStore.getState().createDirect(created.id), {
          errorTitle: 'Could not open a chat with this Bot'
        }))
      if (conversation) useUiStore.getState().setActive(conversation.id)
      return true
    } finally {
      setSaving(false)
    }
  }, [bot, saving, state, valid])

  return { state, patch, bot, isEdit: bot !== null, errors, valid, dirty, saving, focusFirstError, save }
}

/* ------------------------------------------------------------------ *
 * The fields
 * ------------------------------------------------------------------ */

export function BotForm({ form }: { form: BotFormApi }): ReactElement {
  const { state, patch, errors } = form
  // Blurring the name field, or a rejected save, reveals its validation message.
  // Until then an untouched empty field stays quiet. `focusFirstError` runs on a
  // failed save attempt, so listening for the focus it moves is enough.
  const [nameTouched, setNameTouched] = useState(false)
  useEffect(() => {
    const node = document.querySelector<HTMLElement>('[data-field="name"]')
    if (!node) return
    const reveal = (): void => setNameTouched(true)
    node.addEventListener('ccb:reveal-error', reveal)
    return () => node.removeEventListener('ccb:reveal-error', reveal)
  }, [])
  const nameId = useId()
  const titleId = useId()
  const descriptionId = useId()
  const modelId = useId()
  const customModelId = useId()

  const insertExample = useCallback(() => {
    patch({
      description: state.description.trim()
        ? `${state.description.trimEnd()}\n\n${EXAMPLE_DESCRIPTION}`
        : EXAMPLE_DESCRIPTION
    })
  }, [patch, state.description])

  return (
    <div className="flex flex-col" style={{ gap: 22 }}>
      <FormSection title="Avatar">
        <AvatarPicker
          name={state.name}
          value={{
            avatarType: state.avatarType,
            avatarValue: state.avatarValue,
            accent: state.accent
          }}
          onChange={(next) => patch(next)}
        />
      </FormSection>

      <FormSection title="Identity">
        <Field
          label="Name"
          htmlFor={nameId}
          // An empty, untouched field is not a mistake the user has made yet:
          // greeting them with "Name is required" before they have typed a
          // character reads as broken rather than helpful. Show it once they
          // have engaged with the field (or tried to save).
          error={nameTouched || state.name.length > 0 ? errors.name : undefined}
          counter={state.name.length >= 32 ? `${state.name.length}/40` : undefined}
        >
          <Input
            id={nameId}
            data-field="name"
            data-autofocus
            size="lg"
            value={state.name}
            maxLength={40}
            placeholder="Short name"
            invalid={Boolean((nameTouched || state.name.length > 0) && errors.name)}
            spellCheck={false}
            autoComplete="off"
            onBlur={() => setNameTouched(true)}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>

        <Field
          label="Job title"
          htmlFor={titleId}
          optional
          error={errors.title}
          hint="Good jobs: Talent Scout, Expense Manager, Bug Reproduction. “General Helper” gives the Bot less to work with."
        >
          <Input
            id={titleId}
            data-field="title"
            size="lg"
            value={state.title}
            maxLength={60}
            placeholder="One primary job"
            invalid={Boolean(errors.title)}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Standing instructions"
        description="Re-sent at the start of every turn, in every conversation. Write durable rules here — how this Bot works, what it never does — and keep one-off tasks in the chat."
      >
        <Field label="Description" htmlFor={descriptionId} error={errors.description}>
          <Textarea
            id={descriptionId}
            data-field="description"
            value={state.description}
            minHeight={132}
            maxHeight={320}
            placeholder="Investigate product-performance questions using our observability tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short summary with the highest-impact issue first. Never change production settings."
            invalid={Boolean(errors.description)}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </Field>
        <div className="flex items-center justify-between" style={{ gap: 8 }}>
          <Button
            size="sm"
            variant="ghost"
            leading={<Sparkles size={14} strokeWidth={1.75} aria-hidden />}
            onClick={insertExample}
          >
            Insert example
          </Button>
          <span
            className="text-[var(--fg-quaternary)]"
            style={{ fontSize: 'var(--fs-micro)', fontVariantNumeric: 'tabular-nums' }}
          >
            {state.description.length.toLocaleString()} characters
          </span>
        </div>
      </FormSection>

      <FormSection
        title="Working folder"
        description="Where this Bot runs by default. A group’s own workspace, when it has one, wins over this."
      >
        <WorkspaceField
          label="Default working directory"
          value={state.defaultWorkingDirectory}
          onChange={(next) => patch({ defaultWorkingDirectory: next })}
          field="defaultWorkingDirectory"
          error={errors.defaultWorkingDirectory}
          emptyHint="No folder set — the Bot falls back to your default workspace, then your home folder."
        />
      </FormSection>

      <FormSection title="Model">
        <Field
          label="Model"
          htmlFor={modelId}
          hint={
            state.modelChoice === 'default'
              ? 'Default passes no model flag at all, so this Bot uses whatever your Claude Code is set to today.'
              : undefined
          }
        >
          <Select
            id={modelId}
            data-field="model"
            options={MODEL_OPTIONS}
            value={state.modelChoice}
            onChange={(e) => patch({ modelChoice: e.target.value })}
          />
        </Field>

        {state.modelChoice === 'custom' ? (
          <Field
            label="Custom model id"
            htmlFor={customModelId}
            error={errors.customModel}
            hint="Passed straight through to Claude Code as --model."
          >
            <Input
              id={customModelId}
              data-field="customModel"
              value={state.customModel}
              placeholder="claude-sonnet-4-5"
              spellCheck={false}
              autoComplete="off"
              invalid={Boolean(errors.customModel)}
              onChange={(e) => patch({ customModel: e.target.value })}
            />
          </Field>
        ) : null}
      </FormSection>

      <FormSection
        title="Permissions"
        description="Claude Code stays the execution authority — this only chooses how much it asks for."
      >
        <PermissionModePicker
          value={state.permissionMode}
          onChange={(permissionMode) => patch({ permissionMode })}
        />
      </FormSection>

      <FormSection
        title="Tools"
        description="Patterns are Claude Code’s own: a bare tool name, or a name with an argument pattern like Bash(git *)."
      >
        {/*
          PRD §38.11–38.12. The identical setting in Settings › Claude carries
          this warning; this sheet — the surface every user actually goes
          through, including during onboarding — carried none of it, while
          offering a one-tap bare `Bash` chip. An allow rule in headless mode has
          no prompt to fall back to, so the disclosure has to be wherever the
          field is.
        */}
        <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
          Bots run as your OS user, with your file access. They are not security boundaries and they
          are not isolated from each other: a Bot’s working folder is where it starts, not a limit.
        </Note>
        <ToolChipInput
          label="Allowed tools"
          value={state.allowedTools}
          onChange={(allowedTools) => patch({ allowedTools })}
          suggestions={ALLOW_SUGGESTIONS}
          hint="Runs without Claude Code stopping to ask, on every turn this Bot takes. Leave empty to use Claude Code’s own rules unchanged."
        />
        {/* `Bash` and `Bash(npm test)` look like the same kind of entry in a chip
            row, and they are not: the unscoped one is every command the model
            writes, unattended. Said only when it is actually on the list. */}
        {state.allowedTools.includes('Bash') ? (
          <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
            <strong style={{ fontWeight: 550 }}>Bash</strong> on its own allows every command this
            Bot writes to run unattended. Scope it — <code>Bash(npm test)</code>,{' '}
            <code>Bash(git *)</code> — unless you mean that.
          </Note>
        ) : null}
        <ToolChipInput
          label="Disallowed tools"
          tone="danger"
          value={state.disallowedTools}
          onChange={(disallowedTools) => patch({ disallowedTools })}
          suggestions={TOOL_SUGGESTIONS}
          hint="Blocked outright. A reviewer that cannot write is a better reviewer."
        />
      </FormSection>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Permission mode
 * ------------------------------------------------------------------ */

function PermissionModePicker({
  value,
  onChange
}: {
  value: PermissionMode
  onChange(next: PermissionMode): void
}): ReactElement {
  const groupName = useId()
  // What `default` resolves to at spawn time. Read here rather than passed in
  // so every caller of the picker (new sheet, edit sheet) tells the truth
  // without having to remember to.
  const appDefault = useAppStore((s) => s.settings?.defaultPermissionMode) ?? 'default'
  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {PERMISSION_OPTIONS.map((option) => {
        const selected = option.value === value
        const inherits = option.value === 'default'
        const detail = inherits ? INHERITED_DETAIL[appDefault] : option.detail
        return (
          // A real radio input inside the label: arrow-key navigation, the
          // roving focus and the group semantics all come for free, and none of
          // it has to be re-implemented in JS.
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
              'hover:bg-[var(--surface-hover)]',
              // The radio itself is visually hidden, so its focus ring would be
              // invisible. The ring is drawn on the card instead — outline, not
              // box-shadow, so it follows the radius and costs no layout.
              'focus-within:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] focus-within:[outline-offset:2px]'
            )}
            style={{
              gap: 10,
              padding: '10px 12px',
              borderRadius: 'var(--r-5)',
              background: selected ? 'var(--surface-2)' : 'transparent',
              border: `1px solid ${selected ? 'var(--border-3)' : 'var(--border-1)'}`
            }}
          >
            <input
              type="radio"
              name={groupName}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className="mt-[3px] grid shrink-0 place-items-center rounded-full transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
              style={{
                width: 16,
                height: 16,
                border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-3)'}`
              }}
            >
              {selected ? (
                <span
                  className="block rounded-full"
                  style={{ width: 8, height: 8, background: 'var(--accent)' }}
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
              <span className="flex items-center" style={{ gap: 6 }}>
                <span
                  className="text-[var(--fg-primary)]"
                  style={{
                    fontSize: 'var(--fs-chrome)',
                    lineHeight: 'var(--lh-chrome)',
                    fontWeight: 550
                  }}
                >
                  {option.label}
                </span>
                {/* The resolved mode, so the radio itself says what it runs as.
                    Tinted when that is the permissive one — the whole failure
                    was a Bot reading "Ask" while spawning with acceptEdits. */}
                {inherits ? (
                  <span
                    style={{
                      fontSize: 'var(--fs-nano)',
                      letterSpacing: 'var(--ls-nano)',
                      color:
                        appDefault === 'acceptEdits'
                          ? 'var(--fg-warning)'
                          : 'var(--fg-tertiary)'
                    }}
                  >
                    {RESOLVED_BADGE[appDefault]}
                  </span>
                ) : null}
              </span>
              <span
                className="text-[var(--fg-secondary)]"
                style={{
                  fontSize: 'var(--fs-micro)',
                  lineHeight: 'var(--lh-micro)',
                  letterSpacing: 'var(--ls-micro)'
                }}
              >
                {detail}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Shared field chrome — also used by the group sheet
 * ------------------------------------------------------------------ */

export function FormSection({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): ReactElement {
  return (
    <section className="flex flex-col" style={{ gap: 10 }}>
      <div className="flex flex-col" style={{ gap: 2 }}>
        <h3
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontWeight: 510
          }}
        >
          {title}
        </h3>
        {description ? (
          <p
            className="text-[var(--fg-quaternary)]"
            style={{
              fontSize: 'var(--fs-micro)',
              lineHeight: 'var(--lh-micro)',
              letterSpacing: 'var(--ls-micro)'
            }}
          >
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col" style={{ gap: 12 }}>
        {children}
      </div>
    </section>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  counter,
  optional,
  children
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  error?: string
  counter?: string
  optional?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <label
          htmlFor={htmlFor}
          className="text-[var(--fg-secondary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            fontWeight: 510
          }}
        >
          {label}
          {optional ? (
            <span className="text-[var(--fg-quaternary)]" style={{ fontWeight: 400 }}>
              {' '}
              · optional
            </span>
          ) : null}
        </label>
        {counter ? (
          <span
            className="shrink-0 text-[var(--fg-quaternary)]"
            style={{ fontSize: 'var(--fs-nano)', fontVariantNumeric: 'tabular-nums' }}
          >
            {counter}
          </span>
        ) : null}
      </div>
      {children}
      {error ? (
        <p
          role="alert"
          className="text-[var(--fg-danger)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)'
          }}
        >
          {error}
        </p>
      ) : hint ? (
        <p
          className="text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)'
          }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Working directory
 * ------------------------------------------------------------------ */

/**
 * Debounced existence check. A missing folder is a real, common failure (a repo
 * moved, an external disk unplugged) and it silently breaks every turn the Bot
 * takes, so it is surfaced at the moment the path is chosen rather than as a
 * runtime error later.
 */
export function usePathExists(path: string): { checking: boolean; missing: boolean } {
  const [missing, setMissing] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const trimmed = path.trim()
    if (!trimmed) {
      setMissing(false)
      setChecking(false)
      return
    }
    let cancelled = false
    setChecking(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const exists = await bridge().system.pathExists(trimmed)
          if (!cancelled) setMissing(!exists)
        } catch {
          // If we cannot ask, do not cry wolf — an unverifiable path is not a
          // known-missing path.
          if (!cancelled) setMissing(false)
        } finally {
          if (!cancelled) setChecking(false)
        }
      })()
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [path])

  return { checking, missing }
}

export function WorkspaceField({
  label,
  value,
  onChange,
  field,
  error,
  emptyHint,
  optional
}: {
  label: string
  value: string
  onChange(next: string): void
  /** `data-field` hook so an invalid submit can focus this control. */
  field: string
  error?: string
  emptyHint?: string
  optional?: boolean
}): ReactElement {
  const id = useId()
  const { missing } = usePathExists(value)

  const browse = useCallback(async () => {
    const result = await withToast(
      () => bridge().system.pickDirectory(value.trim() || undefined),
      { errorTitle: 'Could not open the folder picker' }
    )
    if (result?.path) onChange(result.path)
  }, [onChange, value])

  const reveal = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) return
    void withToast(() => bridge().system.revealPath(trimmed), {
      errorTitle: 'Could not reveal that folder'
    })
  }, [value])

  return (
    <Field label={label} htmlFor={id} error={error} optional={optional} hint={!value.trim() ? emptyHint : undefined}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <Input
          id={id}
          data-field={field}
          className="min-w-0 flex-1"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="/Users/you/dev/your-project"
          invalid={Boolean(error) || missing}
          onChange={(e) => onChange(e.target.value)}
          // font-family inherits from the wrapper down to the inner input, so a
          // real path renders monospaced without touching the primitive.
          style={{ fontFamily: value ? 'var(--font-mono)' : undefined }}
        />
        <Button
          variant="secondary"
          onClick={() => void browse()}
          leading={<FolderOpen size={16} strokeWidth={1.75} aria-hidden />}
        >
          Browse
        </Button>
        <IconButton label="Reveal in file manager" disabled={!value.trim()} onClick={reveal}>
          <FolderSearch size={18} strokeWidth={1.75} />
        </IconButton>
      </div>

      {missing ? (
        <p
          className="flex items-start"
          style={{
            gap: 6,
            marginTop: 2,
            color: 'var(--fg-warning)',
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)'
          }}
        >
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-[1px] shrink-0" />
          <span>That folder isn’t on disk right now. Pick another, or runs will fall back to your default workspace.</span>
        </p>
      ) : null}
    </Field>
  )
}
