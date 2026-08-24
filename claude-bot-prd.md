# PRD — Claude Code Bots
**Working title:** Claude Code Bots  
**Concept:** “Grok Bot for Claude Code” — a local-first Electron desktop app that turns a user's existing Claude Code subscription into a roster of persistent AI teammates.

**Status:** Build-ready v1 PRD  
**Date:** 2026-08-23  
**Primary target:** macOS first, then Windows  
**Inference:** Anthropic via the user's locally authenticated Claude Code CLI  
**Backend:** None required for v1  
**Remote computer:** None  
**Cloud sync:** None in v1  
**API key:** Not required and should not be requested

---

## 1. Product Summary

Claude Code Bots is a desktop messaging application for Claude Code.

Instead of opening separate terminal sessions, the user creates named Bots such as:

- Researcher
- Builder
- Reviewer
- Product Manager
- Debugger
- Chief of Staff

Each Bot has:

- a name;
- avatar;
- title/job;
- persistent instructions/personality;
- a default working directory;
- a Claude model preference;
- a Claude Code permission mode;
- persistent conversations backed by Claude Code session IDs.

The user talks to Bots through a familiar chat UI rather than a terminal.

The defining feature is **multi-Bot conversation**:

- create a group conversation containing multiple Bots;
- mention one Bot with `@Builder`;
- mention several Bots in one message;
- use `@everyone`;
- allow Bots to see relevant messages from other Bots in that group;
- allow a Bot to hand work to another Bot;
- run multiple Bots concurrently when the user addresses several of them.

The app is **local-first**. It does not provision a cloud VM, remote browser, or hosted agent backend. All execution occurs on the user's computer through the locally installed Claude Code CLI. The only required external compute is whatever Anthropic normally performs when Claude Code sends model requests.

---

## 2. Product Thesis

Claude Code is already a capable local agent runtime, but its terminal-first UX makes it awkward to treat multiple Claude sessions as a persistent “team.”

Grok Bot's strongest product idea is not the remote computer. It is the **messaging metaphor for durable agents**:

- one roster;
- persistent named teammates;
- separate roles;
- separate histories;
- group chats;
- mentions;
- visible handoffs;
- parallel work.

Claude Code Bots should recreate that interaction model while using Claude Code itself as the execution engine.

The app should feel closer to Slack/iMessage/Discord for agents than to an IDE.

---

## 3. Research Basis: Grok Bot Feature Model

The product is inspired by the current Grok Bot interaction model documented by xAI/SpaceXAI.

### 3.1 Core Grok Bot concepts observed

Grok Bot currently presents a Bot as a durable named teammate with its own job, conversation, working context, and memory.

Documented Bot-management features include:

- create Bot;
- edit name/profile/description/avatar;
- pin;
- hide/unhide;
- duplicate;
- delete;
- up to 50 Bots and group chats combined;
- durable role-specific context.

### 3.2 Messaging/collaboration features observed

Documented chat features include:

- direct Bot conversations;
- group chats with 2–6 Bots;
- `@Bot` mentions;
- multiple Bot mentions;
- `@everyone`;
- attachments;
- links/images;
- replies/threads;
- reactions;
- sending another instruction while work is in progress;
- stopping/redirection while a Bot is working;
- bot-to-bot asynchronous handoffs;
- visible tool/activity messages;
- search across prior work.

### 3.3 Extended Grok Bot features observed

Grok Bot also includes:

- shared persistent cloud computer;
- browser/desktop computer use;
- app logins;
- connectors/plugins;
- MCP;
- skills;
- slash-command invocation of skills;
- routines/schedules;
- workflow teaching by demonstration;
- approval boundaries;
- notifications;
- desktop + iOS sync;
- local-computer execution controls.

These are useful reference points but **not all belong in this product's v1**, because Claude Code Bots intentionally has no hosted computer or always-on backend.

---

## 4. Goals

### 4.1 Primary goals

1. Make Claude Code feel like a team of persistent coworkers rather than isolated terminal sessions.
2. Let a user create and manage multiple named Bots.
3. Provide first-class 1:1 chat with each Bot.
4. Provide group conversations with multiple Bots.
5. Support `@mentions` that deterministically decide which Bot(s) run.
6. Preserve each Bot's context between app launches.
7. Preserve each Bot's context separately in each conversation.
8. Stream Claude Code output into a polished chat UI.
9. Expose useful Claude Code activity without dumping raw terminal noise.
10. Use the user's existing Claude Code authentication/subscription.
11. Keep app data and agent execution local.
12. Make implementation straightforward enough for Claude Code to build directly from this PRD.

### 4.2 Secondary goals

- Show running/queued/completed/error states.
- Allow parallel Bot turns.
- Let users interrupt a running Bot.
- Allow a Bot to request another Bot's help.
- Display relevant tool activity and file changes.
- Support per-Bot project/workspace directories.
- Support file attachments through local filesystem references.
- Provide basic conversation search.
- Provide export/import backup.

---

## 5. Non-Goals for v1

The following are explicitly out of scope for the first release:

