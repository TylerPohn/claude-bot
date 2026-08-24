/**
 * The typed bridge between the renderer and the main process.
 *
 * The renderer never sees `ipcRenderer`. It gets `window.botApp` (the `BotApi`
 * contract in `@shared/types/api`) and nothing else.
 *
 * Two behaviours here are driven by MEASURED Electron 43 behaviour, not by docs:
 *
 * 1. ERROR TRANSPORT. Electron re-creates an Error when it crosses the ipc and
 *    contextBridge boundaries using ONLY its `message` — custom properties are
 *    dropped (verified). Main therefore serializes `{code, message, detail}` into
 *    the message between `__CCB_ERR__` / `__CCB_END__` markers, and this file
 *    parses them back out. Electron also prefixes the renderer-side message with
 *    `Error invoking remote method '<channel>': `, so we SEARCH for the markers
 *    instead of matching the start of the string. The mirrored format lives in
 *    `src/main/ipc/index.ts` — change both sides together.
 *
 * 2. REBUILDING THE ERROR IN THE MAIN WORLD. Because of (1), an Error thrown from
 *    a bridged function arrives in the renderer with `.code` stripped. To give the
 *    renderer a real `Error` carrying `.code`/`.detail`, the bridged API is
 *    rejected with a plain envelope object (plain objects ARE copied faithfully)
 *    and a tiny wrapper installed via `contextBridge.executeInMainWorld` converts
 *    each envelope into a real Error inside the renderer's own world. If that API
 *    is unavailable we fall back to `exposeInMainWorld`; the envelope still
 *    exposes `.message`, `.code`, `.detail` and stringifies correctly, it just is
 *    not an `instanceof Error`.
 *
 * 3. EVENTS. Exactly one `ipcRenderer.on(APP_EVENT_CHANNEL)` listener exists for
 *    the whole app; it fans out to per-event-name handler sets. Unsubscribing
 *    removes only that one handler.
 */
import { contextBridge, ipcRenderer } from 'electron'

import { APP_EVENT_CHANNEL, IPC_CHANNELS } from '@shared/types/api'
import type {
  BotApi,
  ContextMenuItem,
  ConversationSessionInfo,
  IpcChannel,
  MessagePage,
  PickDirectoryResult,
  PickFilesResult,
  SendMessageResult
} from '@shared/types/api'
import type { AppEventMap, AppEventName } from '@shared/types/events'
import type {
  AppSettings,
  Bot,
  DiagnosticsReport,
  Message,
  RuntimeStatus,
  SearchResult
} from '@shared/types'
import type {
  BotDraftInput,
  BotPatchInput,
  ConversationPatchInput,
  CreateGroupInput,
  GetMessagesInput,
  SearchInput,
  SendMessageInput,
  SettingsPatchInput
} from '@shared/schemas'

/* ------------------------------------------------------------------ *
 * Error transport (mirror of src/main/ipc/index.ts)
 * ------------------------------------------------------------------ */

const ERROR_ENVELOPE_RE = /__CCB_ERR__([\s\S]*?)__CCB_END__/

interface ErrorEnvelope {
  __ccbError: true
  name: string
  message: string
  code: string
  detail?: string
  toString(): string
}

function makeEnvelope(code: string, message: string, detail?: string): ErrorEnvelope {
  return {
    __ccbError: true,
    name: 'BotAppError',
    message,
    code,
    ...(detail === undefined ? {} : { detail }),
    // Kept so `String(err)` reads sensibly even in the fallback path where the
    // renderer receives this object instead of a real Error.
    toString(): string {
      return `BotAppError: ${message}`
    }
  }
}

function toEnvelope(err: unknown): ErrorEnvelope {
  const raw = err instanceof Error ? err.message : String(err)
  const match = ERROR_ENVELOPE_RE.exec(raw)
  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1]) as { code?: string; message?: string; detail?: string }
      return makeEnvelope(
        parsed.code ?? 'internal',
        parsed.message ?? 'Something went wrong.',
        parsed.detail
      )
    } catch {
      // Fall through to the generic envelope below.
    }
  }
  // An error that never reached our wrapper: a dropped channel, a crashed main
  // process, or a structured-clone failure on the payload.
  return makeEnvelope('internal', raw)
}

async function invoke<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T
  } catch (err) {
    throw toEnvelope(err)
  }
}

/* ------------------------------------------------------------------ *
 * Event fan-out — one ipcRenderer listener for the entire app
 * ------------------------------------------------------------------ */

type ErasedHandler = (payload: unknown) => void

const handlers = new Map<string, Set<ErasedHandler>>()
let listening = false

function ensureListener(): void {
  if (listening) return
  listening = true

  ipcRenderer.on(APP_EVENT_CHANNEL, (_event, message: unknown) => {
    if (!message || typeof message !== 'object') return
    const { type, payload } = message as { type?: unknown; payload?: unknown }
    if (typeof type !== 'string') return

    const set = handlers.get(type)
    if (!set || set.size === 0) return

    // Copy first: a handler is allowed to unsubscribe itself while dispatching.
    for (const handler of Array.from(set)) {
      try {
        handler(payload)
      } catch (err) {
        // One bad subscriber must not stop the rest of the app from updating.
        console.error(`[botApp] handler for "${type}" threw`, err)
      }
    }
  })
}

