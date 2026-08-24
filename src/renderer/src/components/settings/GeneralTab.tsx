import { useCallback, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { CornerDownLeft, FolderOpen, Monitor, Moon, Sun, TriangleAlert } from 'lucide-react'

import type { AppSettings, Appearance } from '@shared/types'
import type { SettingsPatchInput } from '@shared/schemas'
import { cn } from '@/lib/cn'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { FONT_SCALE_MAX, FONT_SCALE_MIN } from './SettingsModal'
import {
  CopyField,
  Note,
  SettingRow,
  SettingsSection,
  SettingsSlider,
  useControlId,
  useSliderValue
} from './SettingRow'

const APPEARANCE_OPTIONS: Array<{
  value: Appearance
  label: string
  icon: typeof Monitor
}> = [
  // Copy is verbatim from DESIGN §3.8.
  { value: 'system', label: 'Follow System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
]

export function GeneralTab({ settings }: { settings: AppSettings }): ReactElement {
  const updateSettings = useAppStore((s) => s.updateSettings)

  const save = useCallback(
    (patch: SettingsPatchInput) => {
      void withToast(() => updateSettings(patch), { errorTitle: 'Could not save that setting' })
    },
    [updateSettings]
  )

  const concurrencyId = useControlId('concurrency')
  const fontScaleId = useControlId('font-scale')
  const sendKeyId = useControlId('send-key')

  const [concurrency, setConcurrency] = useSliderValue(
    settings.maxConcurrentBots,
    useCallback((n: number) => save({ maxConcurrentBots: n }), [save])
  )
  const [fontScale, setFontScale] = useSliderValue(
    settings.fontScale,
    useCallback((n: number) => save({ fontScale: n }), [save])
  )

  const [browsing, setBrowsing] = useState(false)
  const chooseWorkspace = useCallback(async () => {
    setBrowsing(true)
    try {
      const picked = await withToast(
        () => bridge().system.pickDirectory(settings.defaultWorkspace ?? undefined),
        { errorTitle: 'Could not open the folder picker' }
      )
      if (picked?.path) save({ defaultWorkspace: picked.path })
    } finally {
      setBrowsing(false)
    }
  }, [save, settings.defaultWorkspace])

  return (
    <>
      <SettingsSection title="Appearance">
        <SettingRow
          label="Theme"
          description="Applies immediately. Follow System switches with macOS or Windows."
        >
          <Segmented
            label="Theme"
            value={settings.appearance}
            options={APPEARANCE_OPTIONS}
            onChange={(value) => save({ appearance: value })}
          />
        </SettingRow>

        <SettingRow
          label="Text size"
          description="Scales every label and message in the app. Layout stays put."
          controlId={fontScaleId}
        >
          <SettingsSlider
            id={fontScaleId}
            label="Text size"
            value={fontScale}
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={0.05}
            onChange={setFontScale}
            valueLabel={`${Math.round(fontScale * 100)}%`}
            minLabel="85%"
            maxLabel="130%"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="At launch">
        <SettingRow
          label="Open Claude Bot at login"
          description="Starts the app in the background when you sign in to this computer."
          control={
            <Switch
              label="Open Claude Bot at login"
              checked={settings.launchAtLogin}
              onChange={(checked) => save({ launchAtLogin: checked })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingRow
          label="Show notifications"
          description="A Bot notifies you exactly twice: when it finishes, and when it needs your input."
          control={
            <Switch
              label="Show notifications"
              checked={settings.showNotifications}
              onChange={(checked) => save({ showNotifications: checked })}
            />
          }
        />
        <SettingRow
          label="Notify even when the conversation is open"
          description="Off by default — a notification for the chat already on your screen is noise. The sidebar dot and the dock badge still count everything you are not looking at."
          disabled={!settings.showNotifications}
          control={
            <Switch
              label="Notify even when the conversation is open"
              disabled={!settings.showNotifications}
              checked={settings.notifyOnFocusedConversation}
              onChange={(checked) => save({ notifyOnFocusedConversation: checked })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Workspace">
        <SettingRow
          label="Default workspace"
          description="Where a Bot runs when neither the conversation nor the Bot sets its own folder. Claude Code reads, edits and runs commands relative to this directory."
          control={
            <Button
              size="sm"
              loading={browsing}
              leading={<FolderOpen size={14} strokeWidth={1.75} />}
              onClick={() => void chooseWorkspace()}
            >
              Browse…
            </Button>
          }
          footnote={
            settings.defaultWorkspace ? (
              <div className="flex items-center gap-[8px]">
                <CopyField
                  value={settings.defaultWorkspace}
                  copyLabel="Copy default workspace path"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => save({ defaultWorkspace: null })}
                >
                  Clear
                </Button>
              </div>
            ) : (
              <Note tone="neutral">
                Nothing set — Bots fall back to your home folder, which is rarely what you want.
              </Note>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="Running Bots">
        <SettingRow
          label="Maximum concurrent Bots"
          description="Every Bot in this app runs through the one Claude Code install signed in to your account, so they all draw on the same subscription allowance. Running more at once does not get you more — it just spends the allowance faster and makes a usage limit more likely mid-task."
          controlId={concurrencyId}
          footnote={
            concurrency > 5 ? (
              <Note tone="warning" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
                Above 5 you are far more likely to hit your Claude usage limit part-way through a
                group turn. Your history stays safe, but the remaining Bots stop.
              </Note>
            ) : undefined
          }
        >
          <SettingsSlider
            id={concurrencyId}
            label="Maximum concurrent Bots"
            value={concurrency}
            min={1}
            max={12}
            onChange={setConcurrency}
            valueLabel={
              concurrency === 3
                ? '3 Bots · recommended'
                : `${concurrency} ${concurrency === 1 ? 'Bot' : 'Bots'}`
            }
            minLabel="1"
            maxLabel="12"
          />
        </SettingRow>

        <SettingRow
          label="Let one Bot run in several chats at once"
          description="Off by default. A Bot keeps a separate Claude session per conversation, so two simultaneous turns can edit the same files from two different plans — and the transcript gives you no hint which run did what. Leave this off unless you are deliberately fanning one Bot out."
          control={
            <Switch
              label="Let one Bot run in several chats at once"
              checked={settings.allowSameBotConcurrentConversations}
              onChange={(checked) => save({ allowSameBotConcurrentConversations: checked })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Composing">
        <SettingRow
          label="Send with"
          description="The other combination always inserts a newline."
          controlId={sendKeyId}
          control={
            <div style={{ width: 168 }}>
              <Select
                id={sendKeyId}
                value={settings.sendKey}
                options={[
                  { value: 'enter', label: 'Enter' },
                  { value: 'mod+enter', label: '⌘ / Ctrl + Enter' }
                ]}
                onChange={(e) =>
                  save({ sendKey: e.currentTarget.value === 'enter' ? 'enter' : 'mod+enter' })
                }
              />
            </div>
          }
          footnote={
            <p
              className="flex items-center gap-[6px] text-[var(--fg-quaternary)]"
              style={{ fontSize: 'var(--fs-micro)' }}
            >
              <CornerDownLeft size={13} strokeWidth={1.75} aria-hidden />
              {settings.sendKey === 'enter'
                ? 'Shift + Enter inserts a newline.'
                : 'Enter inserts a newline.'}
            </p>
          }
        />

        <SettingRow
          label="Show thinking"
          description="Reveals Claude's extended-thinking text above a reply while it streams. Useful when you are debugging a Bot's reasoning, noisy the rest of the time."
          control={
            <Switch
              label="Show thinking"
              checked={settings.showThinking}
              onChange={(checked) => save({ showThinking: checked })}
            />
          }
        />
      </SettingsSection>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Segmented control (DESIGN §3.8)
 * ------------------------------------------------------------------ */

interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon: typeof Monitor
}

/**
 * Height 32, radius 8, `--surface-2` track with a `--surface-3` thumb that
 * slides over `--dur-fast`. Implemented as a real radiogroup so ←/→ move
 * between options and a screen reader announces "2 of 3", which a row of
 * toggle buttons never does.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<SegmentedOption<T>>
  onChange(value: T): void
  label: string
}): ReactElement {
  const groupRef = useRef<HTMLDivElement>(null)
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  const move = (delta: number): void => {
    const next = options[(index + delta + options.length) % options.length]
    if (!next) return
    onChange(next.value)
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus()
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
      className="relative grid w-full"
      style={{
        height: 32,
        padding: 3,
        gridTemplateColumns: `repeat(${options.length}, 1fr)`,
        background: 'var(--surface-2)',
        borderRadius: 'var(--r-4)'
      }}
    >
      <span
        aria-hidden
        className="absolute"
        style={{
          top: 3,
          bottom: 3,
          left: 3,
          width: `calc((100% - 6px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
          background: 'var(--surface-3)',
          borderRadius: 'var(--r-3)',
          boxShadow: 'var(--shadow-low)',
          transition: 'transform var(--dur-fast) var(--ease-out-quad)'
        }}
      />
      {options.map((option) => {
        const selected = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative z-[1] inline-flex items-center justify-center gap-[6px] whitespace-nowrap',
              'transition-[color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
              selected
                ? 'text-[var(--fg-primary)]'
                : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
            )}
            style={{
              borderRadius: 'var(--r-3)',
              fontSize: 'var(--fs-meta)',
              letterSpacing: 'var(--ls-meta)',
              fontWeight: selected ? 550 : 510
            }}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