- remote/cloud computers;
- hosted backend;
- browser automation layer independent of Claude Code;
- mobile app;
- cross-device sync;
- account system for this app;
- server-side conversation storage;
- custom Anthropic API key flow;
- direct Anthropic Messages API integration;
- billing;
- payments;
- marketplace;
- enterprise admin console;
- workflow recording by observing mouse/keyboard;
- always-on scheduled work while the host computer is asleep;
- guaranteed background execution after the Electron app quits;
- multi-user shared group chats.

Do not accidentally build a SaaS backend for v1.

---

## 6. Critical Integration Principle: Claude Code Subscription

### 6.1 Required approach

Claude Code Bots MUST use the user's installed `claude` executable as the agent runtime.

Do not call the Anthropic API directly for normal operation.

Do not ask for an Anthropic API key.

Do not proxy inference through an app-owned server.

The app should detect the executable with logic such as:

- `which claude` on macOS/Linux;
- `where claude` on Windows;
- configurable manual binary path as fallback.

### 6.2 Authentication

The app relies on Claude Code's existing authentication.

On first launch:

1. Detect `claude`.
2. Run a lightweight health/version check.
3. If Claude Code is missing, show installation instructions.
4. If Claude Code is installed but unauthenticated, show a button that opens a terminal with `claude` so the user can complete `/login`.
5. Re-run the health check afterward.

The app itself must not capture the user's Anthropic password, OAuth token, or subscription credentials.

### 6.3 Subscription/rate-limit reality

All Bots ultimately consume the same Claude Code subscription allowance.

Therefore:

- concurrency must be configurable;
- default maximum concurrent Claude processes: **3**;
- additional Bot turns enter a queue;
- UI must show `Queued`;
- app must surface recognizable rate-limit messages cleanly;
- do not silently switch to API billing;
- do not ask for Console credits in v1.

---

## 7. Claude Code Runtime Design

### 7.1 Process model

For v1, use **one spawned Claude Code process per Bot turn**, not one permanently attached PTY per Bot.

Recommended command shape:

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  [--resume "<session-id>"] \
  [--model "<model>"] \
  [--permission-mode "<mode>"]
