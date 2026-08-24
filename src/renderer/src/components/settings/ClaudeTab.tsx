import { useCallback, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import {
  Check,
  Copy,
  FolderSearch,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  X
} from 'lucide-react'

import type { AppSettings, ModelPreference, PermissionMode, RuntimeAvailability } from '@shared/types'
import type { SettingsPatchInput } from '@shared/schemas'
import { settingsPatchSchema } from '@shared/schemas'
import { cn } from '@/lib/cn'
import { bridge, withToast } from '@/lib/ipc'
import { formatDaySeparator, pluralize } from '@/lib/format'
import { isMac } from '@/lib/platform'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import {
  CopyField,
  Note,
  SettingRow,
  SettingsSection,
  SettingsSlider,
  useControlId,
  useSliderValue
} from './SettingRow'

/**
 * Mirrors `SAFETY_DISALLOWED_TOOLS` in `src/main/orchestration/guardrails.ts`.
 * The renderer deliberately has no `@main` alias, so the list is duplicated
 * rather than imported — change both together. Showing it verbatim is the point
 * of the toggle: a safety switch whose contents you cannot read is just a vibe.
 */
const GUARDRAIL_PATTERNS = [
  'Bash(rm -rf /*)',
  'Bash(rm -fr /*)',
  'Bash(sudo *)',
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(shutdown*)',
  'Bash(mkfs*)',
  'Bash(dd *)',
  'Bash(:(){*)'
] as const

const NPM_INSTALL = 'npm install -g @anthropic-ai/claude-code'
const NATIVE_INSTALL_UNIX = 'curl -fsSL https://claude.ai/install.sh | bash'
const NATIVE_INSTALL_WIN = 'irm https://claude.ai/install.ps1 | iex'

const AVAILABILITY: Record<
  RuntimeAvailability,
  { label: string; color: string; blurb: string }
> = {
  ok: {
    label: 'Ready',
    color: 'var(--fg-success)',
    blurb: 'Claude Code answered a version check and is signed in. Bots can run.'
  },
  checking: {
    label: 'Checking…',
    color: 'var(--fg-tertiary)',
    blurb: 'Probing the executable.'
  },
  missing: {
    label: 'Not found',
    color: 'var(--fg-danger)',
    blurb: 'No `claude` executable on your PATH or at the path set below.'
  },
  unauthenticated: {
    label: 'Not signed in',
    color: 'var(--fg-warning)',
    blurb: 'Claude Code is installed but has no active session on this computer.'
  },
  error: {
    label: 'Not responding',
    color: 'var(--fg-danger)',
    blurb: 'The executable was found but did not answer a version check.'
  }
}

const MODEL_OPTIONS: Array<{ value: ModelPreference; label: string }> = [
  { value: 'default', label: 'Whatever Claude Code is set to' },
  { value: 'opus', label: 'Opus — deepest reasoning' },
  { value: 'sonnet', label: 'Sonnet — balanced' },
  { value: 'haiku', label: 'Haiku — fastest' }
]

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Ask — standard Claude Code rules' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan — read and analyse only' }
]

const PERMISSION_BLURB: Record<PermissionMode, string> = {
  default: 'Claude Code applies its own permission rules, plus the tool lists below.',
  acceptEdits:
    'File edits are applied without asking. Commands are still governed by Claude Code’s rules.',
  plan: 'Reads and analyses only. Nothing on disk changes, no commands run.'
}

/**
 * How permissive each mode is. Only the direction matters: moving UP
 * re-permissions every Bot left on “Use app default” — the scheduler resolves
 * their stored `default` against this setting at spawn time — so it needs the
 * user's consent, while moving DOWN is always safe to apply straight away.
 *
 * The failure this guards: one change here silently gave every inheriting Bot
 * unattended file-write approval, and nothing anywhere said so.
 */
const PERMISSION_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2 }

/** The mode name as it reads in a sentence about what a Bot will do. */
const PERMISSION_NAME: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan'
}

