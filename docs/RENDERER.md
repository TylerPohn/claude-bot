# Renderer Contract

Binding, like `docs/ARCHITECTURE.md`. `docs/DESIGN.md` is the visual spec — every pixel value,
copy string and interaction rule comes from there. This file fixes the **code** surface so lanes
compile against each other.

Already written — do not recreate, do not modify:

- `src/renderer/index.html` (CSP is deliberate; the entry is `/src/main.tsx`)
- `src/renderer/src/styles/tokens.css`, `src/renderer/src/styles/main.css`
- `src/renderer/src/lib/cn.ts` → `cn(...parts)`
- `src/renderer/src/components/ui/BotAvatar.tsx` → `BotAvatar`, `GroupAvatar`, `ACCENT_HEX`

Aliases available in the renderer: `@/` → `src/renderer/src`, `@shared/` → `src/shared`.
The bridge is `window.botApp`, typed as `BotApi` from `@shared/types/api`.

**Scope deviations from `docs/DESIGN.md` — obey these, the spec describes Grok Bot, not us:**

- **No "Agent Computer" view** (DESIGN §2.7). We have no cloud VM; it is an explicit PRD
  non-goal. Where the spec puts that button, we put **Workspace** — it opens the details drawer
  scrolled to the workspace section.
- **No Allow / Deny / Always-allow approval buttons** (DESIGN §4.5). Print-mode Claude Code
  cannot round-trip a permission prompt in v1. The equivalent card is a **permission remediation
  card**: title `{Bot} needs permission to run {tool}`, body = the denial detail, actions
  `Open in Terminal` and `Edit allowed tools`.
- **No routines/schedules, no skills marketplace, no connectors, no sign-in.** Authentication is
  Claude Code's own; we only detect it.
- Reactions ARE implemented (👍 👎 ✅ 👀) but are local metadata only — never an instruction.

---

## 1. Stores — owned by lane **SHELL**

### `src/renderer/src/stores/appStore.ts`

Zustand v5, single store, `create<AppState>()((set, get) => …)`. Server-ish data only.

```ts
export interface AppState {
  // ---- data
  bots: Record<string, Bot>
  botOrder: string[]                       // pinned first, then name order
  conversations: Record<string, ConversationSummary>
  conversationOrder: string[]              // pinned, then lastMessageAt desc
  messages: Record<string, Message[]>      // by conversationId, oldest-first
  pagination: Record<string, { cursor: string | null; hasMore: boolean; loading: boolean }>
  settings: AppSettings | null
  runtime: RuntimeStatus | null
  ready: boolean
  bootError: string | null

  // ---- selectors (plain functions on the store, not hooks)
  botsFor(conversationId: string): Bot[]
  conversationTitle(conversationId: string): string
  isBotBusy(botId: string): boolean

  // ---- actions
  bootstrap(): Promise<void>               // loads everything + subscribes to events, idempotent
  refreshBots(): Promise<void>
  refreshConversations(): Promise<void>
  loadMessages(conversationId: string): Promise<void>       // first page, no-op if loaded
  loadOlder(conversationId: string): Promise<void>
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
  confirmEveryone(input: SendMessageInput, remember: boolean): Promise<SendMessageResult>
  retryMessage(messageId: string): Promise<void>
  stopJob(jobId: string): Promise<void>
  stopConversation(conversationId: string): Promise<void>
  react(messageId: string, emoji: string): Promise<void>
  deleteMessage(messageId: string): Promise<void>
  markRead(conversationId: string): Promise<void>

  createBot(input: BotDraftInput): Promise<Bot>
  updateBot(id: string, patch: BotPatchInput): Promise<Bot>
  duplicateBot(id: string): Promise<Bot>
  setBotPinned(id: string, pinned: boolean): Promise<void>
  setBotHidden(id: string, hidden: boolean): Promise<void>
  deleteBot(id: string): Promise<void>

  createDirect(botId: string): Promise<ConversationSummary>
  createGroup(input: CreateGroupInput): Promise<ConversationSummary>
  updateConversation(id: string, patch: ConversationPatchInput): Promise<ConversationSummary>
  deleteConversation(id: string): Promise<void>

  updateSettings(patch: SettingsPatchInput): Promise<void>
  recheckRuntime(): Promise<void>
}
export const useAppStore: UseBoundStore<StoreApi<AppState>>
```

