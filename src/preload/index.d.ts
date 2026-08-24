/**
 * Ambient declaration for the renderer: `window.botApp` is the full `BotApi`.
 * `tsconfig.web.json` includes this file so the renderer type-checks against the
 * same contract the preload implements.
 */
import type { BotApi } from '@shared/types/api'

declare global {
  interface Window {
    botApp: BotApi
  }
}

export {}
