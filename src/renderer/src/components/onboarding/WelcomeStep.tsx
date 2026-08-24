import type { ReactElement, ReactNode } from 'react'
import { KeyRound, Laptop, Terminal } from 'lucide-react'

import type { BotAccent, BotShape } from '@shared/types'
import { BotAvatar } from '@/components/ui/BotAvatar'

/**
 * Screen 1. The hero is a cluster of real `BotAvatar`s rather than an icon: the
 * blob avatars are the product's signature, and five of them in different shapes
 * and colours says "a team" in a way no illustration would.
 */
const HERO: Array<{ name: string; shape: BotShape; accent: BotAccent; size: number; dy: number }> = [
  { name: 'Researcher', shape: 'arch', accent: 'cyan', size: 46, dy: 16 },
  { name: 'Reviewer', shape: 'hexagon', accent: 'blue', size: 66, dy: 4 },
  { name: 'Builder', shape: 'squircle', accent: 'violet', size: 96, dy: -10 },
  { name: 'Debugger', shape: 'teardrop', accent: 'rose', size: 66, dy: 4 },
  { name: 'Test Engineer', shape: 'clover', accent: 'emerald', size: 46, dy: 16 }
]

const POINTS: Array<{ icon: ReactNode; title: string; body: string }> = [
  {
    icon: <Laptop size={16} strokeWidth={1.75} />,
    title: 'Local-first',
    body: 'Your Bots, their chats and every setting live on this computer, in a file you can open and back up.'
  },
  {
    icon: <Terminal size={16} strokeWidth={1.75} />,
    title: 'Uses your installed Claude Code',
    body: 'Every turn runs through the Claude Code you already have, under your existing subscription.'
  },
  {
    icon: <KeyRound size={16} strokeWidth={1.75} />,
    title: 'No separate API key',
    body: 'Nothing to paste, nothing extra to pay for — not now, and not later.'
  }
]

/** PRD §39, verbatim. Do not paraphrase: it is the app's privacy disclosure. */
const PRIVACY_DISCLOSURE =
  'Chats are stored by this app on your computer. When a Bot runs, the app invokes your installed Claude Code client, which sends model requests according to your Anthropic account and privacy settings.'

export function WelcomeStep(): ReactElement {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Decorative: the names are announced properly in the sidebar, and five
          avatar labels here would just be noise for a screen reader. */}
      <div
        aria-hidden
        className="relative flex items-end justify-center"
        style={{ height: 110, marginBottom: 28 }}
      >
        <span
          className="pointer-events-none absolute"
          style={{
            width: 320,
            height: 320,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background:
              'radial-gradient(closest-side, color-mix(in srgb, var(--brand-hero) 16%, transparent), transparent)'
          }}
        />
        {HERO.map((entry, index) => (
          <span
            key={entry.name}
            className="relative"
            style={{
              marginLeft: index === 0 ? 0 : -12,
              transform: `translateY(${entry.dy}px)`,
              zIndex: entry.size,
              animation: `slide-up-in var(--dur-slow) var(--ease-out-quart) ${index * 60}ms both`
            }}
          >
            <BotAvatar
              name={entry.name}
              avatarType="shape"
              avatarValue={entry.shape}
              accent={entry.accent}
              size={entry.size}
            />
          </span>
        ))}
      </div>

      <h1
        style={{
          fontSize: 'var(--fs-hero)',
          lineHeight: 'var(--lh-hero)',
          letterSpacing: 'var(--ls-hero)',
          fontWeight: 550,
          color: 'var(--fg-primary)',
          maxWidth: 520
        }}
      >
        Your Claude Code team, in a chat app.
      </h1>

      <p
        className="mt-[12px]"
        style={{
          maxWidth: 460,
          fontSize: 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          letterSpacing: 'var(--ls-ui)',
          color: 'var(--fg-secondary)'
        }}
      >
        Give each Bot a name, a job and a folder to work in. Then message them like teammates —
        one at a time, or several in a group.
      </p>

      <ul
        className="mt-[32px] flex w-full flex-col text-left"
        style={{ gap: 14, maxWidth: 480 }}
      >
        {POINTS.map((point) => (
          <li key={point.title} className="flex items-start" style={{ gap: 12 }}>
            <span
              aria-hidden
              className="grid shrink-0 place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 'var(--r-5)',
                background: 'var(--surface-2)',
                color: 'var(--fg-secondary)'
              }}
            >
              {point.icon}
            </span>
            <span className="flex min-w-0 flex-col" style={{ gap: 2, paddingTop: 3 }}>
              <span
                style={{
                  fontSize: 'var(--fs-label)',
                  lineHeight: 'var(--lh-label)',
                  letterSpacing: 'var(--ls-label)',
                  fontWeight: 550,
                  color: 'var(--fg-primary)'
                }}
              >
                {point.title}
              </span>
              <span
                style={{
                  fontSize: 'var(--fs-meta)',
                  lineHeight: 'var(--lh-meta)',
                  letterSpacing: 'var(--ls-meta)',
                  color: 'var(--fg-secondary)'
                }}
              >
                {point.body}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* Tertiary at --fs-meta, NOT quaternary at --fs-micro. This is the one
          legally meaningful sentence on the first screen the product ever
          shows, and it shipped as the least legible text on it: #636363 at 12px
          is 3.14:1, under the 4.5:1 AA floor that applies at this size, on a
          screen where every other line clears 7:1. Tertiary/meta measures
          5.12:1 dark and 5.61:1 light and still sits one visible step quieter
          than the feature blurbs above, so the box still reads as a footnote.
          Fix it here, never by retuning --fg-quaternary: that tier is the app's
          placeholder/separator grey (tokens.css forbids moving one step of the
          neutral ramp on its own). */}
      <p
        className="selectable mt-[28px] text-left"
        style={{
          maxWidth: 480,
          padding: '10px 12px',
          borderRadius: 'var(--r-4)',
          border: '1px solid var(--border-1)',
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          letterSpacing: 'var(--ls-meta)',
          color: 'var(--fg-tertiary)'
        }}
      >
        {PRIVACY_DISCLOSURE}
      </p>
    </div>
  )
}