function subscribe<K extends AppEventName>(
  name: K,
  handler: (payload: AppEventMap[K]) => void
): () => void {
  ensureListener()

  let set = handlers.get(name)
  if (!set) {
    set = new Set<ErasedHandler>()
    handlers.set(name, set)
  }
  // The payload type is checked at the call site; the registry is intentionally
  // erased so one Map can hold every event name.
  const erased = handler as ErasedHandler
  set.add(erased)

  return () => {
    const current = handlers.get(name)
    if (!current) return
    current.delete(erased)
    if (current.size === 0) handlers.delete(name)
  }
}

/* ------------------------------------------------------------------ *
 * The API surface
 * ------------------------------------------------------------------ */

const api: BotApi = {
  bots: {
    list: () => invoke<Bot[]>(IPC_CHANNELS.botsList),
    get: (id: string) => invoke<Bot | null>(IPC_CHANNELS.botsGet, { id }),
    create: (input: BotDraftInput) => invoke<Bot>(IPC_CHANNELS.botsCreate, { draft: input }),
    update: (id: string, patch: BotPatchInput) =>
      invoke<Bot>(IPC_CHANNELS.botsUpdate, { id, patch }),
    duplicate: (id: string) => invoke<Bot>(IPC_CHANNELS.botsDuplicate, { id }),
    setPinned: (id: string, pinned: boolean) =>
      invoke<Bot>(IPC_CHANNELS.botsSetPinned, { id, value: pinned }),
    setHidden: (id: string, hidden: boolean) =>
      invoke<Bot>(IPC_CHANNELS.botsSetHidden, { id, value: hidden }),
    remove: (id: string) => invoke<void>(IPC_CHANNELS.botsRemove, { id }),
    presets: () =>
      invoke<Array<BotDraftInput & { presetId: string; tagline: string }>>(
        IPC_CHANNELS.botsPresets
      )
  },

  conversations: {
    list: () => invoke(IPC_CHANNELS.conversationsList),
    get: (id: string) => invoke(IPC_CHANNELS.conversationsGet, { id }),
    createDirect: (botId: string) => invoke(IPC_CHANNELS.conversationsCreateDirect, { botId }),
    createGroup: (input: CreateGroupInput) =>
      invoke(IPC_CHANNELS.conversationsCreateGroup, { input }),
    update: (id: string, patch: ConversationPatchInput) =>
      invoke(IPC_CHANNELS.conversationsUpdate, { id, patch }),
    remove: (id: string) => invoke<void>(IPC_CHANNELS.conversationsRemove, { id }),
    markRead: (id: string) => invoke<void>(IPC_CHANNELS.conversationsMarkRead, { id }),
    setFocused: (id: string | null) =>
      invoke<void>(IPC_CHANNELS.conversationsSetFocused, { id }),
    getMessages: (input: GetMessagesInput) =>
      invoke<MessagePage>(IPC_CHANNELS.conversationsGetMessages, input),
    search: (input: SearchInput) => invoke<SearchResult[]>(IPC_CHANNELS.conversationsSearch, input),
    exportMarkdown: (id: string) =>
      invoke<{ path: string | null }>(IPC_CHANNELS.conversationsExportMarkdown, { id }),
    clearTranscript: (id: string) =>
      invoke<void>(IPC_CHANNELS.conversationsClearTranscript, { id }),
    sessions: (id: string) =>
      invoke<ConversationSessionInfo[]>(IPC_CHANNELS.conversationsSessions, { id })
  },

  messages: {
    send: (input: SendMessageInput) => invoke<SendMessageResult>(IPC_CHANNELS.messagesSend, input),
    confirmEveryone: (input: SendMessageInput & { remember: boolean }) =>
      invoke<SendMessageResult>(IPC_CHANNELS.messagesConfirmEveryone, input),
    cancelPending: (conversationId: string) =>
      invoke<{ messageId: string | null }>(IPC_CHANNELS.messagesCancelPending, { conversationId }),
    retry: (messageId: string) =>
      invoke<SendMessageResult>(IPC_CHANNELS.messagesRetry, { messageId }),
    stop: (jobId: string) => invoke<void>(IPC_CHANNELS.messagesStop, { jobId }),
    stopConversation: (conversationId: string) =>
      invoke<void>(IPC_CHANNELS.messagesStopConversation, { conversationId }),
    react: (messageId: string, emoji: string) =>
      invoke<Message>(IPC_CHANNELS.messagesReact, { messageId, emoji }),
    remove: (messageId: string) => invoke<void>(IPC_CHANNELS.messagesRemove, { messageId })
  },

  runtime: {
    status: () => invoke<RuntimeStatus>(IPC_CHANNELS.runtimeStatus),
    recheck: () => invoke<RuntimeStatus>(IPC_CHANNELS.runtimeRecheck),
    openLoginTerminal: () => invoke<void>(IPC_CHANNELS.runtimeOpenLoginTerminal),
    pickExecutable: () => invoke<{ path: string | null }>(IPC_CHANNELS.runtimePickExecutable)
  },

  settings: {
    get: () => invoke<AppSettings>(IPC_CHANNELS.settingsGet),
    update: (patch: SettingsPatchInput) => invoke<AppSettings>(IPC_CHANNELS.settingsUpdate, patch)
  },

  system: {
    pickDirectory: (defaultPath?: string) =>
      invoke<PickDirectoryResult>(IPC_CHANNELS.systemPickDirectory, { defaultPath }),
    pickFiles: () => invoke<PickFilesResult>(IPC_CHANNELS.systemPickFiles),
    revealPath: (path: string) => invoke<void>(IPC_CHANNELS.systemRevealPath, { path }),
    openPath: (path: string) => invoke<void>(IPC_CHANNELS.systemOpenPath, { path }),
    openExternal: (url: string) => invoke<void>(IPC_CHANNELS.systemOpenExternal, { url }),
    openTerminalAt: (path: string) => invoke<void>(IPC_CHANNELS.systemOpenTerminalAt, { path }),
    openEditorAt: (path: string) => invoke<void>(IPC_CHANNELS.systemOpenEditorAt, { path }),
    pathExists: (path: string) => invoke<boolean>(IPC_CHANNELS.systemPathExists, { path }),
    copyText: (text: string) => invoke<void>(IPC_CHANNELS.systemCopyText, { text }),
    contextMenu: (items: ContextMenuItem[]) =>
      invoke<string | null>(IPC_CHANNELS.systemContextMenu, { items }),
    diagnostics: () => invoke<DiagnosticsReport>(IPC_CHANNELS.systemDiagnostics),
    exportBackup: () => invoke<{ path: string | null }>(IPC_CHANNELS.systemExportBackup),
    importBackup: () =>
      invoke<{ imported: boolean; error?: string }>(IPC_CHANNELS.systemImportBackup),
    revealAppData: () => invoke<void>(IPC_CHANNELS.systemRevealAppData),
    clearAllData: () => invoke<void>(IPC_CHANNELS.systemClearAllData),
    appInfo: () =>
      invoke<{ version: string; platform: string; isMac: boolean }>(IPC_CHANNELS.systemAppInfo)
  },

  events: {
    on: subscribe
  }
}

