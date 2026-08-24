/// <reference types="vite/client" />

/**
 * The renderer's view of the preload bridge.
 *
 * `src/preload/index.d.ts` declares the same global; interface merging makes the
 * two identical declarations collapse into one. This file exists so the renderer
 * type-checks even if the preload package is ever compiled separately.
 */
import type { BotApi } from '@shared/types/api'

declare global {
  interface Window {
    botApp: BotApi
  }
}

export {}
