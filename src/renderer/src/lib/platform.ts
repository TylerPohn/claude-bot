/**
 * Platform facts the chrome needs synchronously.
 *
 * The macOS title bar is `hiddenInset`, so the sidebar's top strip has to
 * reserve 80px on the left for the traffic lights — but ONLY on macOS, where
 * they exist. `window.botApp.system.appInfo()` is the authority; it is async, and
 * the first paint cannot wait for it, so we seed from the Electron user-agent
 * (which always carries "Macintosh" on darwin) and refine once the IPC answers.
 */

interface PlatformInfo {
  isMac: boolean
  platform: string
  version: string
}

function guess(): PlatformInfo {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Macintosh|Mac OS X/i.test(ua)) return { isMac: true, platform: 'darwin', version: '' }
  if (/Windows/i.test(ua)) return { isMac: false, platform: 'win32', version: '' }
  return { isMac: false, platform: 'linux', version: '' }
}

/** Mutable module singleton — read it, never hold a copy across renders. */
export const platform: PlatformInfo = guess()

export function isMac(): boolean {
  return platform.isMac
}

/** Called once from App.tsx with the authoritative answer from main. */
export function applyPlatform(info: { version: string; platform: string; isMac: boolean }): void {
  platform.isMac = info.isMac
  platform.platform = info.platform
  platform.version = info.version
  document.documentElement.dataset.platform = info.platform
}

/** ⌘ on macOS, Ctrl everywhere else. Used by Kbd chips and hotkey hints. */
export function modLabel(): string {
  return platform.isMac ? '⌘' : 'Ctrl'
}

/**
 * Left padding for any strip that runs along the top of the window on the left
 * edge. 20px traffic-light origin + 3 × 14px buttons + gaps ≈ 80px.
 */
export function titleBarInsetLeft(): number {
  return platform.isMac ? 80 : 12
}

/** Read once in JS — CSS alone cannot reach a JS-driven scroll spring. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
