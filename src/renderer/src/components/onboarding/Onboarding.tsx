import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import type { RuntimeStatus } from '@shared/types'
import { titleBarInsetLeft } from '@/lib/platform'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Toaster } from '@/components/ui/Toaster'

import { WelcomeStep } from './WelcomeStep'
import { DetectStep } from './DetectStep'
import { AuthStep } from './AuthStep'
import { FirstBotStep } from './FirstBotStep'
import { DoneStep } from './DoneStep'

/**
 * First run (PRD §35). A full-window flow, not a modal: there is nothing behind
 * it worth showing yet, and a scrim over an empty app would be pretending
 * otherwise. Five screens, a real back/next, and a Skip that still marks
 * onboarding complete so it never comes back uninvited.
 */

const STEPS = ['Welcome', 'Claude Code', 'Sign-in', 'First Bot', 'Ready'] as const

/**
 * A step can take the footer's primary action over from the shell.
 *
 * Only the First Bot step does, and it has to: its forward action is "create
 * this Bot", which only that screen knows how to run or when it is allowed. It
 * used to render its own "Create {name}" button at the bottom of a form that
 * scrolls — measured 138px below the fold on arrival in the shipped 1180×820
 * window — while the footer Continue the user had pressed on the three screens
 * before this one sat permanently disabled with no explanation. The forward
 * action belongs in the one place that is always on screen.
 */
export interface StepPrimaryAction {
  label: string
  disabled?: boolean
  loading?: boolean
  /** Why the action is blocked, shown as quiet copy beside the button. */
  reason?: string | null
  run(): void
}

/** While Claude Code is missing, re-probe on a slow loop so installing it in
 *  another window resolves this screen without the user touching anything. */
const POLL_MS = 4000
/** Each probe spawns a real subprocess. Stop after ~4 minutes of nobody acting;
 *  the Recheck button is right there, and an unbounded background loop is not. */
const MAX_POLLS = 60