/* ------------------------------------------------------------------ *
 * Install
 * ------------------------------------------------------------------ */

/**
 * Installs `window.botApp` in the renderer's own world, wrapping every bridged
 * function so a rejected envelope becomes a real `Error` with `.code`/`.detail`.
 *
 * The function below is SERIALIZED and evaluated in the main world: it must be
 * completely self-contained — no imports, no module-scope references, no closures.
 */
function installInMainWorld(bridged: BotApi): boolean {
  const result: unknown = contextBridge.executeInMainWorld({
    func: (raw: unknown) => {
      const wrap = (value: unknown): unknown => {
        if (typeof value === 'function') {
          const fn = value as (...args: unknown[]) => unknown
          return (...args: unknown[]): unknown => {
            const returned = fn(...args)
            const maybeThenable = returned as { then?: unknown } | null
            if (maybeThenable && typeof maybeThenable.then === 'function') {
              return (returned as Promise<unknown>).catch((err: unknown) => {
                const envelope = err as {
                  __ccbError?: boolean
                  message?: string
                  code?: string
                  detail?: string
                } | null
                if (envelope && envelope.__ccbError === true) {
                  const rebuilt = new Error(envelope.message ?? 'Something went wrong.') as Error & {
                    code?: string
                    detail?: string
                  }
                  rebuilt.name = 'BotAppError'
                  rebuilt.code = envelope.code ?? 'internal'
                  if (envelope.detail !== undefined) rebuilt.detail = envelope.detail
                  throw rebuilt
                }
                throw err
              })
            }
            return returned
          }
        }
        if (value && typeof value === 'object') {
          const source = value as Record<string, unknown>
          const out: Record<string, unknown> = {}
          for (const key of Object.keys(source)) out[key] = wrap(source[key])
          return out
        }
        return value
      }

      ;(globalThis as unknown as { botApp: unknown }).botApp = wrap(raw)
      return true
    },
    args: [bridged]
  })
  return result === true
}

let installed = false
try {
  installed =
    typeof contextBridge.executeInMainWorld === 'function' && installInMainWorld(api)
} catch (err) {
  console.error('[botApp] executeInMainWorld unavailable; using exposeInMainWorld', err)
}

if (!installed) {
  // Fallback: the renderer receives error envelopes rather than real Errors.
  contextBridge.exposeInMainWorld('botApp', api)
}
