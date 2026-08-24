/**
 * The main window plus the process-wide web-content security policy.
 *
 * Security posture (PRD 38): the renderer is a sandboxed document that can only
 * talk to the OS through the preload bridge. Concretely that means:
 *   - contextIsolation on, nodeIntegration off, webviewTag off, sandbox ON;
 *   - the sandbox costs us nothing: a sandboxed preload may still require
 *     `electron` for `contextBridge` and `ipcRenderer`, which is all this one
 *     uses. The single real constraint is that the preload bundle must be
 *     CommonJS, which `electron.vite.config.ts` already pins. (It shipped with
 *     `sandbox: false` and a comment claiming the preload needed it - untrue,
 *     and it left the process that renders model output running without the OS
 *     sandbox. Do not turn it off again without measuring what actually breaks.)
 *   - every in-page navigation and every `window.open` is denied; links leave the
 *     app only through `shell.openExternal`, and only for http/https/mailto;
 *   - the renderer document is served from a private `app://` origin, so the
 *     CSP below means what it says (see "The renderer's own origin" for the
 *     measured reason a `file://` document did not);
 *   - a Content-Security-Policy is stamped onto renderer responses;
 *   - every web permission except clipboard writes is refused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

import { BrowserWindow, app, protocol, screen, session, shell } from 'electron'

import { log } from '@main/lib/logger'
import { userDataDir } from '@main/lib/paths'

const DEFAULT_BOUNDS = { width: 1180, height: 820 } as const
const MIN_BOUNDS = { width: 900, height: 640 } as const

/** Window geometry is chrome state, not user settings, so it lives beside the db. */
const WINDOW_STATE_FILE = 'window-state.json'
const SAVE_DEBOUNCE_MS = 400

interface WindowState {
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

let mainWindow: BrowserWindow | null = null
let saveTimer: NodeJS.Timeout | null = null

/** Schemes we are willing to hand to the OS. Everything else is dropped. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** The only web permission the renderer is granted. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/* ------------------------------------------------------------------ *
 * The renderer's own origin
 * ------------------------------------------------------------------ */

const RENDERER_SCHEME = 'app'
const RENDERER_HOST = 'bundle'
const RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`

/**
 * The production renderer is served from `app://bundle/`, not from `file://`.
 *
 * This is what makes the CSP below true. `'self'` resolves against the
 * document's origin, and for a `file://` document Chromium resolves it to file:
 * URLs GENERALLY — not to the directory the document came from. Measured in the
 * shipped build, with BOTH this header and the <meta> tag enforcing
 * `default-src 'self'`: `fetch('file:///etc/hosts')` returned the file,
 * `fetch('file:///Users/<me>/.claude.json')` returned 181KB including the OAuth
 * account, `fetch('/../../../../etc/hosts')` climbed out of the bundle, and a
 * `<script src="file:///tmp/evil.js">` from outside the bundle LOADED AND RAN —
 * all with zero `securitypolicyviolation` events, while an inline script and a
 * remote fetch were correctly blocked. The policy was live; `'self'` just meant
 * "every file on this machine". A custom standard scheme gives the document a
 * real origin, so `'self'` is this bundle and nothing else.
 *
 * What that closes: local file reads and out-of-bundle script loads from the
 * renderer, i.e. the "read anything and ship it" half of any future XSS. What it
 * does NOT close: the preload bridge's own surface, and `system:openExternal`,
 * which still hands any http(s) URL (query string included) to the browser.
 *
 * `registerSchemesAsPrivileged` must run before `app.whenReady()`, which is why
 * this is a module-level side effect: `src/main/index.ts` imports this file at
 * the top, long before it calls `whenReady()`. `standard` is what gives the
 * scheme a real origin at all; `secure` keeps the document a secure context
 * (crypto.subtle, and no mixed-content downgrade of the policy).
 *
 * One user-visible cost, accepted knowingly: storage is keyed by origin, so the
 * move from `file://` retires whatever `uiStore` had persisted (sidebar width,
 * collapsed sections, unsent drafts). That store is explicitly "transient UI
 * state" and degrades to defaults, so the price is one reset, once.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

/** Extensions the bundle actually contains, plus the obvious neighbours. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

function rendererRoot(): string {
  return join(__dirname, '../renderer')
}

/**
 * Serve one file out of `out/renderer`, and nothing else.
 *
 * The containment check is not decoration. `standard: true` makes Chromium
 * canonicalise literal `..` segments before we ever see them, but a
 * percent-encoded `%2e%2e` arrives here decoded, so an explicit prefix test is
 * the only thing that keeps this handler from becoming the file: origin again by
 * another name.
 *
 * The CSP is set on the response as well as by `onHeadersReceived`: webRequest is
 * not guaranteed to run for a `protocol.handle` response, and a header that
 * silently stopped being applied would leave the <meta> tag as the only policy.
 */
async function serveRendererAsset(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.host !== RENDERER_HOST) return new Response('Not found', { status: 404 })

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (pathname === '' || pathname === '/') pathname = '/index.html'