export function Onboarding({ onDone }: { onDone: () => void }): ReactElement {
  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)
  const [checking, setChecking] = useState(false)
  const [pollExhausted, setPollExhausted] = useState(false)
  const [createdBotId, setCreatedBotId] = useState<string | null>(null)
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null)
  const [stepAction, setStepAction] = useState<StepPrimaryAction | null>(null)
  const nextRef = useRef<HTMLButtonElement>(null)

  const runtime = useAppStore((s) => s.runtime)
  const createdBot = useAppStore((s) => (createdBotId ? s.bots[createdBotId] : undefined))

  /* `recheckRuntime` flips the store to `checking` for the duration of the probe.
     With a 4s poll that would strobe the verdict card and the Continue button, so
     the last RESOLVED status is what these screens render; the in-flight probe is
     shown by its own indicator instead. */
  const [resolved, setResolved] = useState<RuntimeStatus | null>(null)
  useEffect(() => {
    if (runtime && runtime.availability !== 'checking') setResolved(runtime)
  }, [runtime])

  const status = runtime?.availability === 'checking' ? resolved : runtime
  const availability = status?.availability ?? 'checking'
  const runtimeFound = availability === 'ok' || availability === 'unauthenticated'

  const goTo = useCallback((next: number) => {
    setStep(next)
    setFurthest((seen) => Math.max(seen, next))
  }, [])

  /* ---- runtime probes ------------------------------------------------ */

  const recheck = useCallback(async () => {
    setChecking(true)
    // The user is engaged again, so re-arm the automatic loop.
    setPollExhausted(false)
    try {
      await useAppStore.getState().recheckRuntime()
    } finally {
      setChecking(false)
    }
  }, [])

  const pickExecutable = useCallback(() => {
    void withToast(
      async () => {
        const picked = await bridge().runtime.pickExecutable()
        if (picked.path) await useAppStore.getState().recheckRuntime()
        return picked
      },
      { errorTitle: 'Could not use that executable' }
    )
  }, [])

  const openLoginTerminal = useCallback(() => {
    void withToast(() => bridge().runtime.openLoginTerminal(), {
      errorTitle: 'Could not open a terminal'
    })
  }, [])

  // Changing screens is the user re-engaging, so the loop starts fresh there too.
  useEffect(() => {
    setPollExhausted(false)
  }, [step])

  // Poll only on the two screens that are actually waiting on an answer, and
  // only while the answer is still "no" — this spawns a real subprocess.
  const shouldPoll = (step === 1 || step === 2) && availability !== 'ok' && !pollExhausted
  useEffect(() => {
    if (!shouldPoll) return
    let inFlight = false
    let polls = 0
    const timer = window.setInterval(() => {
      // Nothing has changed while the window is hidden, and a background app
      // spawning a CLI probe every four seconds is not acceptable behaviour.
      if (inFlight || document.visibilityState !== 'visible') return
      polls += 1
      if (polls > MAX_POLLS) {
        window.clearInterval(timer)
        setPollExhausted(true)
        return
      }
      inFlight = true
      void useAppStore
        .getState()
        .recheckRuntime()
        .finally(() => {
          inFlight = false
        })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [shouldPoll])

  /* ---- flow ---------------------------------------------------------- */

  const onCreated = useCallback(
    (botId: string, conversationId: string) => {
      setCreatedBotId(botId)
      setCreatedConversationId(conversationId)
      goTo(4)
    },
    [goTo]
  )

  const finish = useCallback(() => {
    if (createdConversationId) {
      // Screen 5 drops the user straight into the new Bot's chat (PRD §35).
      useUiStore.getState().setActive(createdConversationId)
      void useAppStore.getState().loadMessages(createdConversationId)
    }
    onDone()
  }, [createdConversationId, onDone])

  /* The step that publishes an action owns the footer button entirely — label,
     enabled state and click. Steps that publish nothing keep the shell's own
     Continue. `step === 3` deliberately has NO clause here any more: the First
     Bot step used to disable Continue outright, which left that screen with no
     working control in the footer at all. */
  const stepOwnsFooter = step === 3 && stepAction !== null
  const nextDisabled = stepOwnsFooter ? Boolean(stepAction?.disabled) : step === 1 && !runtimeFound

  /* A published action can be replaced while the step is open (the label tracks
     the Bot's name as it is typed), so clear it on the way OUT of the step
     rather than trusting the child's unmount ordering. */
  useEffect(() => {
    return () => setStepAction(null)
  }, [step])

  /* Put initial focus on the primary action, on every screen.
     Without this the flow opens with focus on <body>, so the very first Tab
     lands on "Skip setup" — a single keystroke that persists
     `onboardingCompleted` and cannot be undone from anywhere in the app — and
     the instinctive Tab-then-Enter destroys the setup flow outright.
     This cannot use the `[data-autofocus]` convention: that attribute is read
     only by Modal's `useFocusTrap`, and onboarding is deliberately a full-window
     flow with no Modal in it, so the attribute alone would be inert.
     A disabled CTA is left alone, which is what keeps the First Bot step's own
     autofocused name field from being stolen. */
  useEffect(() => {
    // A frame late: the step body mounts in the same commit, and on the First
    // Bot step its `autoFocus` input would otherwise win the race either way.
    const frame = requestAnimationFrame(() => {
      const button = nextRef.current
      if (button && !button.disabled) button.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [step])

  const nextLabel = stepOwnsFooter
    ? (stepAction?.label ?? 'Continue')
    : step === 0
      ? 'Get started'
      : step === STEPS.length - 1
        ? 'Start chatting'
        : 'Continue'

  const onNext = useCallback(() => {
    if (stepOwnsFooter) stepAction?.run()
    else if (step === STEPS.length - 1) finish()
    else goTo(step + 1)
  }, [finish, goTo, step, stepAction, stepOwnsFooter])

  const body = useMemo(() => {
    switch (step) {
      case 0:
        return <WelcomeStep />
      case 1:
        return (
          <DetectStep
            status={status}
            checking={checking}
            watching={shouldPoll}
            onRecheck={() => void recheck()}
            onPickExecutable={pickExecutable}
          />
        )
      case 2:
        return (
          <AuthStep
            status={status}
            checking={checking}
            watching={shouldPoll}
            onRecheck={() => void recheck()}
            onOpenTerminal={openLoginTerminal}
            onBack={() => goTo(1)}
          />
        )
      case 3:
        return (
          <FirstBotStep
            createdBotId={createdBotId}
            onCreated={onCreated}
            onSkip={() => goTo(4)}
            onPrimaryAction={setStepAction}
          />
        )
      default:
        return <DoneStep bot={createdBot ?? null} />
    }
  }, [
    step,
    status,
    checking,
    shouldPoll,
    recheck,
    pickExecutable,
    openLoginTerminal,
    createdBotId,
    createdBot,
    onCreated,
    goTo
  ])

  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-app)' }}>
      {/* The window's own drag strip. Every control inside it is `no-drag`,
          because a drag region swallows all pointer events beneath it. */}
      <header
        className="drag flex shrink-0 items-center justify-between"
        style={{ height: 'var(--header-h)', padding: `0 12px 0 ${titleBarInsetLeft()}px` }}
      >
        <span className="flex items-center gap-[8px]">
          <BotAvatar name="Claude Bot" avatarValue="squircle" accent="violet" size={20} />
          <span
            style={{
              fontSize: 'var(--fs-micro)',
              letterSpacing: 'var(--ls-micro)',
              fontWeight: 510,
              color: 'var(--fg-tertiary)'
            }}
          >
            Claude Bot
          </span>
        </span>
        <Button variant="ghost" size="sm" className="no-drag" onClick={onDone}>
          Skip setup
        </Button>
      </header>

      <main className="scroller flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* `m-auto` in a column flex container centres short steps vertically and
            lets tall ones scroll from the top instead of clipping. */}
        <div
          key={step}
          className="m-auto w-full"
          style={{
            maxWidth: 640,
            padding: '28px 24px 36px',
            animation: 'slide-up-in var(--dur-slow) var(--ease-out-quart)'
          }}
        >
          {body}
        </div>
      </main>

      <footer
        className="flex shrink-0 items-center"
        style={{ height: 76, padding: '0 24px', borderTop: '1px solid var(--border-1)' }}
      >
        <div className="flex flex-1 justify-start">
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => goTo(step - 1)}
              leading={<ArrowLeft size={16} strokeWidth={1.75} />}
              style={{ height: 44, borderRadius: 22, paddingInline: 18, fontSize: 'var(--fs-ui)' }}
            >
              Back
            </Button>
          ) : null}
        </div>

        <ol className="flex items-center" aria-label="Setup progress">
          {STEPS.map((label, index) => {
            const reachable = index <= furthest
            const current = index === step
            return (
              <li key={label}>
                <button
                  type="button"
                  disabled={!reachable}
                  /* Progress, not navigation: Back and Continue already do this
                     job, so the dots must not sit between the two real actions
                     in the tab order. Still clickable, still announced. */
                  tabIndex={-1}
                  aria-current={current ? 'step' : undefined}
                  aria-label={`Step ${index + 1} of ${STEPS.length}: ${label}`}
                  onClick={() => reachable && setStep(index)}
                  className="grid place-items-center disabled:cursor-default"
                  style={{ width: 20, height: 24 }}
                >
                  <span
                    aria-hidden
                    className="block transition-[background-color,width] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
                    style={{
                      width: current ? 16 : 6,
                      height: 6,
                      borderRadius: 'var(--r-full)',
                      background: current
                        ? 'var(--fg-primary)'
                        : reachable
                          ? 'var(--fg-tertiary)'
                          : 'var(--fg-quaternary)'
                    }}
                  />
                </button>
              </li>
            )
          })}
        </ol>

        <div className="flex flex-1 items-center justify-end gap-[12px]">
          {/* Why the button is disabled, in the one place the user is looking
              when they wonder. A disabled Button carries `pointer-events-none`,
              so a tooltip or a `title` on it can never fire — the reason has to
              be plain copy next to it. */}
          {nextDisabled && stepAction?.reason ? (
            <p
              className="text-right text-[var(--fg-tertiary)]"
              style={{ maxWidth: 260, fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
            >
              {stepAction.reason}
            </p>
          ) : null}
          <Button
            ref={nextRef}
            variant="filled"
            disabled={nextDisabled}
            loading={stepAction?.loading ?? false}
            onClick={onNext}
            // The arrow means "next screen". A step that owns the footer runs
            // its own action instead, so it would be promising the wrong thing.
            trailing={stepOwnsFooter ? undefined : <ArrowRight size={16} strokeWidth={1.75} />}
            style={{
              height: 44,
              borderRadius: 22,
              minWidth: 168,
              paddingInline: 22,
              fontSize: 'var(--fs-ui)'
            }}
          >
            {nextLabel}
          </Button>
        </div>
      </footer>

      {/* Onboarding replaces the whole app, so it has to carry its own toast
          layer — every IPC failure in here reports through `withToast`. */}
      <Toaster />
    </div>
  )
}