**Streaming performance requirement.** `message:delta` fires up to 30×/s per running Bot. The
reducer must replace **only the one message object** and the one conversation array, leaving every
other array identity intact:

```ts
// inside the 'message:delta' handler
set((s) => {
  const list = s.messages[payload.conversationId]
  if (!list) return s
  const i = list.findIndex((m) => m.id === payload.messageId)
  if (i === -1) return s
  const next = list.slice()
  next[i] = {
    ...list[i]!,
    bodyMarkdown: list[i]!.bodyMarkdown + (payload.textDelta ?? '')
  }
  return { messages: { ...s.messages, [payload.conversationId]: next } }
})
```
`MessageRow` is `React.memo`'d on the message object identity, so only the streaming row
re-renders. Never map over the whole list to apply a delta.

### `src/renderer/src/stores/uiStore.ts` — owned by lane **SHELL**

Transient UI state. Persist the marked fields to `localStorage` under `ccb.ui`.

```ts
export interface UiState {
  activeConversationId: string | null
  detailsOpen: boolean                   // persist
  sidebarWidth: number                   // persist, 200–360
  sidebarCollapsed: boolean              // persist
  collapsedSections: Record<string, boolean>  // persist
  showHidden: boolean
  drafts: Record<string, { text: string; attachments: AttachmentInput[]; replyToId: string | null }> // persist
  modal:
    | null
    | { kind: 'bot'; botId?: string; preset?: string }
    | { kind: 'group'; conversationId?: string }
    | { kind: 'settings'; tab?: 'general' | 'claude' | 'bots' | 'data' | 'about' }
    | { kind: 'onboarding' }
    | { kind: 'confirm'; title: string; body?: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }
    | { kind: 'everyone'; input: SendMessageInput; botCount: number }
  palette: null | 'command' | 'search'
  toasts: Toast[]
  jumpToMessageId: string | null
  setActive(id: string | null): void
  openModal(m: UiState['modal']): void
  closeModal(): void
  setDraft(conversationId: string, patch: Partial<Draft>): void
  clearDraft(conversationId: string): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void
  jumpTo(messageId: string): void
}
export interface Toast { id: string; level: 'info'|'success'|'warn'|'error'; title: string; body?: string; actionLabel?: string; onAction?: () => void }
export const useUiStore: UseBoundStore<StoreApi<UiState>>
```

---

## 2. Hooks — owned by lane **SHELL**

`src/renderer/src/hooks/useStickToBottom.ts`
```ts
export function useStickToBottom(deps: unknown[]): {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  isAtBottom: boolean
  scrollToBottom(behavior?: 'smooth' | 'instant'): void
}
```
Requirements (from DESIGN §6, these are not optional):
- Spring-driven, `damping 0.7 / stiffness 0.05 / mass 1.25`; per tick
  `v = (damping*v + stiffness*diff) / mass`, `acc += v * (dt / (1000/60))`.
- `isAtBottom` threshold **70px**. Programmatic-scroll retention window **350ms**.
- Track `isAtBottom`, `isNearBottom` and `escapedFromLock` as separate flags; once the user
  scrolls up, stop following until they return to the bottom.
- Drive from a **ResizeObserver on the content element** — streaming text changes height without
  ever firing a scroll event.
- Distinguish user scroll from programmatic with a `wheel`/`touchstart`/`mousedown` flag plus the
  350ms window. Never debounce.
- Read `matchMedia('(prefers-reduced-motion: reduce)')` **in JS** and fall back to instant jumps.
  A springing scroll is exactly what that setting exists to prevent.

`src/renderer/src/hooks/useHotkeys.ts`
```ts
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled?: boolean): void
```
Keys like `'mod+k'`, `'mod+shift+n'`, `'escape'`, `'mod+.'`. `mod` = ⌘ on mac, Ctrl elsewhere.
Ignores events originating in inputs/textareas unless the combo includes a modifier.