  const root = rendererRoot()
  const target = normalize(join(root, pathname))
  if (target !== root && !target.startsWith(root + sep)) {
    log.warn('window', 'refused an app:// request that pointed outside the bundle', { pathname })
    return new Response('Forbidden', { status: 403 })
  }

  try {
    const body = await readFile(target)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': contentSecurityPolicy(),
        'x-content-type-options': 'nosniff',
        // The bundle is versioned by filename; the shell itself must not be
        // served from a stale cache after an update.
        'cache-control': 'no-cache'
      }
    })
  } catch (err) {
    log.warn('window', `no bundled asset at ${pathname}`, err)
    return new Response('Not found', { status: 404 })
  }
}

/** electron-vite sets this only in `electron-vite dev`; its absence means "load the build". */
function devRendererUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  return url && url.length > 0 ? url : null
}

/**
 * electron-vite names the preload bundle after the OUTPUT FORMAT it picked, and
 * that depends on whether package.json declares `type: module`: an ESM build
 * emits `index.mjs`, a CommonJS build emits `index.cjs` (measured — this project
 * currently produces `index.cjs`). Probing keeps the window working across that
 * switch instead of silently loading nothing, which manifests as a renderer with
 * no `window.botApp` at all.
 */
function preloadScriptPath(): string {
  const directory = join(__dirname, '../preload')
  // `.cjs` first, deliberately: an ESM preload cannot load under `sandbox: true`,
  // so a stale `index.mjs` left in `out/preload` by an older build would win the
  // probe and yield a renderer with no `window.botApp` at all.
  for (const name of ['index.cjs', 'index.js', 'index.mjs']) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  log.error('window', `no preload bundle found in ${directory}`)
  return join(directory, 'index.cjs')
}

function windowStatePath(): string {
  return join(userDataDir(), WINDOW_STATE_FILE)
}

function readWindowState(): WindowState | null {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>
    if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return null
    return {
      x: typeof raw.x === 'number' ? raw.x : null,
      y: typeof raw.y === 'number' ? raw.y : null,
      width: Math.max(MIN_BOUNDS.width, Math.round(raw.width)),
      height: Math.max(MIN_BOUNDS.height, Math.round(raw.height)),
      maximized: raw.maximized === true
    }
  } catch {
    // First launch, or a corrupt file: fall back to defaults rather than failing boot.
    return null
  }
}

/**
 * A saved position is only usable if it still lands on a connected display —
 * otherwise unplugging an external monitor hides the window off-screen forever.
 */
function isOnSomeDisplay(state: WindowState): boolean {
  if (state.x === null || state.y === null) return false
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      state.x !== null &&
      state.y !== null &&
      state.x + state.width > area.x + 40 &&
      state.y + state.height > area.y + 40 &&
      state.x < area.x + area.width - 40 &&
      state.y < area.y + area.height - 40
    )
  })
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // `getNormalBounds` reports the restored geometry even while maximized.
  const bounds = win.getNormalBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized()
  }
  try {
    writeFileSync(windowStatePath(), JSON.stringify(state), 'utf8')
  } catch (err) {
    log.warn('window', 'could not persist window bounds', err)
  }
}

function scheduleSave(win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistWindowState(win)
  }, SAVE_DEBOUNCE_MS)
}