```

Parse stdout line-by-line as JSON events.

Capture stderr separately.

Store the returned `session_id`.

A subsequent turn in the same Bot/conversation pair resumes that exact session.

### 7.2 Why process-per-turn

Advantages:

- simple lifecycle;
- easy cancellation;
- easy queueing;
- easy crash recovery;
- no fragile terminal emulation;
- Claude Code itself persists session history;
- clean mapping between a message and one execution job.

### 7.3 Session identity rule

**Do not give a Bot one global Claude Code session.**

Create a separate Claude Code session for every:

`bot_id + conversation_id`

pair.

Reason: the same Bot may participate in:

- its direct chat;
- Project Alpha group;
- Marketing group;
- a temporary review conversation.

Context from one conversation must not leak into another.

Database entity:

`bot_conversation_sessions`

Fields:

- `bot_id`
- `conversation_id`
- `claude_session_id`
- `last_seen_message_id`
- `created_at`
- `updated_at`

Unique index on `(bot_id, conversation_id)`.

### 7.4 First turn

When there is no `claude_session_id`:

- build Bot system context;
- build conversation context;
- spawn a new Claude Code print-mode run;
- capture its returned `session_id`;
- save it.

### 7.5 Later turns

When a session exists:

- spawn with `--resume <session-id>`;
- send only the new user/group context that Bot has not already consumed;
- update `last_seen_message_id`.

---

## 8. Bot Model

### 8.1 Bot fields

Each Bot has:

```ts
type Bot = {
  id: string
  name: string
  title?: string
  description: string
  avatarType: "emoji" | "initials" | "image"
  avatarValue: string
  defaultWorkingDirectory?: string
  model: "default" | "sonnet" | "opus" | string
  permissionMode: "default" | "acceptEdits" | "plan"
  allowedTools?: string[]
  disallowedTools?: string[]
  pinned: boolean
  hidden: boolean
  createdAt: string
  updatedAt: string
}
```

Do not expose `bypassPermissions` in normal UI for v1.

### 8.2 Bot profile semantics

`description` is durable instruction, not a one-time prompt.

Example:

> You are the senior implementation engineer. Own coding tasks end-to-end. Prefer small, testable changes. Inspect the repo before editing. Run relevant tests after changes. Explain blockers briefly. Never push, deploy, or delete data unless explicitly asked.

Every invocation should make the Bot's identity and standing rules clear.

### 8.3 Suggested Bot presets

First-run flow may offer:

- Builder
- Reviewer
- Researcher
- Product Manager
- Debugger
- Test Engineer

Presets are templates only. User can edit everything.

---

## 9. Conversations

### 9.1 Conversation types

```ts
type ConversationType = "direct" | "group"
```

A direct conversation contains exactly one Bot.

A group contains 2–10 Bots in this product.

Grok Bot uses 2–6; Claude Code Bots may support 10, but UI should be optimized for 2–6.

### 9.2 Conversation fields

```ts
type Conversation = {
  id: string
  type: "direct" | "group"
  name: string
  memberBotIds: string[]
  pinned: boolean
  hidden: boolean
  createdAt: string
  updatedAt: string
}
```

### 9.3 Sidebar

Left sidebar sections:

1. New chat button
2. Search
3. Pinned
4. Direct Bots
5. Groups
6. Hidden
7. Settings

Each row shows:

- avatar;
- name;
- last-message preview;
- timestamp;
- unread/attention dot;
- running indicator if active.

---

## 10. Chat Interface

### 10.1 Layout

Main window:

- left: conversation sidebar;
- center: transcript;
- optional right drawer: conversation/Bot details.

Composer at bottom.

### 10.2 Message rendering

User messages:

- right aligned or visually distinct.

Bot messages:

- Bot avatar;
- Bot name;
- timestamp;
- Markdown rendering;
- code blocks;
- tables;
- file links;
- copy button.

System/activity rows:

- muted cards;
- running state;
- tool invocation;
- file edit;
- command execution;
- error;
- cancelled;
- queued.

### 10.3 Streaming

Bot text must stream incrementally.

Do not wait for the process to finish before showing text.

Maintain one provisional message while streaming, then finalize it when the Claude Code result event arrives.

### 10.4 Composer

Composer supports:

- multiline text;
- Enter to send;
- Shift+Enter newline;
- `@` autocomplete;
- file attach button;
- drag-and-drop files;
- Stop button while targeted Bot is running.

---

## 11. `@Mention` Behavior

This is a core product requirement.

### 11.1 Direct chat

In a direct Bot conversation:

- normal message invokes that Bot;
- `@OtherBot` may be allowed as an explicit handoff in phase 2.

### 11.2 Group chat with explicit mentions

If message contains one or more valid Bot mentions:

```text
@Builder implement the login screen.
@Reviewer inspect the current auth architecture first.
```

Invoke exactly the mentioned Bots.

They may run concurrently subject to global concurrency limits.

### 11.3 `@everyone`

`@everyone` invokes all Bots in the group.

Show a confirmation when group size > 4:

> Run 6 Bots? This may use Claude Code quota quickly.

Allow “Don't ask again for this group.”

### 11.4 Group message with no mention

Default v1 behavior:

- show a small routing selector above composer:
  - `Auto`
  - a specific Bot
  - `Everyone`
- default is `Auto`.

For `Auto`, select one Bot deterministically with a lightweight **local router**, not an extra Claude request.

Router rules:

1. If group has `defaultResponderBotId`, invoke it.
2. Else if only one Bot is idle and others are running, invoke the idle Bot.
3. Else invoke the first Bot in group membership order.

Do **not** spend subscription quota on a separate routing model in v1.

The UI should encourage explicit `@mentions` for predictable behavior.

### 11.5 Mention parsing

Mentions are structured tokens, not plain regex text after sending.

Composer stores:

```ts
{
  display: "@Builder",
  botId: "bot_123"
}
```

Renaming a Bot must not break old messages.

---

## 12. Multi-Bot Group Context

This is the key orchestration problem.

Each Claude Code session only directly remembers what that session saw.

Therefore, before invoking a Bot in a group, the app must inject messages added to the group since that Bot last ran.

### 12.1 Context bridge

For every invocation:

1. Read `last_seen_message_id` for this Bot/conversation.
2. Fetch all relevant group messages after that point.
3. Build a compact bridge block.
4. Include it before the new task.
5. After successful ingestion, advance `last_seen_message_id`.

Example hidden bridge:

```text
You are participating in a shared group conversation named "Website Launch".

Messages since you last participated:

[USER — Tyler]
@Researcher find the current docs for Electron auto-update.

[Researcher]
Electron's recommended update path is ...

[Reviewer]
The existing app already uses electron-updater in src/main/update.ts.

Now respond to the user's newest message addressed to you.

Important:
- You are @Builder.
- Do not impersonate other Bots.
- Do not answer on their behalf.
- You may reference their messages above.
```

### 12.2 Include only relevant content

To reduce subscription usage:

- include messages since last seen;
- cap bridge by character/token budget;
- prefer user and Bot final-text messages;
- omit verbose tool logs unless explicitly relevant;
- if too large, generate a deterministic truncation with oldest messages dropped;
- phase 2 may add local summaries.

### 12.3 Bot self-identity

Every group prompt must state:

- this Bot's name;
- this Bot's role;
- group name;
- member names;
- newest user instruction;
- prohibition on speaking as another Bot.

---

## 13. Bot-to-Bot Handoffs

### 13.1 Goal

Bots should be able to ask other Bots for work without making the human manually copy/paste.

### 13.2 v1 safe design

Do not depend on Claude Code inventing a special proprietary tool.

Instead expose a local MCP server named something like:

`claude-code-bots`

Available tools:

```ts
send_message_to_bot({
  bot_name: string,
  message: string
})

