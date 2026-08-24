/**
 * Wire-format definitions shared by the local MCP handoff bridge and the
 * loopback control server that backs it.
 *
 * Two protocols meet in this file:
 *
 *  1. **MCP over stdio** — newline-delimited JSON-RPC 2.0 spoken between the
 *     Claude Code CLI (client) and `src/main/mcp/bridge.ts` (server).
 *  2. **The control RPC** — a single `POST /rpc` call from the bridge back into
 *     the Electron main process, which is the only party that can actually
 *     touch the database and the job scheduler.
 *
 * NOTE: `bridge.ts` deliberately does **not** import from this module. It runs
 * as a standalone Electron-as-node script and the contract for that file is
 * "zero imports outside `node:` builtins", so the handful of constants it needs
 * are repeated there verbatim. This module stays the documented source of truth
 * and both sides must be edited together — see the guard comment in `bridge.ts`.
 */

/* ------------------------------------------------------------------ *
 * MCP identity
 * ------------------------------------------------------------------ */

/**
 * The MCP protocol revision the CLI negotiated against during verification.
 * Claude Code echoes whatever the server reports here, so we pin the version we
 * actually implement rather than mirroring the client's request.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * Server key inside `--mcp-config`. Claude Code namespaces tools as
 * `mcp__<serverName>__<toolName>`, so this string is load-bearing: changing it
 * changes every tool name the model sees (and every entry in `allowedTools`).
 * Underscores only — the CLI's tool-name grammar does not accept dashes.
 */
export const MCP_SERVER_NAME = 'claude_code_bots'

export const MCP_SERVER_VERSION = '1.0.0'

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0
 * ------------------------------------------------------------------ */

export type JsonRpcId = string | number | null

/** A request carries an `id`; a *notification* omits it entirely and must never be answered. */
export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603
} as const

/* ------------------------------------------------------------------ *
 * MCP tool surface
 * ------------------------------------------------------------------ */

/** Minimal JSON Schema subset we emit — MCP clients only need object schemas here. */
export interface McpJsonSchema {
  type: 'object'
  properties: Record<string, { type: 'string'; description: string }>
  required: string[]
  additionalProperties: false
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: McpJsonSchema
}

/** Content block shape returned by `tools/call`. */
export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpTextContent[]
  isError?: boolean
}

export const HANDOFF_TOOL = {
  sendToBot: 'send_message_to_bot',
  sendToGroup: 'send_message_to_group',
  listBots: 'list_bots'
} as const

export type HandoffToolName = (typeof HANDOFF_TOOL)[keyof typeof HANDOFF_TOOL]

/**
 * Tool definitions exactly as the model sees them.
 *
 * The descriptions do real work. Claude's default assumption about a tool is
 * that it is a synchronous function returning an answer; a handoff is nothing
 * of the sort. Without the explicit "this posts a visible message and returns
 * immediately" framing, models call `send_message_to_bot` and then sit waiting
 * for a reply that will never arrive inside this turn, or worse, invent the
 * other Bot's response. Keep the asynchrony spelled out.
 */
export const HANDOFF_TOOLS: McpToolDefinition[] = [
  {
    name: HANDOFF_TOOL.sendToBot,
    description: [
      'Hand a piece of work to another Bot in this chat.',
      '',
      'This posts a VISIBLE message in the shared conversation, addressed to that Bot, and',
      'queues the Bot to respond on its own turn. It is NOT a synchronous function call:',
      'it returns as soon as the message is posted and it never returns the other Bot\'s answer.',
      'The other Bot replies asynchronously, in the conversation, after your turn ends — you',
      'will see the reply the next time you are asked to respond. Do not wait for it, do not',
      'poll for it, and never invent what the other Bot said.',
      '',
      'Use this when another Bot is genuinely better suited to part of the work. Write the',
      'message as if you were speaking to a colleague: state what you need, name the files or',
      'commands involved, and include enough context that they can act without re-reading the',
      'whole conversation. Call list_bots first if you are unsure who is here or how a name is',
      'spelled. To answer the human, just write your reply normally — do not use this tool.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        bot_name: {
          type: 'string',
          description:
            'Exact name of a Bot in this conversation, as returned by list_bots. Case-insensitive.'
        },
        message: {
          type: 'string',
          description:
            'The message to post for that Bot. Self-contained: say what you need and why, with the relevant paths or commands.'
        }
      },
      required: ['bot_name', 'message'],
      additionalProperties: false
    }
  },
  {
    name: HANDOFF_TOOL.sendToGroup,
    description: [
      'Post a VISIBLE message to everyone in this conversation — the human and every other Bot.',
      '',
      'Like send_message_to_bot, this is asynchronous: it returns as soon as the message is',
      'posted and never returns anyone\'s answer. Replies appear in the conversation after your',
      'turn ends.',
      '',
      'Use this sparingly — for a status update, a blocking question, or a heads-up that the',
      'whole group needs. If exactly one Bot should act, use send_message_to_bot instead so the',
      'work is not duplicated. If you are simply answering the human, write your reply normally',
      'rather than calling this tool.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to post to the whole conversation.'
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: HANDOFF_TOOL.listBots,
    description: [
      'List the Bots that are members of this conversation, with their names and roles.',
      '',
      'Read-only and instant — it does not post anything. Call it before send_message_to_bot',
      'when you are not certain who is available or exactly how a name is spelled; bot_name must',
      'match one of the names returned here.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
]

/** Fully-qualified name the model sees for a bare handoff tool name. */
export function qualifiedToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`
}

/**
 * The three namespaced tool names. These must be appended to every job's
 * `--allowedTools` so Claude can call them without stopping to ask permission —
 * a permission prompt in a headless `claude -p` run just stalls the turn.
 */
export const HANDOFF_TOOL_NAMES: string[] = HANDOFF_TOOLS.map((t) => qualifiedToolName(t.name))

/* ------------------------------------------------------------------ *
 * Control RPC (bridge -> Electron main)
 * ------------------------------------------------------------------ */

export const CONTROL_RPC_PATH = '/rpc'

/** Hard ceiling on a control request body. A handoff note is text; 256KB is already generous. */
export const CONTROL_MAX_BODY_BYTES = 256 * 1024

/**
 * Environment variables handed to the bridge process through `--mcp-config`.
 * The bridge has no other channel back to the app.
 *
 * Identity (which Bot, which conversation) is deliberately NOT here. The token
 * is minted per turn and the server holds the `token -> { botId,
 * conversationId }` mapping, so the caller's identity is a property of the
 * credential it presents and nothing the bridge sends can change it.
 */
export const CONTROL_ENV = {
  port: 'CCB_PORT',
  token: 'CCB_TOKEN'
} as const

/**
 * A control call carries only the tool and its arguments.
 *
 * This used to carry `botId`/`conversationId`, with a comment claiming "the
 * bridge cannot forge this, it is baked into env". It could: the env only
 * decided what the bridge *sent*, and the server read the identity straight out
 * of the body. Anything holding the token could therefore impersonate any Bot
 * and reset the handoff-depth and turn-budget guards, both of which are derived
 * from the caller's identity. The server now rejects a body that carries either
 * field, so a bridge from an older build fails loudly instead of being trusted.
 */
export interface ControlRequestBody {
  tool: string
  arguments: Record<string, unknown>
}

export interface ControlResponseBody {
  ok: boolean
  /** Human/model readable result text. Rendered straight into the tool result. */
  text: string
}

/** Shape of the `--mcp-config` value we serialize for each job. */
export interface McpConfigDocument {
  mcpServers: Record<
    string,
    {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  >
}