`src/renderer/src/hooks/useAutosizeTextarea.ts` → `(ref, value, maxHeight)`.
`src/renderer/src/hooks/useContextMenu.ts`
```ts
export function useContextMenu(): (items: ContextMenuItem[], e?: React.MouseEvent) => Promise<string | null>
```
Calls `window.botApp.system.contextMenu`. Native menus are built in the main process; the renderer
only `preventDefault()`s and sends IPC.

`src/renderer/src/hooks/useEvent.ts`
```ts
export function useAppEvent<K extends AppEventName>(name: K, handler: (p: AppEventMap[K]) => void): void
```

---

## 3. UI primitives — owned by lane **SHELL** (`src/renderer/src/components/ui/`)

Every one is a plain function component, forwardRef where it wraps a DOM node.

| File | Export | Notes |
|---|---|---|
| `Button.tsx` | `Button` | `variant: 'filled' \| 'secondary' \| 'ghost' \| 'danger'`, `size: 'sm' \| 'md'`, `loading`, `iconOnly`. Heights 28 / 32. Radius `--r-button`; `iconOnly` is a circle. |
| `IconButton.tsx` | `IconButton` | 32×32 circle, ghost by default, `--btn-ghost-hover` on hover, requires `label` for a11y. |
| `Input.tsx` | `Input` | 36px, `--input-bg`, 1px `--input-border`, radius `--r-4`. |
| `Textarea.tsx` | `Textarea` | autosizing variant of the above. |
| `Select.tsx` | `Select` | native `<select>` styled to match; no popover library. |
| `Switch.tsx` | `Switch` | 32×18 track, 14px thumb, 100ms. |
| `Modal.tsx` | `Modal` | portal + scrim `--overlay`, `--shadow-dialog`, 175ms `dialog-in`, focus trap, Esc closes, restores focus. `title`, `description`, `footer`, `width`. |
| `Sheet.tsx` | `Sheet` | right-side panel variant of Modal, 420px, slides in. |
| `Tooltip.tsx` | `Tooltip` | 500ms open delay, 13px, `--surface-3`, radius `--r-3`. |
| `Popover.tsx` | `Popover` | anchored, click-outside, Esc. |
| `Badge.tsx` | `Badge` | 18px pill, 11px/590. |
| `StatusDot.tsx` | `StatusDot` | `state: 'idle' \| 'unread' \| 'attention' \| 'working' \| 'queued' \| 'error'`, 8px. See DESIGN §3.4 — three visually distinct states, never collapsed into one. |
| `Kbd.tsx` | `Kbd` | 10px/`--fs-nano`, `--chip-bg`, radius `--r-2`. Renders `mod` as ⌘ on mac. |
| `EmptyState.tsx` | `EmptyState` | icon, title, body, optional action. |
| `Spinner.tsx` | `Spinner` | 14px ring; use sparingly — prefer the shimmer indicator. |
| `Skeleton.tsx` | `Skeleton` | uses the `.skeleton` class; `delay` prop (default 250ms) so fast loads never flash one. |
| `Toaster.tsx` | `Toaster` | bottom-right stack, reads `useUiStore().toasts`. |
| `ConfirmDialog.tsx` | `ConfirmDialog` | reads `modal.kind === 'confirm'`. |
| `ScrollArea.tsx` | `ScrollArea` | just applies `.scroller` + `overflow-y:auto`; not a library. |

Icons: `lucide-react`, `strokeWidth={1.75}`, size 18 in chrome / 16 inline / 14 in dense rows.

---

## 4. Lane ownership

### Lane **SHELL**
`src/main.tsx`, `src/App.tsx`, `src/stores/*`, `src/hooks/*`, `src/lib/*` (except `cn.ts`),
`src/components/ui/*` (except `BotAvatar.tsx`), `src/components/sidebar/*`.

`lib/format.ts` must export: `formatTime` (`8:41 AM`), `formatRelativeShort`
(`8:41 AM` / `Yesterday` / `Tuesday` / `Mar 4`), `formatDaySeparator` (**verbatim**
`Today 7:58 AM`, `Yesterday 4:12 PM`, `Tuesday 9:03 AM`, `Mar 4 9:03 AM`), `formatBytes`,
`formatDuration`, `formatCost`, `plainTextPreview(markdown, max)`.