export function ClaudeTab({ settings }: { settings: AppSettings }): ReactElement {
  const runtime = useAppStore((s) => s.runtime)
  const recheckRuntime = useAppStore((s) => s.recheckRuntime)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const bots = useAppStore((s) => s.bots)

  const [checking, setChecking] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  /** A widening choice waiting for consent; the select shows it meanwhile. */
  const [pendingPermission, setPendingPermission] = useState<PermissionMode | null>(null)

  // Bots stored on `default` carry no mode of their own — JobScheduler resolves
  // them against this setting each time they spawn. Hidden and archived Bots are
  // counted too: they still run the moment someone messages them.
  const inheriting = useMemo(
    () => Object.values(bots).filter((bot) => bot.permissionMode === 'default'),
    [bots]
  )

  const save = useCallback(
    (patch: SettingsPatchInput) => {
      void withToast(() => updateSettings(patch), { errorTitle: 'Could not save that setting' })
    },
    [updateSettings]
  )

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      await recheckRuntime()
    } finally {
      setChecking(false)
    }
  }, [recheckRuntime])

  const availability: RuntimeAvailability = runtime?.availability ?? 'checking'
  const health = AVAILABILITY[availability]

  const modelId = useControlId('model')
  const permissionId = useControlId('permission')
  const depthId = useControlId('handoff-depth')
  const turnsId = useControlId('auto-turns')
  const budgetId = useControlId('bridge-budget')

  const [depth, setDepth] = useSliderValue(
    settings.maxHandoffDepth,
    useCallback((n: number) => save({ maxHandoffDepth: n }), [save])
  )
  const [turns, setTurns] = useSliderValue(
    settings.maxAutomatedTurnsPerHumanMessage,
    useCallback((n: number) => save({ maxAutomatedTurnsPerHumanMessage: n }), [save])
  )
  const [budget, setBudget] = useSliderValue(
    settings.groupBridgeCharBudget,
    useCallback((n: number) => save({ groupBridgeCharBudget: n }), [save])
  )

  // A user who pinned a full model id keeps seeing it rather than a blank select.
  const modelOptions = useMemo(() => {
    const known = MODEL_OPTIONS.some((option) => option.value === settings.defaultModel)
    return known
      ? MODEL_OPTIONS
      : [...MODEL_OPTIONS, { value: settings.defaultModel, label: settings.defaultModel }]
  }, [settings.defaultModel])

  return (
    <>
      {/* ---- health panel -------------------------------------------- */}
      <section style={{ marginBottom: 24 }}>
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 'var(--r-5)',
            padding: 16
          }}
        >
          <div className="flex items-start gap-[10px]">
            <span
              aria-hidden
              className={cn('shrink-0 rounded-full', availability === 'checking' && 'animate-pulse')}
              style={{
                width: 8,
                height: 8,
                marginTop: 7,
                background: health.color,
                boxShadow: `0 0 0 3px color-mix(in srgb, ${health.color} 18%, transparent)`
              }}
            />
            <div className="min-w-0 flex-1">
              <p
                className="text-[var(--fg-primary)]"
                style={{
                  fontSize: 'var(--fs-ui)',
                  lineHeight: 'var(--lh-ui)',
                  letterSpacing: 'var(--ls-ui)',
                  fontWeight: 550
                }}
              >
                Claude Code · {health.label}
              </p>
              <p
                className="text-[var(--fg-secondary)]"
                style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
              >
                {health.blurb}
              </p>
            </div>
            <span
              className="shrink-0 text-[var(--fg-quaternary)]"
              style={{ fontSize: 'var(--fs-micro)', marginTop: 3 }}
            >
              {runtime ? `Checked ${formatDaySeparator(runtime.checkedAt)}` : ''}
            </span>
          </div>

          <dl className="flex flex-col" style={{ gap: 8, marginTop: 14 }}>
            <div className="flex items-center gap-[12px]">
              <dt
                className="shrink-0 text-[var(--fg-tertiary)]"
                style={{ width: 76, fontSize: 'var(--fs-meta)' }}
              >
                Version
              </dt>
              <dd
                className="selectable min-w-0 flex-1 truncate text-[var(--fg-primary)]"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)' }}
              >
                {runtime?.version ? `v${runtime.version}` : '—'}
              </dd>
            </div>
            <div className="flex items-center gap-[12px]">
              <dt
                className="shrink-0 text-[var(--fg-tertiary)]"
                style={{ width: 76, fontSize: 'var(--fs-meta)' }}
              >
                Executable
              </dt>
              <dd className="min-w-0 flex-1">
                <CopyField
                  value={runtime?.executablePath ?? null}
                  empty="Not resolved"
                  copyLabel="Copy the Claude Code executable path"
                />
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center gap-[8px]" style={{ marginTop: 14 }}>
            <Button
              size="sm"
              variant={availability === 'ok' ? 'secondary' : 'filled'}
              loading={checking}
              leading={<RefreshCw size={14} strokeWidth={1.75} />}
              onClick={() => void recheck()}
            >
              Recheck
            </Button>
            <Button
              size="sm"
              leading={<Terminal size={14} strokeWidth={1.75} />}
              onClick={() => {
                void withToast(() => bridge().runtime.openLoginTerminal(), {
                  errorTitle: 'Could not open a terminal'
                })
              }}
            >
              Open Claude Code in Terminal
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leading={<FolderSearch size={14} strokeWidth={1.75} />}
              onClick={() => {
                void withToast(
                  async () => {
                    const picked = await bridge().runtime.pickExecutable()
                    // Main re-probes on its own and pushes `runtime:status`; this
                    // just makes the panel update without waiting for that event.
                    if (picked.path) await recheckRuntime()
                    return picked
                  },
                  { errorTitle: 'Could not use that executable' }
                )
              }}
            >
              Choose executable…
            </Button>
            {settings.claudeExecutablePath ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  save({ claudeExecutablePath: null })
                  void recheckRuntime()
                }}
              >
                Use PATH again
              </Button>
            ) : null}
          </div>

          {runtime?.detail ? (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setShowDetail((open) => !open)}
                className="text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]"
                style={{ fontSize: 'var(--fs-meta)' }}
              >
                {showDetail ? 'Hide probe output' : 'Show probe output'}
              </button>
              {showDetail ? (
                <pre
                  className="selectable scroller text-[var(--fg-tertiary)]"
                  style={{
                    marginTop: 8,
                    maxHeight: 140,
                    overflow: 'auto',
                    padding: 10,
                    background: 'var(--surface-1)',
                    borderRadius: 'var(--r-4)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-micro)',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {runtime.detail}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        {availability === 'missing' ? <InstallInstructions /> : null}
        {availability === 'unauthenticated' ? (
          <Note tone="warning" className="mt-[12px]">
            Run <Mono>claude</Mono> once in a terminal and finish signing in with your Claude
            account. Claude Bot never asks for an API key — it uses the session Claude Code
            already has.
          </Note>
        ) : null}
      </section>

      {/* ---- defaults ------------------------------------------------ */}
      <SettingsSection
        title="Defaults for new turns"
        description="Every Bot can override these on its own profile. A Bot left on “Use app default” falls through to what you choose here, every time it runs."
      >
        <SettingRow
          label="Default model"
          controlId={modelId}
          description="Passed to Claude Code as --model. Leave it on the first option to let your Claude Code configuration decide."
          control={
            <div style={{ width: 240 }}>
              <Select
                id={modelId}
                value={settings.defaultModel}
                options={modelOptions.map((option) => ({
                  value: String(option.value),
                  label: option.label
                }))}
                onChange={(e) => save({ defaultModel: e.currentTarget.value })}
              />
            </div>
          }
        />

        <SettingRow
          label="Default permission mode"
          controlId={permissionId}
          description={
            inheriting.length > 0
              ? `Claude Code remains the execution authority. There is deliberately no bypass option here. This is not only for new Bots: ${pluralize(inheriting.length, 'existing Bot')} left on “Use app default” resolve it the moment they run.`
              : 'Claude Code remains the execution authority. There is deliberately no bypass option here. It applies to new Bots, and to any Bot left on “Use app default”.'
          }
          control={
            <div style={{ width: 240 }}>
              <Select
                id={permissionId}
                // Shows the pending choice while it is being confirmed, so the
                // control does not snap back under the question being asked.
                value={pendingPermission ?? settings.defaultPermissionMode}
                options={PERMISSION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(e) => {
                  const next = e.currentTarget.value as PermissionMode
                  if (next === settings.defaultPermissionMode) {
                    setPendingPermission(null)
                    return
                  }
                  // Widening re-permissions Bots the user is not looking at, and
                  // no other surface would tell them it happened. Narrowing, and
                  // any change with nothing inheriting, applies immediately.
                  if (
                    inheriting.length > 0 &&
                    PERMISSION_RANK[next] > PERMISSION_RANK[settings.defaultPermissionMode]
                  ) {
                    setPendingPermission(next)
                    return
                  }
                  setPendingPermission(null)
                  save({ defaultPermissionMode: next })
                }}
              />
            </div>
          }
          footnote={
            pendingPermission ? (
              <div className="flex flex-col" style={{ gap: 8 }}>
                <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
                  {pluralize(inheriting.length, 'Bot')} left on “Use app default” will start running
                  as{' '}
                  <strong style={{ fontWeight: 550 }}>{PERMISSION_NAME[pendingPermission]}</strong>.{' '}
                  {PERMISSION_BLURB[pendingPermission]}
                  <span className="mt-[4px] block text-[var(--fg-tertiary)]">
                    {inheriting.map((bot) => bot.name).join(', ')}
                  </span>
                </Note>
                <div className="flex" style={{ gap: 8 }}>
                  <Button
                    size="sm"
                    variant="filled"
                    onClick={() => {
                      save({ defaultPermissionMode: pendingPermission })
                      setPendingPermission(null)
                    }}
                  >
                    {`Change ${pluralize(inheriting.length, 'Bot')}`}
                  </Button>
                  <Button size="sm" onClick={() => setPendingPermission(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
                {PERMISSION_BLURB[settings.defaultPermissionMode]}
              </p>
            )
          }
        />
      </SettingsSection>

      {/* ---- tools --------------------------------------------------- */}
      <SettingsSection
        title="Tools"
        description="Patterns are Claude Code tool specs — a bare tool name like Read, or a scoped call like Bash(npm test:*). They are merged with each Bot’s own lists."
      >
        {/*
          PRD §38.10–38.11. The app previously said nothing about this anywhere a
          user of the packaged build would see, while the per-Bot “Working folder”
          field reads like a scope. It is not one: a Claude Code cwd is a starting
          point, not a jail. Stated here because this is the app-wide surface for
          what Bots are allowed to do.
        */}
        <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />} className="mb-[12px]">
          Bots run as your OS user, with your file access. They are not security
          boundaries and they are not isolated from each other: a Bot’s working folder is
          where it starts, not a limit, so different Bots can reach the same files — and
          each other’s folders — if your Claude Code permissions allow it.
        </Note>
        <SettingRow
          label="Always allowed"
          description="Runs without Claude Code stopping to ask. Keep this tight — anything here applies to every Bot in the app."
        >
          <ToolChips
            field="globalAllowedTools"
            values={settings.globalAllowedTools}
            placeholder="Read, Bash(npm test:*)…"
            label="Globally allowed tools"
            onChange={(next) => save({ globalAllowedTools: next })}
          />
        </SettingRow>

        <SettingRow
          label="Never allowed"
          description="Passed to Claude Code as a deny rule. A pattern here wins over the allow list."
        >
          <ToolChips
            field="globalDisallowedTools"
            values={settings.globalDisallowedTools}
            placeholder="Bash(rm *), WebFetch…"
            label="Globally disallowed tools"
            tone="danger"
            onChange={(next) => save({ globalDisallowedTools: next })}
          />
        </SettingRow>

        <SettingRow
          label="Safety guardrails"
          description="Adds a short, fixed deny list on top of your own. It is not a sandbox and does not try to be — it blocks a handful of command shapes that are catastrophic and essentially never what you meant from a chat message."
          control={
            <Switch
              label="Safety guardrails"
              checked={settings.safetyGuardrails}
              onChange={(checked) => save({ safetyGuardrails: checked })}
            />
          }
          footnote={
            settings.safetyGuardrails ? (
              <Note tone="neutral" icon={<ShieldCheck size={14} strokeWidth={1.75} />}>
                <span>Blocked while this is on:</span>
                <div className="flex flex-wrap" style={{ gap: 4, marginTop: 6 }}>
                  {GUARDRAIL_PATTERNS.map((pattern) => (
                    <Mono key={pattern}>{pattern}</Mono>
                  ))}
                </div>
                {/*
                  The honest half. These are matched as literal command prefixes,
                  so the list blocks these spellings and nothing else — saying so
                  here is what stops the switch from reading as a category of
                  protection it does not buy.
                */}
                <div style={{ marginTop: 6 }}>
                  Matched as literal command prefixes: the same command written another way (
                  <Mono>/bin/rm -rf /</Mono>, <Mono>rm -rfv /</Mono>, or a script that does it) is
                  not covered.
                </div>
              </Note>
            ) : (
              <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
                Off. The {GUARDRAIL_PATTERNS.length} command prefixes this adds — recursive
                deletes at an absolute path, <Mono>sudo</Mono>, force pushes, disk writes — are no
                longer denied. Commands are governed only by Claude Code’s own rules and your
                lists above.
              </Note>
            )
          }
        />
      </SettingsSection>

      {/* ---- handoffs ------------------------------------------------ */}
      <SettingsSection
        title="Handoffs and turn budgets"
        description="A handoff is one Bot waking another inside the same group. These caps are what stop two Bots from volleying a task back and forth while you are away from your desk."
      >
        <SettingRow
          label="Let Bots hand work to each other"
          description="When off, only you can start a turn. Bots still see each other’s messages in a group."
          control={
            <Switch
              label="Let Bots hand work to each other"
              checked={settings.handoffsEnabled}
              onChange={(checked) => save({ handoffsEnabled: checked })}
            />
          }
        />

        <SettingRow
          label="Maximum handoff depth"
          controlId={depthId}
          description="How many Bots a single request may travel through. 0 disables chaining entirely; 2 covers “research → write → review”."
          disabled={!settings.handoffsEnabled}
        >
          <SettingsSlider
            id={depthId}
            label="Maximum handoff depth"
            value={depth}
            min={0}
            max={6}
            disabled={!settings.handoffsEnabled}
            onChange={setDepth}
            valueLabel={depth === 0 ? 'No chaining' : `${depth} deep`}
            minLabel="0"
            maxLabel="6"
          />
        </SettingRow>

        <SettingRow
          label="Automated turns per message"
          controlId={turnsId}
          description="A hard ceiling on how many Bot turns one message of yours can cause, however the work is routed. Reaching it ends the chain and posts a note in the transcript."
        >
          <SettingsSlider
            id={turnsId}
            label="Automated turns per message"
            value={turns}
            min={1}
            max={32}
            onChange={setTurns}
            valueLabel={`${turns} ${turns === 1 ? 'turn' : 'turns'}`}
            minLabel="1"
            maxLabel="32"
          />
        </SettingRow>

        <SettingRow
          label="Group context budget"
          controlId={budgetId}
          description="How much of a group’s recent conversation each Bot is caught up on before its turn. More context means better awareness and a larger prompt against your Claude allowance."
        >
          <SettingsSlider
            id={budgetId}
            label="Group context budget"
            value={budget}
            min={1000}
            max={200000}
            step={1000}
            onChange={setBudget}
            valueLabel={`${budget.toLocaleString()} characters`}
            minLabel="1k"
            maxLabel="200k"
          />
        </SettingRow>
      </SettingsSection>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Install instructions
 * ------------------------------------------------------------------ */

function InstallInstructions(): ReactElement {
  const native = isMac() || navigator.userAgent.includes('Linux') ? NATIVE_INSTALL_UNIX : NATIVE_INSTALL_WIN

  return (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        background: 'var(--surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--r-5)'
      }}
    >
      <p
        className="text-[var(--fg-primary)]"
        style={{ fontSize: 'var(--fs-chrome)', fontWeight: 550 }}
      >
        Install Claude Code
      </p>
      <p
        className="text-[var(--fg-secondary)]"
        style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)', marginTop: 4 }}
      >
        Run one of these in a terminal, then run <Mono>claude</Mono> once to sign in with your Claude
        account. There is no API key to enter.
      </p>
      <div className="flex flex-col" style={{ gap: 8, marginTop: 12 }}>
        <CommandLine command={NPM_INSTALL} caption="With npm" />
        <CommandLine command={native} caption="Without npm" />
      </div>
      <p
        className="text-[var(--fg-quaternary)]"
        style={{ fontSize: 'var(--fs-micro)', marginTop: 10 }}
      >
        Already installed somewhere unusual? Use <em>Choose executable…</em> above to point the app
        straight at it.
      </p>
    </div>
  )
}

function CommandLine({ command, caption }: { command: string; caption: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <span className="text-[var(--fg-tertiary)]" style={{ fontSize: 'var(--fs-micro)' }}>
        {caption}
      </span>
      <div
        className="flex items-center gap-[8px]"
        style={{
          padding: '6px 6px 6px 10px',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-1)',
          borderRadius: 'var(--r-4)'
        }}
      >
        <code
          className="selectable min-w-0 flex-1 truncate text-[var(--fg-primary)]"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-code)' }}
        >
          {command}
        </code>
        <Button
          size="sm"
          variant="ghost"
          leading={
            copied ? (
              <Check size={14} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
            ) : (
              <Copy size={14} strokeWidth={1.75} />
            )
          }
          onClick={() => {
            void withToast(() => bridge().system.copyText(command), {
              errorTitle: 'Could not copy that'
            }).then((result) => {
              if (result === null) return
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1400)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tool pattern chips
 * ------------------------------------------------------------------ */

/**
 * Validation runs against the *shared* zod schema rather than a copied regex, so
 * a pattern accepted here can never be rejected by main a moment later.
 */
function validatePattern(
  field: 'globalAllowedTools' | 'globalDisallowedTools',
  value: string
): string | null {
  const result = settingsPatchSchema.safeParse({ [field]: [value] })
  if (result.success) return null
  return result.error.issues[0]?.message ?? 'That is not a valid tool pattern.'
}

function ToolChips({
  field,
  values,
  onChange,
  placeholder,
  label,
  tone = 'neutral'
}: {
  field: 'globalAllowedTools' | 'globalDisallowedTools'
  values: string[]
  onChange(next: string[]): void
  placeholder: string
  label: string
  tone?: 'neutral' | 'danger'
}): ReactElement {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = useCallback(() => {
    const value = draft.trim().replace(/,+$/, '').trim()
    if (value.length === 0) {
      setDraft('')
      setError(null)
      return
    }
    if (values.includes(value)) {
      setDraft('')
      setError(null)
      return
    }
    const problem = validatePattern(field, value)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setDraft('')
    onChange([...values, value])
  }, [draft, field, onChange, values])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit()
      return
    }
    // Backspace on an empty field removes the last chip — the behaviour every
    // token input has, and the only way to do this without reaching for a mouse.
    if (event.key === 'Backspace' && draft.length === 0 && values.length > 0) {
      event.preventDefault()
      onChange(values.slice(0, -1))
    }
  }

  const chipColor = tone === 'danger' ? 'var(--fg-danger)' : 'var(--fg-primary)'

  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div
        className="flex flex-wrap items-center"
        style={{
          gap: 4,
          minHeight: 36,
          padding: 5,
          background: 'var(--input-bg)',
          border: `1px solid ${error ? 'var(--fg-danger)' : 'var(--input-border)'}`,
          borderRadius: 'var(--r-4)'
        }}
      >
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-[4px]"
            style={{
              height: 22,
              padding: '0 2px 0 8px',
              background: 'var(--chip-bg)',
              border: '1px solid var(--border-1)',
              borderRadius: 'var(--r-chip)',
              color: chipColor,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)'
            }}
          >
            <span className="selectable">{value}</span>
            <IconButton
              label={`Remove ${value}`}
              size={16}
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              <X size={11} strokeWidth={2} />
            </IconButton>
          </span>
        ))}
        <input
          value={draft}
          aria-label={label}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) => {
            setDraft(e.currentTarget.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          className="selectable min-w-[120px] flex-1 bg-transparent text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]"
          style={{
            height: 24,
            padding: '0 4px',
            fontSize: 'var(--fs-meta)',
            caretColor: 'var(--accent)'
          }}
        />
      </div>
      {error ? (
        <p className="text-[var(--fg-danger)]" style={{ fontSize: 'var(--fs-micro)' }}>
          {error}
        </p>
      ) : (
        <p className="text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
          {values.length === 0
            ? 'Nothing set. Type a pattern and press Enter.'
            : `${values.length} ${values.length === 1 ? 'pattern' : 'patterns'} · Enter adds, Backspace removes the last`}
        </p>
      )}
    </div>
  )
}

function Mono({ children }: { children: ReactNode }): ReactElement {
  return (
    <code
      className="selectable"
      style={{
        padding: '1px 5px',
        background: 'var(--chip-bg)',
        borderRadius: 'var(--r-2)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-micro)'
      }}
    >
      {children}
    </code>
  )
}