send_message_to_group({
  conversation_id: string,
  message: string
})
```

The MCP server is provided by the Electron app locally.

When Bot A calls `send_message_to_bot`:

1. validate Bot exists;
2. create a visible handoff message in current conversation;
3. enqueue Bot B with the handoff;
4. Bot B's response posts visibly;
5. optionally notify Bot A by injecting Bot B's reply next time Bot A resumes.

### 13.3 Loop protection

Prevent agent ping-pong.

Global defaults:

- maximum handoff depth: 3;
- maximum 8 automated Bot turns caused by one human message;
- when limit reached, post system notice and stop.

### 13.4 Handoff visibility

Every handoff is visible:

> Builder → Reviewer: “Please review the auth changes for security regressions.”

No invisible orchestration.

---

## 14. Working Directories

Claude Code is most useful when attached to a real project.

### 14.1 Per-Bot default

Each Bot may have a default working directory.

Example:

- Builder → `/Users/me/dev/my-app`
- Researcher → no directory
- Reviewer → `/Users/me/dev/my-app`

### 14.2 Per-conversation override

A conversation may optionally set a workspace directory that overrides Bot defaults.

This is valuable for project groups.

Priority:

1. conversation workspace;
2. Bot default working directory;
3. app-configured fallback working directory;
4. user home directory.

### 14.3 Workspace UI

Conversation details drawer:

- Workspace path
- Change workspace
- Reveal in Finder
- Open terminal here
- Open in VS Code (optional if detected)

---

## 15. Claude Code Permissions

### 15.1 Supported modes in UI

- Plan — read/analyze only.
- Ask/default — standard Claude Code rules.
- Accept edits — file edits automatically allowed, commands still governed by Claude Code permissions.

Do not make unrestricted bypass the normal product path.

### 15.2 Permission problem in non-interactive mode

Print-mode execution cannot rely on a terminal prompt the Electron user never sees.

For v1:

- respect user's Claude Code settings;
- expose `allowedTools` / `disallowedTools`;
- support permission mode selection;
- capture permission-related failures;
- show a clear remediation card.

Example:

> Builder needs permission to run `npm test`.
> Open this Bot in Terminal or update its allowed tools.

Phase 2 should implement a local MCP permission-prompt bridge so the Electron UI can present Approve / Deny controls.

### 15.3 Destructive operations

The app should ship with optional safety defaults that disallow obviously destructive commands unless the user changes settings.

Do not attempt an exhaustive shell sandbox.

Claude Code remains the execution authority.

---

## 16. Tool Activity UI

Claude Code `stream-json` events should be normalized into internal activity objects.

```ts
type Activity = {
  id: string
  messageId: string
  botId: string
  type:
    | "thinking"
    | "tool_start"
    | "tool_end"
    | "command"
    | "file_read"
    | "file_write"
    | "mcp"
    | "result"
    | "error"
  title: string
  detail?: string
  status: "running" | "success" | "error"
  startedAt: string
  endedAt?: string
}
```

Default transcript should be concise:

> Builder edited 3 files  
> Builder ran `npm test` — passed

Click to expand raw details.

Do not dump raw JSON into the user transcript.

---

## 17. Attachments

### 17.1 v1

Support local files by path.

When the user attaches files:

- store metadata in app DB;
- do not copy unless necessary;
- include explicit paths in the Claude prompt;
- verify file still exists before execution.

Message shows attachment chips.

### 17.2 Images

If Claude Code can consume the referenced image through its normal local file tools, allow it as a local path.

No separate image-upload backend.

### 17.3 Folders

Support attaching a folder by adding it as context/instruction:

> Inspect files under `/path/...`

Do not recursively ingest the folder into Electron.

---

## 18. Threads and Replies

### 18.1 v1

Support “Reply to message.”

A reply stores `reply_to_message_id`.

Render a compact quoted preview.

When invoking a Bot, include the referenced message explicitly.

### 18.2 Full nested threads

True Slack-style side threads can be phase 2.

v1 does not need a separate thread pane.

---

## 19. Reactions

Phase 2.

Reactions are useful UI but not critical to execution.

If implemented:

- 👍
- 👎
- ✅
- 👀

They are local metadata.

Do not treat a reaction as an instruction to an agent unless a future setting explicitly enables that behavior.

---

## 20. Search

### 20.1 v1

Local full-text search across:

- conversation names;
- Bot names;
- user messages;
- Bot messages.

Use SQLite FTS5.

Search result opens the conversation and scrolls to the matching message.

### 20.2 Later

Search:

- file names;
- command activity;
- tool activity;
- generated artifacts.

---

## 21. Pin / Hide / Duplicate / Delete

Match the useful Grok Bot management model.

### Pin

Pinned Bots/groups appear at top.

### Hide

Removes from normal sidebar but preserves history.

### Duplicate Bot

Copy:

- profile;
- avatar;
- model;
- permission mode;
- default working directory;
- tool settings.

Do not copy:

- Claude session IDs;
- conversation history.

### Delete

Delete Bot only after confirmation.

If Bot belongs to groups:

- remove Bot from those groups;
- preserve messages it previously sent;
- label historical author as deleted Bot if necessary.

---

## 22. Stop, Retry, Regenerate

### Stop

If a Bot process is active:

- send graceful termination first;
- after short timeout, kill process tree;
- mark turn `cancelled`;
- keep partial output visible;
- do not advance session bookkeeping incorrectly.

### Retry

Retry same human instruction against the same prior session if safe.

### Regenerate

Create a new branch execution from the same prior transcript state is difficult with Claude Code session semantics.

For v1, label action `Retry` rather than promising true branch regeneration.

---

## 23. Parallelism and Queue

### 23.1 Job scheduler

Internal job entity:

```ts
type BotJob = {
  id: string
  botId: string
  conversationId: string
  triggeringMessageId: string
  status: "queued" | "running" | "success" | "error" | "cancelled"
  handoffDepth: number
  processPid?: number
  createdAt: string
  startedAt?: string
  completedAt?: string
}
```

### 23.2 Constraints

- max global concurrent Claude processes: configurable, default 3;
- max 1 active job for the same `(bot, conversation)` pair;
- jobs for the same pair are FIFO;
- different Bots can run concurrently;
- same Bot may run in separate conversations concurrently only if explicitly enabled; default OFF to reduce confusion.

### 23.3 UI

Group header may show:

- `2 working`
- `1 queued`

Bot rows show animated status dot.

---

## 24. Persistence

Use SQLite via `better-sqlite3`.

Store database in Electron `app.getPath("userData")`.

Tables:

- `bots`
- `conversations`
- `conversation_members`
- `messages`
- `attachments`
- `bot_conversation_sessions`
- `jobs`
- `activities`
- `settings`
- `message_mentions`

Recommended message schema:

```sql
messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  author_type TEXT NOT NULL, -- user | bot | system
  author_bot_id TEXT,
  body_markdown TEXT NOT NULL,
  reply_to_message_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