`App.tsx` composes: title bar drag strip → `<Sidebar/>` → `<ChatView/>` → `<DetailsDrawer/>`,
plus `<Toaster/>`, `<CommandPalette/>`, `<SearchPalette/>`, the modal switch, and
`<Onboarding/>` when `!settings.onboardingCompleted`. It calls `bootstrap()` once, stamps
`data-theme` on `<html>` from settings, and registers the global hotkeys from DESIGN §4.8.
It also handles `app:command` and `app:navigate` events from the main process.

Sidebar layout is DESIGN §2.2 exactly: 56px top bar (with the macOS traffic-light inset of
80px left padding), optional pinned strip, sections (`Direct`, `Groups`, plus custom sections),
60px rows, `Show hidden chats` footer. Rows use the `.row-pill` class. Right-click a row →
native context menu: Pin/Unpin, Hide, Duplicate (bots only), Export transcript, Delete.

### Lane **CHAT**
`src/components/chat/*`, `src/components/activity/*`.

`ChatView.tsx` — header (DESIGN §2.3), `MessageList`, composer slot, empty state.
`MessageList.tsx` — the transcript, `useStickToBottom`, day separators, grouping runs by author.
`MessageRow.tsx` — `React.memo` on the message object. Bubbles per DESIGN §2.4:
- **direct chats: no per-message avatar and no per-message timestamp.** This is the single
  biggest thing to get right; time lives in the day separator and a hover tooltip.
- **group chats: a 20px avatar and a sender name once per run.**
- user right-aligned `--bubble-user-*`, bot left-aligned `--bubble-agent-*`, radius 18px,
  `max-width: min(640px, 80%)`, 4px gap within a run, 12px across runs.

`Markdown.tsx` — the streaming-safe renderer. Non-negotiable:
- Split the body into blocks and `React.memo` each. Only the final block changes per token.
  Merge a block into the previous one while an HTML tag stack is open. Without this, every
  block boundary shifts and memoization is destroyed.
- `components`, `remarkPlugins`, `rehypePlugins` are **module-level constants**. Inline literals
  are new references each render and silently defeat the whole strategy.
