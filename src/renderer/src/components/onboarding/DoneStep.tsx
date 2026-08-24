import type { ReactElement } from 'react'
import { AtSign, Users } from 'lucide-react'

import type { Bot } from '@shared/types'
import { BotAvatar } from '@/components/ui/BotAvatar'

/**
 * Screen 5 (PRD §35). Two lines, not a manual: the only two things that are not
 * self-evident from a chat window are what `@` does and what a group is. The
 * footer button drops the user into the new Bot's chat.
 */
export function DoneStep({ bot }: { bot: Bot | null }): ReactElement {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative" style={{ marginBottom: 24 }}>
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            width: 220,
            height: 220,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background:
              'radial-gradient(closest-side, color-mix(in srgb, var(--brand-hero) 18%, transparent), transparent)'
          }}
        />
        <span className="relative block">
          {bot ? (
            <BotAvatar bot={bot} size={88} />
          ) : (
            <BotAvatar
              name="Claude Bot"
              avatarType="shape"
              avatarValue="squircle"
              accent="violet"
              size={88}
            />
          )}
        </span>
      </div>

      <h1
        style={{
          fontSize: 'var(--fs-hero)',
          lineHeight: 'var(--lh-hero)',
          letterSpacing: 'var(--ls-hero)',
          fontWeight: 550,
          color: 'var(--fg-primary)',
          maxWidth: 480
        }}
      >
        {bot ? `${bot.name} is ready.` : 'You’re set up.'}
      </h1>

      <p
        className="mt-[10px]"
        style={{
          maxWidth: 440,
          fontSize: 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          color: 'var(--fg-secondary)'
        }}
      >
        {bot
          ? 'Describe the outcome you want and let it work. You can stop a run at any time.'
          : 'Create a Bot from the + button in the sidebar whenever you are ready.'}
      </p>

      <ul className="mt-[28px] flex w-full flex-col text-left" style={{ gap: 12, maxWidth: 460 }}>
        <Line
          icon={<AtSign size={16} strokeWidth={1.75} />}
          text={
            <>
              <strong style={{ fontWeight: 550, color: 'var(--fg-primary)' }}>@mention</strong> a Bot
              to hand it the next step — in a one-to-one chat you never need to, the Bot is already
              listening.
            </>
          }
        />
        <Line
          icon={<Users size={16} strokeWidth={1.75} />}
          text={
            <>
              <strong style={{ fontWeight: 550, color: 'var(--fg-primary)' }}>Groups</strong> put
              several Bots and you in one thread; each keeps its own Claude Code session, and
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-code)' }}>
                {' '}
                @everyone{' '}
              </span>
              asks them all at once.
            </>
          }
        />
      </ul>
    </div>
  )
}

function Line({
  icon,
  text
}: {
  icon: ReactElement
  text: ReactElement
}): ReactElement {
  return (
    <li className="flex items-start" style={{ gap: 12 }}>
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
        {icon}
      </span>
      <span
        style={{
          paddingTop: 5,
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          letterSpacing: 'var(--ls-meta)',
          color: 'var(--fg-secondary)'
        }}
      >
        {text}
      </span>
    </li>
  )
}