Use migrations from day one.

---

## 25. Electron Architecture

Recommended stack:

- Electron
- TypeScript
- React
- Vite
- Tailwind CSS
- Radix UI or shadcn/ui
- Zustand for UI state
- TanStack Query optional
- better-sqlite3
- Zod
- react-markdown
- remark-gfm
- highlight.js or Shiki
- electron-builder

### 25.1 Process boundaries

**Main process owns:**

- SQLite;
- Claude process spawning;
- filesystem operations;
- OS dialogs;
- process cancellation;
- local MCP server;
- settings;
- notifications.

**Renderer owns:**

- UI;
- transient editor state;
- chat rendering;
- mention picker;
- optimistic message state.

Use a typed preload bridge.

Do not enable Node integration in renderer.

Use context isolation.

---

## 26. IPC Surface

Example typed interface:

```ts
window.botApp = {
  bots: {
    list(),
    create(input),
    update(id, patch),
    duplicate(id),
    hide(id),
    delete(id)
  },

  conversations: {
    list(),
    createDirect(botId),
    createGroup(input),
    update(id, patch),
    getMessages(id, cursor?),
    search(query)
  },

  messages: {
    send(input),
    retry(messageId),
    stop(jobId)
  },

  runtime: {
    detectClaude(),
    getClaudeVersion(),
    healthCheck()
  },

  settings: {
    get(),
    update(patch)
  }
}
```

IPC inputs must be Zod-validated in main process.

---

## 27. Claude Adapter

Create an abstraction.

```ts
interface AgentRuntime {
  checkAvailability(): Promise<RuntimeStatus>
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent>
  cancel(jobId: string): Promise<void>
}
```

Implementation:

`ClaudeCodeRuntime`

Do not spread shell command construction throughout the app.

### 27.1 Safe spawning

Use `child_process.spawn`.

Do not concatenate shell strings with user content.

Pass arguments as an array.

Set `cwd` explicitly.

Prefer `shell: false`.

### 27.2 Prompt transport

Avoid putting arbitrarily long prompts directly into command-line arguments.

Preferred implementation:

- spawn `claude -p ...` with appropriate flags;
- send prompt through stdin when supported;
- otherwise use a securely created temp file or argument only for small prompts.

Never interpolate untrusted prompt content into shell syntax.

---

## 28. Runtime Event Parser

The Claude adapter should parse NDJSON/stream JSON defensively.

Requirements:

- tolerate unknown event types;
- preserve raw payload in debug logs;
- never crash UI because a future Claude Code release added a field;
- derive session ID from init/result events;
- aggregate assistant text blocks;
- map tool-use blocks into activity cards;
- detect result success/error;
- capture model and permission mode where exposed.

Store Claude Code version with diagnostic logs.

---

## 29. Bot Prompt Construction

### 29.1 Profile layer

Every new session receives:

```text
You are a persistent AI teammate inside a desktop app called Claude Code Bots.

Identity:
Name: {{bot.name}}
Title: {{bot.title}}

Standing instructions:
{{bot.description}}

Behavior:
- Act only as {{bot.name}}.
- Be concise in chat updates.
- Use Claude Code tools when they help complete the task.
- Treat the current working directory as the active workspace.
- Never claim another Bot's work as your own.
```

### 29.2 Group layer

Add group identity and unseen messages.

### 29.3 User task layer

Append exact newest user instruction with structured mention metadata removed from text only when needed.

Preserve visible wording.

---

## 30. Slash Commands

### v1 app commands

- `/newbot`
- `/newgroup`
- `/clear-ui` (not Claude session)
- `/workspace`
- `/model`
- `/permissions`

Do not conflict unnecessarily with Claude Code slash commands.