- Repair unterminated markers before parsing (`**`, `*`, `_`, `` ` ``, `~~`); drop incomplete
  images; render an unclosed code fence as plain preformatted text and only highlight once the
  closing fence lands.
- react-markdown 10 is safe by default. **Do not add `rehype-raw`. Do not override
  `urlTransform`.** Set `disallowedElements={['script','iframe','object','embed','form','input']}`
  with `unwrapDisallowed`. Route `a` through a handler that calls
  `window.botApp.system.openExternal` for http/https only.

`CodeBlock.tsx` — shiki. Create the highlighter **once at module scope** with
`createHighlighterCore` + `createJavaScriptRegexEngine` (no Oniguruma WASM) and only the langs
ts/js/tsx/jsx/python/bash/json/yaml/sql/css/html/markdown/rust/go/diff. Highlight in an effect
after the fence closes; render plain `<pre>` until then. Copy button on hover; language label.

`activity/ActivityStrip.tsx` — the concise default view: one line per collapsed group, e.g.
`Edited 3 files`, `Ran npm test — passed`, `Read 8 files`, with a chevron that expands into
`ActivityCard`s. Never dump raw JSON into the transcript. Card visual = DESIGN §2.4 nested-panel
pattern (outer `--bubble-agent-bg` radius 20 padding 16, label 15/550, inner
`--bubble-nested-bg` radius 14 padding 14, mono 13px).

`chat/SystemMessage.tsx` — inset cards for each `SystemMessageKind`, with the PRD §37 copy:
- `rate_limit` → **"Claude Code usage limit reached. Your Bot history is safe. Retry after your
  Claude allowance resets."** Never mention API keys or billing.
- `session_recovered` → **"Started a fresh Claude session because the previous session could not
  be resumed."**
- `handoff` → `{From} → {To}` with the note, avatars of both.
- `permission_denied` → the remediation card described at the top of this file.
- `workspace_missing`, `loop_guard`, `interrupted`, `bot_removed`.

### Lane **COMPOSER**
`src/components/composer/*`.

`Composer.tsx` — DESIGN §2.5 exactly: standalone 36px `+` circle **outside** the pill on its
left, 44px pill radius 22, trailing 32px circular button whose glyph is send (has text) /
stop (Bot working). Placeholder **`Ask {Bot name}`** in a direct chat, **`Message {Group name}`**
in a group. Enter sends, Shift+Enter newlines (respect `settings.sendKey`). Auto-grow to 8 lines
(198px) then scroll. Drafts persist per conversation via `uiStore`.

`MentionPicker.tsx` — opens on `@`, filters members, ↑/↓/Enter/Esc, inserts a structured mention
(`{botId, display, start, end}`) into the composer's mention list. `@everyone` is always the last
option in a group. Renders inserted mentions as inline chips coloured by the bot's accent.
A mention chip must survive a bot rename — render from the stored `display`, never re-parse.

`RoutingSelector.tsx` — group only, above the pill: `Auto` / a specific Bot / `Everyone`.
`AttachmentTray.tsx` — chips with name, size, remove; drag-and-drop onto the whole chat column;
missing files render struck-through with a warning tint.
`StopButton.tsx` — always visible while a Bot in this conversation is running; the confirm copy
is **"This doesn't undo actions already completed."**

### Lane **MODALS**
`src/components/bots/*`, `src/components/groups/*`.

`BotSheet.tsx` — create/edit. Fields: name, title, description (the standing-instructions
textarea, with a hint that it persists across every turn), avatar (shape + colour picker — a grid
of the 10 shapes × 10 accents, live-previewing a real `BotAvatar` at 96px), default working
directory (with a Browse button and an inline "folder is missing" warning), model, permission
mode, allowed/disallowed tools (chip inputs). Live preview card at the top. Save is disabled
until the name is non-empty and unique.

`BotList.tsx` — a manage-all view reachable from Settings.
`GroupSheet.tsx` + `MemberPicker.tsx` — 2–10 members (UI optimized for 2–6, warn above 6), name,
emoji icon, workspace, default responder.

### Lane **SETTINGS**
`src/components/settings/*`, `src/components/details/*`.

`SettingsModal.tsx` with tabs General / Claude Code / Bots / Data / About, exactly the fields in
PRD §34. The Claude Code tab shows detected version + path + auth health with a `Recheck` button,
an `Open Claude Code in Terminal` button, and a manual executable picker.
`DetailsDrawer.tsx` — 320px right panel per DESIGN §2.6: members (group), workspace path with
Change / Reveal in Finder / Open Terminal / Open in VS Code, model, permission mode, Claude
session ids (read-only, monospace, with a "these are local" note), danger zone.

### Lane **ONBOARDING**
`src/components/onboarding/*`, `src/components/search/*`.

`Onboarding.tsx` — the 5 screens from PRD §35 as a single full-window flow.
Screen 1 copy: headline **"Your Claude Code team, in a chat app."**, three bullets covering
local-first, uses your installed Claude Code, and no separate API key. Screen 2 detects Claude
and shows Installed/Not found + version + path, with install instructions when absent. Screen 3
verifies auth cheaply with an `Open Terminal to sign in` fallback. Screen 4 offers the six presets
as picker cards (real `BotAvatar`s) plus "Create your own". Screen 5 drops into the new Bot's chat.
Include the PRD §39 privacy disclosure verbatim on screen 1.

`CommandPalette.tsx` (⌘K) — fuzzy over conversations, bots and commands (New Bot, New Group,
Settings, Toggle theme, Stop all). `top: 13vh`, not centred. Five-layer `--shadow-dialog`.
`SearchPalette.tsx` (⌘F) — debounced 150ms full-text search via `conversations.search`. Results
show conversation, author avatar, timestamp and the snippet. The snippet arrives with U+0001 / U+0002 sentinel characters wrapping each match — **split the string on those two code points and wrap the pieces in `<mark>`. Never set innerHTML.**
Selecting a result opens the conversation and calls `jumpTo(messageId)`; `MessageList` scrolls to
it and applies `.hit-flash`.