function contentSecurityPolicy(): string {
  const dev = devRendererUrl()
  if (dev) {
    // Vite's dev server serves modules over http and pushes HMR over a websocket,
    // and React Fast Refresh needs eval. This relaxation exists ONLY in dev.
    const origin = new URL(dev).origin
    const ws = origin.replace(/^http/, 'ws')
    return [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      `img-src 'self' data: blob: ${origin}`,
      `font-src 'self' data: ${origin}`,
      `connect-src 'self' ${origin} ${ws}`,
      `media-src 'self' data: blob:`,
      `worker-src 'self' blob:`,
      `object-src 'none'`,
      `base-uri 'none'`,
      `form-action 'none'`,
      `frame-src 'none'`
    ].join('; ')
  }
  // Production: no remote origins at all — this app has no backend by design.
  // 'unsafe-inline' for styles is required because React writes inline style
  // attributes (accent color variables); it does not permit inline <script>.
  //
  // Keep this list identical to the <meta> policy in src/renderer/index.html.
  // Both are enforced and the browser takes the INTERSECTION, so a directive
  // present in only one of them silently narrows the other — which is how
  // `wasm-unsafe-eval` sat here for a release doing nothing (the meta's
  // `script-src 'self'` cancelled it, and the highlighter uses the JS regex
  // engine and loads no WASM anyway).
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `media-src 'self' data: blob:`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-src 'none'`
  ].join('; ')
}

function openExternalIfSafe(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) {
    log.warn('window', `blocked external open for scheme ${parsed.protocol}`)
    return
  }
  void shell.openExternal(parsed.toString())
}

/**
 * Process-wide hardening. Call once, after `app.whenReady()` and before the first
 * window is created, so the CSP is in place for the very first document load.
 */
export function installSecurityHandlers(): void {
  const ses = session.defaultSession

  // Must be live before the first window loads `app://bundle/index.html`.
  try {
    protocol.handle(RENDERER_SCHEME, serveRendererAsset)
  } catch (err) {
    // Only reachable if this ran twice; the first registration is the live one.
    log.warn('window', `could not register the ${RENDERER_SCHEME}: protocol`, err)
  }

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    // Drop any pre-existing header so ours is the only policy in effect.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key]
    }
    headers['Content-Security-Policy'] = [contentSecurityPolicy()]
    callback({ responseHeaders: headers })
  })

  // The renderer needs no device permission. Clipboard writes are the one
  // exception: the UI copies code blocks and diagnostics with `navigator.clipboard`.
  ses.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  )
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfSafe(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      const current = contents.getURL()
      // Vite's HMR client can legitimately reload the dev URL; anything else that
      // tries to navigate the shell away from the app is a bug or an attack.
      if (url === current) return
      const dev = devRendererUrl()
      if (dev && url.startsWith(dev)) return
      event.preventDefault()
      openExternalIfSafe(url)
    })

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })
}

export function createWindow(): BrowserWindow {
  const saved = readWindowState()
  const usePosition = saved !== null && isOnSomeDisplay(saved)

  const win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_BOUNDS.width,
    height: saved?.height ?? DEFAULT_BOUNDS.height,
    ...(usePosition && saved ? { x: saved.x ?? undefined, y: saved.y ?? undefined } : {}),
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: false,
    backgroundColor: '#0A0A0B',
    titleBarStyle: 'hiddenInset',
    // Optically centred in the 56px header (--header-h), where the sidebar
    // search pill and the chat header's identity pill both centre at y=28.
    //
    // The derivation is NOT (headerHeight - 14) / 2, which is what DESIGN.md
    // still says: `y` positions the top of the 16px-tall NSWindow button FRAME,
    // and the visible light is a 12px circle inset 2px inside it, so the optical
    // centre is y + 8. Centring in a header of height H therefore needs
    // y = (H - 16) / 2 → 20 for H = 56. (Measured on real macOS chrome at
    // y = 18, 20 and 21; centre = y + 8 in all three.) 18 read 2px high.
    trafficLightPosition: { x: 20, y: 20 },
    title: 'Claude Bot',
    webPreferences: {
      // `__dirname` is native in the CommonJS output and shimmed by electron-vite
      // in the ESM output, so it is correct either way.
      preload: preloadScriptPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true
    }
  })

  if (saved?.maximized) win.maximize()

  // Avoid the white flash: reveal only once the renderer has painted.
  win.once('ready-to-show', () => win.show())

  win.on('resize', () => scheduleSave(win))
  win.on('move', () => scheduleSave(win))
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistWindowState(win)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const dev = devRendererUrl()
  if (dev) {
    void win.loadURL(dev)
  } else {
    // NOT `loadFile`: that gives the document the file:// origin, which is what
    // made `'self'` meaningless (see `registerSchemesAsPrivileged` above). The
    // built index.html references its assets relatively, so they resolve under
    // app://bundle/ without any change to the renderer.
    void win.loadURL(RENDERER_URL)
  }

  mainWindow = win
  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/** Bring the existing window forward (second-instance, dock click, notification). */
export function focusMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