### Claude skills/commands

Phase 2 can discover and surface Claude Code skills/commands from the environment.

---

## 31. Skills and MCP

Grok Bot prominently supports skills/plugins/routines.

For this local product, leverage Claude Code's ecosystem rather than inventing another one.

### v1

- inherit the user's Claude Code MCP configuration;
- optionally add app-owned local MCP server for handoffs;
- show detected MCP servers in Bot details if available from runtime init event.

### phase 2

- detect Claude Code skills/commands;
- autocomplete them in composer;
- per-Bot enabled-skill UI;
- one-click creation/editing of Bot-specific instruction files.

---

## 32. Routines / Scheduling

Not v1.

Reason: without a hosted runtime, routines only work while the user's machine and app are running.

Possible phase 3:

- local schedules;
- Electron background/tray mode;
- launch-at-login;
- clear badge showing `Local schedule — runs only while this computer is awake`.

Never imply 24/7 reliability without a remote service.

---

## 33. Notifications

### v1

Native desktop notifications when:

- a background Bot finishes;
- a Bot errors;
- a queued job becomes blocked;
- a rate limit is encountered.

Do not notify when the currently focused conversation completes unless user enables it.

---

## 34. App Settings

### General

- appearance: system/light/dark;
- launch at login;
- show notifications;
- default workspace;
- maximum concurrent Bots;
- allow same Bot to run in multiple chats concurrently;
- Claude executable path.

### Claude Code

- detected version;
- authentication health;
- default model;
- default permission mode;
- global allowed tools;
- global disallowed tools;
- button: Open Claude Code in Terminal.

### Data

- export backup;
- import backup;
- reveal app data folder;
- clear local app data.

---

## 35. Onboarding

### Screen 1 — Welcome

> Your Claude Code team, in a chat app.

Explain:

- local-first;
- uses installed Claude Code;
- no separate API key.

### Screen 2 — Detect Claude

Display:

- Installed / Not found
- version
- path

If absent, installation instructions.

### Screen 3 — Verify authentication

Run a minimal safe health check.

Avoid burning significant quota.

If uncertain, offer Open Terminal to log in.

### Screen 4 — Create first Bot

Fields:

- name;
- role;
- description;
- workspace;
- model.

Offer presets.

### Screen 5 — First message

Open Bot chat.

---

## 36. UI Style

Target visual feel:

- native desktop;
- dark-mode excellent;
- minimal chrome;
- compact but not IDE-dense;
- obvious avatars and authorship;
- conversation-centric rather than project-file-centric.

Reference mental model:

- Slack/Discord sidebar;
- iMessage simplicity;
- Linear-level polish.

Do not visually clone Grok Bot branding.

Do not use xAI/Grok trademarks in the shipped product name or app icon.

---

## 37. Error Handling

Handle these explicitly:

### Claude executable missing

Actionable install state.

### Claude not authenticated

Explain and open terminal.

### Session cannot resume

- preserve transcript;
- create replacement Claude session;
- inject a compact recovery context from local transcript;
- show small system notice:
  `Started a fresh Claude session because the previous session could not be resumed.`

### Rate limit

Show:

> Claude Code usage limit reached. Your Bot history is safe. Retry after your Claude allowance resets.

Do not offer API billing in v1.

### Working directory missing

Prompt user to locate replacement.

### Process crash

Keep partial text and stderr diagnostics.

### Malformed stream JSON

Log raw line and continue when possible.

### App restart during active run

On startup, mark orphaned `running` jobs as `interrupted`.

Do not claim they are still executing.

---

## 38. Security

1. No app-owned remote backend.
2. No storing Anthropic auth secrets.
3. Renderer has no direct shell access.
4. Strict Electron context isolation.
5. Spawn commands without shell interpolation.
6. Validate IPC.
7. Never render arbitrary HTML from Bot output.
8. Sanitize Markdown links.
9. Make file links local-only and explicit.
10. Treat all Bots as having the same OS user privileges; Bots are not security boundaries.
11. Warn that different Bots may access the same filesystem if their Claude Code permissions allow it.
12. Do not expose dangerous permission bypass in default UI.

---

## 39. Privacy

Local app data includes:

- Bot profiles;
- transcripts;
- workspace paths;
- Claude session IDs;
- activity metadata.

Store locally only in v1.

Claude Code itself sends relevant prompts/context to Anthropic under the user's own Claude account and Claude Code settings.

The product must not claim that inference is local.

Suggested onboarding disclosure:

> Chats are stored by this app on your computer. When a Bot runs, the app invokes your installed Claude Code client, which sends model requests according to your Anthropic account and privacy settings.

---

## 40. Analytics

v1 should have **no mandatory remote analytics**.

Optional later telemetry must be opt-in.

Local diagnostics may include:

- runtime version;
- event parse errors;
- process exit codes.

Provide `Copy diagnostics` button.

---

## 41. Data Export

Export to a `.zip` or folder:

```text
claude-code-bots-export/
  manifest.json
  bots.json
  conversations.json
  messages.json
  settings.json
```

Do not export Anthropic credentials.

Claude session IDs may be omitted by default because they may not be portable.

Allow Markdown export for individual conversations.

---

## 42. Feature-Parity Matrix

| Grok Bot capability | Claude Code Bots v1 | Notes |
|---|---:|---|
| Named persistent Bots | Yes | Core |
| Bot profile/job/description | Yes | Core |
| Bot avatar | Yes | Core |
| Direct Bot chat | Yes | Core |
| Multiple Bots | Yes | Core |
| Group chats | Yes | Core |
| `@Bot` | Yes | Core |
| multiple mentions | Yes | Core |
| `@everyone` | Yes | Core |
| Bots run concurrently | Yes | Local process scheduler |
| Bot-to-Bot handoff | Yes | Local MCP bridge |
| Persistent role/context | Yes | Profile + Claude session |
| Pin/hide | Yes | Core |
| Duplicate Bot | Yes | Core |
| Delete Bot | Yes | Core |
| Reply to message | Yes | Core |
| Reactions | Later | UX only |
| Search | Yes | SQLite FTS |
| Attach local files | Yes | Local paths |
| Activity/tool transcript | Yes | Parsed stream JSON |
| Redirect/stop running work | Yes | Kill/cancel process |
| Skills | Partial | Inherit Claude Code; deeper UI later |
| MCP/connectors | Partial | Inherit Claude Code MCP |
| Routines/schedules | Later | Local-only limitation |
| Notifications | Yes | Desktop |
| Persistent cloud computer | No | Explicit non-goal |
| Browser desktop takeover | No | Claude Code may use its own tools only |
| App login sessions | No | No shared remote browser |
| Teach workflow by demo | No | Out of scope |
| iOS/mobile | No | Desktop first |
| Cross-device sync | No | Local-first |
| 24/7 while laptop closed | No | Explicitly impossible without hosted runtime |
| Approval UI | Partial | Full permission bridge phase 2 |

---

## 43. MVP Definition

The MVP is successful when the user can:

1. install/open Electron app;
2. have app detect authenticated Claude Code;
3. create three Bots;
4. assign each a name/role/workspace;
5. chat individually with each;
6. close and reopen app;
7. continue each direct conversation with retained Claude context;
8. create a group with all three;
9. send `@Researcher investigate X`;
10. see only Researcher respond;
11. send `@Builder and @Reviewer handle Y`;
12. see both execute, potentially in parallel;
13. see each Bot's output clearly attributed;
14. see concise tool/file activity;
15. stop a running Bot;
16. attach a local file;
17. search prior messages;
18. pin/hide/duplicate a Bot;
19. receive a desktop notification for a background completion;
20. do all inference via the user's existing Claude Code installation.

Anything beyond this is secondary to shipping.

---

## 44. Acceptance Tests

### Bot creation

**Given** Claude Code is available  
**When** user creates Bot `Builder`  
**Then** Builder appears in sidebar and persists after restart.

### Direct session persistence

**Given** user tells Builder “the project codename is Atlas”  
**And** Builder's Claude session completes  
**When** app restarts and user asks “what is the codename?”  
**Then** Builder should answer using the resumed conversation context.

### Conversation isolation

**Given** Builder has a direct chat and belongs to Group A  
**When** user tells Builder a secret test phrase only in Group A  
**Then** Builder's direct chat must not receive Group A's Claude session history automatically.

### Single mention

**Given** Group A has Builder, Reviewer, Researcher  
**When** user sends `@Reviewer inspect the implementation`  
**Then** only Reviewer gets a job.

### Multi mention

**When** user sends `@Builder fix it and @Reviewer review the fix`  
**Then** both Bots get jobs.

For v1 both may start in parallel; the user's instruction should not imply Reviewer automatically waits unless sequencing is explicitly requested.

### Everyone

**When** user sends `@everyone give your recommendation`  
**Then** every Bot receives a job subject to queue limits.

### Group awareness

**Given** Researcher posted findings  
**When** Builder is subsequently invoked  
**Then** Builder receives unseen Researcher group output in its context bridge.

### Stop

**Given** Builder is running  
**When** user presses Stop  
**Then** Claude process is terminated and UI shows Cancelled.

### Rate limit

**Given** Claude Code returns a rate-limit condition  
**Then** app shows a readable subscription-limit state without asking for an API key.

### Missing session

**Given** a persisted Claude session can no longer resume  
**Then** transcript stays intact and user can continue through a recovered new session.

---

## 45. Implementation Milestones

### Milestone 0 — Scaffold

- Electron + React + TypeScript
- secure preload bridge
- SQLite migrations
- app shell

### Milestone 1 — Claude runtime

- detect executable
- health/version check
- spawn process
- stream JSON parser
- cancellation
- error normalization

### Milestone 2 — Direct Bots

- Bot CRUD
- direct conversations
- message composer
- streamed output
- persisted Claude session IDs
- workspace selection

### Milestone 3 — Groups

- create/edit group
- mention autocomplete
- structured mention storage
- multi-Bot scheduler
- context bridge
- simultaneous responses

### Milestone 4 — Agent UX

- activity cards
- queued/running states
- stop/retry
- file attachments
- replies
- notifications

### Milestone 5 — Handoffs

- local app MCP server
- bot-to-bot message tool
- visible handoff messages
- loop limits

### Milestone 6 — Polish

- search
- pin/hide/duplicate
- settings
- import/export
- onboarding
- diagnostics
- packaging

---

## 46. Recommended Directory Structure

```text
src/
  main/
    index.ts
    ipc/
    db/
      migrations/
      repositories/
    runtime/
      AgentRuntime.ts
      ClaudeCodeRuntime.ts
      ClaudeStreamParser.ts
      ProcessManager.ts
      JobScheduler.ts
    orchestration/
      PromptBuilder.ts
      MentionRouter.ts
      GroupContextBridge.ts
      HandoffManager.ts
    mcp/
      server.ts
    services/
      NotificationService.ts
      ExportService.ts

  preload/
    index.ts
    types.ts

  renderer/
    app/
    components/
      sidebar/
      chat/
      composer/
      bots/
      groups/
      activity/
      settings/
    stores/
    hooks/
    lib/
    styles/

shared/
  schemas/
  types/
```

---

## 47. Key Engineering Decisions

### Decision 1
**Use Claude Code CLI, not Anthropic API.**

Why: subscription compatibility and no separate billing/API key.

### Decision 2
**Use Claude session per Bot + conversation.**

Why: correct context isolation.

### Decision 3
**Use local SQLite as source of truth for UI transcript.**

Why: app needs a unified group transcript even though underlying Claude sessions are separate.

### Decision 4
**Use process-per-turn.**

Why: simpler control and recovery.

### Decision 5
**Use structured mentions.**

Why: deterministic routing.

### Decision 6
**Inject unseen group context.**

Why: underlying sessions cannot magically see each other.

### Decision 7
**Use app-owned local MCP for handoffs.**

Why: gives Claude a principled way to contact another Bot without hosted infrastructure.

### Decision 8
**No cloud sync/backend in v1.**

Why: product requirement and dramatically smaller scope.

---

## 48. Open Technical Questions to Resolve During Build

These should not block initial implementation.

1. Which exact Claude Code stream-json event variants exist in the user's installed current release?
   - Build parser from observed events and tolerate unknown variants.

2. Can a clean authentication health check be performed without consuming meaningful quota?
   - Prefer version/config/session checks where possible.
   - Do not spam a model request on every launch.

3. Best way to support interactive permission prompts from Electron?
   - v1: rely on modes/settings and readable failures.
   - phase 2: MCP permission prompt bridge.

4. Does Claude Code expose a stable command for listing authentication/subscription state?
   - If not, use best-effort detection and a terminal login fallback.

5. How should very large group histories be compacted?
   - v1: only unseen messages + hard cap.
   - later: local or Bot-generated summaries.

---

## 49. Future Roadmap

### Phase 2

- full approval UI;
- reactions;
- true side threads;
- Claude skills/command discovery;
- richer MCP management;
- Bot templates;
- conversation branching;
- local summaries/memory notes;
- project-specific Bot teams;
- configurable sequential workflows;
- git diff cards;
- test-result cards.

### Phase 3

- local routines while machine is awake;
- menu-bar/tray mode;
- launch-at-login;
- optional encrypted sync;
- optional mobile companion;
- optional user-provided remote runner — only if product direction changes.

---

## 50. Build Instruction to Claude Code

Build this as a real production-quality Electron application, not a mockup.

Prioritize this order:

1. Claude Code runtime reliability.
2. Session isolation and persistence.
3. Direct chat.
4. Group chat.
5. `@mention` routing.
6. Group context bridging.
7. Parallel job scheduler.
8. Activity UX.
9. Bot-to-Bot handoffs.
10. Polish.

Do not implement a server backend.

Do not use Anthropic API keys.

Do not fake agent responses.

Do not simulate multiple Bots with one shared session.

Do not allow context from unrelated conversations to leak into one another.

Keep the architecture modular so a different local agent runtime could be added later, but implement Claude Code only for the first release.

---

## 51. Research References

Primary product research:

- xAI / SpaceXAI — Grok Bot overview  
  https://docs.x.ai/grok-bot/overview

- xAI / SpaceXAI — Create and manage Bots  
  https://docs.x.ai/grok-bot/bots

- xAI / SpaceXAI — Message and collaborate  
  https://docs.x.ai/grok-bot/chat-and-collaboration

- xAI / SpaceXAI — Skills and routines  
  https://docs.x.ai/grok-bot/skills-routines-and-automations

- xAI / SpaceXAI — Settings and notifications  
  https://docs.x.ai/grok-bot/settings-and-notifications

- xAI / SpaceXAI — Approvals, security, and privacy  
  https://docs.x.ai/grok-bot/approvals-security-and-privacy

- xAI — Introducing Grok Bot  
  https://x.ai/news/introducing-grok-bot

Claude Code integration research:

- Anthropic — Claude Code CLI reference  
  https://docs.anthropic.com/en/docs/claude-code/cli-usage

- Anthropic — Claude Code getting started/authentication  
  https://docs.anthropic.com/en/docs/claude-code/getting-started

- Anthropic Help — Using Claude Code with Pro or Max  
  https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan

---

# End of PRD
